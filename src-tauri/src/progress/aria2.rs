use super::model::{
    EtaKind, JobPhase, ProcessingStage, ProgressSnapshotV2, SpeedKind, TotalKind, TransferProgress,
};
use super::state_machine::JobStateMachine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_COMPARISONS_PER_JOB: usize = 64;
const MAX_ARIA2_JOBS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Aria2Status {
    Waiting,
    Active,
    Paused,
    Complete,
    Error,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Aria2FileProgressInput {
    pub(crate) index: u32,
    pub(crate) path: String,
    pub(crate) selected: bool,
    pub(crate) completed_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Aria2ProgressInput {
    pub(crate) gid: Option<String>,
    pub(crate) status: Aria2Status,
    pub(crate) total_length: Option<u64>,
    pub(crate) completed_length: u64,
    pub(crate) download_speed_bps: Option<f64>,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) metadata_ready: bool,
    pub(crate) files: Vec<Aria2FileProgressInput>,
    pub(crate) error_code: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) seeding: bool,
}

impl Aria2ProgressInput {
    /// Parses the console readout already emitted by the productive aria2c
    /// worker. This is intentionally not a second process or a JSON-RPC path.
    pub(crate) fn from_console_line(line: &str) -> Option<Self> {
        let start = line.rfind("[#")?;
        let end = line[start..].find(']')? + start;
        let body = &line[start + 1..end];
        let mut gid = None;
        let mut total_length = None;
        let mut completed_length = None;
        let mut download_speed_bps = None;
        let mut eta_seconds = None;

        for token in body.split_whitespace() {
            if let Some(value) = token.strip_prefix('#') {
                gid = (!value.is_empty()).then(|| value.to_string());
            }
            let size_token = token.strip_prefix("SIZE:").unwrap_or(token);
            if let Some((completed, total_with_percent)) = size_token.split_once('/') {
                completed_length = parse_byte_value(completed);
                let total = total_with_percent
                    .split('(')
                    .next()
                    .unwrap_or(total_with_percent);
                total_length = parse_byte_value(total).filter(|value| *value > 0);
            }
            if let Some(speed) = token.strip_prefix("DL:").and_then(parse_byte_value) {
                download_speed_bps = Some(speed as f64);
            }
            if let Some(eta) = token.strip_prefix("ETA:").and_then(parse_eta) {
                eta_seconds = Some(eta);
            }
        }

        let completed_length = completed_length?;
        Some(Self {
            gid,
            status: Aria2Status::Active,
            total_length,
            completed_length,
            download_speed_bps,
            eta_seconds,
            metadata_ready: total_length.is_some(),
            files: Vec::new(),
            error_code: None,
            error_message: None,
            seeding: false,
        })
    }
}

fn parse_byte_value(value: &str) -> Option<u64> {
    let normalized = value.trim().trim_end_matches("/s");
    let units = [
        ("TiB", 1024_f64.powi(4)),
        ("GiB", 1024_f64.powi(3)),
        ("MiB", 1024_f64.powi(2)),
        ("KiB", 1024_f64),
        ("TB", 1000_f64.powi(4)),
        ("GB", 1000_f64.powi(3)),
        ("MB", 1000_f64.powi(2)),
        ("KB", 1000_f64),
        ("B", 1_f64),
    ];
    for (suffix, multiplier) in units {
        let Some(number) = normalized.strip_suffix(suffix) else {
            continue;
        };
        let parsed = number.trim().parse::<f64>().ok()?;
        if !parsed.is_finite() || parsed < 0.0 {
            return None;
        }
        return Some((parsed * multiplier).round().min(u64::MAX as f64) as u64);
    }
    None
}

