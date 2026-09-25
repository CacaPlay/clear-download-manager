use super::aggregate::aggregate_streams_with_expected;
use super::aria2::{
    Aria2ProgressComparison, Aria2ProgressInput, Aria2ShadowStore, Aria2V1Observation,
};
use super::coordinator;
use super::ffmpeg::{FfmpegProgressAdapterV2, FfmpegProgressObservation, FfmpegProgressStatus};
use super::http::{ContentRangeFacts, HttpComparison, HttpShadowStore, HttpV1Observation};
use super::model::{
    EtaKind, JobPhase, ProgressKind, ProgressSnapshotV2, SpeedKind, StreamKind, StreamPhase,
    StreamProgress, TotalKind, TransferProgress,
};
use super::playlist::{PlaylistComparison, PlaylistItemSeed, PlaylistShadowStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_COMPARISONS_PER_JOB: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum YtDlpProgressStatus {
    Preparing,
    Downloading,
    Finished,
    Paused,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YtDlpProgressInput {
    pub(crate) stream_id: Option<String>,
    pub(crate) downloaded_bytes: Option<u64>,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_bytes_estimate: Option<u64>,
    pub(crate) speed_bps: Option<f64>,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) percent: Option<f64>,
    pub(crate) format_id: Option<String>,
    pub(crate) filename: Option<String>,
    pub(crate) status: Option<YtDlpProgressStatus>,
    pub(crate) stream_kind: StreamKind,
}

impl YtDlpProgressInput {
    pub(crate) fn from_json(progress: &Value) -> Option<Self> {
        let object = progress.as_object()?;
        let info = object.get("info_dict").and_then(Value::as_object);
        let downloaded_bytes = number_as_u64(object.get("downloaded_bytes"));
        let total_bytes = number_as_u64(object.get("total_bytes"));
        let total_bytes_estimate = number_as_u64(object.get("total_bytes_estimate"));
        let speed_bps = number_as_f64(object.get("speed"));
        let eta_seconds = number_as_u64(object.get("eta"));
        let percent = percent_from_object(object);
        let format_id = string_from(object, "format_id")
            .or_else(|| info.and_then(|value| string_from(value, "format_id")));
        let filename =
            string_from(object, "filename").or_else(|| string_from(object, "tmpfilename"));
        let status = string_from(object, "status").and_then(|value| parse_status(&value));
        let stream_kind = stream_kind_from_info(info);

        if downloaded_bytes.is_none()
            && total_bytes.is_none()
            && total_bytes_estimate.is_none()
            && speed_bps.is_none()
            && eta_seconds.is_none()
            && percent.is_none()
            && format_id.is_none()
            && filename.is_none()
            && status.is_none()
        {
            return None;
        }

        Some(Self {
            stream_id: filename.clone().or_else(|| format_id.clone()),
            downloaded_bytes,
            total_bytes,
            total_bytes_estimate,
            speed_bps,
            eta_seconds,
            percent,
            format_id,
            filename,
            status,
            stream_kind,
        })
    }
}

fn string_from(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn number_as_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|entry| {
        entry
            .as_u64()
            .or_else(|| {
                entry
                    .as_f64()
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(|number| number as u64)
            })
            .or_else(|| {
                entry
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(|number| number as u64)
            })
    })
}

