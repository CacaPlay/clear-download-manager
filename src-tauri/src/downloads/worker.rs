#![allow(clippy::invisible_characters)]
#![allow(clippy::items_after_test_module)]

use super::{
    bytes_look_like_html, canonical_google_docs_export_url, complete_verified_http_job,
    current_downloads_dir, fail_job, finalize_http_job_owned, http_lease_is_current,
    http_v1_observation, human_bytes, isolate_stale_partial, load_http_resume_state,
    mark_http_finalizing, persist_http_representation, release_http_lease,
    request_download_response_with_range_and_validator, response_content_range,
    response_is_unexpected_html, response_total_bytes, sanitize_filename, unique_destination,
    HTTP_STALE_LEASE,
};
use crate::dispatcher;
use crate::progress::adapter::{
    shadow_begin_http, shadow_http_observe, shadow_http_response_headers,
    shadow_mark_http_cancelled, shadow_mark_http_cancelling, shadow_mark_http_completed,
    shadow_mark_http_failed, shadow_mark_http_paused, shadow_mark_http_post_processing,
    shadow_mark_http_preparing,
};
use crate::{
    configure_connection, parse_public_http_url, url_has_public_network_target,
    DownloadQueueReceipt, LocalState, ProgressPersistenceGate, TransferRateSampler,
    WorkerCompletion, WorkerCompletionGuard, DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS, EXIT_REQUESTED,
};
use fs2::FileExt;
use reqwest::blocking::Client;
use reqwest::header::ACCEPT_RANGES;
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const HTTP_IDLE_TIMEOUT_SECS: u64 = 60;

pub(crate) struct ActiveDownloadGuard {
    id: i64,
    active: Arc<Mutex<HashSet<i64>>>,
}

impl Drop for ActiveDownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.id);
        }
    }
}

pub(crate) fn run_download_worker_with_completion(
    db_path: PathBuf,
    active: Arc<Mutex<HashSet<i64>>>,
    id: i64,
    completion: Option<WorkerCompletion>,
) -> bool {
    {
        let mut active_guard = match active.lock() {
            Ok(guard) => guard,
            Err(_) => {
                fail_job(
                    &db_path,
                    id,
                    "No se pudo iniciar la descarga porque el registro de tareas está bloqueado",
                );
                if let Some(completion) = completion {
                    completion();
                }
                return false;
            }
        };
        if !active_guard.insert(id) {
            if let Some(completion) = completion {
                completion();
            }
            return false;
        }
    }

    // Cambia el estado antes de crear el hilo para que la interfaz no permanezca
    // mostrando "En espera" mientras Windows planifica el worker.
    if let Ok(connection) = Connection::open(&db_path) {
        let _ = connection.execute(
            "UPDATE jobs SET status='running', detail='Preparando conexión…', updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('queued','running')",
            params![id],
        );
    }

    thread::spawn(move || {
        let _completion = WorkerCompletionGuard::new(completion);
        let _guard = ActiveDownloadGuard {
            id,
            active: active.clone(),
        };
        shadow_begin_http(id, 0);
        shadow_mark_http_preparing(id);
        if let Err(primary_error) = run_download_worker_inner(&db_path, id) {
            if EXIT_REQUESTED.load(Ordering::SeqCst) {
                return;
            }
            if primary_error == HTTP_STALE_LEASE {
                return;
            }
            if complete_verified_http_job(&db_path, id) {
                return;
            }
            let current_status = Connection::open(&db_path)
                .ok()
                .and_then(|connection| {
                    connection
                        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                            row.get::<_, String>(0)
                        })
                        .ok()
                })
                .unwrap_or_else(|| "failed".into());
            if matches!(
                current_status.as_str(),
                "paused" | "cancelled" | "completed" | "deleting"
            ) {
                if current_status == "paused" {
                    shadow_mark_http_paused(id);
                } else if current_status == "cancelled" {
                    shadow_mark_http_cancelling(id);
                    shadow_mark_http_cancelled(id);
                }
                return;
            }
            shadow_mark_http_failed(id);
            fail_job(&db_path, id, &primary_error);
        }
    });
    true
}

