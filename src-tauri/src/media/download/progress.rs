use std::collections::HashMap;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::progress::adapter::{
    shadow_mark_finalizing, shadow_mark_post_processing_stage, shadow_observe,
    shadow_observe_ffmpeg_line, stream_kind_from_codecs, V1ProgressObservation, YtDlpProgressInput,
};
use crate::progress::ffmpeg::{processing_stage_from_state, processing_stage_from_ytdlp_line};
use crate::{
    human_bytes, json_number_as_f64, json_number_as_u64, stabilize_reported_speed,
    ProgressPersistenceGate,
};

use super::super::parse_positive_u64;

pub(crate) fn format_id_from_media_path(path: &str) -> Option<String> {
    let marker = path.rfind(".f")?;
    let suffix = &path[marker + 2..];
    let format_id = suffix.split('.').next()?.trim();
    (!format_id.is_empty()).then_some(format_id.to_string())
}

#[derive(Debug, Default)]
pub(crate) struct MediaStreamProgress {
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_estimated: bool,
    pub(crate) reported_percent: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PlannedMediaStream {
    pub(crate) kind: crate::progress::model::StreamKind,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_estimated: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RequestedMediaPlan {
    pub(crate) stream_count: usize,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_estimated: bool,
}

#[derive(Debug)]
pub(crate) struct MediaProgressTracker {
    pub(crate) streams: HashMap<String, MediaStreamProgress>,
    pub(crate) planned_streams: HashMap<String, PlannedMediaStream>,
    pub(crate) expected_streams: usize,
    pub(crate) declared_total_bytes: Option<u64>,
    pub(crate) declared_total_estimated: bool,
    pub(crate) last_downloaded_bytes: u64,
    pub(crate) persistence_gate: ProgressPersistenceGate,
}

impl MediaProgressTracker {
    pub(crate) fn new(format_selector: &str) -> Self {
        let expected_streams = format_selector
            .split('/')
            .next()
            .map(|selected| selected.matches('+').count() + 1)
            .unwrap_or(1)
            .max(1);
        Self {
            streams: HashMap::new(),
            planned_streams: HashMap::new(),
            // This is only a provisional count. As soon as yt-dlp reports the
            // actual requested_downloads/requested_formats plan it replaces it,
            // including when a combined fallback was selected.
            expected_streams,
            declared_total_bytes: None,
            declared_total_estimated: false,
            last_downloaded_bytes: 0,
            persistence_gate: ProgressPersistenceGate::new(),
        }
    }

    pub(crate) fn apply_stream_plan(&mut self, payload: &str) {
        let values = payload.split('|').collect::<Vec<_>>();
        let mut planned = HashMap::new();
        for chunk in values.chunks(5) {
            let Some(format_id) = chunk
                .first()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("NA"))
            else {
                continue;
            };
            let vcodec = chunk.get(1).copied().unwrap_or_default().trim();
            let acodec = chunk.get(2).copied().unwrap_or_default().trim();
            let exact = chunk.get(3).and_then(|value| parse_positive_u64(value));
            let approximate = chunk.get(4).and_then(|value| parse_positive_u64(value));
            planned.insert(
                format_id.to_string(),
                PlannedMediaStream {
                    kind: stream_kind_from_codecs(vcodec, acodec),
                    total_bytes: exact.or(approximate),
                    total_estimated: exact.is_none() && approximate.is_some(),
                },
            );
        }
        if !planned.is_empty() {
            self.expected_streams = planned.len().max(1);
            let total = planned
                .values()
                .map(|stream| stream.total_bytes)
                .collect::<Option<Vec<_>>>()
                .and_then(|sizes| (!sizes.is_empty()).then_some(sizes.into_iter().sum::<u64>()));
            self.declared_total_bytes = total;
            self.declared_total_estimated = planned.values().any(|stream| stream.total_estimated);
            self.planned_streams = planned;
        }
    }

    pub(crate) fn update_from_json(&mut self, progress: &Value) -> MediaProgressUpdate {
        let mut raw_input = YtDlpProgressInput::from_json(progress);
        if let Some(plan) = requested_media_plan(progress) {
            self.expected_streams = plan.stream_count.max(1);
            if let Some(total) = plan.total_bytes {
                self.declared_total_bytes = Some(total);
                self.declared_total_estimated = plan.total_estimated;
            }
        }

        let stream_key = media_progress_stream_key(progress);
        let filename_format_id = format_id_from_media_path(&stream_key);
        if let Some(raw) = raw_input.as_mut() {
            raw.stream_id = Some(stream_key.clone());
            if raw.format_id.is_none() {
                raw.format_id = filename_format_id.clone();
            }
            if let Some(format_id) = raw.format_id.as_ref() {
                if let Some(planned) = self.planned_streams.get(format_id) {
                    raw.stream_kind = planned.kind;
                    if raw.total_bytes.is_none() && raw.total_bytes_estimate.is_none() {
                        if planned.total_estimated {
                            raw.total_bytes_estimate = planned.total_bytes;
                        } else {
                            raw.total_bytes = planned.total_bytes;
                        }
                    }
                }
            }
        }
        let downloaded = json_number_as_u64(progress.get("downloaded_bytes")).unwrap_or(0);
        let exact_total = json_number_as_u64(progress.get("total_bytes"));
        let estimated_total = json_number_as_u64(progress.get("total_bytes_estimate"));
        let total = exact_total.or(estimated_total);
        let stream = self.streams.entry(stream_key).or_default();
        stream.downloaded_bytes = stream.downloaded_bytes.max(downloaded);
        if let Some(percent) = progress_percent_from_ytdlp(progress) {
            stream.reported_percent = Some(percent);
        }
        if let Some(total) = total.filter(|value| *value > 0) {
            // An exact total always replaces an older estimate for this stream.
            if exact_total.is_some() || stream.total_bytes.is_none() || stream.total_estimated {
                stream.total_bytes = Some(total);
                stream.total_estimated = exact_total.is_none();
            } else if let Some(previous) = stream.total_bytes {
                stream.total_bytes = Some(previous.max(total));
            }
        }

        let aggregate_downloaded = self
            .streams
            .values()
            .map(|stream| stream.downloaded_bytes)
            .sum::<u64>()
            .max(self.last_downloaded_bytes);
        self.last_downloaded_bytes = aggregate_downloaded;

        let known_totals_complete = self.streams.len() >= self.expected_streams
            && self
                .streams
                .values()
                .all(|stream| stream.total_bytes.is_some());
        let actual_totals_complete =
            known_totals_complete && self.streams.values().all(|stream| !stream.total_estimated);
        let (aggregate_total, total_estimated) = if actual_totals_complete {
            // Actual transfer totals are more trustworthy than yt-dlp's
            // filesize_approx metadata and must replace it as soon as available.
            (
                Some(
                    self.streams
                        .values()
                        .filter_map(|stream| stream.total_bytes)
                        .sum::<u64>()
                        .max(aggregate_downloaded),
                ),
                false,
            )
        } else if known_totals_complete {
            // A complete set that contains one or more estimates is useful to
            // the UI, but it must remain explicitly approximate. It is never
            // used as an exact denominator by the backend snapshot.
            (
                Some(
                    self.streams
                        .values()
                        .filter_map(|stream| stream.total_bytes)
                        .sum::<u64>()
                        .max(aggregate_downloaded),
                ),
                true,
            )
        } else if let Some(total) = self
            .declared_total_bytes
            .filter(|_| self.declared_total_estimated)
        {
            // A single legitimate estimate can still communicate useful
            // context. Keep the flag so consumers render it with '~'.
            (Some(total.max(aggregate_downloaded)), true)
        } else if let Some(total) = self
            .declared_total_bytes
            .filter(|_| !self.declared_total_estimated)
        {
            (Some(total.max(aggregate_downloaded)), false)
        } else {
            (None, false)
        };

        let measured_percent = if self
            .streams
            .values()
            .any(|stream| stream.reported_percent.is_some())
        {
            let divisor = self.expected_streams.max(self.streams.len()).max(1) as f64;
            Some(
                (self
                    .streams
                    .values()
                    .filter_map(|stream| stream.reported_percent)
                    .sum::<f64>()
                    / divisor)
                    .clamp(0.0, 99.4),
            )
        } else {
            None
        };
        let progress_percent = aggregate_total
            .filter(|total| *total > 0)
            .map(|total| aggregate_downloaded as f64 * 100.0 / total as f64)
            .map(|percent| percent.clamp(0.0, 99.4))
            .or(measured_percent);

        MediaProgressUpdate {
            downloaded_bytes: aggregate_downloaded,
            total_bytes: aggregate_total,
            total_estimated,
            progress_percent,
            speed_bps: json_number_as_f64(progress.get("speed")).unwrap_or(0.0),
            eta_seconds: json_number_as_u64(progress.get("eta")),
            format_id: progress
                .get("format_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    progress
                        .get("info_dict")
                        .and_then(|info| info.get("format_id"))
                        .and_then(Value::as_str)
                })
                .map(ToOwned::to_owned),
            filename: progress
                .get("filename")
                .and_then(Value::as_str)
                .or_else(|| progress.get("tmpfilename").and_then(Value::as_str))
                .map(ToOwned::to_owned),
            raw_input,
        }
    }
}