fn parse_eta(value: &str) -> Option<u64> {
    let mut total = 0_u64;
    let mut current = String::new();
    for character in value.trim().chars() {
        if character.is_ascii_digit() {
            current.push(character);
            continue;
        }
        let amount = current.parse::<u64>().ok()?;
        current.clear();
        total = total.saturating_add(match character {
            'd' => amount.saturating_mul(86_400),
            'h' => amount.saturating_mul(3_600),
            'm' => amount.saturating_mul(60),
            's' => amount,
            _ => return None,
        });
    }
    if !current.is_empty() {
        total = total.saturating_add(current.parse::<u64>().ok()?);
    }
    Some(total)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Aria2V1Observation {
    pub(crate) status: Aria2Status,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) progress_percent: Option<f64>,
    pub(crate) speed_bps: Option<f64>,
    pub(crate) eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Aria2ProgressDivergence {
    None,
    MetadataPending,
    V1UsesFilesystemSize,
    DownloadedRegression,
    TotalMismatch,
    StatusMismatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Aria2ProgressComparison {
    pub(crate) timestamp_ms: u64,
    pub(crate) job_id: i64,
    pub(crate) gid: Option<String>,
    pub(crate) raw: Aria2ProgressInput,
    pub(crate) v1: Aria2V1Observation,
    pub(crate) v2: ProgressSnapshotV2,
    pub(crate) divergence: Aria2ProgressDivergence,
}

#[derive(Debug)]
pub(crate) struct Aria2ProgressAdapterV2 {
    job_id: i64,
    gid: Option<String>,
    machine: JobStateMachine,
    last_transfer: TransferProgress,
    last_snapshot: Option<ProgressSnapshotV2>,
}

impl Aria2ProgressAdapterV2 {
    pub(crate) fn new(job_id: i64) -> Self {
        Self {
            job_id,
            gid: None,
            machine: JobStateMachine::new(),
            last_transfer: TransferProgress::default(),
            last_snapshot: None,
        }
    }

    pub(crate) fn begin_attempt(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_terminal() {
            let _ = self.machine.begin_retry();
        }
        if self.machine.phase() == JobPhase::Queued {
            let _ = self.machine.transition(JobPhase::Preparing);
        } else if self.machine.phase() == JobPhase::Paused {
            let _ = self.machine.transition(JobPhase::Downloading);
        }
        self.snapshot(None)
    }

    pub(crate) fn accept(
        &mut self,
        input: &Aria2ProgressInput,
        v1: Aria2V1Observation,
    ) -> Option<Aria2ProgressComparison> {
        if self.machine.phase().is_terminal()
            && !matches!(input.status, Aria2Status::Error | Aria2Status::Removed)
        {
            return None;
        }
        if input.gid.is_some() {
            self.gid = input.gid.clone();
        }
        let (downloaded_bytes, total_bytes) = selected_totals(input);
        let transfer = transfer_from_input(input, downloaded_bytes, total_bytes);
        self.last_transfer = transfer.clone();
        match input.status {
            Aria2Status::Waiting => self.ensure_preparing(),
            Aria2Status::Active => {
                if input.metadata_ready && total_bytes.is_some() {
                    self.ensure_downloading();
                } else {
                    self.ensure_preparing();
                }
            }
            Aria2Status::Paused => self.ensure_paused(),
            Aria2Status::Complete => self.mark_transfer_complete(),
            Aria2Status::Error => {
                let _ = self.mark_failed();
            }
            Aria2Status::Removed => {
                let _ = self.mark_cancelled();
            }
        }
        let snapshot = self.snapshot(None)?;
        let divergence = compare_v1_v2(&v1, &snapshot);
        Some(Aria2ProgressComparison {
            timestamp_ms: now_ms(),
            job_id: self.job_id,
            gid: self.gid.clone(),
            raw: input.clone(),
            v1,
            v2: snapshot,
            divergence,
        })
    }

    pub(crate) fn mark_paused(&mut self) -> Option<ProgressSnapshotV2> {
        self.ensure_paused();
        self.last_transfer.speed_bps = Some(0.0);
        self.last_transfer.speed_kind = SpeedKind::Reported;
        self.last_transfer.eta_seconds = None;
        self.last_transfer.eta_kind = EtaKind::Unavailable;
        self.snapshot(None)
    }

    pub(crate) fn mark_cancelling(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_active() {
            let _ = self.machine.cancel();
        }
        self.snapshot(None)
    }

    pub(crate) fn mark_cancelled(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() != JobPhase::Cancelling {
            self.mark_cancelling()?;
        }
        let _ = self.machine.process_terminated();
        self.snapshot(None)
    }

    pub(crate) fn mark_failed(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Cancelling {
            let _ = self.machine.process_terminated();
            return self.snapshot(None);
        }
        if !self.machine.phase().is_terminal() {
            let _ = self.machine.transition(JobPhase::Failed);
        }
        self.last_transfer.speed_bps = Some(0.0);
        self.last_transfer.speed_kind = SpeedKind::Reported;
        self.last_transfer.eta_seconds = None;
        self.last_transfer.eta_kind = EtaKind::Unavailable;
        self.snapshot(None)
    }

    pub(crate) fn mark_finalizing(&mut self) -> Option<ProgressSnapshotV2> {
        self.mark_transfer_complete();
        self.snapshot(None)
    }

    pub(crate) fn mark_completed(&mut self, final_size: u64) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Downloading {
            self.mark_transfer_complete();
        }
        if self.machine.phase() == JobPhase::Finalizing {
            let _ = self.machine.transition(JobPhase::Completed);
        }
        self.snapshot(Some(final_size))
    }

    pub(crate) fn snapshot(&mut self, final_size: Option<u64>) -> Option<ProgressSnapshotV2> {
        let mut snapshot = ProgressSnapshotV2::new(
            self.job_id as u64,
            self.machine.phase(),
            self.last_transfer.clone(),
        );
        snapshot.attempt = self.machine.attempt();
        snapshot.stage = match snapshot.phase {
            JobPhase::Preparing => None,
            JobPhase::PostProcessing => Some(ProcessingStage::Verifying),
            JobPhase::Finalizing | JobPhase::Completed => Some(ProcessingStage::Verifying),
            _ => None,
        };
        snapshot.final_size = final_size;
        if snapshot.validate().is_err() {
            return self.last_snapshot.clone();
        }
        self.last_snapshot = Some(snapshot.clone());
        Some(snapshot)
    }

    fn ensure_preparing(&mut self) {
        match self.machine.phase() {
            JobPhase::Queued => {
                let _ = self.machine.transition(JobPhase::Preparing);
            }
            JobPhase::Paused => {
                let _ = self.machine.transition(JobPhase::Downloading);
                let _ = self.machine.transition(JobPhase::Paused);
            }
            _ => {}
        }
    }

    fn ensure_downloading(&mut self) {
        if self.machine.phase() == JobPhase::Queued {
            let _ = self.machine.transition(JobPhase::Preparing);
        }
        if matches!(self.machine.phase(), JobPhase::Preparing | JobPhase::Paused) {
            let _ = self.machine.transition(JobPhase::Downloading);
        }
    }

    fn ensure_paused(&mut self) {
        if self.machine.phase() == JobPhase::Queued {
            let _ = self.machine.transition(JobPhase::Preparing);
        }
        if matches!(
            self.machine.phase(),
            JobPhase::Preparing | JobPhase::Downloading
        ) {
            let _ = self.machine.transition(JobPhase::Paused);
        }
    }

    fn mark_transfer_complete(&mut self) {
        self.ensure_downloading();
        if self.machine.phase() == JobPhase::Downloading {
            let _ = self.machine.transition(JobPhase::PostProcessing);
        }
        if self.machine.phase() == JobPhase::PostProcessing {
            let _ = self.machine.transition(JobPhase::Finalizing);
        }
    }
}

fn selected_totals(input: &Aria2ProgressInput) -> (u64, Option<u64>) {
    let selected: Vec<_> = input.files.iter().filter(|file| file.selected).collect();
    if selected.is_empty() {
        return (
            input.completed_length,
            input.total_length.filter(|total| *total > 0),
        );
    }
    let completed = selected
        .iter()
        .fold(0_u64, |sum, file| sum.saturating_add(file.completed_bytes));
    let total = selected
        .iter()
        .map(|file| file.total_bytes.filter(|value| *value > 0))
        .collect::<Option<Vec<_>>>()
        .map(|values| values.into_iter().fold(0_u64, u64::saturating_add))
        .filter(|value| *value > 0);
    (completed, total)
}

fn transfer_from_input(
    input: &Aria2ProgressInput,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) -> TransferProgress {
    let mut transfer = match total_bytes {
        Some(total) => {
            TransferProgress::with_total(downloaded_bytes.min(total), Some(total), TotalKind::Exact)
        }
        None => TransferProgress::unknown(downloaded_bytes),
    };
    if let Some(speed) = input.download_speed_bps.filter(|value| value.is_finite()) {
        transfer = transfer.with_speed(speed.max(0.0), SpeedKind::Reported);
        if let Some(eta) = input.eta_seconds {
            transfer = transfer.with_eta(eta, EtaKind::Reported);
        } else if let Some(total) = total_bytes.filter(|value| *value > downloaded_bytes) {
            if speed > 0.0 {
                transfer = transfer.with_eta(
                    ((total - downloaded_bytes) as f64 / speed).ceil() as u64,
                    EtaKind::Estimated,
                );
            }
        }
    }
    transfer
}

fn compare_v1_v2(v1: &Aria2V1Observation, v2: &ProgressSnapshotV2) -> Aria2ProgressDivergence {
    if v1.status == Aria2Status::Active
        && v1.total_bytes.is_none()
        && v2.phase == JobPhase::Preparing
        && v2.transfer.total_kind == TotalKind::Unknown
    {
        return Aria2ProgressDivergence::MetadataPending;
    }
    if v2.transfer.downloaded_bytes < v1.downloaded_bytes {
        return Aria2ProgressDivergence::DownloadedRegression;
    }
    if v1.total_bytes != v2.transfer.total_bytes {
        return Aria2ProgressDivergence::TotalMismatch;
    }
    if v1.status == Aria2Status::Active
        && v2.phase != JobPhase::Downloading
        && v2.phase != JobPhase::Preparing
    {
        return Aria2ProgressDivergence::StatusMismatch;
    }
    Aria2ProgressDivergence::None
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

#[derive(Debug, Default)]
pub(crate) struct Aria2ShadowStore {
    jobs: HashMap<i64, Aria2ProgressAdapterV2>,
    comparisons: HashMap<i64, VecDeque<Aria2ProgressComparison>>,
}

impl Aria2ShadowStore {
    pub(crate) fn begin(&mut self, job_id: i64) {
        if !self.jobs.contains_key(&job_id) && self.jobs.len() >= MAX_ARIA2_JOBS {
            if let Some(oldest) = self.jobs.keys().next().copied() {
                self.jobs.remove(&oldest);
                self.comparisons.remove(&oldest);
            }
        }
        let adapter = self
            .jobs
            .entry(job_id)
            .or_insert_with(|| Aria2ProgressAdapterV2::new(job_id));
        adapter.begin_attempt();
        self.comparisons.entry(job_id).or_default();
    }

    pub(crate) fn observe(
        &mut self,
        job_id: i64,
        input: Aria2ProgressInput,
        v1: Aria2V1Observation,
    ) {
        let Some(adapter) = self.jobs.get_mut(&job_id) else {
            return;
        };
        let Some(comparison) = adapter.accept(&input, v1) else {
            return;
        };
        let samples = self.comparisons.entry(job_id).or_default();
        samples.push_back(comparison);
        while samples.len() > MAX_COMPARISONS_PER_JOB {
            samples.pop_front();
        }
    }

    pub(crate) fn mark_paused(&mut self, job_id: i64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_paused();
        }
    }

    pub(crate) fn mark_cancelling(&mut self, job_id: i64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_cancelling();
        }
    }

    pub(crate) fn mark_cancelled(&mut self, job_id: i64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_cancelled();
        }
    }

    pub(crate) fn mark_failed(&mut self, job_id: i64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_failed();
        }
    }

    pub(crate) fn mark_finalizing(&mut self, job_id: i64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_finalizing();
        }
    }

    pub(crate) fn mark_completed(&mut self, job_id: i64, final_size: u64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            adapter.mark_completed(final_size);
        }
    }

    pub(crate) fn snapshot(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.jobs
            .get(&job_id)
            .and_then(|job| job.last_snapshot.clone())
    }

    pub(crate) fn comparisons(&self, job_id: i64) -> Vec<Aria2ProgressComparison> {
        self.comparisons
            .get(&job_id)
            .map(|samples| samples.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn remove(&mut self, job_id: i64) {
        self.jobs.remove(&job_id);
        self.comparisons.remove(&job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::model::ProgressKind;

    fn active(total: Option<u64>, completed: u64) -> Aria2ProgressInput {
        Aria2ProgressInput {
            gid: Some("abc123".into()),
            status: Aria2Status::Active,
            total_length: total,
            completed_length: completed,
            download_speed_bps: Some(100.0),
            eta_seconds: None,
            metadata_ready: total.is_some(),
            files: Vec::new(),
            error_code: None,
            error_message: None,
            seeding: false,
        }
    }

    fn v1(input: &Aria2ProgressInput) -> Aria2V1Observation {
        Aria2V1Observation {
            status: input.status,
            downloaded_bytes: input.completed_length,
            total_bytes: input.total_length,
            progress_percent: input
                .total_length
                .filter(|total| *total > 0)
                .map(|total| input.completed_length as f64 * 100.0 / total as f64),
            speed_bps: input.download_speed_bps,
            eta_seconds: input.eta_seconds,
        }
    }

    #[test]
    fn parses_real_aria2_console_fields_without_json_rpc() {
        let input = Aria2ProgressInput::from_console_line(
            "[#2089b0 9.5MiB/10MiB(95%) CN:8 DL:2MiB ETA:1s]",
        )
        .expect("aria2 line");
        assert_eq!(input.gid.as_deref(), Some("2089b0"));
        assert_eq!(input.completed_length, 9_961_472);
        assert_eq!(input.total_length, Some(10_485_760));
        assert_eq!(input.download_speed_bps, Some(2.0 * 1024.0 * 1024.0));
        assert_eq!(input.eta_seconds, Some(1));
    }

    #[test]
    fn magnet_without_metadata_is_preparing_and_unknown() {
        let mut adapter = Aria2ProgressAdapterV2::new(7);
        adapter.begin_attempt();
        let input = active(None, 0);
        adapter.accept(&input, v1(&input));
        let snapshot = adapter.last_snapshot.expect("snapshot");
        assert_eq!(snapshot.phase, JobPhase::Preparing);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Unavailable);
        assert_eq!(snapshot.transfer.progress, None);
    }

    #[test]
    fn metadata_appears_without_replacing_job_or_resetting_attempt() {
        let mut adapter = Aria2ProgressAdapterV2::new(8);
        adapter.begin_attempt();
        let unknown = active(None, 0);
        adapter.accept(&unknown, v1(&unknown));
        let known = active(Some(3_500), 800);
        adapter.accept(&known, v1(&known));
        let snapshot = adapter.last_snapshot.expect("snapshot");
        assert_eq!(snapshot.job_id, 8);
        assert_eq!(snapshot.phase, JobPhase::Downloading);
        assert_eq!(snapshot.attempt, 0);
        assert_eq!(snapshot.transfer.downloaded_bytes, 800);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Exact);
    }

    #[test]
    fn selected_multi_file_total_excludes_unselected_files() {
        let input = Aria2ProgressInput {
            files: vec![
                Aria2FileProgressInput {
                    index: 1,
                    path: "a.bin".into(),
                    selected: true,
                    completed_bytes: 100,
                    total_bytes: Some(1_000),
                },
                Aria2FileProgressInput {
                    index: 2,
                    path: "b.bin".into(),
                    selected: false,
                    completed_bytes: 2_000,
                    total_bytes: Some(2_000),
                },
                Aria2FileProgressInput {
                    index: 3,
                    path: "c.bin".into(),
                    selected: true,
                    completed_bytes: 50,
                    total_bytes: Some(500),
                },
            ],
            ..active(Some(3_500), 2_150)
        };
        assert_eq!(selected_totals(&input), (150, Some(1_500)));
    }

    #[test]
    fn resume_starts_with_existing_aria2_bytes() {
        let mut adapter = Aria2ProgressAdapterV2::new(9);
        adapter.begin_attempt();
        let input = active(Some(1_000), 400);
        adapter.accept(&input, v1(&input));
        assert_eq!(
            adapter.last_snapshot.unwrap().transfer.downloaded_bytes,
            400
        );
    }

    #[test]
    fn retry_increments_attempt_without_changing_job_identity() {
        let mut adapter = Aria2ProgressAdapterV2::new(91);
        adapter.begin_attempt();
        adapter.mark_failed();
        adapter.begin_attempt();
        let snapshot = adapter.last_snapshot.expect("retry snapshot");
        assert_eq!(snapshot.job_id, 91);
        assert_eq!(snapshot.attempt, 1);
        assert_eq!(snapshot.phase, JobPhase::Preparing);
    }

    #[test]
    fn pause_resume_keeps_bytes_and_clears_stale_eta() {
        let mut adapter = Aria2ProgressAdapterV2::new(10);
        adapter.begin_attempt();
        let input = active(Some(1_000), 400);
        adapter.accept(&input, v1(&input));
        adapter.mark_paused();
        let paused = adapter.last_snapshot.clone().expect("paused");
        assert_eq!(paused.phase, JobPhase::Paused);
        assert_eq!(paused.transfer.downloaded_bytes, 400);
        assert_eq!(paused.transfer.eta_seconds, None);
        let resumed = active(Some(1_000), 400);
        adapter.accept(&resumed, v1(&resumed));
        assert_eq!(adapter.last_snapshot.unwrap().phase, JobPhase::Downloading);
    }

    #[test]
    fn cancellation_cannot_be_resurrected_by_late_aria2_event() {
        let mut adapter = Aria2ProgressAdapterV2::new(11);
        adapter.begin_attempt();
        let input = active(Some(1_000), 400);
        adapter.accept(&input, v1(&input));
        adapter.mark_cancelling();
        adapter.mark_cancelled();
        adapter.accept(&active(Some(1_000), 900), v1(&active(Some(1_000), 900)));
        assert_eq!(adapter.last_snapshot.unwrap().phase, JobPhase::Cancelled);
    }

    #[test]
    fn finalization_precedes_completed_and_final_size_is_external() {
        let mut adapter = Aria2ProgressAdapterV2::new(12);
        adapter.begin_attempt();
        let input = active(Some(1_000), 1_000);
        adapter.accept(&input, v1(&input));
        adapter.mark_finalizing();
        assert_eq!(
            adapter.last_snapshot.as_ref().unwrap().phase,
            JobPhase::Finalizing
        );
        adapter.mark_completed(990);
        let completed = adapter.last_snapshot.unwrap();
        assert_eq!(completed.phase, JobPhase::Completed);
        assert_eq!(completed.final_size, Some(990));
        assert!(completed.transfer.progress.unwrap() >= 0.99);
        assert!(completed.validate().is_ok());
    }

    #[test]
    fn seeding_does_not_exceed_download_progress() {
        let mut adapter = Aria2ProgressAdapterV2::new(121);
        adapter.begin_attempt();
        let mut input = active(Some(1_000), 1_000);
        input.seeding = true;
        adapter.accept(&input, v1(&input));
        let snapshot = adapter.last_snapshot.expect("seeding snapshot");
        assert_eq!(snapshot.transfer.progress, Some(1.0));
        assert!(snapshot.transfer.progress.unwrap() <= 1.0);
    }

    #[test]
    fn failed_and_removed_are_terminal() {
        let mut failed = Aria2ProgressAdapterV2::new(13);
        failed.begin_attempt();
        failed.mark_failed();
        assert_eq!(failed.last_snapshot.unwrap().phase, JobPhase::Failed);

        let mut removed = Aria2ProgressAdapterV2::new(14);
        removed.begin_attempt();
        removed.mark_cancelled();
        assert_eq!(removed.last_snapshot.unwrap().phase, JobPhase::Cancelled);
    }

    #[test]
    fn shadow_store_is_bounded_and_comparisons_are_bounded() {
        let mut store = Aria2ShadowStore::default();
        for job_id in 0..(MAX_ARIA2_JOBS as i64 + 2) {
            store.begin(job_id);
        }
        assert!(store.jobs.len() <= MAX_ARIA2_JOBS);
        store.begin(99);
        for completed in 0..(MAX_COMPARISONS_PER_JOB as u64 + 3) {
            let input = active(Some(100), completed.min(100));
            store.observe(99, input.clone(), v1(&input));
        }
        assert_eq!(store.comparisons(99).len(), MAX_COMPARISONS_PER_JOB);
    }
}