pub(crate) fn run_download_worker(db_path: PathBuf, active: Arc<Mutex<HashSet<i64>>>, id: i64) {
    if dispatcher::wake_if_installed() {
        return;
    }
    let _ = run_download_worker_with_completion(db_path, active, id, None);
}

pub(crate) fn resume_download_worker_when_idle(
    db_path: PathBuf,
    active: Arc<Mutex<HashSet<i64>>>,
    id: i64,
) {
    if dispatcher::wake_if_installed() {
        return;
    }
    thread::spawn(move || {
        for _ in 0..120 {
            let busy = active
                .lock()
                .map(|guard| guard.contains(&id))
                .unwrap_or(true);
            if !busy {
                if let Ok(connection) = Connection::open(&db_path) {
                    let _ = connection.execute(
                        "UPDATE jobs SET status='running',detail='Reanudando descarga…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",
                        params![id],
                    );
                }
                run_download_worker(db_path, active, id);
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        fail_job(
            &db_path,
            id,
            "No fue posible reanudar la descarga porque el proceso anterior no terminó a tiempo",
        );
    });
}

fn acquire_http_writer_lock(temp_path: &Path) -> Result<fs::File, String> {
    let lock_path = PathBuf::from(format!("{}.lock", temp_path.display()));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("No se pudo abrir el ownership lock HTTP: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("No se pudo adquirir el ownership lock HTTP: {error}"))?;
    Ok(lock)
}

fn unsatisfied_range_total(response: &reqwest::blocking::Response) -> Option<u64> {
    response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().strip_prefix("bytes */"))
        .and_then(|value| value.parse::<u64>().ok())
}

fn response_representation_changed(
    state_etag: Option<&str>,
    state_last_modified: Option<&str>,
    response: &reqwest::blocking::Response,
) -> bool {
    let response_etag = super::strong_etag(response);
    let response_last_modified = super::last_modified(response);
    if (state_etag.is_some() && response_etag.is_none())
        || (state_last_modified.is_some() && response_last_modified.is_none())
    {
        return true;
    }
    state_etag
        .zip(response_etag.as_deref())
        .is_some_and(|(old, new)| old != new)
        || state_last_modified
            .zip(response_last_modified.as_deref())
            .is_some_and(|(old, new)| old != new)
}

fn finalize_rust_http_staging(
    db_path: &Path,
    id: i64,
    lease: &super::HttpLease,
    destination: &Path,
    temp_path: &Path,
    downloaded: u64,
    total_bytes: Option<u64>,
) -> Result<(), String> {
    if downloaded == 0 {
        return Err("El servidor no entregó contenido".into());
    }
    if let Some(total) = total_bytes {
        if downloaded != total {
            return Err(format!(
                "La descarga quedó incompleta: {} de {}",
                human_bytes(downloaded),
                human_bytes(total)
            ));
        }
    }
    mark_http_finalizing(db_path, id, lease)?;
    // Windows may reject FlushFileBuffers/SyncAll on a read-only handle
    // (ERROR_ACCESS_DENIED).  Reopen the staging file with write access for
    // the final durability barrier; the transfer writer has already been
    // flushed and closed before this helper is entered.
    let staged = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp_path)
        .map_err(|error| format!("No se pudo abrir el parcial para finalizar: {error}"))?;
    staged
        .sync_all()
        .map_err(|error| format!("No se pudo sincronizar el parcial: {error}"))?;
    drop(staged);
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    if !http_lease_is_current(&connection, id, lease)? {
        return Err(HTTP_STALE_LEASE.into());
    }
    if destination.exists() {
        return Err("Ya existe un archivo con el mismo nombre".into());
    }
    fs::rename(temp_path, destination)
        .map_err(|error| format!("No se pudo finalizar el archivo: {error}"))?;
    let final_size = destination
        .metadata()
        .map_err(|error| format!("No se pudo verificar el archivo final: {error}"))?
        .len();
    if final_size != downloaded {
        return Err("El archivo final no coincide con los bytes descargados".into());
    }
    finalize_http_job_owned(
        db_path,
        id,
        lease,
        destination,
        final_size,
        "Completada y verificada",
    )?;
    shadow_mark_http_completed(id, final_size);
    Ok(())
}

pub(crate) fn run_download_worker_inner(db_path: &Path, id: i64) -> Result<(), String> {
    let Some(lease) = super::claim_http_lease(db_path, id)? else {
        return Ok(());
    };
    let result = run_rust_http_worker(db_path, id, &lease);
    if result.is_err() {
        release_http_lease(db_path, id, &lease);
    }
    result
}

fn run_rust_http_worker(db_path: &Path, id: i64, lease: &super::HttpLease) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let state = load_http_resume_state(db_path, id)?;
    let referrer: String = connection
        .query_row(
            "SELECT COALESCE(referrer,'') FROM download_jobs WHERE job_id=?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    let destination = state.destination.clone();
    let temp_path = state.temp_path.clone();
    let url = canonical_google_docs_export_url(&parse_public_http_url(
        &state.url,
        "El enlace de descarga no es válido",
    )?)
    .map(|value| value.to_string())
    .unwrap_or(state.url);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let writer_lock = acquire_http_writer_lock(&temp_path)?;
    let mut existing = temp_path.metadata().map(|value| value.len()).unwrap_or(0);
    if state.total_bytes.is_some_and(|total| existing > total) {
        let stale = isolate_stale_partial(&temp_path)?;
        return Err(format!(
            "El parcial local supera el tamaño remoto conocido; se conservó en {}",
            stale
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "una ruta aislada".into())
        ));
    }
    if state
        .total_bytes
        .is_some_and(|total| existing == total && total > 0)
    {
        finalize_rust_http_staging(
            db_path,
            id,
            lease,
            &destination,
            &temp_path,
            existing,
            state.total_bytes,
        )?;
        drop(writer_lock);
        return Ok(());
    }

    let client = Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        )
        .connect_timeout(Duration::from_secs(20))
        // reqwest applies this timeout to each blocking read operation, so a
        // large download may run longer while a stalled stream remains bounded.
        .timeout(Duration::from_secs(HTTP_IDLE_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 12 {
                return attempt.error("La descarga superó el límite de redirecciones");
            }
            if url_has_public_network_target(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("La redirección apunta a una dirección local o privada")
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
    // Segmented HTTP remains storage-compatible but is intentionally disabled
    // until every segment shares this lease, validator and finalization path.
    let referrer = (!referrer.trim().is_empty()).then_some(referrer.as_str());
    let mut bandwidth_limiter = super::read_job_bandwidth_policy(&connection, id).limiter();
    let mut bandwidth_limit = bandwidth_limiter
        .as_ref()
        .map(|limiter| limiter.bytes_per_second());
    let if_range = state
        .strong_etag
        .as_deref()
        .or(state.last_modified.as_deref());
    let mut response = request_download_response_with_range_and_validator(
        &client,
        &url,
        (existing > 0).then(|| format!("bytes={existing}-")),
        referrer,
        if_range,
    )?;
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        match unsatisfied_range_total(&response) {
            Some(total) if existing == total => {
                finalize_rust_http_staging(db_path, id, lease, &destination, &temp_path, existing, Some(total))?;
                drop(writer_lock);
                return Ok(());
            }
            Some(total) if existing > total => {
                let stale = isolate_stale_partial(&temp_path)?;
                return Err(format!("El parcial supera el Content-Range remoto ({total}); se conservó en {}", stale.map(|path| path.display().to_string()).unwrap_or_else(|| "una ruta aislada".into())));
            }
            _ => return Err("El servidor rechazó el resume con 416 sin un total coherente; se conservó el parcial".into()),
        }
    }
    if response.status() == StatusCode::OK && existing > 0 {
        isolate_stale_partial(&temp_path)?;
        existing = 0;
    }
    if !response.status().is_success() {
        return Err(format!("El servidor respondió {}", response.status()));
    }
    let mut partial = response.status() == StatusCode::PARTIAL_CONTENT;
    if response_is_unexpected_html(&response, &destination) {
        return Err(
            "El enlace devolvió una página web en vez del archivo. Usa el enlace directo de descarga o vuelve a analizarlo"
                .into(),
        );
    }

    if response.status() == StatusCode::PARTIAL_CONTENT {
        let facts = response_content_range(&response)
            .ok_or_else(|| "El servidor devolvió 206 sin Content-Range válido".to_string())?;
        if facts.start != existing {
            return Err(format!(
                "El servidor reanudó desde un byte inesperado: {} en vez de {}",
                facts.start, existing
            ));
        }
        if state
            .total_bytes
            .is_some_and(|total| facts.total.is_some_and(|remote| remote != total))
            || response_representation_changed(
                state.strong_etag.as_deref(),
                state.last_modified.as_deref(),
                &response,
            )
        {
            isolate_stale_partial(&temp_path)?;
            existing = 0;
            response = request_download_response_with_range_and_validator(
                &client, &url, None, referrer, None,
            )?;
        }
        partial = response.status() == StatusCode::PARTIAL_CONTENT;
        if !response.status().is_success() {
            return Err(format!("El servidor respondió {}", response.status()));
        }
    }

    let accepts_ranges = response
        .headers()
        .get(ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("bytes"))
        .unwrap_or(false);
    let resumable = partial || accepts_ranges;
    let mut total_bytes = response_total_bytes(&response, existing);
    let mut response_etag = super::strong_etag(&response);
    let mut response_last_modified = super::last_modified(&response);
    let mut representation = super::representation_fingerprint(
        &url,
        total_bytes,
        response_etag.as_deref(),
        response_last_modified.as_deref(),
    );
    persist_http_representation(
        db_path,
        id,
        lease,
        total_bytes,
        existing,
        resumable,
        response_etag.as_deref(),
        response_last_modified.as_deref(),
        &representation,
    )?;
    shadow_http_response_headers(
        id,
        response.status().as_u16(),
        existing,
        response.content_length(),
        response_content_range(&response),
        http_v1_observation(existing, total_bytes, None, None, "running", None),
    );

    let mut file = if partial && existing > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp_path)
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_path)
    }
    .map_err(|error| format!("No se pudo crear el archivo temporal: {error}"))?;

    let mut downloaded = existing;
    let mut last_db_update = Instant::now() - Duration::from_secs(1);
    let mut speed_sampler = TransferRateSampler::new(downloaded);
    let mut progress_gate = ProgressPersistenceGate::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut transport_retries = 0_u8;
    let mut inspected_body_prefix = false;

    loop {
        if !http_lease_is_current(&connection, id, lease)? {
            return Err(HTTP_STALE_LEASE.into());
        }
        let status: String = connection
            .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if status == "paused" {
            shadow_mark_http_paused(id);
            connection
                .execute(
                    "UPDATE jobs SET detail='En pausa · archivo parcial conservado', updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                )
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        if status == "cancelled" {
            shadow_mark_http_cancelling(id);
            let delete_partial = connection
                .query_row(
                    "SELECT cancel_cleanup FROM jobs WHERE id=?1",
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(1)
                != 0;
            let detail = if delete_partial {
                "Cancelada · limpieza segura solicitada"
            } else {
                "Cancelada · parcial conservado"
            };
            connection
                .execute(
                    "UPDATE jobs SET detail=?1, progress=0, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![detail, id],
                )
                .map_err(|error| error.to_string())?;
            shadow_mark_http_cancelled(id);
            return Ok(());
        }

        // Context-menu changes are persisted while a Rust HTTP worker is
        // active. Refresh the limiter between reads so an active transfer
        // adopts the new cap without requiring a pause/restart cycle.
        let requested_limit = super::read_job_bandwidth_policy(&connection, id).bytes_per_second();
        if requested_limit != bandwidth_limit {
            bandwidth_limiter = super::read_job_bandwidth_policy(&connection, id).limiter();
            bandwidth_limit = requested_limit;
        }

        let read_budget = bandwidth_limiter
            .as_ref()
            .map(|limiter| limiter.read_grant(buffer.len()))
            .unwrap_or(buffer.len());
        let count = match response.read(&mut buffer[..read_budget]) {
            Ok(0) if total_bytes.is_some_and(|total| downloaded < total) && resumable => {
                if transport_retries >= 4 {
                    return Err(format!(
                        "La descarga terminó antes de tiempo: {} de {}",
                        human_bytes(downloaded),
                        human_bytes(total_bytes.unwrap_or(downloaded))
                    ));
                }
                transport_retries += 1;
                connection
                    .execute(
                        "UPDATE jobs SET detail=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                        params![
                            format!("Reconectando desde {}…", human_bytes(downloaded)),
                            id
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                thread::sleep(Duration::from_secs(u64::from(transport_retries)));
                response = request_download_response_with_range_and_validator(
                    &client,
                    &url,
                    Some(format!("bytes={downloaded}-")),
                    referrer,
                    response_etag
                        .as_deref()
                        .or(response_last_modified.as_deref()),
                )?;
                if response.status() == StatusCode::OK {
                    file.flush().map_err(|error| error.to_string())?;
                    file.sync_all().map_err(|error| error.to_string())?;
                    drop(file);
                    isolate_stale_partial(&temp_path)?;
                    downloaded = 0;
                    total_bytes = response.content_length();
                    response_etag = super::strong_etag(&response);
                    response_last_modified = super::last_modified(&response);
                    representation = super::representation_fingerprint(
                        &url,
                        total_bytes,
                        response_etag.as_deref(),
                        response_last_modified.as_deref(),
                    );
                    persist_http_representation(
                        db_path,
                        id,
                        lease,
                        total_bytes,
                        0,
                        false,
                        response_etag.as_deref(),
                        response_last_modified.as_deref(),
                        &representation,
                    )?;
                    file = OpenOptions::new()
                        .create(true)
                        .write(true)
                        .truncate(true)
                        .open(&temp_path)
                        .map_err(|error| error.to_string())?;
                } else if response.status() != StatusCode::PARTIAL_CONTENT {
                    return Err("La conexión se interrumpió y el servidor no permitió reanudar desde el último byte".into());
                } else {
                    let facts = response_content_range(&response)
                        .ok_or_else(|| "Resume sin Content-Range".to_string())?;
                    if facts.start != downloaded
                        || state
                            .total_bytes
                            .is_some_and(|total| facts.total.is_some_and(|remote| remote != total))
                        || response_representation_changed(
                            response_etag.as_deref(),
                            response_last_modified.as_deref(),
                            &response,
                        )
                    {
                        return Err("La representación remota cambió durante el resume; no se concatenará el parcial".into());
                    }
                }
                speed_sampler.reset(downloaded);
                continue;
            }
            Ok(count) => count,
            Err(error) if resumable && transport_retries < 4 => {
                transport_retries += 1;
                connection
                    .execute(
                        "UPDATE jobs SET detail=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                        params![
                            format!("Conexión interrumpida · reintentando {transport_retries}/4…"),
                            id
                        ],
                    )
                    .map_err(|db_error| db_error.to_string())?;
                thread::sleep(Duration::from_secs(u64::from(transport_retries)));
                response = request_download_response_with_range_and_validator(
                    &client,
                    &url,
                    Some(format!("bytes={downloaded}-")),
                    referrer,
                    response_etag
                        .as_deref()
                        .or(response_last_modified.as_deref()),
                )?;
                if response.status() != StatusCode::PARTIAL_CONTENT {
                    return Err(format!(
                        "La conexión se interrumpió y no fue posible reanudarla: {error}"
                    ));
                }
                let facts = response_content_range(&response)
                    .ok_or_else(|| "Resume sin Content-Range".to_string())?;
                if facts.start != downloaded
                    || response_representation_changed(
                        response_etag.as_deref(),
                        response_last_modified.as_deref(),
                        &response,
                    )
                {
                    return Err("La representación remota cambió durante el resume; no se concatenará el parcial".into());
                }
                speed_sampler.reset(downloaded);
                continue;
            }
            Err(error) => return Err(format!("La conexión se interrumpió: {error}")),
        };
        if count == 0 {
            break;
        }
        if let Some(limiter) = bandwidth_limiter.as_ref() {
            let should_continue = limiter.throttle_bytes(count, || {
                let status: String = connection
                    .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                Ok(matches!(status.as_str(), "paused" | "cancelled"))
            })?;
            if !should_continue {
                continue;
            }
        }
        if !inspected_body_prefix && downloaded == 0 {
            inspected_body_prefix = true;
            if bytes_look_like_html(&buffer[..count]) {
                return Err(
                    "El enlace devolvió una página web en vez del archivo. Usa el enlace directo de descarga o vuelve a analizarlo"
                        .into(),
                );
            }
        }
        transport_retries = 0;
        if !http_lease_is_current(&connection, id, lease)? {
            return Err(HTTP_STALE_LEASE.into());
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("No se pudo escribir el archivo: {error}"))?;
        downloaded += count as u64;
        let shadow_speed = speed_sampler.sample(downloaded);
        let shadow_eta = total_bytes.and_then(|total| {
            (shadow_speed > 1.0 && total > downloaded)
                .then_some(((total - downloaded) as f64 / shadow_speed).ceil() as u64)
        });
        shadow_http_observe(
            id,
            downloaded,
            http_v1_observation(
                downloaded,
                total_bytes,
                (shadow_speed > 0.0).then_some(shadow_speed),
                shadow_eta,
                "running",
                None,
            ),
        );

        if last_db_update.elapsed() >= Duration::from_millis(DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS) {
            let speed = speed_sampler.sample(downloaded);
            let progress = total_bytes
                .filter(|total| *total > 0)
                .map(|total| downloaded as f64 * 100.0 / total as f64)
                .unwrap_or(0.0)
                .clamp(0.0, 99.9);
            if !progress_gate.should_persist(downloaded, progress, Duration::ZERO) {
                continue;
            }
            let detail = match total_bytes {
                Some(total) => format!(
                    "{} / {} · {}/s",
                    human_bytes(downloaded),
                    human_bytes(total),
                    human_bytes(speed as u64)
                ),
                None => format!(
                    "{} descargados · {}/s · tamaño total desconocido",
                    human_bytes(downloaded),
                    human_bytes(speed as u64)
                ),
            };
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| error.to_string())?;
            let job_changed = transaction
                .execute(
                    "UPDATE jobs SET progress=?1, detail=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND EXISTS (SELECT 1 FROM download_jobs WHERE job_id=?3 AND ownership_generation=?4 AND ownership_token=?5)",
                    params![progress, detail, id, lease.generation, lease.token],
                )
                .map_err(|error| error.to_string())?;
            if job_changed != 1 {
                return Err(HTTP_STALE_LEASE.into());
            }
            let eta_seconds = total_bytes.and_then(|total| {
                (speed > 1.0 && total > downloaded)
                    .then_some(((total - downloaded) as f64 / speed).ceil() as i64)
            });
            transaction
                .execute(
                    "UPDATE download_jobs SET downloaded_bytes=?1,speed_bps=?2,eta_seconds=?3,updated_at=CURRENT_TIMESTAMP WHERE job_id=?4 AND ownership_generation=?5 AND ownership_token=?6",
                    params![downloaded as i64, speed, eta_seconds, id, lease.generation, lease.token],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            progress_gate.mark_persisted(downloaded, progress);
            last_db_update = Instant::now();
        }
    }

    file.flush().map_err(|error| error.to_string())?;
    file.sync_all()
        .map_err(|error| format!("No se pudo sincronizar el archivo: {error}"))?;
    drop(file);
    shadow_mark_http_post_processing(id);
    finalize_rust_http_staging(
        db_path,
        id,
        lease,
        &destination,
        &temp_path,
        downloaded,
        total_bytes,
    )?;
    drop(writer_lock);
    Ok(())
}

pub(crate) fn create_http_download_job(
    db_path: &Path,
    active_downloads: Arc<Mutex<HashSet<i64>>>,
    downloads_dir: &Path,
    source_url: &Url,
    filename: &str,
    detail: &str,
    referrer: Option<&str>,
) -> Result<DownloadQueueReceipt, String> {
    fs::create_dir_all(downloads_dir).map_err(|error| error.to_string())?;
    let filename = sanitize_filename(filename);
    // Reserve the partial path before touching SQLite. This closes the race
    // where two rapid queue requests both observed the same empty destination
    // and subsequently shared one .part/aria2 output.
    let (destination, temp_path) = reserve_http_destination(downloads_dir, &filename)?;
    let database_result = (|| {
        let mut connection = Connection::open(db_path).map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO jobs(title,detail,progress,status,updated_at) VALUES(?1,?2,0,'queued',CURRENT_TIMESTAMP)",
                params![filename, detail],
            )
            .map_err(|error| error.to_string())?;
        let job_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path,referrer) VALUES(?1,?2,?3,?4,?5)",
                params![
                    job_id,
                    source_url.to_string(),
                    destination.to_string_lossy().to_string(),
                    temp_path.to_string_lossy().to_string(),
                    referrer.unwrap_or_default()
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok::<_, String>(job_id)
    })();
    let job_id = match database_result {
        Ok(job_id) => job_id,
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
    };
    run_download_worker(db_path.to_path_buf(), active_downloads, job_id);
    Ok(DownloadQueueReceipt {
        job_id,
        filename,
        destination: destination.to_string_lossy().to_string(),
        resumable: false,
    })
}

fn reserve_http_destination(
    downloads_dir: &Path,
    filename: &str,
) -> Result<(PathBuf, PathBuf), String> {
    for _ in 0..10_000 {
        let destination = unique_destination(downloads_dir, filename);
        let temp_path = PathBuf::from(format!("{}.part", destination.display()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => {
                drop(file);
                return Ok((destination, temp_path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "No se pudo reservar el destino de la descarga: {error}"
                ));
            }
        }
    }
    Err("No se pudo reservar un destino único para la descarga".into())
}

#[cfg(test)]
mod destination_reservation_tests {
    use super::{finalize_rust_http_staging, reserve_http_destination, run_download_worker_inner};
    use crate::db::migrate;
    use rusqlite::{params, Connection};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reservations_avoid_legacy_segments_and_partial_collisions() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "cacatools-http-reservation-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary directory");
        let legacy_segment = directory.join("same-file.exe.part.segment-000.part");
        fs::write(&legacy_segment, b"historical segment").expect("legacy segment");
        let first = reserve_http_destination(&directory, "same-file.exe").expect("first");
        let second = reserve_http_destination(&directory, "same-file.exe").expect("second");
        assert_eq!(first.0, directory.join("same-file (2).exe"));
        assert_ne!(first.0, second.0);
        assert_ne!(first.1, second.1);
        assert!(first.1.is_file());
        assert!(second.1.is_file());
        assert_eq!(
            fs::read(&legacy_segment).expect("legacy segment remains"),
            b"historical segment"
        );
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn finalization_syncs_and_renames_a_complete_staging_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cacatools-http-finalization-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let db_path = root.join("state.sqlite");
        let destination = root.join("tool.exe");
        let temp_path = root.join("tool.exe.part");
        let payload = b"deterministic complete HTTP payload";
        fs::write(&temp_path, payload).expect("write staging file");

        let connection = Connection::open(&db_path).expect("open test database");
        migrate(&connection).expect("migrate test database");
        connection
            .execute(
                "INSERT INTO jobs(title,status,detail) VALUES(?1,'queued','Transferencia')",
                params!["tool.exe"],
            )
            .expect("insert test job");
        let id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path,total_bytes,downloaded_bytes,resumable) VALUES(?1,?2,?3,?4,?5,?6,1)",
                params![
                    id,
                    "https://example.test/tool.exe",
                    destination.to_string_lossy().to_string(),
                    temp_path.to_string_lossy().to_string(),
                    payload.len() as i64,
                    payload.len() as i64,
                ],
            )
            .expect("insert HTTP job");
        drop(connection);

        let lease = crate::downloads::claim_http_lease(&db_path, id)
            .expect("claim HTTP lease")
            .expect("queued job claim");
        finalize_rust_http_staging(
            &db_path,
            id,
            &lease,
            &destination,
            &temp_path,
            payload.len() as u64,
            Some(payload.len() as u64),
        )
        .expect("finalize complete staging file");

        assert!(destination.is_file());
        assert!(!temp_path.exists());
        let connection = Connection::open(&db_path).expect("reopen test database");
        let state: (String, f64, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT jobs.status,jobs.progress,download_jobs.downloaded_bytes,download_jobs.total_bytes,download_jobs.error FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE jobs.id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("read finalized state");
        assert_eq!(state.0, "completed");
        assert_eq!(state.1, 100.0);
        assert_eq!(state.2, payload.len() as i64);
        assert_eq!(state.3, payload.len() as i64);
        assert!(state.4.is_none());

        drop(connection);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn complete_partial_is_finalized_through_http_worker_without_network_request() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cacatools-http-worker-complete-part-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let db_path = root.join("state.sqlite");
        let destination = root.join("recovered.rar");
        let temp_path = root.join("recovered.rar.part");
        let payload = b"complete partial recovered by the production worker";
        fs::write(&temp_path, payload).expect("write complete partial");

        let connection = Connection::open(&db_path).expect("open test database");
        migrate(&connection).expect("migrate test database");
        connection
            .execute(
                "INSERT INTO jobs(title,status,detail,progress) VALUES(?1,'queued','Transferencia',100)",
                params!["recovered.rar"],
            )
            .expect("insert test job");
        let id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path,total_bytes,downloaded_bytes,resumable) VALUES(?1,?2,?3,?4,?5,?6,1)",
                params![
                    id,
                    "https://example.test/recovered.rar",
                    destination.to_string_lossy().to_string(),
                    temp_path.to_string_lossy().to_string(),
                    payload.len() as i64,
                    // This deliberately mirrors the historical database drift:
                    // the persisted counter may be stale while the on-disk
                    // partial is exactly the remote size.
                    payload.len() as i64 + 8192,
                ],
            )
            .expect("insert HTTP job");
        drop(connection);

        run_download_worker_inner(&db_path, id).expect("worker finalizes complete partial");

        assert!(destination.is_file());
        assert!(!temp_path.exists());
        let connection = Connection::open(&db_path).expect("reopen test database");
        let state: (String, f64, i64, i64, Option<String>, String) = connection
            .query_row(
                "SELECT jobs.status,jobs.progress,download_jobs.downloaded_bytes,download_jobs.total_bytes,download_jobs.error,download_jobs.finalization_state FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE jobs.id=?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("read worker state");
        assert_eq!(state.0, "completed");
        assert_eq!(state.1, 100.0);
        assert_eq!(state.2, payload.len() as i64);
        assert_eq!(state.3, payload.len() as i64);
        assert!(state.4.is_none());
        assert_eq!(state.5, "none");

        drop(connection);
        fs::remove_dir_all(root).expect("cleanup");
    }
}

pub(crate) fn queue_http_download_inner(
    url: &str,
    filename: &str,
    state: &LocalState,
) -> Result<DownloadQueueReceipt, String> {
    let parsed = parse_public_http_url(url, "El enlace capturado no es válido")?;
    let downloads_dir = current_downloads_dir(state)?;
    create_http_download_job(
        &state.db_path,
        state.active_downloads.clone(),
        &downloads_dir,
        &parsed,
        filename,
        "Descarga capturada desde el navegador",
        None,
    )
}
