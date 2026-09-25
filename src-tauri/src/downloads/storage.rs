#![allow(clippy::invisible_characters)]

use super::sanitize_filename;
use crate::app::process::wait_for_external_processes_idle;
use crate::{
    cleanup_managed_paths_when_idle, external_processes_active, kill_process_tree,
    terminate_external_processes, ExternalProcessRegistry, LocalState,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const LEGACY_HTTP_SEGMENT_SLOTS: usize = 8;

pub(crate) fn unique_destination(directory: &Path, filename: &str) -> PathBuf {
    let candidate = directory.join(filename);
    if !destination_has_download_artifacts(&candidate) {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("descarga");
    let extension = path.extension().and_then(|value| value.to_str());
    for number in 2..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem} ({number}).{extension}"),
            None => format!("{stem} ({number})"),
        };
        let next = directory.join(name);
        if !destination_has_download_artifacts(&next) {
            return next;
        }
    }
    directory.join(format!("descarga-{}.bin", std::process::id()))
}

fn destination_has_download_artifacts(destination: &Path) -> bool {
    let temp_path = PathBuf::from(format!("{}.part", destination.display()));
    destination.exists()
        || temp_path.exists()
        || PathBuf::from(format!("{}.aria2", destination.display())).exists()
        || (0..LEGACY_HTTP_SEGMENT_SLOTS).any(|index| {
            PathBuf::from(format!("{}.segment-{index:03}.part", temp_path.display())).exists()
        })
}

pub(crate) fn unique_directory(parent: &Path, label: &str) -> PathBuf {
    let safe = sanitize_filename(label);
    let candidate = parent.join(&safe);
    if !candidate.exists() {
        return candidate;
    }
    for number in 2..10_000 {
        let next = parent.join(format!("{safe} ({number})"));
        if !next.exists() {
            return next;
        }
    }
    parent.join(format!("torrent-{}", std::process::id()))
}

pub(crate) fn directory_size(path: &Path) -> u64 {
    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.path().symlink_metadata() else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0usize;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if value >= 100.0 {
        format!("{value:.0} {}", UNITS[index])
    } else {
        format!("{value:.1} {}", UNITS[index])
    }
}

pub(crate) fn current_downloads_dir(state: &LocalState) -> Result<PathBuf, String> {
    state
        .downloads_dir
        .lock()
        .map(|path| path.clone())
        .map_err(|_| "No se pudo acceder a la carpeta de descargas".to_string())
}

pub(crate) fn recent_kind_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "mkv" | "webm" | "mov" | "avi" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" => "audio",
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "svg" => "image",
        "xlsx" | "xls" | "csv" | "ods" => "sheet",
        "pptx" | "ppt" | "odp" => "presentation",
        "pdf" => "pdf",
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" | "cab" | "jar" => "archive",
        "exe" | "msi" | "msix" | "appx" | "appxbundle" | "apk" | "deb" | "rpm" | "dmg" => "app",
        "iso" | "img" | "vhd" | "vhdx" => "disk",
        _ => "file",
    }
}

