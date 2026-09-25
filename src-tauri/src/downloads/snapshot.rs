use crate::{
    youtube_thumbnail_for_source, CurrencySnapshot, DownloadConcurrencySettings, DownloadPriority,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{ffi::OsStr, path::Path};

use super::recent_kind_from_path;

#[derive(Serialize)]
pub(crate) struct StorageSnapshot {
    pub(crate) free_bytes: u64,
    pub(crate) total_bytes: u64,
}

#[derive(Serialize)]
pub(crate) struct JobSnapshot {
    pub(crate) id: i64,
    /// Immutable visual insertion order. For regular jobs this is the
    /// AUTOINCREMENT job id; status/progress updates must never change it.
    pub(crate) added_order: i64,
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) progress: f64,
    pub(crate) status: String,
    pub(crate) kind: String,
    pub(crate) engine: String,
    pub(crate) stage: String,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_bytes_estimated: bool,
    pub(crate) progress_estimated: bool,
    pub(crate) final_size: Option<u64>,
    pub(crate) speed_bps: f64,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) indeterminate: bool,
    pub(crate) extension: String,
    pub(crate) source_url: String,
    pub(crate) destination: String,
    pub(crate) thumbnail: String,
    pub(crate) priority: DownloadPriority,
    #[serde(rename = "speedLimitBps")]
    pub(crate) speed_limit_bps: Option<u64>,
    pub(crate) updated_at: String,
}

#[derive(Serialize)]
pub(crate) struct QueueSnapshot {
    pub(crate) active: u64,
    pub(crate) queued: u64,
    pub(crate) paused: u64,
    pub(crate) completed_today: u64,
    pub(crate) failed: u64,
    pub(crate) total_speed_bps: f64,
}

#[derive(Serialize)]
pub(crate) struct RecentFileSnapshot {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) category: String,
    pub(crate) opened_at: String,
    pub(crate) kind: String,
}

#[derive(Serialize)]
pub(crate) struct PlaylistBatchSummarySnapshot {
    pub(crate) batch_id: i64,
    /// The first child job id gives the playlist a position in the same
    /// global sequence as regular downloads. Child jobs are inserted in the
    /// same transaction as the batch, so this remains stable for its life.
    pub(crate) added_order: i64,
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) status: String,
    pub(crate) stage: String,
    pub(crate) indeterminate: bool,
    pub(crate) total_items: u64,
    pub(crate) completed_items: u64,
    pub(crate) failed_items: u64,
    pub(crate) active_items: u64,
    pub(crate) progress: f64,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_bytes_estimated: bool,
    pub(crate) progress_estimated: bool,
    pub(crate) final_size: Option<u64>,
    pub(crate) speed_bps: f64,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) destination: String,
    pub(crate) thumbnail_stack: String,
    pub(crate) last_error: Option<String>,
    pub(crate) priority: DownloadPriority,
    #[serde(rename = "speedLimitBps")]
    pub(crate) speed_limit_bps: Option<u64>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Serialize)]
pub(crate) struct DownloadActivitySnapshot {
    pub(crate) queue: QueueSnapshot,
    pub(crate) jobs: Vec<JobSnapshot>,
    pub(crate) playlist_batches: Vec<PlaylistBatchSummarySnapshot>,
}

#[derive(Serialize)]
pub(crate) struct DesktopSnapshot {
    pub(crate) storage: StorageSnapshot,
    pub(crate) currency: CurrencySnapshot,
    pub(crate) queue: QueueSnapshot,
    pub(crate) jobs: Vec<JobSnapshot>,
    pub(crate) playlist_batches: Vec<PlaylistBatchSummarySnapshot>,
    pub(crate) recent_files: Vec<RecentFileSnapshot>,
}

#[derive(Serialize)]
pub(crate) struct DesktopSettingsSnapshot {
    pub(crate) downloads_dir: String,
    #[serde(rename = "downloadConcurrency")]
    pub(crate) download_concurrency: DownloadConcurrencySettings,
}

