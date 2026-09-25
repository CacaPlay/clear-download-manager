use crate::{
    cleanup_managed_paths_when_idle, deduplicate_storage_paths, fail_torrent_job,
    job_uses_legacy_removed_provider, kill_process_tree, legacy_removed_provider_error,
    run_download_worker, run_media_worker, run_torrent_worker, terminate_external_processes,
    wait_for_external_processes_idle, ExternalProcessRegistry, MediaRuntimePaths,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Serialize)]
pub(crate) struct DownloadScheduleSnapshot {
    pub(crate) id: i64,
    pub(crate) job_id: Option<i64>,
    pub(crate) action: String,
    pub(crate) run_at: String,
    pub(crate) repeat_daily: bool,
    pub(crate) enabled: bool,
    pub(crate) last_run_at: Option<String>,
}

pub(crate) fn validate_schedule_action(action: &str) -> Result<&str, String> {
    match action {
        "resume" | "pause" | "cancel" => Ok(action),
        _ => Err("La acción programada no es válida".into()),
    }
}

pub(crate) fn normalize_schedule_time(value: &str) -> Result<String, String> {
    let value = value.trim().replace('T', " ");
    let prefix = value.chars().take(16).collect::<String>();
    if prefix.len() != 16 {
        return Err("La fecha y hora programada no es válida".into());
    }
    for (index, character) in prefix.chars().enumerate() {
        let valid = match index {
            4 | 7 => character == '-',
            10 => character == ' ',
            13 => character == ':',
            _ => character.is_ascii_digit(),
        };
        if !valid {
            return Err("La fecha y hora programada no es válida".into());
        }
    }
    Ok(value.chars().take(19).collect())
}