pub(crate) struct JobStorageRecord {
    pub(crate) job_id: i64,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) direct_destination: Option<PathBuf>,
    pub(crate) direct_temp: Option<PathBuf>,
    pub(crate) media_destination_dir: Option<PathBuf>,
    pub(crate) media_output: Option<PathBuf>,
    pub(crate) torrent_destination_dir: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobStoragePreview {
    pub(crate) job_id: i64,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) active: bool,
    pub(crate) can_emergency_stop: bool,
    pub(crate) managed_root: String,
    pub(crate) final_paths: Vec<String>,
    pub(crate) partial_paths: Vec<String>,
    pub(crate) storage_exists: bool,
    pub(crate) safe_for_storage_deletion: bool,
    pub(crate) safety_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelJobReceipt {
    pub(crate) job_id: i64,
    pub(crate) delete_partial: bool,
    pub(crate) partial_path: Option<String>,
    pub(crate) cleanup_pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteJobReceipt {
    pub(crate) job_id: i64,
    pub(crate) delete_storage: bool,
    pub(crate) record_deleted: bool,
    pub(crate) stopped_active_job: bool,
    pub(crate) cleanup_pending: bool,
    pub(crate) removed_paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletePlaylistReceipt {
    pub(crate) batch_id: i64,
    pub(crate) delete_storage: bool,
    pub(crate) record_deleted: bool,
    pub(crate) stopped_active_jobs: usize,
    pub(crate) removed_paths: Vec<String>,
}

pub(crate) fn optional_path(value: Option<String>) -> Option<PathBuf> {
    value
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

pub(crate) fn load_job_storage_record(
    connection: &Connection,
    id: i64,
) -> Result<JobStorageRecord, String> {
    connection
        .query_row(
            "SELECT jobs.id,jobs.title,jobs.status,download_jobs.destination,download_jobs.temp_path,media_jobs.destination_dir,media_jobs.output_path,torrent_jobs.destination_dir
             FROM jobs
             LEFT JOIN download_jobs ON download_jobs.job_id=jobs.id
             LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id
             LEFT JOIN torrent_jobs ON torrent_jobs.job_id=jobs.id
             WHERE jobs.id=?1",
            params![id],
            |row| {
                Ok(JobStorageRecord {
                    job_id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    direct_destination: optional_path(row.get::<_, Option<String>>(3)?),
                    direct_temp: optional_path(row.get::<_, Option<String>>(4)?),
                    media_destination_dir: optional_path(row.get::<_, Option<String>>(5)?),
                    media_output: optional_path(row.get::<_, Option<String>>(6)?),
                    torrent_destination_dir: optional_path(row.get::<_, Option<String>>(7)?),
                })
            },
        )
        .map_err(|_| "La tarea ya no existe".to_string())
}

pub(crate) fn media_work_dir(record: &JobStorageRecord) -> Option<PathBuf> {
    record.media_destination_dir.as_ref().map(|destination| {
        destination
            .join(".cacatools-work")
            .join(format!("job-{}", record.job_id))
    })
}

pub(crate) fn job_final_storage_paths(record: &JobStorageRecord) -> Vec<(PathBuf, bool)> {
    let mut paths = Vec::new();
    if let Some(path) = record.direct_destination.clone() {
        paths.push((path, false));
    }
    if let Some(path) = record.media_output.clone() {
        paths.push((path, false));
    }
    if let Some(path) = record.torrent_destination_dir.clone() {
        paths.push((path, true));
    }
    paths
}

pub(crate) fn job_partial_storage_paths(record: &JobStorageRecord) -> Vec<(PathBuf, bool)> {
    let mut paths = Vec::new();
    if let Some(path) = record.direct_temp.clone() {
        paths.push((path, false));
    }
    if let Some(path) = media_work_dir(record) {
        paths.push((path, true));
    }
    if record.status != "completed" {
        if let Some(path) = record.torrent_destination_dir.clone() {
            paths.push((path, true));
        }
    }
    paths
}

pub(crate) fn deduplicate_storage_paths(paths: Vec<(PathBuf, bool)>) -> Vec<(PathBuf, bool)> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|(path, _)| seen.insert(path.clone()))
        .collect()
}

pub(crate) fn canonical_managed_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("La carpeta administrada de descargas no es absoluta".into());
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("No se pudo preparar la carpeta administrada: {error}"))?;
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("No se pudo validar la carpeta administrada: {error}"))?;
    if canonical.parent().is_none() {
        return Err("La raíz del sistema no puede usarse como carpeta administrada".into());
    }
    Ok(canonical)
}

pub(crate) fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut cursor = Some(path);
    while let Some(candidate) = cursor {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        cursor = candidate.parent();
    }
    None
}

pub(crate) fn validate_managed_candidate(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if !candidate.is_absolute() {
        return Err(format!(
            "La ruta administrada no es absoluta: {}",
            candidate.display()
        ));
    }
    if candidate
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!(
            "La ruta contiene segmentos inseguros: {}",
            candidate.display()
        ));
    }
    let root = canonical_managed_root(root)?;
    let ancestor = nearest_existing_ancestor(candidate)
        .ok_or_else(|| "No se encontró un ancestro válido para la ruta".to_string())?;
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("No se pudo validar la ruta administrada: {error}"))?;
    if canonical_ancestor == root && candidate == root.as_path() {
        return Err("No se permite eliminar la carpeta administrada completa".into());
    }
    if !canonical_ancestor.starts_with(&root) {
        return Err(format!(
            "La ruta está fuera de la carpeta administrada: {}",
            candidate.display()
        ));
    }

    let mut cursor = Some(candidate);
    while let Some(path) = cursor {
        if path.exists() {
            let metadata = path
                .symlink_metadata()
                .map_err(|error| format!("No se pudo inspeccionar la ruta: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "La ruta contiene un enlace simbólico y no se eliminará: {}",
                    path.display()
                ));
            }
        }
        if path == root.as_path() {
            break;
        }
        cursor = path.parent();
    }

    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("No se pudo validar la ruta final: {error}"))?;
        if canonical == root || !canonical.starts_with(&root) {
            return Err(format!(
                "La ruta no pertenece al almacenamiento administrado: {}",
                candidate.display()
            ));
        }
        Ok(canonical)
    } else {
        Ok(candidate.to_path_buf())
    }
}