#[derive(Serialize)]
pub(crate) struct DownloadQueueReceipt {
    pub(crate) job_id: i64,
    pub(crate) filename: String,
    pub(crate) destination: String,
    pub(crate) resumable: bool,
}

#[derive(Serialize)]
pub(crate) struct FileMetadataSnapshot {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) extension: String,
    pub(crate) size_bytes: u64,
    pub(crate) modified_unix: Option<u64>,
    pub(crate) readonly: bool,
}

#[derive(Serialize)]
pub(crate) struct QueueActionReceipt {
    pub(crate) affected: usize,
    pub(crate) action: String,
}

fn download_stage_label(status: &str, detail: &str, resolution_state: &str) -> String {
    match status {
        "queued" => return "En espera".to_string(),
        "paused" => return "En pausa".to_string(),
        "completed" => return "Completado".to_string(),
        "failed" => return "Error".to_string(),
        "cancelled" => return "Cancelado".to_string(),
        _ => {}
    }
    let context = format!("{detail} {resolution_state}").to_ascii_lowercase();
    if context.contains("merging") || context.contains("combinando") {
        "Combinando video y audio"
    } else if context.contains("converting")
        || context.contains("convirtiendo")
        || context.contains("extractaudio")
    {
        "Convirtiendo"
    } else if context.contains("validating")
        || context.contains("validando")
        || context.contains("comprobando")
        || context.contains("verificando")
    {
        "Validando"
    } else if context.contains("analizando")
        || context.contains("analyzing")
        || context.contains("obteniendo metadatos")
    {
        "Analizando"
    } else if context.contains("conectando") || context.contains("esperando datos") {
        "Conectando"
    } else if context.contains("finalizando") || context.contains("finalizing") {
        "Finalizando"
    } else if context.contains("preparando")
        || context.contains("tagging")
        || context.contains("processing")
    {
        "Preparando"
    } else {
        "Descargando"
    }
    .to_string()
}