#[derive(Debug)]
pub(crate) struct MediaProgressUpdate {
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_estimated: bool,
    pub(crate) progress_percent: Option<f64>,
    pub(crate) speed_bps: f64,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) format_id: Option<String>,
    pub(crate) filename: Option<String>,
    pub(crate) raw_input: Option<YtDlpProgressInput>,
}

pub(crate) fn progress_percent_from_ytdlp(progress: &Value) -> Option<f64> {
    progress
        .get("_percent_str")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.trim_end_matches('%').trim())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.clamp(0.0, 99.4))
}

pub(crate) fn requested_media_plan(progress: &Value) -> Option<RequestedMediaPlan> {
    let info = progress.get("info_dict")?;
    let downloads = info
        .get("requested_downloads")
        .or_else(|| info.get("requested_formats"))?
        .as_array()?;
    if downloads.is_empty() {
        return None;
    }

    let mut total = 0_u64;
    let mut total_complete = true;
    let mut estimated = false;
    for download in downloads {
        if let Some(size) = json_number_as_u64(download.get("filesize")).filter(|size| *size > 0) {
            total = total.saturating_add(size);
        } else if let Some(size) =
            json_number_as_u64(download.get("filesize_approx")).filter(|size| *size > 0)
        {
            total = total.saturating_add(size);
            estimated = true;
        } else {
            total_complete = false;
        }
    }

    Some(RequestedMediaPlan {
        stream_count: downloads.len(),
        total_bytes: (total_complete && total > 0).then_some(total),
        total_estimated: estimated,
    })
}