pub(crate) fn remove_link_without_following(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), String> {
    if metadata.is_dir() {
        return fs::remove_dir(path)
            .map_err(|error| format!("No se pudo eliminar el enlace de carpeta: {error}"));
    }
    if metadata.file_type().is_symlink() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(file_error) => fs::remove_dir(path).map_err(|directory_error| {
                format!(
                    "No se pudo eliminar el enlace sin seguirlo: archivo={file_error}; carpeta={directory_error}"
                )
            }),
        };
    }
    fs::remove_file(path)
        .map_err(|error| format!("No se pudo eliminar el enlace de archivo: {error}"))
}

pub(crate) fn remove_directory_tree_without_following_links(path: &Path) -> Result<(), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("No se pudo inspeccionar la carpeta: {error}"))?;
    if metadata.file_type().is_symlink() {
        return remove_link_without_following(path, &metadata);
    }
    if !metadata.is_dir() {
        return Err(format!("La ruta no es una carpeta: {}", path.display()));
    }
    for entry in
        fs::read_dir(path).map_err(|error| format!("No se pudo leer la carpeta: {error}"))?
    {
        let entry = entry.map_err(|error| format!("No se pudo leer una entrada: {error}"))?;
        let child = entry.path();
        let child_metadata = child
            .symlink_metadata()
            .map_err(|error| format!("No se pudo inspeccionar una entrada: {error}"))?;
        if child_metadata.file_type().is_symlink() {
            remove_link_without_following(&child, &child_metadata)?;
        } else if child_metadata.is_dir() {
            remove_directory_tree_without_following_links(&child)?;
        } else if child_metadata.is_file() {
            fs::remove_file(&child)
                .map_err(|error| format!("No se pudo eliminar {}: {error}", child.display()))?;
        }
    }
    fs::remove_dir(path)
        .map_err(|error| format!("No se pudo eliminar la carpeta {}: {error}", path.display()))
}

pub(crate) fn remove_managed_storage_path(
    root: &Path,
    candidate: &Path,
    expected_directory: bool,
) -> Result<bool, String> {
    let validated = validate_managed_candidate(root, candidate)?;
    if !validated.exists() {
        return Ok(false);
    }
    let metadata = validated
        .symlink_metadata()
        .map_err(|error| format!("No se pudo inspeccionar la ruta: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "No se seguirá un enlace simbólico: {}",
            validated.display()
        ));
    }
    if expected_directory {
        if !metadata.is_dir() {
            return Err(format!(
                "Se esperaba una carpeta administrada: {}",
                validated.display()
            ));
        }
        remove_directory_tree_without_following_links(&validated)?;
    } else {
        if !metadata.is_file() {
            return Err(format!(
                "Se esperaba un archivo administrado: {}",
                validated.display()
            ));
        }
        fs::remove_file(&validated)
            .map_err(|error| format!("No se pudo eliminar {}: {error}", validated.display()))?;
    }
    Ok(true)
}

pub(crate) fn job_is_active(state: &LocalState, id: i64) -> bool {
    state
        .active_downloads
        .lock()
        .map(|active| active.contains(&id))
        .unwrap_or(true)
        || state
            .active_media_pids
            .lock()
            .map(|active| active.contains_key(&id))
            .unwrap_or(true)
        || external_processes_active(&state.external_processes, id)
}