/// Return the format that the user will actually receive, without guessing
/// from an opaque provider URL such as `/watch?v=...`.  The media output mode
/// is stronger evidence than a directory path while a job is still queued or
/// being finalized; completed direct downloads use their final filename.
pub(crate) fn snapshot_extension(output_mode: Option<&str>, destination: &str) -> String {
    let mode_extension = output_mode.and_then(|mode| {
        let normalized = mode.trim().to_ascii_lowercase();
        if normalized.starts_with("video_mp4") {
            Some("mp4")
        } else if normalized.starts_with("video_webm") {
            Some("webm")
        } else if normalized.starts_with("audio_mp3") {
            Some("mp3")
        } else if normalized.starts_with("audio_m4a") {
            Some("m4a")
        } else if normalized.starts_with("audio_flac") {
            Some("flac")
        } else {
            None
        }
    });
    if let Some(extension) = mode_extension {
        return extension.to_string();
    }
    Path::new(destination)
        .extension()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|extension| !extension.is_empty() && extension.len() <= 16)
        .filter(|extension| {
            extension
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

pub(crate) fn read_download_activity(
    connection: &Connection,
    recent_only: bool,
) -> Result<DownloadActivitySnapshot, String> {
    let mut jobs_statement = connection
        .prepare(
            "SELECT jobs.id,jobs.title,jobs.detail,jobs.progress,jobs.status,
                    COALESCE(download_jobs.destination,torrent_jobs.destination_dir),media_jobs.output_mode,
                    COALESCE(download_jobs.downloaded_bytes,media_jobs.downloaded_bytes,torrent_jobs.downloaded_bytes,0),
                    COALESCE(download_jobs.total_bytes,media_jobs.total_bytes,torrent_jobs.total_bytes),
                    COALESCE(download_jobs.speed_bps,media_jobs.speed_bps,torrent_jobs.speed_bps,0),
                    COALESCE(download_jobs.eta_seconds,media_jobs.eta_seconds,torrent_jobs.eta_seconds),
                    CASE
                        WHEN media_jobs.job_id IS NOT NULL THEN 'yt-dlp'
                        WHEN torrent_jobs.job_id IS NOT NULL THEN 'aria2c'
                        ELSE 'http-range'
                    END,
                    COALESCE(download_jobs.url,media_jobs.source_url,torrent_jobs.source,''),
                    COALESCE(download_jobs.destination,media_jobs.output_path,torrent_jobs.destination_dir,''),
                    COALESCE(NULLIF(playlist_items.thumbnail,''),NULLIF(media_jobs.thumbnail,''),''),
                    COALESCE(media_jobs.total_bytes_estimated,0),
                    COALESCE(media_jobs.resolution_state,''),
                    COALESCE(jobs.priority,'normal'),
                    jobs.updated_at,
                    COALESCE((SELECT bytes_per_second FROM download_speed_limits WHERE job_id=jobs.id),-1)
             FROM jobs
             LEFT JOIN download_jobs ON download_jobs.job_id=jobs.id
             LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id
             LEFT JOIN torrent_jobs ON torrent_jobs.job_id=jobs.id
             LEFT JOIN playlist_items ON playlist_items.job_id=jobs.id
              WHERE media_jobs.playlist_batch_id IS NULL
                AND jobs.status <> 'deleting'
                AND (?1=0 OR jobs.status IN ('running','queued','paused')
                    OR jobs.updated_at >= datetime('now','-10 minutes'))
             ORDER BY CASE WHEN jobs.status IN ('running','queued','paused','failed') THEN 0 ELSE 1 END,
                      jobs.updated_at DESC
             LIMIT 300",
        )
        .map_err(|error| error.to_string())?;
    let jobs = jobs_statement
        .query_map(params![recent_only as i64], |row| {
            let status: String = row.get(4)?;
            let detail = crate::media::sanitize_media_error_for_display(&row.get::<_, String>(2)?);
            let source_url: String = row.get(12)?;
            let destination: Option<String> = row.get(5)?;
            let output_mode: Option<String> = row.get(6)?;
            let destination_path: String = row.get(13)?;
            let extension = snapshot_extension(output_mode.as_deref(), &destination_path);
            let raw_total_bytes: Option<i64> = row.get(8)?;
            let total_bytes = raw_total_bytes
                .filter(|value| *value > 0)
                .map(|value| value as u64);
            let raw_downloaded_bytes = row.get::<_, i64>(7)?.max(0) as u64;
            let reported_progress: f64 = row.get(3)?;
            let total_bytes_estimated = row.get::<_, i64>(15)? != 0;
            let downloaded_bytes = if total_bytes_estimated {
                raw_downloaded_bytes
            } else {
                total_bytes
                    .map(|total| raw_downloaded_bytes.min(total))
                    .unwrap_or(raw_downloaded_bytes)
            };
            let progress = if status == "completed" {
                100.0
            } else if let Some(total) = total_bytes.filter(|_| !total_bytes_estimated) {
                (downloaded_bytes as f64 * 100.0 / total as f64).clamp(0.0, 99.9)
            } else {
                reported_progress.clamp(0.0, 99.9)
            };
            let engine: String = row.get(11)?;
            let kind = if engine == "aria2c" {
                "torrent".to_string()
            } else {
                match output_mode.as_deref() {
                    Some(mode) if mode.starts_with("audio_") => "audio".to_string(),
                    Some(mode) if mode.starts_with("video_") => "video".to_string(),
                    Some("source") => "video".to_string(),
                    _ => destination
                        .as_deref()
                        .map(Path::new)
                        .map(recent_kind_from_path)
                        .unwrap_or("file")
                        .to_string(),
                }
            };
            let resolution_state: String = row.get(16)?;
            let stage = download_stage_label(&status, &detail, &resolution_state);
            let progress_estimated =
                status == "running" && total_bytes.is_none() && reported_progress > 0.0;
            let indeterminate = status == "running"
                && (stage.as_str() != "Descargando"
                    || (total_bytes.is_none() && !progress_estimated));
            let final_size = (status == "completed").then_some(total_bytes).flatten();
            let speed_bps = if status == "running" {
                row.get::<_, f64>(9)?.max(0.0)
            } else {
                0.0
            };
            let eta_seconds = if status == "running" {
                row.get::<_, Option<i64>>(10)?
                    .map(|value| value.max(0) as u64)
            } else {
                None
            };
            Ok(JobSnapshot {
                id: row.get(0)?,
                added_order: row.get(0)?,
                title: row.get(1)?,
                detail,
                progress,
                status,
                kind,
                engine,
                stage,
                downloaded_bytes,
                total_bytes,
                total_bytes_estimated,
                progress_estimated,
                final_size,
                speed_bps,
                eta_seconds,
                indeterminate,
                extension,
                source_url: source_url.clone(),
                destination: destination_path,
                thumbnail: {
                    let stored = row.get::<_, String>(14)?;
                    if stored.trim().is_empty() {
                        youtube_thumbnail_for_source(&source_url)
                    } else {
                        stored
                    }
                },
                priority: DownloadPriority::from_persisted(&row.get::<_, String>(17)?),
                speed_limit_bps: row
                    .get::<_, i64>(19)
                    .ok()
                    .filter(|value| *value >= 0)
                    .map(|value| value as u64),
                updated_at: row.get(18)?,
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let mut playlist_statement = connection
        .prepare(
            "SELECT pb.id,pb.title,pb.format,pb.status,
                    COUNT(pi.id),
                    COALESCE(SUM(CASE WHEN pi.status='completed' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN pi.status='failed' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN pi.status IN ('running','paused') THEN 1 ELSE 0 END),0),
                    CASE WHEN COUNT(pi.id)=0 THEN 0.0 ELSE
                        SUM(CASE
                            WHEN pi.status IN ('completed','failed') THEN 100.0
                            ELSE COALESCE(jobs.progress,pi.progress,0.0)
                        END) / COUNT(pi.id)
                    END,
                    COALESCE(SUM(COALESCE(media_jobs.downloaded_bytes,0)),0),
                    CASE WHEN COUNT(pi.id)>0
                              AND COALESCE(SUM(CASE WHEN media_jobs.total_bytes IS NULL OR media_jobs.total_bytes<=0 THEN 1 ELSE 0 END),0)=0
                         THEN SUM(media_jobs.total_bytes) END,
                    COALESCE(SUM(CASE WHEN jobs.status='running' THEN COALESCE(media_jobs.speed_bps,0) ELSE 0 END),0),
                    MAX(CASE WHEN jobs.status='running' THEN media_jobs.eta_seconds END),
                    COALESCE(MAX(media_jobs.destination_dir),''),
                    COALESCE(GROUP_CONCAT(CASE WHEN pi.thumbnail<>'' THEN pi.thumbnail ELSE pi.source_url END, char(31)),''),
                    MAX(NULLIF(media_jobs.error,'')),
                    MAX(CASE WHEN jobs.status='running' THEN jobs.detail END),
                    MAX(CASE WHEN jobs.status='running' THEN media_jobs.resolution_state END),
                    MAX(COALESCE(media_jobs.total_bytes_estimated,0)),
                     COALESCE(pb.priority,'normal'),
                     pb.created_at,pb.updated_at,
                     COALESCE((SELECT bytes_per_second
                                 FROM download_speed_limits dsl
                                 JOIN playlist_items pi2 ON pi2.job_id=dsl.job_id
                                WHERE pi2.batch_id=pb.id
                                ORDER BY dsl.updated_at DESC
                                LIMIT 1),-1),
                     COALESCE(MIN(jobs.id),9223372036854775807)
             FROM playlist_batches pb
             LEFT JOIN playlist_items pi ON pi.batch_id=pb.id
             LEFT JOIN jobs ON jobs.id=pi.job_id
             LEFT JOIN media_jobs ON media_jobs.job_id=pi.job_id
             WHERE (?1=0 OR pb.status IN ('running','queued','paused')
                    OR pb.updated_at >= datetime('now','-10 minutes'))
             GROUP BY pb.id
             ORDER BY CASE WHEN pb.status IN ('running','queued','paused') THEN 0 ELSE 1 END,
                      pb.updated_at DESC
             LIMIT 120",
        )
        .map_err(|error| error.to_string())?;
    let playlist_batches = playlist_statement
        .query_map(params![recent_only as i64], |row| {
            let status: String = row.get(3)?;
            let total_bytes = row
                .get::<_, Option<i64>>(10)?
                .filter(|value| *value > 0)
                .map(|value| value as u64);
            let total_bytes_estimated = row.get::<_, i64>(18)? != 0;
            let raw_downloaded_bytes = row.get::<_, i64>(9)?.max(0) as u64;
            let downloaded_bytes = if total_bytes_estimated {
                raw_downloaded_bytes
            } else {
                total_bytes
                    .map(|total| raw_downloaded_bytes.min(total))
                    .unwrap_or(raw_downloaded_bytes)
            };
            let reported_progress = row.get::<_, f64>(8)?.clamp(0.0, 100.0);
            let progress = if status == "completed" {
                100.0
            } else if let Some(total) = total_bytes.filter(|_| !total_bytes_estimated) {
                (downloaded_bytes as f64 * 100.0 / total as f64).clamp(0.0, 99.9)
            } else {
                reported_progress
            };
            let active_detail = row.get::<_, Option<String>>(16)?.unwrap_or_default();
            let active_resolution = row.get::<_, Option<String>>(17)?.unwrap_or_default();
            let stage = download_stage_label(&status, &active_detail, &active_resolution);
            let progress_estimated =
                status == "running" && total_bytes.is_none() && reported_progress > 0.0;
            let indeterminate = status == "running"
                && (stage.as_str() != "Descargando"
                    || (total_bytes.is_none() && !progress_estimated));
            let final_size = (status == "completed" && !total_bytes_estimated)
                .then_some(total_bytes)
                .flatten();
            Ok(PlaylistBatchSummarySnapshot {
                batch_id: row.get(0)?,
                added_order: row.get(23)?,
                title: row.get(1)?,
                format: row.get(2)?,
                status,
                stage,
                indeterminate,
                total_items: row.get::<_, i64>(4)?.max(0) as u64,
                completed_items: row.get::<_, i64>(5)?.max(0) as u64,
                failed_items: row.get::<_, i64>(6)?.max(0) as u64,
                active_items: row.get::<_, i64>(7)?.max(0) as u64,
                progress,
                downloaded_bytes,
                total_bytes,
                total_bytes_estimated,
                progress_estimated,
                final_size,
                speed_bps: row.get::<_, f64>(11)?.max(0.0),
                eta_seconds: row
                    .get::<_, Option<i64>>(12)?
                    .map(|value| value.max(0) as u64),
                destination: row.get(13)?,
                thumbnail_stack: row.get(14)?,
                last_error: row.get(15)?,
                priority: DownloadPriority::from_persisted(&row.get::<_, String>(19)?),
                speed_limit_bps: row
                    .get::<_, i64>(22)
                    .ok()
                    .filter(|value| *value >= 0)
                    .map(|value| value as u64),
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let (active, queued, paused, completed_today, failed): (i64, i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
                SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='completed' AND date(updated_at,'localtime')=date('now','localtime') THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='failed' AND date(updated_at,'localtime')=date('now','localtime') THEN 1 ELSE 0 END)
             FROM jobs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap_or((0, 0, 0, 0, 0));
    let total_speed_bps: f64 = connection
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(download_jobs.speed_bps,media_jobs.speed_bps,torrent_jobs.speed_bps,0)),0)
             FROM jobs
             LEFT JOIN download_jobs ON download_jobs.job_id=jobs.id
             LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id
             LEFT JOIN torrent_jobs ON torrent_jobs.job_id=jobs.id
             WHERE jobs.status='running'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    let queue = QueueSnapshot {
        active: active.max(0) as u64,
        queued: queued.max(0) as u64,
        paused: paused.max(0) as u64,
        completed_today: completed_today.max(0) as u64,
        failed: failed.max(0) as u64,
        total_speed_bps: total_speed_bps.max(0.0),
    };
    Ok(DownloadActivitySnapshot {
        queue,
        jobs,
        playlist_batches,
    })
}