pub(crate) fn read_schedule(
    connection: &Connection,
    id: i64,
) -> Result<DownloadScheduleSnapshot, String> {
    connection
        .query_row(
            "SELECT id,job_id,action,run_at,repeat_daily,enabled,last_run_at FROM download_schedules WHERE id=?1",
            params![id],
            |row| {
                Ok(DownloadScheduleSnapshot {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    action: row.get(2)?,
                    run_at: row.get(3)?,
                    repeat_daily: row.get::<_, i64>(4)? != 0,
                    enabled: row.get::<_, i64>(5)? != 0,
                    last_run_at: row.get(6)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn scheduled_job_is_media(connection: &Connection, job_id: i64) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM media_jobs WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn scheduled_job_is_torrent(connection: &Connection, job_id: i64) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM torrent_jobs WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

#[derive(Clone)]
pub(crate) struct SchedulerRuntime {
    pub(crate) active_downloads: Arc<Mutex<HashSet<i64>>>,
    pub(crate) active_media_pids: Arc<Mutex<HashMap<i64, u32>>>,
    pub(crate) external_processes: ExternalProcessRegistry,
    pub(crate) media_runtime: Option<MediaRuntimePaths>,
    pub(crate) aria2_path: Option<PathBuf>,
    pub(crate) managed_root: PathBuf,
}

fn execute_scheduled_action(
    db_path: &Path,
    runtime: &SchedulerRuntime,
    job_id: i64,
    action: &str,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let is_media = scheduled_job_is_media(&connection, job_id);
    let is_torrent = scheduled_job_is_torrent(&connection, job_id);
    let direct_temp = connection
        .query_row(
            "SELECT temp_path FROM download_jobs WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let media_destination = connection
        .query_row(
            "SELECT destination_dir FROM media_jobs WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let torrent_destination = connection
        .query_row(
            "SELECT destination_dir FROM torrent_jobs WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match action {
        "resume" => {
            if job_uses_legacy_removed_provider(&connection, job_id)? {
                connection
                    .execute(
                        "UPDATE download_schedules SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                        params![job_id],
                    )
                    .map_err(|error| error.to_string())?;
                return Err(legacy_removed_provider_error());
            }
            let affected = connection
                .execute(
                    "UPDATE jobs SET status='queued',detail='Iniciada por el programador',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            if affected == 0 {
                return Err("La tarea programada ya está completada, cancelada o eliminada".into());
            }
            drop(connection);
            if is_media {
                if let Some(media_runtime) = runtime.media_runtime.clone() {
                    run_media_worker(
                        db_path.to_path_buf(),
                        media_runtime,
                        runtime.active_media_pids.clone(),
                        runtime.external_processes.clone(),
                        job_id,
                    );
                }
            } else if is_torrent {
                if let Some(path) = runtime.aria2_path.clone() {
                    run_torrent_worker(
                        db_path.to_path_buf(),
                        path,
                        runtime.active_media_pids.clone(),
                        job_id,
                    );
                } else {
                    fail_torrent_job(
                        db_path,
                        job_id,
                        "aria2c no está disponible para ejecutar la tarea programada",
                    );
                }
            } else {
                run_download_worker(
                    db_path.to_path_buf(),
                    runtime.active_downloads.clone(),
                    job_id,
                );
            }
        }
        "pause" => {
            connection
                .execute(
                    "UPDATE jobs SET status='paused',detail='Pausada por el programador',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('queued','running')",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            drop(connection);
            if is_media || is_torrent {
                if let Ok(active) = runtime.active_media_pids.lock() {
                    if let Some(pid) = active.get(&job_id).copied().filter(|pid| *pid > 0) {
                        kill_process_tree(pid);
                    }
                }
                terminate_external_processes(&runtime.external_processes, job_id);
            }
        }
        "cancel" => {
            connection
                .execute(
                    "UPDATE jobs SET status='cancelled',cancel_cleanup=1,detail='Cancelada por el programador',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status<>'completed'",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE download_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE media_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE torrent_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE playlist_items SET status='cancelled' WHERE job_id=?1 AND status<>'completed'",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE download_schedules SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND enabled=1",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            drop(connection);
            if is_media || is_torrent {
                if let Ok(active) = runtime.active_media_pids.lock() {
                    if let Some(pid) = active.get(&job_id).copied().filter(|pid| *pid > 0) {
                        kill_process_tree(pid);
                    }
                }
                terminate_external_processes(&runtime.external_processes, job_id);
            }
            let _ = wait_for_external_processes_idle(
                &runtime.external_processes,
                job_id,
                Duration::from_secs(15),
            );
            let mut partial_paths = Vec::new();
            if let Some(path) = direct_temp.map(PathBuf::from) {
                partial_paths.push((path, false));
            }
            if let Some(path) = torrent_destination.map(PathBuf::from) {
                partial_paths.push((path, true));
            } else if let Some(destination) = media_destination {
                partial_paths.push((
                    PathBuf::from(destination)
                        .join(".cacatools-work")
                        .join(format!("job-{job_id}")),
                    true,
                ));
            }
            cleanup_managed_paths_when_idle(
                job_id,
                runtime.active_downloads.clone(),
                runtime.active_media_pids.clone(),
                runtime.external_processes.clone(),
                runtime.managed_root.clone(),
                deduplicate_storage_paths(partial_paths),
            );
        }
        _ => return Err("Acción programada desconocida".into()),
    }
    Ok(())
}

pub(crate) fn run_download_scheduler(db_path: PathBuf, runtime: SchedulerRuntime) {
    thread::spawn(move || loop {
        let due = Connection::open(&db_path)
            .and_then(|connection| {
                let mut statement = connection.prepare(
                    "SELECT id,job_id,action,repeat_daily FROM download_schedules WHERE enabled=1 AND datetime(run_at)<=datetime('now','localtime') ORDER BY datetime(run_at) ASC LIMIT 20",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? != 0,
                    ))
                })?;
                Ok(rows.flatten().collect::<Vec<_>>())
            })
            .unwrap_or_default();

        for (schedule_id, job_id, action, repeat_daily) in due {
            let result = job_id.map_or(Ok(()), |job_id| {
                execute_scheduled_action(&db_path, &runtime, job_id, &action)
            });
            if let Ok(connection) = Connection::open(&db_path) {
                if repeat_daily && result.is_ok() {
                    let _ = connection.execute(
                        "UPDATE download_schedules SET run_at=datetime(run_at,'+1 day'),last_run_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                        params![schedule_id],
                    );
                } else {
                    let _ = connection.execute(
                        "UPDATE download_schedules SET enabled=0,last_run_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                        params![schedule_id],
                    );
                }
            }
        }
        thread::sleep(Duration::from_secs(10));
    });
}