pub(crate) fn wait_for_job_idle(state: &LocalState, id: i64) -> bool {
    for _ in 0..200 {
        if !job_is_active(state, id) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn runtime_job_is_active(
    id: i64,
    active_downloads: &Arc<Mutex<HashSet<i64>>>,
    active_media_pids: &Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: &ExternalProcessRegistry,
) -> bool {
    active_downloads
        .lock()
        .map(|active| active.contains(&id))
        .unwrap_or(true)
        || active_media_pids
            .lock()
            .map(|active| active.contains_key(&id))
            .unwrap_or(true)
        || external_processes_active(external_processes, id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn schedule_job_deletion_after_idle(
    id: i64,
    delete_storage: bool,
    db_path: PathBuf,
    active_downloads: Arc<Mutex<HashSet<i64>>>,
    active_media_pids: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    managed_root: PathBuf,
    final_paths: Vec<(PathBuf, bool)>,
    storage_paths: Vec<(PathBuf, bool)>,
) {
    thread::spawn(move || {
        // The UI does not wait for this.  The row remains a database tombstone
        // until every worker has released its readers and writers.
        let mut idle = false;
        for _ in 0..600 {
            if !runtime_job_is_active(
                id,
                &active_downloads,
                &active_media_pids,
                &external_processes,
            ) {
                idle = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !idle {
            return;
        }

        if delete_storage {
            // A Windows reader can outlive the process termination signal by a
            // short interval. Retry in the background instead of exposing that
            // delay to the user or deleting a path before it is safe.
            for (path, is_directory) in &storage_paths {
                let mut removed_or_absent = false;
                for _ in 0..240 {
                    match remove_managed_storage_path(&managed_root, path, *is_directory) {
                        Ok(_) => {
                            removed_or_absent = true;
                            break;
                        }
                        Err(_) => thread::sleep(Duration::from_millis(250)),
                    }
                }
                if !removed_or_absent {
                    return;
                }
            }
        }

        let Ok(mut connection) = Connection::open(&db_path) else {
            return;
        };
        let Ok(transaction) = connection.transaction() else {
            return;
        };
        if delete_storage {
            for (path, _) in &final_paths {
                let _ = transaction.execute(
                    "DELETE FROM recent_files WHERE path=?1",
                    params![path.to_string_lossy().to_string()],
                );
            }
        }
        let Ok(affected) = transaction.execute(
            "DELETE FROM jobs WHERE id=?1 AND status='deleting'",
            params![id],
        ) else {
            return;
        };
        if affected == 0 {
            return;
        }
        let _ = transaction.commit();
    });
}

pub(crate) fn stop_job_internal_without_wait(
    id: i64,
    delete_partial: bool,
    state: &LocalState,
) -> Result<CancelJobReceipt, String> {
    stop_job_internal_with_wait(id, delete_partial, state, false)
}

pub(crate) fn stop_job_internal(
    id: i64,
    delete_partial: bool,
    state: &LocalState,
) -> Result<CancelJobReceipt, String> {
    stop_job_internal_with_wait(id, delete_partial, state, true)
}

fn stop_job_internal_with_wait(
    id: i64,
    delete_partial: bool,
    state: &LocalState,
    wait_for_external: bool,
) -> Result<CancelJobReceipt, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let record = load_job_storage_record(&connection, id)?;
    if record.status == "completed" {
        return Err("Una descarga completada no puede detenerse de emergencia".into());
    }
    let detail = if delete_partial {
        "Detenida de emergencia · eliminando temporales"
    } else {
        "Detenida de emergencia · temporales conservados"
    };
    connection
        .execute(
            "UPDATE jobs SET status='cancelled',cancel_cleanup=?1,progress=CASE WHEN ?1=1 THEN 0 ELSE progress END,detail=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?3",
            params![if delete_partial { 1 } else { 0 }, detail, id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE download_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE media_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE torrent_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_items SET status='cancelled' WHERE job_id=?1 AND status<>'completed'",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE download_schedules SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND enabled=1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);

    if let Ok(active) = state.active_media_pids.lock() {
        if let Some(pid) = active.get(&id).copied().filter(|pid| *pid > 0) {
            kill_process_tree(pid);
        }
    }
    terminate_external_processes(&state.external_processes, id);
    if wait_for_external {
        let _ = wait_for_external_processes_idle(
            &state.external_processes,
            id,
            Duration::from_secs(15),
        );
    }

    let partial_paths = deduplicate_storage_paths(job_partial_storage_paths(&record));
    let partial_path = partial_paths
        .first()
        .map(|(path, _)| path.to_string_lossy().to_string());
    let cleanup_pending = delete_partial && !partial_paths.is_empty();
    if cleanup_pending {
        cleanup_managed_paths_when_idle(
            id,
            state.active_downloads.clone(),
            state.active_media_pids.clone(),
            state.external_processes.clone(),
            current_downloads_dir(state)?,
            partial_paths,
        );
    }

    Ok(CancelJobReceipt {
        job_id: id,
        delete_partial,
        partial_path,
        cleanup_pending,
    })
}