pub(crate) fn media_progress_stream_key(progress: &Value) -> String {
    // `filename` is stable across the transfer. yt-dlp may expose only
    // `tmpfilename` while downloading and only `filename` on the final event;
    // preferring the stable path prevents one stream from becoming two IDs.
    for key in ["filename", "tmpfilename"] {
        if let Some(value) = progress.get(key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return value.to_string();
            }
        }
    }
    if let Some(info) = progress.get("info_dict") {
        for key in ["format_id", "format", "ext"] {
            if let Some(value) = info.get(key).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    return format!("{key}:{value}");
                }
            }
        }
    }
    "media-stream".to_string()
}

pub(crate) fn set_media_processing_stage(
    connection: &Connection,
    id: i64,
    state: &str,
    detail: &str,
) {
    if state == "finalizing" {
        shadow_mark_finalizing(id);
    } else if let Some(stage) = processing_stage_from_state(state) {
        shadow_mark_post_processing_stage(id, stage);
    }
    let _ = connection.execute(
        "UPDATE jobs SET detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='running'",
        params![detail, id],
    );
    let _ = connection.execute(
        "UPDATE media_jobs SET resolution_state=?1,speed_bps=0,eta_seconds=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2 AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='running')",
        params![state, id],
    );
    let _ = connection.execute(
        "UPDATE playlist_items SET status='running' WHERE job_id=?1 AND EXISTS (SELECT 1 FROM jobs WHERE id=?1 AND status='running') AND status NOT IN ('cancelled','completed')",
        params![id],
    );
}

