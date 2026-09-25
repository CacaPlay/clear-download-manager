#![allow(clippy::invisible_characters)]

use crate::progress::adapter::{shadow_mark_http_completed, shadow_mark_http_finalizing};
use crate::progress::http::{parse_content_range, ContentRangeFacts, HttpV1Observation};
use crate::{
    configure_connection, ensure_public_network_resolution, parse_public_http_url,
    recent_kind_from_path, url_has_public_http_target, url_has_public_network_target,
};
use reqwest::blocking::Client;
use reqwest::header::{
    CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE,
    LAST_MODIFIED, RANGE,
};
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub(crate) const HTTP_STALE_LEASE: &str = "http_stale_lease";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpLease {
    pub(crate) generation: i64,
    pub(crate) token: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HttpResumeState {
    pub(crate) url: String,
    pub(crate) destination: PathBuf,
    pub(crate) temp_path: PathBuf,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) downloaded_bytes: u64,
    pub(crate) strong_etag: Option<String>,
    pub(crate) last_modified: Option<String>,
    pub(crate) representation_fingerprint: String,
}

pub(crate) fn load_http_resume_state(db_path: &Path, id: i64) -> Result<HttpResumeState, String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT url,destination,temp_path,total_bytes,downloaded_bytes,strong_etag,last_modified,COALESCE(representation_fingerprint,'') FROM download_jobs WHERE job_id=?1",
            params![id],
            |row| {
                Ok(HttpResumeState {
                    url: row.get(0)?,
                    destination: PathBuf::from(row.get::<_, String>(1)?),
                    temp_path: PathBuf::from(row.get::<_, String>(2)?),
                    total_bytes: row.get::<_, Option<i64>>(3)?.filter(|value| *value > 0).map(|value| value as u64),
                    downloaded_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                    strong_etag: row.get(5)?,
                    last_modified: row.get(6)?,
                    representation_fingerprint: row.get(7)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn claim_http_lease(db_path: &Path, id: i64) -> Result<Option<HttpLease>, String> {
    let mut connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (status, generation): (String, i64) = transaction
        .query_row(
            "SELECT jobs.status,COALESCE(download_jobs.ownership_generation,0) FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE jobs.id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    if matches!(
        status.as_str(),
        "paused" | "cancelled" | "completed" | "deleting"
    ) {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let next_generation = generation
        .checked_add(1)
        .ok_or_else(|| "La generación de ownership HTTP alcanzó su límite".to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let token = format!("{}-{nanos}-{next_generation}", process::id());
    let changed = transaction
        .execute(
            "UPDATE download_jobs SET ownership_generation=?1,ownership_token=?2,finalization_state='downloading',updated_at=CURRENT_TIMESTAMP WHERE job_id=?3 AND EXISTS (SELECT 1 FROM jobs WHERE id=?3 AND status IN ('queued','running'))",
            params![next_generation, token, id],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    transaction
        .execute(
            "UPDATE jobs SET status='running',detail='Conectando…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('queued','running')",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(Some(HttpLease {
        generation: next_generation,
        token,
    }))
}

pub(crate) fn http_lease_is_current(
    connection: &Connection,
    id: i64,
    lease: &HttpLease,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT ownership_generation,ownership_token FROM download_jobs WHERE job_id=?1",
            params![id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map(|(generation, token)| generation == lease.generation && token == lease.token)
        .map_err(|error| error.to_string())
}

pub(crate) fn release_http_lease(db_path: &Path, id: i64, lease: &HttpLease) {
    if let Ok(connection) = Connection::open(db_path) {
        let _ = configure_connection(&connection);
        let _ = connection.execute(
            "UPDATE download_jobs SET ownership_token='',finalization_state=CASE WHEN finalization_state='finalizing' THEN finalization_state ELSE 'none' END,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND ownership_generation=?2 AND ownership_token=?3",
            params![id, lease.generation, lease.token],
        );
    }
}

pub(crate) fn mark_http_finalizing(
    db_path: &Path,
    id: i64,
    lease: &HttpLease,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let changed = connection
        .execute(
            "UPDATE download_jobs SET finalization_state='finalizing',speed_bps=0,eta_seconds=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND ownership_generation=?2 AND ownership_token=?3",
            params![id, lease.generation, lease.token],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 || !http_lease_is_current(&connection, id, lease)? {
        return Err(HTTP_STALE_LEASE.into());
    }
    connection
        .execute(
            "UPDATE jobs SET progress=CASE WHEN progress < 100 THEN 100 ELSE progress END,detail='Finalizando…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='running'",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_http_representation(
    db_path: &Path,
    id: i64,
    lease: &HttpLease,
    total: Option<u64>,
    downloaded: u64,
    resumable: bool,
    etag: Option<&str>,
    last_modified: Option<&str>,
    fingerprint: &str,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let changed = connection
        .execute(
            "UPDATE download_jobs SET total_bytes=?1,remote_size=?1,downloaded_bytes=?2,resumable=?3,strong_etag=?4,last_modified=?5,representation_fingerprint=?6,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?7 AND ownership_generation=?8 AND ownership_token=?9",
            params![total.map(|value| value as i64), downloaded as i64, resumable as i64, etag, last_modified, fingerprint, id, lease.generation, lease.token],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 || !http_lease_is_current(&connection, id, lease)? {
        return Err(HTTP_STALE_LEASE.into());
    }
    Ok(())
}

pub(crate) fn strong_etag(response: &reqwest::blocking::Response) -> Option<String> {
    response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.starts_with('"') && !value.starts_with("W/"))
        .map(str::to_string)
}

pub(crate) fn last_modified(response: &reqwest::blocking::Response) -> Option<String> {
    response
        .headers()
        .get(LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn representation_fingerprint(
    url: &str,
    total: Option<u64>,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(url.as_bytes());
    digest.update([0]);
    digest.update(total.unwrap_or(0).to_le_bytes());
    digest.update([0]);
    digest.update(etag.unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(last_modified.unwrap_or_default().as_bytes());
    format!("sha256:{:x}", digest.finalize())
}

pub(crate) fn isolate_stale_partial(temp_path: &Path) -> Result<Option<PathBuf>, String> {
    if !temp_path.exists() {
        return Ok(None);
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let stale = PathBuf::from(format!("{}.stale-{nanos}.part", temp_path.display()));
    fs::rename(temp_path, &stale)
        .map_err(|error| format!("No se pudo aislar el parcial obsoleto: {error}"))?;
    Ok(Some(stale))
}

#[derive(Debug)]
pub(crate) struct RemoteDownloadProbe {
    pub(crate) final_url: Url,
    pub(crate) content_disposition: Option<String>,
    pub(crate) content_type: Option<String>,
    pub(crate) content_length: Option<u64>,
}

pub(crate) fn remote_download_probe(parsed: &Url) -> Result<RemoteDownloadProbe, String> {
    ensure_public_network_resolution(parsed)?;
    let client = Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        )
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("La descarga superó el límite de redirecciones");
            }
            if url_has_public_network_target(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("La redirección apunta a una dirección local o privada")
            }
        }))
        .build()
        .map_err(|error| format!("No se pudo preparar la comprobación del archivo: {error}"))?;

    let head = client
        .head(parsed.clone())
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .send();
    if let Ok(response) = head {
        if response.status().is_success()
            && (response.headers().contains_key(CONTENT_TYPE)
                || response.headers().contains_key(CONTENT_LENGTH)
                || response.headers().contains_key(CONTENT_RANGE))
        {
            return remote_download_probe_from_response(response);
        }
    }

    let ranged = client
        .get(parsed.clone())
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .header(RANGE, "bytes=0-0")
        .send();
    if let Ok(response) = ranged {
        if response.status().is_success()
            && (response.headers().contains_key(CONTENT_TYPE)
                || response.headers().contains_key(CONTENT_LENGTH)
                || response.headers().contains_key(CONTENT_RANGE))
        {
            return remote_download_probe_from_response(response);
        }
    }

    // Some document/object stores reject HEAD and byte-range probes with 400,
    // while a normal GET is a valid download.  Read headers only and drop the
    // body; this does not persist or consume the file in the application.
    let response = client
        .get(parsed.clone())
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .send()
        .map_err(|error| format!("No se pudo inspeccionar el archivo remoto: {error}"))?;
    if response.status().is_success() {
        return remote_download_probe_from_response(response);
    }
    Err(format!(
        "El servidor respondió {} al inspeccionar el archivo",
        response.status()
    ))
}

fn remote_download_probe_from_response(
    response: reqwest::blocking::Response,
) -> Result<RemoteDownloadProbe, String> {
    if !response.status().is_success() {
        return Err(format!(
            "El servidor respondió {} al inspeccionar el archivo",
            response.status()
        ));
    }
    let final_url = response.url().clone();
    if !url_has_public_http_target(&final_url) {
        return Err("La descarga terminó en una dirección local o privada no permitida".into());
    }
    let content_disposition = response
        .headers()
        .get(CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_length = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| response.content_length());
    Ok(RemoteDownloadProbe {
        final_url,
        content_disposition,
        content_type,
        content_length,
    })
}

fn sanitize_http_diagnostic(message: &str) -> String {
    let redacted = message
        .split_whitespace()
        .map(|part| {
            let leading_len = part
                .chars()
                .take_while(|character| matches!(character, '(' | '[' | '{'))
                .map(char::len_utf8)
                .sum::<usize>();
            let trailing_len = part
                .chars()
                .rev()
                .take_while(|character| matches!(character, ')' | ']' | '}' | ',' | ';'))
                .map(char::len_utf8)
                .sum::<usize>();
            let end = part.len().saturating_sub(trailing_len);
            let leading_end = leading_len.min(end);
            let middle_end = end.max(leading_end);
            let leading = &part[..leading_end];
            let middle = &part[leading_end..middle_end];
            let trailing = &part[middle_end..];
            let replacement = Url::parse(middle).ok().map(|mut parsed| {
                if parsed.query().is_some() {
                    parsed.set_query(None);
                }
                parsed.to_string()
            });
            format!(
                "{leading}{}{trailing}",
                replacement.as_deref().unwrap_or(middle)
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    redacted
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(2000)
        .collect()
}

pub(crate) fn http_failure_detail(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("captcha")
        || lower.contains("verify you are human")
        || lower.contains("unusual traffic")
    {
        "Intervención Requerida · completa la verificación del servidor y vuelve a intentar"
    } else if lower.contains("429") || lower.contains("too many requests") {
        "Límite Temporal · el servidor recibió demasiadas solicitudes"
    } else if lower.contains("401")
        || lower.contains("www-authenticate")
        || lower.contains("authentication required")
    {
        "Sesión Requerida · el servidor exige autenticación para este enlace"
    } else if lower.contains("403") || lower.contains("forbidden") {
        "Sesión Requerida · el servidor rechazó el enlace o requiere un enlace temporal nuevo"
    } else if lower.contains("404") || lower.contains("not found") {
        "Archivo no encontrado · comprueba que el enlace siga vigente"
    } else if lower.contains("408")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection")
    {
        "Conexión Temporal · no se pudo completar la transferencia después de varios intentos"
    } else if lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
    {
        "Servidor No Disponible · vuelve a intentarlo en unos momentos"
    } else if lower.contains("html") || lower.contains("página web") {
        "Enlace no descargable · el servidor devolvió una página web en vez del archivo"
    } else {
        "Descarga no completada · revisa el enlace y vuelve a intentarlo"
    }
}

pub(crate) fn fail_job(db_path: &Path, id: i64, message: &str) {
    // A transport error can arrive after the bytes and final rename succeeded
    // but before the SQLite commit was observed by the worker.  Recover that
    // verified artifact first; otherwise a late error could overwrite a real
    // completed download with the red Error state.
    if complete_verified_http_job(db_path, id) {
        return;
    }
    if let Ok(connection) = Connection::open(db_path) {
        let _ = configure_connection(&connection);
        let changed = connection
            .execute(
                "UPDATE jobs SET status='failed', detail=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status NOT IN ('completed','cancelled','paused','deleting')",
                params![http_failure_detail(message), id],
            )
            .unwrap_or(0);
        if changed == 0 {
            return;
        }
        let _ = connection.execute(
            "UPDATE download_jobs SET error=?1, updated_at=CURRENT_TIMESTAMP WHERE job_id=?2 AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='failed')",
            params![sanitize_http_diagnostic(message), id],
        );
    }
}

fn verify_http_final_artifact(destination: &Path, expected_size: u64) -> Result<u64, String> {
    let metadata = fs::metadata(destination)
        .map_err(|error| format!("No existe el archivo final verificable: {error}"))?;
    if !metadata.is_file() {
        return Err("La salida final no es un archivo regular".into());
    }
    let final_size = metadata.len();
    if final_size == 0 {
        return Err("El archivo final está vacío".into());
    }
    if expected_size > 0 && final_size != expected_size {
        return Err(format!(
            "El archivo final tiene {} de {}",
            final_size, expected_size
        ));
    }
    let mut file = fs::File::open(destination)
        .map_err(|error| format!("No se pudo leer el archivo final: {error}"))?;
    let mut prefix = vec![0_u8; 2048];
    let read = file
        .read(&mut prefix)
        .map_err(|error| format!("No se pudo comprobar el archivo final: {error}"))?;
    if bytes_look_like_html(&prefix[..read]) {
        return Err("El archivo final contiene HTML en lugar del archivo solicitado".into());
    }
    Ok(final_size)
}

fn load_http_finalization_record(
    db_path: &Path,
    id: i64,
) -> Option<(String, PathBuf, PathBuf, Option<i64>, i64)> {
    Connection::open(db_path).ok().and_then(|connection| {
        let _ = configure_connection(&connection);
        connection
            .query_row(
                "SELECT jobs.status,download_jobs.destination,download_jobs.temp_path,download_jobs.total_bytes,download_jobs.downloaded_bytes FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE jobs.id=?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        PathBuf::from(row.get::<_, String>(1)?),
                        PathBuf::from(row.get::<_, String>(2)?),
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .ok()
    })
}

pub(crate) fn finalize_http_job(
    db_path: &Path,
    id: i64,
    destination: &Path,
    final_size: u64,
    detail: &str,
) -> Result<(), String> {
    let final_size = verify_http_final_artifact(destination, final_size)?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Descarga completada");
    let mut errors = Vec::new();

    for attempt in 0..5_u64 {
        let connection = match Connection::open(db_path) {
            Ok(connection) => connection,
            Err(error) => {
                errors.push(error.to_string());
                thread::sleep(Duration::from_millis(150 * (attempt + 1)));
                continue;
            }
        };
        if let Err(error) = configure_connection(&connection) {
            errors.push(error.to_string());
            thread::sleep(Duration::from_millis(150 * (attempt + 1)));
            continue;
        }

        let transaction_result = (|| -> Result<(), String> {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| error.to_string())?;
            let changed = transaction
                .execute(
                    "UPDATE jobs SET status='completed',progress=100,detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status NOT IN ('paused','cancelled','deleting')",
                    params![detail, id],
                )
                .map_err(|error| error.to_string())?;
            if changed == 0 {
                let current_status = transaction
                    .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|error| error.to_string())?;
                if current_status == "completed" {
                    transaction.commit().map_err(|error| error.to_string())?;
                    return Ok(());
                }
                return Err(format!(
                    "La tarea no puede finalizar desde el estado {current_status}"
                ));
            }
            let download_changed = transaction
                .execute(
                    "UPDATE download_jobs SET downloaded_bytes=?1,total_bytes=?1,remote_size=?1,speed_bps=0,eta_seconds=0,http_engine_attempts=0,error=NULL,ownership_token='',finalization_state='none',updated_at=CURRENT_TIMESTAMP WHERE job_id=?2 AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='completed')",
                    params![final_size as i64, id],
                )
                .map_err(|error| error.to_string())?;
            if download_changed != 1 {
                return Err("La tarea no tiene un registro HTTP finalizable".into());
            }
            transaction
                .execute(
                    "INSERT INTO recent_files(name,path,category,kind,opened_at) VALUES(?1,?2,'Descargas',?3,CURRENT_TIMESTAMP) ON CONFLICT(path) DO UPDATE SET name=excluded.name,category=excluded.category,kind=excluded.kind,opened_at=CURRENT_TIMESTAMP",
                    params![
                        filename,
                        destination.to_string_lossy().to_string(),
                        recent_kind_from_path(destination)
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())
        })();
        if transaction_result.is_ok() {
            return Ok(());
        }
        if let Err(error) = transaction_result {
            errors.push(error);
        }

        // The recent-files index is secondary.  A failure there must never
        // downgrade a verified file to Error; commit the authoritative job
        // state independently and let the index be repaired later.
        let core_result = (|| -> Result<(), String> {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| error.to_string())?;
            let changed = transaction
                .execute(
                    "UPDATE jobs SET status='completed',progress=100,detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status NOT IN ('paused','cancelled','deleting')",
                    params![detail, id],
                )
                .map_err(|error| error.to_string())?;
            if changed == 0 {
                let current_status = transaction
                    .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|error| error.to_string())?;
                if current_status == "completed" {
                    transaction.commit().map_err(|error| error.to_string())?;
                    return Ok(());
                }
                return Err(format!(
                    "La tarea no puede finalizar desde el estado {current_status}"
                ));
            }
            let download_changed = transaction
                .execute(
                    "UPDATE download_jobs SET downloaded_bytes=?1,total_bytes=?1,remote_size=?1,speed_bps=0,eta_seconds=0,http_engine_attempts=0,error=NULL,ownership_token='',finalization_state='none',updated_at=CURRENT_TIMESTAMP WHERE job_id=?2 AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='completed')",
                    params![final_size as i64, id],
                )
                .map_err(|error| error.to_string())?;
            if download_changed != 1 {
                return Err("La tarea no tiene un registro HTTP finalizable".into());
            }
            transaction.commit().map_err(|error| error.to_string())
        })();
        if core_result.is_ok() {
            return Ok(());
        }
        if let Err(error) = core_result {
            errors.push(error);
        }
        if attempt < 4 {
            thread::sleep(Duration::from_millis(250 * (attempt + 1)));
        }
    }

    Err(format!(
        "El archivo fue verificado, pero no se pudo confirmar su estado en la base local: {}",
        errors
            .last()
            .map(String::as_str)
            .unwrap_or("error desconocido")
    ))
}

/// Finalize only while the caller still owns the persistent HTTP lease.
/// `finalization_state` prevents a second worker from claiming a job while
/// the staging file is being moved and committed.
pub(crate) fn finalize_http_job_owned(
    db_path: &Path,
    id: i64,
    lease: &HttpLease,
    destination: &Path,
    final_size: u64,
    detail: &str,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    if !http_lease_is_current(&connection, id, lease)? {
        return Err(HTTP_STALE_LEASE.into());
    }
    drop(connection);
    finalize_http_job(db_path, id, destination, final_size, detail)
}

pub(crate) fn complete_verified_http_job(db_path: &Path, id: i64) -> bool {
    let Some((status, destination, temp_path, total, downloaded)) =
        load_http_finalization_record(db_path, id)
    else {
        return false;
    };
    if matches!(status.as_str(), "paused" | "cancelled" | "deleting") || temp_path.exists() {
        return false;
    }
    let expected_size = total.filter(|value| *value > 0).unwrap_or(0) as u64;
    let Ok(final_size) = verify_http_final_artifact(&destination, expected_size) else {
        return false;
    };
    if total.is_none() && downloaded > 0 && downloaded as u64 != final_size {
        return false;
    }
    if status == "completed" {
        shadow_mark_http_completed(id, final_size);
        return true;
    }
    shadow_mark_http_finalizing(id);
    let finalized = finalize_http_job(
        db_path,
        id,
        &destination,
        final_size,
        "Completada y verificada · recuperación de finalización",
    )
    .is_ok();
    if finalized {
        shadow_mark_http_completed(id, final_size);
        // aria2 conserva su control mientras existe un parcial. Si la
        // comprobación de tamaño recupera una salida completa después de un
        // cierre anómalo, también debemos retirar ese control aquí.
        let _ = fs::remove_file(PathBuf::from(format!("{}.aria2", destination.display())));
    }
    finalized
}

pub(crate) fn request_download_response(
    client: &Client,
    url: &str,
    offset: u64,
) -> Result<reqwest::blocking::Response, String> {
    request_download_response_with_range_and_validator(
        client,
        url,
        (offset > 0).then(|| format!("bytes={offset}-")),
        None,
        None,
    )
}

pub(super) fn request_download_response_with_range(
    client: &Client,
    url: &str,
    range: Option<String>,
    referrer: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    request_download_response_with_range_and_validator(client, url, range, referrer, None)
}

pub(super) fn request_download_response_with_range_and_validator(
    client: &Client,
    url: &str,
    range: Option<String>,
    referrer: Option<&str>,
    if_range: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let parsed = parse_public_http_url(url, "El enlace de descarga no es válido")?;
    ensure_public_network_resolution(&parsed)?;
    let referer = referrer
        .and_then(|value| Url::parse(value.trim()).ok())
        .filter(|value| matches!(value.scheme(), "http" | "https"))
        .filter(url_has_public_network_target)
        .map(|value| value.to_string())
        .unwrap_or_else(|| parsed.origin().ascii_serialization());
    let mut errors = Vec::new();
    for attempt in 0..4_u64 {
        let mut request = client
            .get(url)
            .header("Accept", "*/*")
            .header("Accept-Language", "es-ES,es;q=0.9,en;q=0.7")
            .header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Referer", referer.as_str())
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "same-origin");
        if let Some(range) = range.as_deref() {
            request = request.header(RANGE, range);
        }
        if let Some(if_range) = if_range.filter(|value| !value.trim().is_empty()) {
            request = request.header(IF_RANGE, if_range);
        }
        match request.send() {
            Ok(response)
                if (response.status().is_server_error()
                    || response.status() == StatusCode::REQUEST_TIMEOUT
                    || response.status() == StatusCode::TOO_MANY_REQUESTS)
                    && attempt < 3 =>
            {
                errors.push(format!("El servidor respondió {}", response.status()));
                thread::sleep(Duration::from_millis(650 * (attempt + 1)));
            }
            Ok(response) => return Ok(response),
            Err(error) => {
                errors.push(error.to_string());
                if attempt < 3 {
                    thread::sleep(Duration::from_millis(650 * (attempt + 1)));
                }
            }
        }
    }
    let message = errors
        .last()
        .map(String::as_str)
        .unwrap_or("error desconocido");
    Err(format!(
        "No se pudo conectar después de varios intentos: {message}"
    ))
}

pub(crate) fn response_total_bytes(
    response: &reqwest::blocking::Response,
    existing: u64,
) -> Option<u64> {
    response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| response.content_length().map(|length| length + existing))
}

pub(super) fn http_v1_observation(
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed_bps: Option<f64>,
    eta_seconds: Option<u64>,
    status: &str,
    final_size: Option<u64>,
) -> HttpV1Observation {
    HttpV1Observation {
        downloaded_bytes,
        total_bytes,
        progress: total_bytes
            .filter(|total| *total > 0)
            .map(|total| (downloaded_bytes as f64 / total as f64).clamp(0.0, 1.0)),
        speed_bps,
        eta_seconds,
        status: status.to_string(),
        final_size,
    }
}

pub(super) fn response_content_range(
    response: &reqwest::blocking::Response,
) -> Option<ContentRangeFacts> {
    response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
}

pub(crate) fn response_is_unexpected_html(
    response: &reqwest::blocking::Response,
    destination: &Path,
) -> bool {
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "html" | "htm" | "xhtml") {
        return false;
    }
    response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false)
}

pub(crate) fn should_try_curl_fallback(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    !lower.contains("aria2c_retryable")
        && !lower.contains("aria2c_resume_exhausted")
        && !lower.contains("curl_retry_exhausted")
        && !lower.contains("media_redirect_required")
        && !lower.contains("html_direct_unsupported")
        && !lower.contains("página web en vez del archivo")
        && !lower.contains("solo se permiten")
        && !lower.contains("dirección local o privada")
        && !lower.contains("redirección apunta")
        && !lower.contains("cancelada")
        && !lower.contains("ya existe un archivo")
}

pub(crate) fn downloaded_file_looks_like_html(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut prefix = vec![0_u8; 2048];
    let Ok(read) = file.read(&mut prefix) else {
        return false;
    };
    let text = String::from_utf8_lossy(&prefix[..read]).to_ascii_lowercase();
    text.contains("<!doctype html")
        || text.contains("<html")
        || text.contains("<head") && text.contains("<body")
}

pub(super) fn bytes_look_like_html(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    text.starts_with("<!doctype html")
        || text.starts_with("<html")
        || text.starts_with("<head")
        || (text.starts_with('<') && text.contains("<body"))
}

#[cfg(test)]
mod tests {
    use super::{complete_verified_http_job, sanitize_http_diagnostic, verify_http_final_artifact};
    use crate::db::migrate;
    use rusqlite::{params, Connection};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sanitized_http_diagnostic_redacts_query_strings() {
        let diagnostic = sanitize_http_diagnostic(
            "HTTP 403 https://cdn.example.test/file?token=secret&expires=123",
        );
        assert!(diagnostic.contains("https://cdn.example.test/file"));
        assert!(!diagnostic.contains("secret"));
        assert!(!diagnostic.contains("expires"));
    }

    #[test]
    fn final_artifact_verification_rejects_empty_html_and_wrong_size() {
        let path = std::env::temp_dir().join(format!(
            "cacatools-http-final-artifact-{}.bin",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        fs::write(&path, b"valid-bytes").expect("write valid artifact");
        assert_eq!(
            verify_http_final_artifact(&path, 11).expect("valid artifact"),
            11
        );
        assert!(verify_http_final_artifact(&path, 12).is_err());

        fs::write(&path, b"<!doctype html><html>").expect("write html artifact");
        assert!(verify_http_final_artifact(&path, 0).is_err());

        fs::write(&path, b"").expect("write empty artifact");
        assert!(verify_http_final_artifact(&path, 0).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn verified_final_artifact_recovers_terminal_sqlite_state() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cacatools-http-recovery-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let db_path = root.join("state.sqlite");
        let destination = root.join("android-studio-quail3-windows.exe");
        let temp_path = root.join("android-studio-quail3-windows.exe.part");
        fs::write(&destination, b"verified-http-bytes").expect("write final artifact");

        let connection = Connection::open(&db_path).expect("open test database");
        migrate(&connection).expect("migrate test database");
        connection
            .execute(
                "INSERT INTO jobs(title,status,detail) VALUES(?1,'running','Transferencia')",
                params!["Android Studio"],
            )
            .expect("insert test job");
        let id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path,total_bytes,downloaded_bytes) VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    id,
                    "https://example.test/android-studio-quail3-windows.exe",
                    destination.to_string_lossy().to_string(),
                    temp_path.to_string_lossy().to_string(),
                    19_i64,
                    19_i64,
                ],
            )
            .expect("insert HTTP job");
        drop(connection);

        assert!(complete_verified_http_job(&db_path, id));
        let connection = Connection::open(&db_path).expect("reopen test database");
        let state: (String, f64, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT jobs.status,jobs.progress,download_jobs.downloaded_bytes,download_jobs.total_bytes,download_jobs.error FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE jobs.id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("read recovered state");
        assert_eq!(state.0, "completed");
        assert_eq!(state.1, 100.0);
        assert_eq!(state.2, 19);
        assert_eq!(state.3, 19);
        assert!(state.4.is_none());

        let _ = fs::remove_dir_all(&root);
    }
}