fn number_as_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|entry| {
            entry
                .as_f64()
                .or_else(|| entry.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .filter(|number: &f64| number.is_finite() && *number >= 0.0)
}

fn percent_from_object(object: &serde_json::Map<String, Value>) -> Option<f64> {
    let raw = object
        .get("_percent_str")
        .or_else(|| object.get("percent_str"))
        .or_else(|| object.get("percent"))?;
    let value = raw
        .as_str()
        .map(|text| text.trim().trim_end_matches('%').trim().to_string())
        .or_else(|| raw.as_f64().map(|number| number.to_string()))?
        .parse::<f64>()
        .ok()?;
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn parse_status(value: &str) -> Option<YtDlpProgressStatus> {
    match value.trim().to_ascii_lowercase().as_str() {
        "preparing" | "started" => Some(YtDlpProgressStatus::Preparing),
        "downloading" => Some(YtDlpProgressStatus::Downloading),
        "finished" | "complete" | "completed" => Some(YtDlpProgressStatus::Finished),
        "paused" => Some(YtDlpProgressStatus::Paused),
        "cancelled" | "canceled" => Some(YtDlpProgressStatus::Cancelled),
        "error" | "failed" => Some(YtDlpProgressStatus::Failed),
        _ => None,
    }
}

fn stream_kind_from_info(info: Option<&serde_json::Map<String, Value>>) -> StreamKind {
    let vcodec = info
        .and_then(|value| value.get("vcodec"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let acodec = info
        .and_then(|value| value.get("acodec"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    stream_kind_from_codecs(vcodec, acodec)
}

pub(crate) fn stream_kind_from_codecs(vcodec: &str, acodec: &str) -> StreamKind {
    let has_video = !vcodec.is_empty() && vcodec != "none";
    let has_audio = !acodec.is_empty() && acodec != "none";
    if has_video && has_audio {
        StreamKind::Combined
    } else if has_video {
        StreamKind::Video
    } else if has_audio {
        StreamKind::Audio
    } else {
        StreamKind::Other
    }
}

#[derive(Debug)]
pub(crate) struct YtDlpProgressAdapterV2 {
    job_id: i64,
    machine: super::state_machine::JobStateMachine,
    streams: HashMap<String, StreamProgress>,
    expected_streams: usize,
    post_stage: Option<super::model::ProcessingStage>,
    phase_progress: Option<f64>,
    phase_progress_kind: ProgressKind,
    phase_eta_seconds: Option<u64>,
    phase_eta_kind: EtaKind,
    processing_speed_ratio: Option<f64>,
    last_snapshot: Option<ProgressSnapshotV2>,
}

impl YtDlpProgressAdapterV2 {
    pub(crate) fn new(job_id: i64) -> Self {
        Self::new_with_expected(job_id, 1)
    }

    pub(crate) fn new_for_selector(job_id: i64, selector: &str) -> Self {
        let expected_streams = selector
            .split('/')
            .next()
            .map(|selected| selected.matches('+').count() + 1)
            .unwrap_or(1)
            .max(1);
        Self::new_with_expected(job_id, expected_streams)
    }

    fn new_with_expected(job_id: i64, expected_streams: usize) -> Self {
        Self {
            job_id,
            machine: super::state_machine::JobStateMachine::new(),
            streams: HashMap::new(),
            expected_streams,
            post_stage: None,
            phase_progress: None,
            phase_progress_kind: ProgressKind::Unavailable,
            phase_eta_seconds: None,
            phase_eta_kind: EtaKind::Unavailable,
            processing_speed_ratio: None,
            last_snapshot: None,
        }
    }

    pub(crate) fn mark_preparing(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Queued {
            let _ = self.machine.transition(JobPhase::Preparing);
        }
        self.snapshot(None)
    }

    pub(crate) fn accept(&mut self, input: &YtDlpProgressInput) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_terminal()
            && !matches!(
                input.status,
                Some(YtDlpProgressStatus::Failed | YtDlpProgressStatus::Cancelled)
            )
        {
            return None;
        }

        // A combined fallback is a legitimate one-stream selection even when
        // the preferred selector was adaptive.  Do not wait forever for an
        // audio stream that yt-dlp never spawned.
        if input.stream_kind == StreamKind::Combined
            && self.streams.is_empty()
            && self.expected_streams > 1
        {
            self.expected_streams = 1;
        }

        self.apply_status(input.status);
        let stream_id = input
            .stream_id
            .clone()
            .or_else(|| input.filename.clone())
            .or_else(|| input.format_id.clone())
            .unwrap_or_else(|| format!("stream-{}", self.streams.len() + 1));
        let previous_stream = self.streams.get(&stream_id).cloned();
        if previous_stream
            .as_ref()
            .is_some_and(|stream| stream.state == StreamPhase::Completed)
            && !matches!(input.status, Some(YtDlpProgressStatus::Finished))
        {
            return self.snapshot(None);
        }
        let previous = previous_stream
            .as_ref()
            .map(|stream| stream.transfer.clone())
            .unwrap_or_default();
        let downloaded_bytes = input.downloaded_bytes.unwrap_or(previous.downloaded_bytes);
        let (total_bytes, total_kind) = if let Some(total) = input.total_bytes {
            (Some(total), TotalKind::Exact)
        } else if let Some(total) = input.total_bytes_estimate {
            (Some(total), TotalKind::Estimated)
        } else if let Some(total) = previous.total_bytes {
            (Some(total), previous.total_kind)
        } else {
            (None, TotalKind::Unknown)
        };
        let mut transfer = match total_kind {
            TotalKind::Exact | TotalKind::Estimated => {
                TransferProgress::with_total(downloaded_bytes, total_bytes, total_kind)
            }
            TotalKind::Unknown => input
                .percent
                .map(|percent| TransferProgress::with_reported_percent(downloaded_bytes, percent))
                .unwrap_or_else(|| TransferProgress::unknown(downloaded_bytes)),
        };
        transfer.reported_percent = input
            .percent
            .map(|percent| (percent / 100.0).clamp(0.0, 1.0));
        if transfer.reported_percent.is_none() {
            transfer.reported_percent = previous.reported_percent;
        }
        if let Some(speed) = input.speed_bps {
            transfer = transfer.with_speed(speed, SpeedKind::Reported);
        } else if let (Some(speed), kind) = (previous.speed_bps, previous.speed_kind) {
            transfer = transfer.with_speed(speed, kind);
        }
        if let Some(eta) = input.eta_seconds {
            let kind = if total_kind == TotalKind::Estimated {
                EtaKind::Estimated
            } else {
                EtaKind::Reported
            };
            transfer = transfer.with_eta(eta, kind);
        } else if let (Some(eta), kind) = (previous.eta_seconds, previous.eta_kind) {
            transfer = transfer.with_eta(eta, kind);
        }

        let stream_kind = if input.stream_kind == StreamKind::Other {
            previous_stream
                .as_ref()
                .map(|stream| stream.kind)
                .unwrap_or(StreamKind::Other)
        } else {
            input.stream_kind
        };
        let stream_phase = stream_phase(
            input.status,
            self.machine.phase(),
            previous_stream.as_ref().map(|stream| stream.state),
        );
        self.streams.insert(
            stream_id.clone(),
            StreamProgress::new(
                stream_id,
                stream_kind,
                input
                    .format_id
                    .clone()
                    .or_else(|| previous_stream.and_then(|stream| stream.format_id)),
                stream_phase,
                transfer,
            ),
        );
        if matches!(input.status, Some(YtDlpProgressStatus::Finished))
            && self.all_streams_completed()
            && self.machine.phase() == JobPhase::Downloading
        {
            let _ = self.machine.transition(JobPhase::PostProcessing);
        }
        self.snapshot(None)
    }

    fn all_streams_completed(&self) -> bool {
        self.streams.len() >= self.expected_streams
            && self
                .streams
                .values()
                .all(|stream| stream.state == StreamPhase::Completed)
    }

    pub(crate) fn mark_post_processing(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Downloading {
            let _ = self.machine.transition(JobPhase::PostProcessing);
        }
        self.snapshot(None)
    }

    pub(crate) fn mark_post_processing_stage(
        &mut self,
        stage: super::model::ProcessingStage,
    ) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Downloading {
            let _ = self.machine.transition(JobPhase::PostProcessing);
        }
        if self.machine.phase() != JobPhase::PostProcessing {
            return self.last_snapshot.clone();
        }
        if self.post_stage != Some(stage) {
            self.phase_progress = None;
            self.phase_progress_kind = ProgressKind::Unavailable;
            self.phase_eta_seconds = None;
            self.phase_eta_kind = EtaKind::Unavailable;
            self.processing_speed_ratio = None;
        }
        self.post_stage = Some(stage);
        self.snapshot(None)
    }

    pub(crate) fn observe_ffmpeg_progress(
        &mut self,
        observation: &FfmpegProgressObservation,
    ) -> Option<ProgressSnapshotV2> {
        self.mark_post_processing_stage(observation.stage)?;
        self.phase_progress = observation.progress;
        self.phase_progress_kind = observation.progress_kind;
        self.phase_eta_seconds = observation.eta_seconds;
        self.phase_eta_kind = observation.eta_kind;
        self.processing_speed_ratio = observation.processing_speed_ratio;
        if observation.status == Some(FfmpegProgressStatus::End) {
            self.phase_progress = Some(1.0);
            self.phase_progress_kind = ProgressKind::Estimated;
        }
        self.snapshot(None)
    }

    pub(crate) fn mark_finalizing(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::PostProcessing {
            let _ = self.machine.transition(JobPhase::Finalizing);
        }
        self.clear_phase_progress();
        self.snapshot(None)
    }

    pub(crate) fn mark_completed(&mut self, final_size: u64) -> Option<ProgressSnapshotV2> {
        if matches!(
            self.machine.phase(),
            JobPhase::Cancelling | JobPhase::Cancelled | JobPhase::Failed
        ) {
            return self.last_snapshot.clone();
        }
        if self.machine.phase() == JobPhase::Downloading {
            let _ = self.machine.transition(JobPhase::PostProcessing);
        }
        if self.machine.phase() == JobPhase::PostProcessing {
            let _ = self.machine.transition(JobPhase::Finalizing);
        }
        if self.machine.phase() == JobPhase::Finalizing {
            let _ = self.machine.transition(JobPhase::Completed);
        }
        self.clear_phase_progress();
        self.snapshot(Some(final_size))
    }

    fn clear_phase_progress(&mut self) {
        self.post_stage = None;
        self.phase_progress = None;
        self.phase_progress_kind = ProgressKind::Unavailable;
        self.phase_eta_seconds = None;
        self.phase_eta_kind = EtaKind::Unavailable;
        self.processing_speed_ratio = None;
    }

    pub(crate) fn mark_paused(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Downloading {
            let _ = self.machine.transition(JobPhase::Paused);
        }
        for stream in self.streams.values_mut() {
            if matches!(
                stream.state,
                StreamPhase::Preparing | StreamPhase::Downloading
            ) {
                stream.state = StreamPhase::Paused;
            }
        }
        self.snapshot(None)
    }

    pub(crate) fn mark_cancelled(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_terminal() && self.machine.phase() != JobPhase::Cancelled {
            return self.last_snapshot.clone();
        }
        if self.machine.phase() != JobPhase::Cancelling {
            let _ = self.machine.cancel();
        }
        if self.machine.phase() == JobPhase::Cancelling {
            let _ = self.machine.process_terminated();
        }
        for stream in self.streams.values_mut() {
            if !matches!(stream.state, StreamPhase::Completed | StreamPhase::Failed) {
                stream.state = StreamPhase::Cancelled;
            }
        }
        self.snapshot(None)
    }

    pub(crate) fn mark_failed(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_terminal() {
            return self.last_snapshot.clone();
        }
        let _ = self.machine.transition(JobPhase::Failed);
        for stream in self.streams.values_mut() {
            if !matches!(
                stream.state,
                StreamPhase::Completed | StreamPhase::Cancelled
            ) {
                stream.state = StreamPhase::Failed;
            }
        }
        self.snapshot(None)
    }

    pub(crate) fn begin_retry(&mut self) -> Result<(), super::state_machine::TransitionError> {
        self.machine.begin_retry()?;
        self.streams.clear();
        self.clear_phase_progress();
        self.last_snapshot = None;
        Ok(())
    }

    fn apply_status(&mut self, status: Option<YtDlpProgressStatus>) {
        match status.unwrap_or(YtDlpProgressStatus::Downloading) {
            YtDlpProgressStatus::Preparing => {
                if self.machine.phase() == JobPhase::Queued {
                    let _ = self.machine.transition(JobPhase::Preparing);
                }
            }
            YtDlpProgressStatus::Downloading => {
                if self.machine.phase() == JobPhase::Queued {
                    let _ = self.machine.transition(JobPhase::Preparing);
                }
                if matches!(self.machine.phase(), JobPhase::Preparing | JobPhase::Paused) {
                    let _ = self.machine.transition(JobPhase::Downloading);
                }
            }
            YtDlpProgressStatus::Finished => {}
            YtDlpProgressStatus::Paused => {
                if self.machine.phase() == JobPhase::Downloading {
                    let _ = self.machine.transition(JobPhase::Paused);
                }
            }
            YtDlpProgressStatus::Cancelled => {
                let _ = self.mark_cancelled();
            }
            YtDlpProgressStatus::Failed => {
                let _ = self.machine.transition(JobPhase::Failed);
            }
        }
    }

    fn snapshot(&mut self, final_size: Option<u64>) -> Option<ProgressSnapshotV2> {
        let mut streams = self.streams.values().cloned().collect::<Vec<_>>();
        streams.sort_by(|left, right| left.id.cmp(&right.id));
        let transfer = aggregate_streams_with_expected(&streams, self.expected_streams);
        let mut snapshot =
            ProgressSnapshotV2::new(self.job_id as u64, self.machine.phase(), transfer);
        snapshot.attempt = self.machine.attempt();
        snapshot.final_size = final_size;
        snapshot.streams = streams;
        snapshot.stage = match self.machine.phase() {
            JobPhase::PostProcessing => self.post_stage,
            _ => None,
        };
        if snapshot.phase == JobPhase::PostProcessing {
            snapshot.phase_progress = self.phase_progress;
            snapshot.phase_progress_kind = self.phase_progress_kind;
            snapshot.phase_eta_seconds = self.phase_eta_seconds;
            snapshot.phase_eta_kind = self.phase_eta_kind;
            snapshot.processing_speed_ratio = self.processing_speed_ratio;
        }
        if snapshot.validate().is_err() {
            return None;
        }
        self.last_snapshot = Some(snapshot.clone());
        Some(snapshot)
    }
}

fn stream_phase(
    status: Option<YtDlpProgressStatus>,
    phase: JobPhase,
    previous: Option<StreamPhase>,
) -> StreamPhase {
    match status {
        Some(YtDlpProgressStatus::Paused) => StreamPhase::Paused,
        Some(YtDlpProgressStatus::Cancelled) => StreamPhase::Cancelled,
        Some(YtDlpProgressStatus::Failed) => StreamPhase::Failed,
        Some(YtDlpProgressStatus::Finished) => StreamPhase::Completed,
        Some(YtDlpProgressStatus::Downloading) if previous == Some(StreamPhase::Paused) => {
            StreamPhase::Downloading
        }
        Some(YtDlpProgressStatus::Downloading) if previous == Some(StreamPhase::Completed) => {
            StreamPhase::Completed
        }
        _ if phase == JobPhase::Preparing => StreamPhase::Preparing,
        _ => StreamPhase::Downloading,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct V1ProgressObservation {
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_estimated: bool,
    pub(crate) progress_percent: Option<f64>,
    pub(crate) indeterminate: bool,
    pub(crate) speed_bps: Option<f64>,
    pub(crate) eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProgressDivergence {
    None,
    ExpectedPercentWithoutTotal,
    DangerousDownloadedRegression,
    AccuracyMismatch,
    V1TransferCompleteDuringPostProcessing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressComparison {
    pub(crate) timestamp_ms: u64,
    pub(crate) job_id: i64,
    pub(crate) raw: YtDlpProgressInput,
    pub(crate) v1: V1ProgressObservation,
    pub(crate) v2: ProgressSnapshotV2,
    pub(crate) divergence: ProgressDivergence,
}

pub(crate) fn compare_v1_v2(
    job_id: i64,
    raw: YtDlpProgressInput,
    v1: V1ProgressObservation,
    v2: ProgressSnapshotV2,
) -> ProgressComparison {
    let divergence = if v2.transfer.downloaded_bytes < v1.downloaded_bytes {
        ProgressDivergence::DangerousDownloadedRegression
    } else if matches!(v2.phase, JobPhase::PostProcessing | JobPhase::Finalizing)
        && v1.progress_percent.is_some_and(|progress| progress >= 1.0)
    {
        ProgressDivergence::V1TransferCompleteDuringPostProcessing
    } else if v1.indeterminate
        && v1.total_bytes.is_none()
        && v1.progress_percent.is_some()
        && v2.transfer.total_kind == TotalKind::Unknown
        && v2.transfer.progress_kind == ProgressKind::Estimated
    {
        ProgressDivergence::ExpectedPercentWithoutTotal
    } else if !v1.total_estimated && v1.total_bytes != v2.transfer.total_bytes {
        ProgressDivergence::AccuracyMismatch
    } else {
        ProgressDivergence::None
    };
    ProgressComparison {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or_default(),
        job_id,
        raw,
        v1,
        v2,
        divergence,
    }
}

#[derive(Debug, Default)]
pub(crate) struct ShadowStoreV2 {
    jobs: HashMap<i64, YtDlpProgressAdapterV2>,
    comparisons: HashMap<i64, VecDeque<ProgressComparison>>,
    playlists: PlaylistShadowStore,
    http: HttpShadowStore,
    aria2: Aria2ShadowStore,
    ffmpeg: HashMap<i64, FfmpegProgressAdapterV2>,
}

impl ShadowStoreV2 {
    pub(crate) fn begin_playlist(&mut self, batch_id: i64, seeds: Vec<PlaylistItemSeed>) {
        self.playlists.ensure_playlist(batch_id, seeds);
    }

    pub(crate) fn begin_http(&mut self, job_id: i64, reused_bytes: u64) {
        self.http.begin(job_id, reused_bytes);
    }

    pub(crate) fn retry_http(&mut self, job_id: i64, reused_bytes: u64) {
        self.http.retry(job_id, reused_bytes);
    }

    pub(crate) fn mark_http_preparing(&mut self, job_id: i64) {
        self.http.mark_preparing(job_id);
    }

    pub(crate) fn http_response_headers(
        &mut self,
        job_id: i64,
        status_code: u16,
        existing_bytes: u64,
        content_length: Option<u64>,
        content_range: Option<ContentRangeFacts>,
        v1: HttpV1Observation,
    ) {
        self.http.response_headers(
            job_id,
            status_code,
            existing_bytes,
            content_length,
            content_range,
            v1,
        );
    }

    pub(crate) fn http_start_stream(
        &mut self,
        job_id: i64,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        v1: HttpV1Observation,
    ) {
        self.http
            .start_stream(job_id, downloaded_bytes, total_bytes, v1);
    }

    pub(crate) fn http_observe(
        &mut self,
        job_id: i64,
        downloaded_bytes: u64,
        v1: HttpV1Observation,
    ) {
        self.http.observe(job_id, downloaded_bytes, v1);
    }

    pub(crate) fn mark_http_paused(&mut self, job_id: i64) {
        self.http.mark_paused(job_id);
    }

    pub(crate) fn mark_http_resumed(&mut self, job_id: i64) {
        self.http.mark_resumed(job_id);
    }

    pub(crate) fn mark_http_cancelling(&mut self, job_id: i64) {
        self.http.mark_cancelling(job_id);
    }

    pub(crate) fn mark_http_cancelled(&mut self, job_id: i64) {
        self.http.mark_cancelled(job_id);
    }

    pub(crate) fn mark_http_failed(&mut self, job_id: i64) {
        self.http.mark_failed(job_id);
    }

    pub(crate) fn mark_http_post_processing(&mut self, job_id: i64) {
        self.http.mark_post_processing(job_id);
    }

    pub(crate) fn mark_http_finalizing(&mut self, job_id: i64) {
        self.http.mark_finalizing(job_id);
    }

    pub(crate) fn mark_http_completed(&mut self, job_id: i64, final_size: u64) {
        self.http.mark_completed(job_id, final_size);
    }

    pub(crate) fn http_snapshot(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.http.snapshot(job_id)
    }

    pub(crate) fn http_comparisons(&self, job_id: i64) -> Vec<HttpComparison> {
        self.http.comparisons(job_id)
    }

    pub(crate) fn begin_aria2(&mut self, job_id: i64) {
        self.aria2.begin(job_id);
    }

    pub(crate) fn observe_aria2(
        &mut self,
        job_id: i64,
        input: Aria2ProgressInput,
        v1: Aria2V1Observation,
    ) {
        self.aria2.observe(job_id, input, v1);
    }

    pub(crate) fn mark_aria2_paused(&mut self, job_id: i64) {
        self.aria2.mark_paused(job_id);
    }

    pub(crate) fn mark_aria2_cancelling(&mut self, job_id: i64) {
        self.aria2.mark_cancelling(job_id);
    }

    pub(crate) fn mark_aria2_cancelled(&mut self, job_id: i64) {
        self.aria2.mark_cancelled(job_id);
    }

    pub(crate) fn mark_aria2_failed(&mut self, job_id: i64) {
        self.aria2.mark_failed(job_id);
    }

    pub(crate) fn mark_aria2_finalizing(&mut self, job_id: i64) {
        self.aria2.mark_finalizing(job_id);
    }

    pub(crate) fn mark_aria2_completed(&mut self, job_id: i64, final_size: u64) {
        self.aria2.mark_completed(job_id, final_size);
    }

    pub(crate) fn mark_post_processing_stage(
        &mut self,
        job_id: i64,
        stage: super::model::ProcessingStage,
    ) {
        self.ffmpeg
            .entry(job_id)
            .or_insert_with(|| FfmpegProgressAdapterV2::new(stage, None))
            .set_stage(stage);
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            if let Some(snapshot) = adapter.mark_post_processing_stage(stage) {
                self.playlists.update_item(job_id, &snapshot, None);
            }
        }
    }

    pub(crate) fn observe_ffmpeg_line(&mut self, job_id: i64, line: &str) {
        let Some(ffmpeg) = self.ffmpeg.get_mut(&job_id) else {
            return;
        };
        let Some(observation) = ffmpeg.accept_line(line) else {
            return;
        };
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            if let Some(snapshot) = adapter.observe_ffmpeg_progress(&observation) {
                self.playlists.update_item(job_id, &snapshot, None);
            }
        }
    }

    pub(crate) fn begin_ffmpeg(
        &mut self,
        job_id: i64,
        stage: super::model::ProcessingStage,
        duration_seconds: Option<f64>,
    ) {
        self.ffmpeg.insert(
            job_id,
            FfmpegProgressAdapterV2::new(stage, duration_seconds),
        );
        self.mark_post_processing_stage(job_id, stage);
    }

    pub(crate) fn aria2_snapshot(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.aria2.snapshot(job_id)
    }

    pub(crate) fn aria2_comparisons(&self, job_id: i64) -> Vec<Aria2ProgressComparison> {
        self.aria2.comparisons(job_id)
    }

    pub(crate) fn pause_playlist(&mut self, batch_id: i64) {
        self.playlists.pause_batch(batch_id);
    }

    pub(crate) fn resume_playlist(&mut self, batch_id: i64) {
        self.playlists.resume_batch(batch_id);
    }

    pub(crate) fn cancel_playlist(&mut self, batch_id: i64) {
        self.playlists.cancel_batch(batch_id);
    }

    pub(crate) fn retry_playlist(&mut self, batch_id: i64) {
        self.playlists.retry_failed_items(batch_id);
    }

    pub(crate) fn begin_single_stream(&mut self, job_id: i64, selector: &str) -> bool {
        let first_selector = selector.split('/').next().unwrap_or_default();
        self.ffmpeg.remove(&job_id);
        self.jobs.insert(
            job_id,
            YtDlpProgressAdapterV2::new_for_selector(job_id, first_selector),
        );
        self.comparisons.remove(&job_id);
        !first_selector.contains('+')
    }

    pub(crate) fn begin_download(&mut self, job_id: i64, selector: &str) -> bool {
        let first_selector = selector.split('/').next().unwrap_or_default();
        self.ffmpeg.remove(&job_id);
        self.jobs.insert(
            job_id,
            YtDlpProgressAdapterV2::new_for_selector(job_id, first_selector),
        );
        self.comparisons.remove(&job_id);
        true
    }

    pub(crate) fn observe(
        &mut self,
        job_id: i64,
        raw: YtDlpProgressInput,
        v1: V1ProgressObservation,
    ) -> Option<ProgressComparison> {
        let adapter = self.jobs.get_mut(&job_id)?;
        let snapshot = adapter.accept(&raw)?;
        self.playlists.update_item(job_id, &snapshot, Some(&v1));
        let comparison = compare_v1_v2(job_id, raw, v1, snapshot);
        let samples = self.comparisons.entry(job_id).or_default();
        samples.push_back(comparison.clone());
        while samples.len() > MAX_COMPARISONS_PER_JOB {
            samples.pop_front();
        }
        Some(comparison)
    }

    pub(crate) fn mark_preparing(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_preparing()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_post_processing(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_post_processing()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_finalizing(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_finalizing()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_completed(
        &mut self,
        job_id: i64,
        final_size: u64,
    ) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_completed(final_size)?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_paused(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_paused()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_cancelled(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_cancelled()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn mark_failed(&mut self, job_id: i64) -> Option<ProgressSnapshotV2> {
        let snapshot = self.jobs.get_mut(&job_id)?.mark_failed()?;
        self.playlists.update_item(job_id, &snapshot, None);
        Some(snapshot)
    }

    pub(crate) fn remove(&mut self, job_id: i64) {
        self.jobs.remove(&job_id);
        self.comparisons.remove(&job_id);
        self.http.remove(job_id);
        self.aria2.remove(job_id);
        self.ffmpeg.remove(&job_id);
    }

    pub(crate) fn snapshot(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.jobs
            .get(&job_id)
            .and_then(|adapter| adapter.last_snapshot.clone())
    }

    pub(crate) fn comparisons(&self, job_id: i64) -> Vec<ProgressComparison> {
        self.comparisons
            .get(&job_id)
            .map(|samples| samples.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn playlist_snapshot(&self, batch_id: i64) -> Option<ProgressSnapshotV2> {
        self.playlists.snapshot(batch_id)
    }

    pub(crate) fn playlist_for_job(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.playlists
            .batch_for_job(job_id)
            .and_then(|batch_id| self.playlists.snapshot(batch_id))
    }

    pub(crate) fn playlist_comparisons(&self, batch_id: i64) -> Vec<PlaylistComparison> {
        self.playlists.comparisons(batch_id)
    }
}

static SHADOW_STORE: OnceLock<Mutex<ShadowStoreV2>> = OnceLock::new();

fn global_shadow_store() -> &'static Mutex<ShadowStoreV2> {
    SHADOW_STORE.get_or_init(|| Mutex::new(ShadowStoreV2::default()))
}

pub(crate) fn debug_report(job_id: i64) -> serde_json::Value {
    let Ok(store) = global_shadow_store().lock() else {
        return serde_json::json!({ "jobId": job_id, "error": "shadow_store_unavailable" });
    };
    serde_json::json!({
        "schemaVersion": 1,
        "jobId": job_id,
        "singleStream": {
            "snapshot": store.snapshot(job_id),
            "comparisons": store.comparisons(job_id),
        },
        "http": {
            "snapshot": store.http_snapshot(job_id),
            "comparisonCount": store.http_comparisons(job_id).len(),
        },
        "aria2": {
            "snapshot": store.aria2_snapshot(job_id),
            "comparisonCount": store.aria2_comparisons(job_id).len(),
        },
        "playlist": {
            "snapshot": store.playlist_for_job(job_id),
            "comparisonCount": store.playlist_comparisons(job_id).len(),
        },
    })
}

fn publish_job(job_id: i64) {
    super::diagnostics::record(
        "adapter_v2",
        Some(job_id),
        "single_stream_or_playlist_snapshot",
    );
    let snapshots = global_shadow_store()
        .lock()
        .ok()
        .map(|store| (store.snapshot(job_id), store.playlist_for_job(job_id)));
    if let Some((Some(snapshot), playlist)) = snapshots {
        super::coordinator::accept(snapshot);
        if let Some(playlist) = playlist {
            super::coordinator::accept_playlist(playlist);
        }
    }
}

fn publish_http(job_id: i64) {
    super::diagnostics::record("adapter_v2", Some(job_id), "http_snapshot");
    if let Some(snapshot) = global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.http_snapshot(job_id))
    {
        super::coordinator::accept(snapshot);
    }
}

fn publish_aria2(job_id: i64) {
    super::diagnostics::record("adapter_v2", Some(job_id), "aria2_snapshot");
    if let Some(snapshot) = global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.aria2_snapshot(job_id))
    {
        super::coordinator::accept(snapshot);
    }
}

fn publish_playlist(batch_id: i64) {
    super::diagnostics::record("adapter_v2", Some(batch_id), "playlist_snapshot");
    if let Some(snapshot) = global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.playlist_snapshot(batch_id))
    {
        super::coordinator::accept_playlist(snapshot);
    }
}

pub(crate) fn shadow_begin_single_stream(job_id: i64, selector: &str) -> bool {
    global_shadow_store()
        .lock()
        .map(|mut store| store.begin_single_stream(job_id, selector))
        .unwrap_or(false)
}

pub(crate) fn shadow_begin_download(job_id: i64, selector: &str) -> bool {
    global_shadow_store()
        .lock()
        .map(|mut store| store.begin_download(job_id, selector))
        .unwrap_or(false)
}

pub(crate) fn shadow_begin_playlist(batch_id: i64, seeds: Vec<PlaylistItemSeed>) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.begin_playlist(batch_id, seeds);
    }
    publish_playlist(batch_id);
}

pub(crate) fn shadow_begin_http(job_id: i64, reused_bytes: u64) {
    super::coordinator::set_reused_bytes(job_id, reused_bytes);
    if let Ok(mut store) = global_shadow_store().lock() {
        store.begin_http(job_id, reused_bytes);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_begin_aria2(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.begin_aria2(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_observe_aria2(job_id: i64, input: Aria2ProgressInput, v1: Aria2V1Observation) {
    super::diagnostics::record("raw_worker_event", Some(job_id), "aria2");
    if let Ok(mut store) = global_shadow_store().lock() {
        store.observe_aria2(job_id, input, v1);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_paused(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_paused(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_cancelling(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_cancelling(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_cancelled(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_cancelled(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_failed(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_failed(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_finalizing(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_finalizing(job_id);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_aria2_completed(job_id: i64, final_size: u64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_aria2_completed(job_id, final_size);
    }
    publish_aria2(job_id);
}

pub(crate) fn shadow_mark_post_processing_stage(job_id: i64, stage: super::model::ProcessingStage) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_post_processing_stage(job_id, stage);
    }
    publish_job(job_id);
}

pub(crate) fn shadow_begin_ffmpeg(
    job_id: i64,
    stage: super::model::ProcessingStage,
    duration_seconds: Option<f64>,
) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.begin_ffmpeg(job_id, stage, duration_seconds);
    }
    publish_job(job_id);
}

pub(crate) fn shadow_observe_ffmpeg_line(job_id: i64, line: &str) {
    super::diagnostics::record("raw_worker_event", Some(job_id), "ffmpeg");
    if let Ok(mut store) = global_shadow_store().lock() {
        store.observe_ffmpeg_line(job_id, line);
    }
    publish_job(job_id);
}

pub(crate) fn shadow_aria2_snapshot(job_id: i64) -> Option<ProgressSnapshotV2> {
    global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.aria2_snapshot(job_id))
}

pub(crate) fn shadow_aria2_comparisons(job_id: i64) -> Vec<Aria2ProgressComparison> {
    global_shadow_store()
        .lock()
        .map(|store| store.aria2_comparisons(job_id))
        .unwrap_or_default()
}

pub(crate) fn shadow_retry_http(job_id: i64, reused_bytes: u64) {
    super::coordinator::set_reused_bytes(job_id, reused_bytes);
    if let Ok(mut store) = global_shadow_store().lock() {
        store.retry_http(job_id, reused_bytes);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_preparing(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_preparing(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_http_response_headers(
    job_id: i64,
    status_code: u16,
    existing_bytes: u64,
    content_length: Option<u64>,
    content_range: Option<ContentRangeFacts>,
    v1: HttpV1Observation,
) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.http_response_headers(
            job_id,
            status_code,
            existing_bytes,
            content_length,
            content_range,
            v1,
        );
    }
    publish_http(job_id);
}

pub(crate) fn shadow_http_start_stream(
    job_id: i64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    v1: HttpV1Observation,
) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.http_start_stream(job_id, downloaded_bytes, total_bytes, v1);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_http_observe(job_id: i64, downloaded_bytes: u64, v1: HttpV1Observation) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.http_observe(job_id, downloaded_bytes, v1);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_paused(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_paused(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_resumed(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_resumed(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_cancelling(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_cancelling(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_cancelled(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_cancelled(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_failed(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_failed(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_post_processing(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_post_processing(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_finalizing(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_finalizing(job_id);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_mark_http_completed(job_id: i64, final_size: u64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.mark_http_completed(job_id, final_size);
    }
    publish_http(job_id);
}

pub(crate) fn shadow_http_snapshot(job_id: i64) -> Option<ProgressSnapshotV2> {
    global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.http_snapshot(job_id))
}

pub(crate) fn shadow_http_comparisons(job_id: i64) -> Vec<HttpComparison> {
    global_shadow_store()
        .lock()
        .map(|store| store.http_comparisons(job_id))
        .unwrap_or_default()
}

pub(crate) fn shadow_pause_playlist(batch_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.pause_playlist(batch_id);
    }
    publish_playlist(batch_id);
}

pub(crate) fn shadow_resume_playlist(batch_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.resume_playlist(batch_id);
    }
    publish_playlist(batch_id);
}

pub(crate) fn shadow_cancel_playlist(batch_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.cancel_playlist(batch_id);
    }
    publish_playlist(batch_id);
}

pub(crate) fn shadow_retry_playlist(batch_id: i64) {
    coordinator::reset_playlist_progress(batch_id);
    if let Ok(mut store) = global_shadow_store().lock() {
        store.retry_playlist(batch_id);
    }
    publish_playlist(batch_id);
}

pub(crate) fn shadow_mark_preparing(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_preparing(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_observe(
    job_id: i64,
    raw: YtDlpProgressInput,
    v1: V1ProgressObservation,
) -> Option<ProgressComparison> {
    super::diagnostics::record("raw_worker_event", Some(job_id), "yt_dlp");
    let comparison = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.observe(job_id, raw, v1));
    publish_job(job_id);
    comparison
}

pub(crate) fn shadow_mark_post_processing(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_post_processing(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_mark_finalizing(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_finalizing(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_mark_completed(job_id: i64, final_size: u64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_completed(job_id, final_size));
    publish_job(job_id);
}

pub(crate) fn shadow_mark_paused(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_paused(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_mark_cancelled(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_cancelled(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_mark_failed(job_id: i64) {
    let _ = global_shadow_store()
        .lock()
        .ok()
        .and_then(|mut store| store.mark_failed(job_id));
    publish_job(job_id);
}

pub(crate) fn shadow_remove(job_id: i64) {
    if let Ok(mut store) = global_shadow_store().lock() {
        store.remove(job_id);
    }
    super::coordinator::remove(job_id);
}

pub(crate) fn shadow_playlist_snapshot(batch_id: i64) -> Option<ProgressSnapshotV2> {
    global_shadow_store()
        .lock()
        .ok()
        .and_then(|store| store.playlist_snapshot(batch_id))
}

pub(crate) fn shadow_playlist_comparisons(batch_id: i64) -> Vec<PlaylistComparison> {
    global_shadow_store()
        .lock()
        .map(|store| store.playlist_comparisons(batch_id))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::model::ProcessingStage;

    fn exact_input() -> YtDlpProgressInput {
        YtDlpProgressInput {
            stream_id: Some("single-stream".into()),
            downloaded_bytes: Some(10),
            total_bytes: Some(100),
            total_bytes_estimate: None,
            speed_bps: Some(20.0),
            eta_seconds: Some(5),
            percent: Some(10.0),
            format_id: Some("18".to_string()),
            filename: Some("video.mp4.part".to_string()),
            status: Some(YtDlpProgressStatus::Downloading),
            stream_kind: StreamKind::Video,
        }
    }

    fn v1_for(input: &YtDlpProgressInput) -> V1ProgressObservation {
        V1ProgressObservation {
            downloaded_bytes: input.downloaded_bytes.unwrap_or_default(),
            total_bytes: input.total_bytes.or(input.total_bytes_estimate),
            total_estimated: input.total_bytes.is_none(),
            progress_percent: input.percent,
            indeterminate: input.total_bytes.is_none() && input.percent.is_none(),
            speed_bps: input.speed_bps,
            eta_seconds: input.eta_seconds,
        }
    }

    fn adaptive_input(
        stream_id: &str,
        kind: StreamKind,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        total_bytes_estimate: Option<u64>,
        percent: Option<f64>,
        status: YtDlpProgressStatus,
    ) -> YtDlpProgressInput {
        YtDlpProgressInput {
            stream_id: Some(stream_id.into()),
            downloaded_bytes: Some(downloaded_bytes),
            total_bytes,
            total_bytes_estimate,
            speed_bps: Some(10.0),
            eta_seconds: Some(5),
            percent,
            format_id: Some(stream_id.into()),
            filename: Some(format!("{stream_id}.part")),
            status: Some(status),
            stream_kind: kind,
        }
    }

    fn adaptive_adapter() -> YtDlpProgressAdapterV2 {
        YtDlpProgressAdapterV2::new_for_selector(900, "134+140")
    }

    #[test]
    fn dash_exact_video_and_audio_aggregate_exactly() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                80,
                Some(100),
                None,
                Some(80.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let snapshot = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                10,
                Some(20),
                None,
                Some(50.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(snapshot.streams.len(), 2);
        assert_eq!(snapshot.transfer.downloaded_bytes, 90);
        assert_eq!(snapshot.transfer.total_bytes, Some(120));
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Exact);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Exact);
    }

    #[test]
    fn dash_estimated_audio_keeps_global_estimated() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                80,
                Some(100),
                None,
                Some(80.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let snapshot = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                10,
                None,
                Some(20),
                Some(50.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(snapshot.transfer.total_bytes, Some(120));
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Estimated);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Estimated);
    }

    #[test]
    fn dash_unknown_audio_preserves_bytes_and_estimates_by_stage() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                80,
                Some(100),
                None,
                Some(80.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let snapshot = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                10,
                None,
                None,
                None,
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 90);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Estimated);
        assert!(snapshot.transfer.progress.is_some());
    }

    #[test]
    fn audio_start_does_not_reset_completed_video() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let video_done = adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        let audio_started = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                1,
                None,
                None,
                Some(1.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(video_done.transfer.downloaded_bytes, 100);
        assert_eq!(audio_started.transfer.downloaded_bytes, 101);
        assert_eq!(audio_started.phase, JobPhase::Downloading);
        assert!(audio_started.transfer.progress.unwrap_or_default() > 0.0);
    }

    #[test]
    fn adaptive_total_transitions_unknown_estimated_exact() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                80,
                Some(100),
                None,
                Some(80.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let unknown = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                5,
                None,
                None,
                None,
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let estimated = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                10,
                None,
                Some(20),
                Some(50.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let exact = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                10,
                Some(20),
                None,
                Some(50.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(unknown.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(estimated.transfer.total_kind, TotalKind::Estimated);
        assert_eq!(exact.transfer.total_kind, TotalKind::Exact);
    }

    #[test]
    fn estimated_audio_overshoot_keeps_real_bytes_and_valid_progress() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        let snapshot = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                12,
                None,
                Some(10),
                Some(100.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 112);
        assert!(snapshot
            .transfer
            .progress
            .is_some_and(|progress| (0.0..=1.0).contains(&progress)));
    }

    #[test]
    fn unknown_totals_with_percentages_use_estimated_stage_fallback() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                50,
                None,
                None,
                Some(50.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        let snapshot = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                20,
                None,
                None,
                Some(20.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Estimated);
        assert_eq!(snapshot.transfer.progress, Some(0.35));
    }

    #[test]
    fn both_streams_complete_enter_postprocessing_before_completed() {
        let mut adapter = adaptive_adapter();
        for (id, kind, total) in [
            ("134", StreamKind::Video, 100),
            ("140", StreamKind::Audio, 20),
        ] {
            adapter
                .accept(&adaptive_input(
                    id,
                    kind,
                    total,
                    Some(total),
                    None,
                    Some(100.0),
                    YtDlpProgressStatus::Downloading,
                ))
                .unwrap();
        }
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        let post_processing = adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                20,
                Some(20),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        assert_eq!(post_processing.phase, JobPhase::PostProcessing);
        assert_eq!(post_processing.final_size, None);
    }

    #[test]
    fn cancel_during_audio_after_video_completion_wins_over_late_event() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                2,
                None,
                None,
                Some(10.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(adapter.mark_cancelled().unwrap().phase, JobPhase::Cancelled);
        assert!(adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                20,
                Some(20),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .is_none());
    }

    #[test]
    fn audio_failure_after_video_completion_cannot_complete_job() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        adapter
            .accept(&adaptive_input(
                "140",
                StreamKind::Audio,
                2,
                None,
                None,
                Some(10.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(adapter.mark_failed().unwrap().phase, JobPhase::Failed);
        assert_eq!(adapter.mark_completed(120).unwrap().phase, JobPhase::Failed);
    }

    #[test]
    fn retry_after_audio_failure_starts_without_old_streams() {
        let mut adapter = adaptive_adapter();
        adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                100,
                Some(100),
                None,
                Some(100.0),
                YtDlpProgressStatus::Finished,
            ))
            .unwrap();
        adapter.mark_failed();
        adapter.begin_retry().unwrap();
        let retry = adapter
            .accept(&adaptive_input(
                "134",
                StreamKind::Video,
                1,
                Some(100),
                None,
                Some(1.0),
                YtDlpProgressStatus::Downloading,
            ))
            .unwrap();
        assert_eq!(retry.attempt, 1);
        assert_eq!(retry.streams.len(), 1);
        assert_eq!(retry.transfer.downloaded_bytes, 1);
    }

    #[test]
    fn parses_exact_event_with_metadata() {
        let value = serde_json::json!({
            "downloaded_bytes": 10,
            "total_bytes": 100,
            "speed": "20.0",
            "eta": 5,
            "_percent_str": "10.0%",
            "filename": "video.mp4.part",
            "status": "downloading",
            "info_dict": {"format_id": "18", "vcodec": "avc1", "acodec": "mp4a"}
        });
        let input = YtDlpProgressInput::from_json(&value).unwrap();
        assert_eq!(input.total_bytes, Some(100));
        assert_eq!(input.total_bytes_estimate, None);
        assert_eq!(input.percent, Some(10.0));
        assert_eq!(input.stream_kind, StreamKind::Combined);
        assert_eq!(input.format_id.as_deref(), Some("18"));
    }

    #[test]
    fn maps_estimated_total_without_promoting_it() {
        let input = YtDlpProgressInput {
            total_bytes: None,
            total_bytes_estimate: Some(120),
            downloaded_bytes: Some(30),
            percent: Some(25.0),
            ..exact_input()
        };
        let mut adapter = YtDlpProgressAdapterV2::new(1);
        let snapshot = adapter.accept(&input).unwrap();
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Estimated);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Estimated);
    }

    #[test]
    fn percent_only_is_estimated_and_total_unknown() {
        let input = YtDlpProgressInput {
            downloaded_bytes: Some(30),
            total_bytes: None,
            total_bytes_estimate: None,
            percent: Some(43.0),
            ..exact_input()
        };
        let mut adapter = YtDlpProgressAdapterV2::new(2);
        let snapshot = adapter.accept(&input).unwrap();
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Estimated);
        assert_eq!(snapshot.transfer.progress, Some(0.43));
    }

    #[test]
    fn missing_speed_keeps_previous_reported_value() {
        let mut adapter = YtDlpProgressAdapterV2::new(3);
        let first = adapter.accept(&exact_input()).unwrap();
        let second = adapter
            .accept(&YtDlpProgressInput {
                downloaded_bytes: Some(20),
                speed_bps: None,
                ..exact_input()
            })
            .unwrap();
        assert_eq!(first.transfer.speed_bps, Some(20.0));
        assert_eq!(second.transfer.speed_bps, Some(20.0));
        assert_eq!(second.transfer.speed_kind, SpeedKind::Reported);
    }

    #[test]
    fn missing_eta_does_not_invent_one() {
        let mut adapter = YtDlpProgressAdapterV2::new(31);
        let snapshot = adapter
            .accept(&YtDlpProgressInput {
                eta_seconds: None,
                ..exact_input()
            })
            .unwrap();
        assert_eq!(snapshot.transfer.eta_seconds, None);
        assert_eq!(snapshot.transfer.eta_kind, EtaKind::Unavailable);
    }

    #[test]
    fn estimate_exceeded_preserves_downloaded_bytes() {
        let input = YtDlpProgressInput {
            downloaded_bytes: Some(120),
            total_bytes_estimate: Some(100),
            total_bytes: None,
            ..exact_input()
        };
        let mut adapter = YtDlpProgressAdapterV2::new(4);
        let snapshot = adapter.accept(&input).unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 120);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Estimated);
    }

    #[test]
    fn malformed_event_is_ignored_without_panic() {
        assert!(YtDlpProgressInput::from_json(&Value::String("broken".to_string())).is_none());
        assert!(YtDlpProgressInput::from_json(&serde_json::json!({
            "downloaded_bytes": "not-a-number",
            "_percent_str": "not-a-percent",
            "speed": "nan"
        }))
        .is_none());
    }

    #[test]
    fn cancellation_cannot_be_resurrected_by_late_event() {
        let mut adapter = YtDlpProgressAdapterV2::new(5);
        adapter.accept(&exact_input()).unwrap();
        let cancelled = adapter.mark_cancelled().unwrap();
        assert_eq!(cancelled.phase, JobPhase::Cancelled);
        assert!(adapter.accept(&exact_input()).is_none());
    }

    #[test]
    fn transfer_finish_enters_postprocessing_before_completed() {
        let mut adapter = YtDlpProgressAdapterV2::new(32);
        adapter.accept(&exact_input()).unwrap();
        let post_processing = adapter
            .accept(&YtDlpProgressInput {
                status: Some(YtDlpProgressStatus::Finished),
                ..exact_input()
            })
            .unwrap();
        assert_eq!(post_processing.phase, JobPhase::PostProcessing);
        assert_eq!(post_processing.final_size, None);
        let finalizing = adapter.mark_finalizing().unwrap();
        assert_eq!(finalizing.phase, JobPhase::Finalizing);
        let completed = adapter.mark_completed(96).unwrap();
        assert_eq!(completed.phase, JobPhase::Completed);
        assert_eq!(completed.final_size, Some(96));
    }

    #[test]
    fn ffmpeg_progress_keeps_transfer_and_phase_progress_separate() {
        let mut adapter = YtDlpProgressAdapterV2::new(34);
        let transfer = adapter
            .accept(&YtDlpProgressInput {
                downloaded_bytes: Some(110),
                total_bytes: Some(110),
                percent: Some(100.0),
                ..exact_input()
            })
            .unwrap();
        assert_eq!(transfer.transfer.downloaded_bytes, 110);
        adapter.mark_post_processing().unwrap();

        let mut ffmpeg = FfmpegProgressAdapterV2::new(ProcessingStage::Merging, Some(100.0));
        ffmpeg.accept_line("out_time_us=50000000");
        ffmpeg.accept_line("speed=2.0x");
        let merging = adapter
            .observe_ffmpeg_progress(&ffmpeg.accept_line("progress=continue").unwrap())
            .unwrap();
        assert_eq!(merging.phase, JobPhase::PostProcessing);
        assert_eq!(merging.stage, Some(ProcessingStage::Merging));
        assert_eq!(merging.transfer.downloaded_bytes, 110);
        assert_eq!(merging.phase_progress, Some(0.5));
        assert_eq!(merging.phase_progress_kind, ProgressKind::Estimated);
        assert_eq!(merging.final_size, None);

        let ended = adapter
            .observe_ffmpeg_progress(&ffmpeg.accept_line("progress=end").unwrap())
            .unwrap();
        assert_eq!(ended.phase, JobPhase::PostProcessing);
        assert_eq!(ended.phase_progress, Some(1.0));

        assert_eq!(
            adapter.mark_finalizing().unwrap().phase,
            JobPhase::Finalizing
        );
        let completed = adapter.mark_completed(106).unwrap();
        assert_eq!(completed.phase, JobPhase::Completed);
        assert_eq!(completed.transfer.downloaded_bytes, 110);
        assert_eq!(completed.final_size, Some(106));
    }

    #[test]
    fn cancellation_during_ffmpeg_cannot_be_resurrected_by_late_end_event() {
        let mut adapter = YtDlpProgressAdapterV2::new(35);
        adapter.accept(&exact_input()).unwrap();
        adapter.mark_post_processing().unwrap();
        let mut ffmpeg = FfmpegProgressAdapterV2::new(ProcessingStage::Merging, Some(10.0));
        ffmpeg.accept_line("out_time_us=5000000");
        adapter.mark_cancelled().unwrap();

        let late = ffmpeg.accept_line("progress=end").unwrap();
        let snapshot = adapter.observe_ffmpeg_progress(&late).unwrap();
        assert_eq!(snapshot.phase, JobPhase::Cancelled);
        assert_eq!(
            adapter.mark_completed(100).unwrap().phase,
            JobPhase::Cancelled
        );
    }

    #[test]
    fn unknown_event_keeps_bytes_and_marks_progress_unavailable() {
        let input = YtDlpProgressInput {
            downloaded_bytes: Some(30),
            total_bytes: None,
            total_bytes_estimate: None,
            percent: None,
            speed_bps: None,
            eta_seconds: None,
            ..exact_input()
        };
        let mut adapter = YtDlpProgressAdapterV2::new(33);
        let snapshot = adapter.accept(&input).unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 30);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Unavailable);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
    }

    #[test]
    fn pause_resume_keeps_bytes_and_total_kind() {
        let mut adapter = YtDlpProgressAdapterV2::new(6);
        adapter.accept(&exact_input()).unwrap();
        let paused = adapter.mark_paused().unwrap();
        assert_eq!(paused.phase, JobPhase::Paused);
        let resumed = adapter
            .accept(&YtDlpProgressInput {
                status: Some(YtDlpProgressStatus::Downloading),
                downloaded_bytes: Some(12),
                ..exact_input()
            })
            .unwrap();
        assert_eq!(resumed.phase, JobPhase::Downloading);
        assert_eq!(resumed.transfer.total_kind, TotalKind::Exact);
        assert_eq!(resumed.transfer.downloaded_bytes, 12);
    }

    #[test]
    fn retry_starts_a_clean_attempt() {
        let mut adapter = YtDlpProgressAdapterV2::new(7);
        adapter.accept(&exact_input()).unwrap();
        adapter.mark_failed();
        adapter.begin_retry().unwrap();
        let snapshot = adapter.accept(&exact_input()).unwrap();
        assert_eq!(snapshot.attempt, 1);
        assert_eq!(snapshot.transfer.downloaded_bytes, 10);
    }

    #[test]
    fn shadow_comparator_classifies_expected_percent_divergence() {
        let input = YtDlpProgressInput {
            downloaded_bytes: Some(30),
            total_bytes: None,
            total_bytes_estimate: None,
            percent: Some(47.0),
            ..exact_input()
        };
        let mut adapter = YtDlpProgressAdapterV2::new(8);
        let snapshot = adapter.accept(&input).unwrap();
        let v1 = V1ProgressObservation {
            downloaded_bytes: 30,
            total_bytes: None,
            total_estimated: false,
            progress_percent: Some(47.0),
            indeterminate: true,
            speed_bps: None,
            eta_seconds: None,
        };
        let comparison = compare_v1_v2(8, input, v1, snapshot);
        assert_eq!(
            comparison.divergence,
            ProgressDivergence::ExpectedPercentWithoutTotal
        );
    }

    #[test]
    fn shadow_comparator_detects_v1_transfer_complete_before_finalization() {
        let mut adapter = YtDlpProgressAdapterV2::new(36);
        adapter.accept(&exact_input()).unwrap();
        let finished = adapter
            .accept(&YtDlpProgressInput {
                status: Some(YtDlpProgressStatus::Finished),
                percent: Some(100.0),
                ..exact_input()
            })
            .unwrap();
        let input = YtDlpProgressInput {
            percent: Some(100.0),
            status: Some(YtDlpProgressStatus::Finished),
            ..exact_input()
        };
        let v1 = V1ProgressObservation {
            downloaded_bytes: 10,
            total_bytes: Some(10),
            total_estimated: false,
            progress_percent: Some(100.0),
            indeterminate: false,
            speed_bps: None,
            eta_seconds: None,
        };
        let comparison = compare_v1_v2(36, input, v1, finished);
        assert_eq!(
            comparison.divergence,
            ProgressDivergence::V1TransferCompleteDuringPostProcessing
        );
    }

    #[test]
    fn shadow_store_is_bounded_and_cleans_up() {
        let mut store = ShadowStoreV2::default();
        assert!(store.begin_single_stream(9, "18"));
        for _ in 0..(MAX_COMPARISONS_PER_JOB + 10) {
            let input = exact_input();
            store.observe(9, input.clone(), v1_for(&input));
        }
        assert_eq!(store.comparisons(9).len(), MAX_COMPARISONS_PER_JOB);
        assert!(store.snapshot(9).is_some());
        store.remove(9);
        assert!(store.snapshot(9).is_none());
        assert!(store.comparisons(9).is_empty());
    }
}