pub(crate) fn ensure_media_job_running(connection: &Connection, id: i64) -> Result<(), String> {
    let status: String = connection
        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if status == "running" {
        Ok(())
    } else {
        Err("media_job_stopped".into())
    }
}

pub(crate) fn update_media_progress(
    connection: &Connection,
    id: i64,
    line: &str,
    tracker: &mut MediaProgressTracker,
    persist_transfer: bool,
) -> bool {
    if line.starts_with("out_time") || line.starts_with("progress=") {
        shadow_observe_ffmpeg_line(id, line);
    }
    if connection
        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
            row.get::<_, String>(0)
        })
        .map(|status| status != "running")
        .unwrap_or(true)
    {
        return false;
    }
    let parsed = line
        .strip_prefix("CACATOOLS_PROGRESS:")
        .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
        .map(|progress| tracker.update_from_json(&progress))
        .or_else(|| {
            line.strip_prefix("CACATOOLS_PROGRESS|").map(|payload| {
                let values = payload.split('|').collect::<Vec<_>>();
                let downloaded_bytes = values
                    .get(3)
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .unwrap_or(0);
                let total_bytes = values
                    .get(4)
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .filter(|value| *value > 0);
                MediaProgressUpdate {
                    downloaded_bytes,
                    total_bytes,
                    total_estimated: false,
                    progress_percent: total_bytes.map(|total| {
                        (downloaded_bytes as f64 * 100.0 / total as f64).clamp(0.0, 99.4)
                    }),
                    speed_bps: values
                        .get(5)
                        .and_then(|value| value.trim().parse::<f64>().ok())
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .unwrap_or(0.0),
                    eta_seconds: values
                        .get(6)
                        .and_then(|value| value.trim().parse::<u64>().ok()),
                    format_id: None,
                    filename: None,
                    raw_input: None,
                }
            })
        });

    if let Some(update) = parsed {
        if tracker.expected_streams >= 1 {
            let raw = update
                .raw_input
                .clone()
                .unwrap_or_else(|| YtDlpProgressInput {
                    stream_id: update.filename.clone().or_else(|| update.format_id.clone()),
                    downloaded_bytes: Some(update.downloaded_bytes),
                    total_bytes: (!update.total_estimated)
                        .then_some(update.total_bytes)
                        .flatten(),
                    total_bytes_estimate: update
                        .total_estimated
                        .then_some(update.total_bytes)
                        .flatten(),
                    speed_bps: (update.speed_bps > 0.0).then_some(update.speed_bps),
                    eta_seconds: update.eta_seconds,
                    percent: update.progress_percent,
                    format_id: update.format_id.clone(),
                    filename: update.filename.clone(),
                    status: Some(crate::progress::adapter::YtDlpProgressStatus::Downloading),
                    stream_kind: crate::progress::model::StreamKind::Combined,
                });
            let v1 = V1ProgressObservation {
                downloaded_bytes: update.downloaded_bytes,
                total_bytes: update.total_bytes,
                total_estimated: update.total_estimated,
                progress_percent: update.progress_percent,
                indeterminate: update.total_bytes.is_none() && update.progress_percent.is_none(),
                speed_bps: (update.speed_bps > 0.0).then_some(update.speed_bps),
                eta_seconds: update.eta_seconds,
            };
            let _ = shadow_observe(id, raw, v1);
        }
        if !persist_transfer {
            return true;
        }
        let progress_for_gate = update.progress_percent.unwrap_or(0.0);
        if !tracker.persistence_gate.should_persist(
            update.downloaded_bytes,
            progress_for_gate,
            Duration::ZERO,
        ) {
            return false;
        }
        let previous_speed = connection
            .query_row(
                "SELECT speed_bps FROM media_jobs WHERE job_id=?1",
                params![id],
                |row| row.get::<_, f64>(0),
            )
            .unwrap_or(0.0);
        let stable_speed = stabilize_reported_speed(previous_speed, update.speed_bps);
        let stable_eta = match update.total_bytes {
            Some(total) if stable_speed > 1.0 && total > update.downloaded_bytes => {
                Some(((total - update.downloaded_bytes) as f64 / stable_speed).ceil() as u64)
            }
            _ => update.eta_seconds,
        };
        let detail = match update.total_bytes {
            Some(total) => {
                let total_label = if update.total_estimated {
                    format!("~{}", human_bytes(total))
                } else {
                    human_bytes(total)
                };
                let downloaded_label = if update.total_estimated {
                    human_bytes(update.downloaded_bytes)
                } else {
                    human_bytes(update.downloaded_bytes.min(total))
                };
                format!(
                    "{} de {} · {}/s",
                    downloaded_label,
                    total_label,
                    human_bytes(stable_speed as u64)
                )
            }
            None => format!(
                "{} descargados · {}/s · tamaño todavía desconocido",
                human_bytes(update.downloaded_bytes),
                human_bytes(stable_speed as u64)
            ),
        };
        let transaction = match connection.unchecked_transaction() {
            Ok(transaction) => transaction,
            Err(_) => return false,
        };
        let write_result = (|| {
            if let Some(percent) = update.progress_percent {
                transaction.execute(
                "UPDATE jobs SET progress=?1,detail=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND status='running'",
                params![percent, detail, id],
                )?;
                transaction.execute(
                "UPDATE playlist_items SET progress=?1,status='running' WHERE job_id=?2 AND status NOT IN ('cancelled','completed') AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='running')",
                params![percent, id],
                )?;
            } else {
                transaction.execute(
                "UPDATE jobs SET progress=0,detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='running'",
                params![detail, id],
                )?;
                transaction.execute(
                "UPDATE playlist_items SET progress=0,status='running' WHERE job_id=?1 AND status NOT IN ('cancelled','completed') AND EXISTS (SELECT 1 FROM jobs WHERE id=?1 AND status='running')",
                params![id],
                )?;
            }
            transaction.execute(
            "UPDATE media_jobs SET downloaded_bytes=?1,total_bytes=?2,total_bytes_estimated=?3,speed_bps=?4,eta_seconds=?5,resolution_state='downloading',updated_at=CURRENT_TIMESTAMP WHERE job_id=?6 AND EXISTS (SELECT 1 FROM jobs WHERE id=?6 AND status='running')",
            params![
                update.downloaded_bytes.min(i64::MAX as u64) as i64,
                update.total_bytes.map(|value| value.min(i64::MAX as u64) as i64),
                if update.total_estimated { 1_i64 } else { 0_i64 },
                stable_speed,
                stable_eta.map(|value| value.min(i64::MAX as u64) as i64),
                id
            ],
            )?;
            transaction.commit()
        })();
        if write_result.is_ok() {
            tracker
                .persistence_gate
                .mark_persisted(update.downloaded_bytes, progress_for_gate);
            return true;
        }
        return false;
    }

    if let Some(stage) = processing_stage_from_ytdlp_line(line) {
        shadow_mark_post_processing_stage(id, stage);
    }
    if line.contains("[Merger]") {
        set_media_processing_stage(
            connection,
            id,
            "merging",
            "Combinando video y audio\u{2026}",
        );
    } else if line.contains("[VideoConvertor]") {
        set_media_processing_stage(connection, id, "converting", "Convirtiendo…");
    } else if line.contains("[ExtractAudio]") {
        set_media_processing_stage(connection, id, "extracting_audio", "Extrayendo audio...");
    } else if line.contains("[Metadata]") || line.contains("[EmbedSubtitle]") {
        set_media_processing_stage(
            connection,
            id,
            "embedding_metadata",
            "Incrustando metadatos…",
        );
    } else if line.contains("[Fixup") {
        set_media_processing_stage(connection, id, "processing", "Preparando archivo final…");
    }
    false
}
