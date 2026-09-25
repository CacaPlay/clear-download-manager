use reqwest::{blocking::Client, header::RANGE};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{thread, time::Duration};
use tauri::{AppHandle, State};
use url::Url;

use super::{
    duration_similarity, job_uses_legacy_removed_provider, match_reasons,
    sanitize_media_error_for_display, search_media_internal, title_similarity, token_similarity,
};
use crate::{
    background_command, enable_available_js_runtime, ensure_public_network_resolution,
    legacy_removed_provider_error, parse_public_http_url, resolver_binary,
    url_has_public_network_target, validate_media_url, LocalState, MediaSearchResult,
};

#[derive(Clone, Serialize)]
pub(crate) struct FailureDiagnosisSnapshot {
    pub(crate) code: String,
    title: String,
    summary: String,
    pub(crate) retryable: bool,
    pub(crate) likely_temporary: bool,
    requires_user_action: bool,
    suggestions: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct MediaRecoverySnapshot {
    original_available: bool,
    message: String,
    alternatives: Vec<MediaSearchResult>,
    diagnosis: FailureDiagnosisSnapshot,
    verification_attempts: usize,
    recovery_mode: String,
    can_retry: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRecoveryRequest {
    job_id: i64,
    title: String,
    source_url: Option<String>,
    creator: Option<String>,
    duration_seconds: Option<f64>,
    limit: Option<usize>,
}

pub(crate) fn failure_diagnosis(message: &str, source_kind: &str) -> FailureDiagnosisSnapshot {
    let lower = message.to_ascii_lowercase();
    let make = |code: &str,
                title: &str,
                summary: &str,
                retryable: bool,
                likely_temporary: bool,
                requires_user_action: bool,
                suggestions: &[&str]| FailureDiagnosisSnapshot {
        code: code.into(),
        title: title.into(),
        summary: summary.into(),
        retryable,
        likely_temporary,
        requires_user_action,
        suggestions: suggestions
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    };

    if lower.contains("refresh-")
        && (lower.contains("file not found")
            || lower.contains("no such file")
            || lower.contains("info.json")
            || lower.contains("metadatos"))
    {
        make(
            "metadata_refresh_failed",
            "No se pudo renovar el enlace temporal",
            "El archivo temporal de metadatos ya no estaba disponible. El parcial no se considera corrupto; hay que volver a analizar la URL original.",
            true,
            true,
            false,
            &[
                "Reanaliza la URL original",
                "Conserva el parcial para reanudarlo si el servidor lo permite",
                "No uses el archivo temporal de metadatos antiguo",
            ],
        )
    } else if lower.contains("private") || lower.contains("privado") {
        make(
            "private_content",
            "Contenido privado",
            "La plataforma exige acceso a una cuenta autorizada o el propietario restringió el contenido.",
            true,
            false,
            true,
            &["Comprueba que tu cuenta tenga acceso", "Importa cookies únicamente desde una sesión propia", "Busca una publicación pública equivalente"],
        )
    } else if lower.contains("not available")
        || lower.contains("unavailable")
        || lower.contains("no disponible")
        || lower.contains("404")
        || lower.contains("410")
        || lower.contains("not found")
    {
        make(
            "source_unavailable",
            "Fuente no disponible",
            "La fuente confirmó que el recurso ya no está accesible desde su dirección original.",
            true,
            false,
            false,
            &[
                "Volver a verificar la dirección",
                "Buscar una alternativa por título, autor y duración",
                "Comprobar si el contenido cambió de URL",
            ],
        )
    } else if lower.contains("geo")
        || lower.contains("country")
        || lower.contains("region")
        || lower.contains("ubicación")
    {
        make(
            "region_restricted",
            "Restricción regional",
            "La fuente respondió, pero limita el contenido según la región de la conexión.",
            true,
            false,
            true,
            &[
                "Comprueba la disponibilidad oficial en tu región",
                "Busca una publicación autorizada alternativa",
            ],
        )
    } else if lower.contains("sign in")
        || lower.contains("login")
        || lower.contains("cookies")
        || lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
    {
        make(
            "authentication_required",
            "La fuente requiere sesión",
            "El servidor rechazó la solicitud anónima o necesita cookies de una cuenta con acceso.",
            true,
            false,
            true,
            &[
                "Inicia sesión en el navegador",
                "Usa cookies de tu propia sesión cuando la plataforma lo permita",
                "Revisa permisos y edad de la cuenta",
            ],
        )
    } else if lower.contains("drm") {
        make(
            "drm_protected",
            "Contenido protegido con DRM",
            "El motor local no puede procesar contenido protegido mediante DRM.",
            false,
            false,
            true,
            &[
                "Utiliza la descarga oficial de la plataforma",
                "Busca una fuente sin DRM y con permiso de descarga",
            ],
        )
    } else if lower.contains("unsupported url") || lower.contains("no suitable extractor") {
        make(
            "unsupported_source",
            "Dirección todavía no compatible",
            "El resolvedor instalado no reconoce la estructura actual de esa página.",
            true,
            false,
            false,
            &[
                "Actualiza el motor multimedia",
                "Prueba el enlace directo del contenido",
                "Busca el contenido por título",
            ],
        )
    } else if lower.contains("requested format")
        || lower.contains("format is not available")
        || lower.contains("formato solicitado")
    {
        make(
            "format_unavailable",
            "La calidad elegida ya no está disponible",
            "La fuente existe, pero la combinación de formato, resolución o audio solicitada no puede obtenerse.",
            true,
            false,
            false,
            &["Usa calidad automática", "Selecciona otra resolución o contenedor", "Permite que FFmpeg combine vídeo y audio"],
        )
    } else if lower.contains("too many requests")
        || lower.contains("rate limit")
        || lower.contains("429")
        || lower.contains("temporarily blocked")
    {
        make(
            "rate_limited",
            "La plataforma limitó temporalmente las solicitudes",
            "Se realizaron demasiadas solicitudes en poco tiempo. La fuente probablemente volverá a responder más tarde.",
            true,
            true,
            false,
            &["Espera unos minutos antes de reintentar", "Reduce las descargas simultáneas", "Evita repetir análisis innecesarios"],
        )
    } else if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("could not resolve")
        || lower.contains("dns")
        || lower.contains("network")
        || lower.contains("conexión")
        || lower.contains("conectar")
    {
        make(
            "network_failure",
            "Fallo temporal de conexión",
            "La descarga no pudo mantener una conexión estable con el servidor.",
            true,
            true,
            false,
            &[
                "Comprueba Internet y DNS",
                "Reintenta conservando el archivo parcial",
                "Reduce conexiones simultáneas si el servidor es inestable",
            ],
        )
    } else if lower.contains("no space")
        || lower.contains("disk full")
        || lower.contains("espacio insuficiente")
        || lower.contains("os error 112")
    {
        make(
            "disk_full",
            "No hay espacio suficiente",
            "Windows no pudo seguir escribiendo porque la unidad de destino está llena.",
            true,
            false,
            true,
            &[
                "Libera espacio en la unidad",
                "Cambia la carpeta de destino",
                "Conserva el parcial para reanudar después",
            ],
        )
    } else if lower.contains("permission denied")
        || lower.contains("access denied")
        || lower.contains("acceso denegado")
    {
        make(
            "permission_denied",
            "Windows bloqueó el acceso a la carpeta",
            "La aplicación no tiene permisos para crear o modificar el archivo de destino.",
            true,
            false,
            true,
            &[
                "Elige una carpeta dentro de tu perfil",
                "Revisa protección contra ransomware",
                "Comprueba permisos de la carpeta",
            ],
        )
    } else if lower.contains("being used")
        || lower.contains("sharing violation")
        || lower.contains("otro proceso")
        || lower.contains("archivo bloqueado")
    {
        make(
            "file_locked",
            "Otro programa está usando el archivo",
            "Windows impidió reemplazar o finalizar el archivo porque sigue abierto en otra aplicación.",
            true,
            true,
            true,
            &["Cierra reproductores, antivirus o editores que usen el archivo", "Reintenta sin eliminar el parcial"],
        )
    } else if lower.contains("hash")
        || lower.contains("integrity")
        || lower.contains("corrupt")
        || lower.contains("integridad")
    {
        make(
            "integrity_failure",
            "La comprobación de integridad falló",
            "Los datos descargados no coinciden con la información esperada o quedaron incompletos.",
            true,
            false,
            false,
            &["Reintenta desde cero si el error se repite", "Comprueba que la fuente no haya cambiado", "Usa otro espejo oficial"],
        )
    } else if lower.contains("página web en vez del archivo")
        || lower.contains("text/html")
        || lower.contains("doctype html")
    {
        make(
            "html_instead_of_file",
            "El enlace devolvió una página, no el archivo",
            "La dirección apunta a una página de descarga, inicio de sesión o comprobación, no al contenido final.",
            true,
            false,
            true,
            &["Abre la página y copia el enlace directo", "Usa el analizador de contenido", "Comprueba si la página exige sesión"],
        )
    } else if lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("server error")
        || lower.contains("servidor respondió 5")
    {
        make(
            "server_failure",
            "El servidor está fallando",
            "La fuente respondió con un error interno o de disponibilidad temporal.",
            true,
            true,
            false,
            &[
                "Reintenta más tarde",
                "Usa otro espejo",
                "Mantén el parcial para no perder progreso",
            ],
        )
    } else if lower.contains("cancel") || lower.contains("cancelada") {
        make(
            "cancelled",
            "La tarea fue cancelada",
            "La descarga se detuvo por una acción del usuario o por el programador.",
            true,
            false,
            false,
            &[
                "Reanuda la tarea si quieres continuar",
                "Elimina el parcial solo cuando ya no lo necesites",
            ],
        )
    } else {
        let summary = if message.trim().is_empty() {
            format!("El motor {source_kind} no devolvió información suficiente para identificar el fallo.")
        } else {
            message.trim().chars().take(500).collect()
        };
        make(
            "unknown_failure",
            "Error todavía no clasificado",
            &summary,
            true,
            false,
            false,
            &[
                "Reintenta una vez",
                "Abre el registro completo si vuelve a fallar",
                "Conserva el parcial durante el diagnóstico",
            ],
        )
    }
}

fn available_diagnosis() -> FailureDiagnosisSnapshot {
    FailureDiagnosisSnapshot {
        code: "available".into(),
        title: "La fuente original está disponible".into(),
        summary: "La segunda comprobación respondió correctamente. No es necesario sustituir el contenido.".into(),
        retryable: true,
        likely_temporary: false,
        requires_user_action: false,
        suggestions: vec!["Reanuda la descarga original".into()],
    }
}

fn verification_should_retry(diagnosis: &FailureDiagnosisSnapshot) -> bool {
    diagnosis.likely_temporary
        || matches!(
            diagnosis.code.as_str(),
            "unknown_failure"
                | "server_failure"
                | "metadata_refresh_failed"
                | "source_unavailable"
                | "unsupported_source"
                | "format_unavailable"
        )
}

fn diagnosis_allows_alternatives(diagnosis: &FailureDiagnosisSnapshot) -> bool {
    matches!(
        diagnosis.code.as_str(),
        "private_content"
            | "source_unavailable"
            | "region_restricted"
            | "authentication_required"
            | "drm_protected"
            | "unsupported_source"
            | "format_unavailable"
    )
}

fn verify_media_availability_once(
    url: &str,
    app: &AppHandle,
) -> Result<(bool, FailureDiagnosisSnapshot), String> {
    let source_url = validate_media_url(url)?;
    let parsed =
        Url::parse(&source_url).map_err(|_| "El enlace multimedia no es válido".to_string())?;
    ensure_public_network_resolution(&parsed)?;
    let binary = resolver_binary(app)?;
    let mut command = background_command(binary);
    enable_available_js_runtime(&mut command);
    command
        .arg("--ignore-config")
        .arg("--simulate")
        .arg("--skip-download")
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg("--socket-timeout")
        .arg("16")
        .arg("--retries")
        .arg("1")
        .arg("--playlist-end")
        .arg("1")
        .arg(source_url);
    let output = command
        .output()
        .map_err(|error| format!("No se pudo verificar la fuente: {error}"))?;
    if output.status.success() {
        return Ok((true, available_diagnosis()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((false, failure_diagnosis(&stderr, "multimedia")))
}

fn verify_media_availability(
    url: &str,
    app: &AppHandle,
) -> Result<(bool, FailureDiagnosisSnapshot, usize), String> {
    let mut diagnosis = failure_diagnosis("", "multimedia");
    for attempt in 1..=2 {
        let (available, current) = verify_media_availability_once(url, app)?;
        if available {
            return Ok((true, current, attempt));
        }
        let should_retry = verification_should_retry(&current);
        diagnosis = current;
        if attempt < 2 && should_retry {
            thread::sleep(Duration::from_millis(450));
        } else {
            return Ok((false, diagnosis, attempt));
        }
    }
    Ok((false, diagnosis, 2))
}

fn verify_direct_availability(
    url: &str,
) -> Result<(bool, FailureDiagnosisSnapshot, usize), String> {
    let source_url = parse_public_http_url(url, "El enlace directo no es válido")?;
    ensure_public_network_resolution(&source_url)?;
    let client = Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .user_agent(format!("CacaTools-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(18))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("La verificación superó el límite de redirecciones");
            }
            if url_has_public_network_target(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("La redirección apunta a una dirección local o privada")
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
    let mut diagnosis = failure_diagnosis("", "HTTP");
    for attempt in 1..=2 {
        let response = client
            .get(source_url.as_str())
            .header(RANGE, "bytes=0-0")
            .header("Accept-Encoding", "identity")
            .send();
        match response {
            Ok(response) if response.status().is_success() => {
                return Ok((true, available_diagnosis(), attempt));
            }
            Ok(response) => {
                diagnosis = failure_diagnosis(
                    &format!("El servidor respondió {}", response.status()),
                    "HTTP",
                );
            }
            Err(error) => {
                diagnosis = failure_diagnosis(&error.to_string(), "HTTP");
            }
        }
        if attempt < 2 && verification_should_retry(&diagnosis) {
            thread::sleep(Duration::from_millis(450));
        } else {
            return Ok((false, diagnosis, attempt));
        }
    }
    Ok((false, diagnosis, 2))
}

pub(crate) fn recover_media_source(
    request: MediaRecoveryRequest,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaRecoverySnapshot, String> {
    let MediaRecoveryRequest {
        job_id,
        title,
        source_url,
        creator,
        duration_seconds,
        limit,
    } = request;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    if job_uses_legacy_removed_provider(&connection, job_id)? {
        return Err(legacy_removed_provider_error());
    }
    let database_values = connection
        .query_row(
            "SELECT jobs.title,jobs.detail,
                    COALESCE(media_jobs.source_url,download_jobs.url,torrent_jobs.source,''),
                    CASE WHEN media_jobs.job_id IS NOT NULL THEN 1 ELSE 0 END,
                    CASE WHEN torrent_jobs.job_id IS NOT NULL THEN 1 ELSE 0 END,
                    COALESCE(media_jobs.error,download_jobs.error,torrent_jobs.error,jobs.detail,''),
                    media_jobs.expected_duration_seconds
             FROM jobs
             LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id
             LEFT JOIN download_jobs ON download_jobs.job_id=jobs.id
             LEFT JOIN torrent_jobs ON torrent_jobs.job_id=jobs.id
             WHERE jobs.id=?1",
            params![job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<f64>>(6)?,
                ))
            },
        )
        .map_err(|_| "La tarea ya no existe".to_string())?;
    drop(connection);

    let (
        stored_title,
        detail,
        stored_source,
        is_media,
        is_torrent,
        stored_error,
        expected_duration,
    ) = database_values;
    let detail = sanitize_media_error_for_display(&detail);
    let stored_error = sanitize_media_error_for_display(&stored_error);
    let effective_title = if title.trim().is_empty() {
        stored_title
    } else {
        title.trim().to_string()
    };
    let effective_source = source_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(stored_source);
    let source_kind = if is_media {
        "multimedia"
    } else if is_torrent {
        "torrent"
    } else {
        "HTTP"
    };
    let fallback_message = if stored_error.trim().is_empty() {
        detail
    } else {
        stored_error
    };
    let mut diagnosis = failure_diagnosis(&fallback_message, source_kind);
    let mut attempts = 0;

    if is_media && !effective_source.trim().is_empty() {
        // A successful metadata probe only proves that the public page still
        // exists. It does not prove that the signed media URL accepts the
        // current session. Do not turn a known 403/session failure into the
        // misleading "source available" result or an endless resume loop.
        if diagnosis.code == "authentication_required" {
            return Ok(MediaRecoverySnapshot {
                original_available: false,
                message: diagnosis.summary.clone(),
                alternatives: Vec::new(),
                diagnosis,
                verification_attempts: 0,
                recovery_mode: "session_required".into(),
                can_retry: false,
            });
        }
        let (available, verified, verification_attempts) =
            verify_media_availability(&effective_source, &app)?;
        diagnosis = verified;
        attempts = verification_attempts;
        if available {
            return Ok(MediaRecoverySnapshot {
                original_available: true,
                message: diagnosis.summary.clone(),
                alternatives: Vec::new(),
                diagnosis,
                verification_attempts: attempts,
                recovery_mode: "available".into(),
                can_retry: true,
            });
        }
    } else if !is_torrent && !effective_source.trim().is_empty() {
        let (available, verified, verification_attempts) =
            verify_direct_availability(&effective_source)?;
        diagnosis = verified;
        attempts = verification_attempts;
        return Ok(MediaRecoverySnapshot {
            original_available: available,
            message: diagnosis.summary.clone(),
            alternatives: Vec::new(),
            can_retry: diagnosis.retryable,
            recovery_mode: if available {
                "available".into()
            } else if diagnosis.likely_temporary {
                "temporary_error".into()
            } else {
                "direct_retry".into()
            },
            diagnosis,
            verification_attempts: attempts,
        });
    }

    if is_torrent || !diagnosis_allows_alternatives(&diagnosis) {
        return Ok(MediaRecoverySnapshot {
            original_available: false,
            message: diagnosis.summary.clone(),
            alternatives: Vec::new(),
            can_retry: diagnosis.retryable,
            recovery_mode: if is_torrent {
                "torrent_retry".into()
            } else {
                "temporary_error".into()
            },
            diagnosis,
            verification_attempts: attempts,
        });
    }

    let creator = creator.unwrap_or_default();
    let search_query = if creator.trim().is_empty() {
        effective_title.clone()
    } else {
        format!("{} {}", effective_title, creator.trim())
    };
    let mut alternatives = search_media_internal(&search_query, 30, &app)?;
    let expected_duration = duration_seconds.or(expected_duration);
    for alternative in &mut alternatives {
        let title_score = title_similarity(&effective_title, &alternative.title);
        let creator_score = if creator.trim().is_empty() {
            0.5
        } else {
            token_similarity(&creator, &alternative.creator)
        };
        let duration_score = duration_similarity(expected_duration, alternative.duration_seconds);
        alternative.similarity =
            (title_score * 0.72 + creator_score * 0.16 + duration_score * 0.12) * 100.0;
        alternative.match_reasons = match_reasons(title_score, creator_score, duration_score);
    }
    alternatives.retain(|item| item.source_url != effective_source);
    alternatives.retain(|item| item.similarity >= 32.0);
    alternatives.sort_by(|left, right| {
        right
            .similarity
            .partial_cmp(&left.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    alternatives.truncate(limit.unwrap_or(8).clamp(1, 15));
    let message = if alternatives.is_empty() {
        "La fuente original no está disponible y no encontramos coincidencias suficientemente cercanas".into()
    } else {
        format!(
            "La fuente original no está disponible. Se encontraron {} alternativas ordenadas por similitud",
            alternatives.len()
        )
    };
    Ok(MediaRecoverySnapshot {
        original_available: false,
        message,
        alternatives,
        can_retry: diagnosis.retryable,
        recovery_mode: "media_alternatives".into(),
        diagnosis,
        verification_attempts: attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnoses_temporary_and_definitive_failures() {
        let temporary = failure_diagnosis("HTTP 429 Too Many Requests", "multimedia");
        assert_eq!(temporary.code, "rate_limited");
        assert!(temporary.retryable);
        assert!(temporary.likely_temporary);

        let refresh = failure_diagnosis("FileNotFoundError: refresh-2.info.json", "multimedia");
        assert_eq!(refresh.code, "metadata_refresh_failed");
        assert!(refresh.likely_temporary);

        let unavailable = failure_diagnosis("ERROR: Video unavailable", "multimedia");
        assert_eq!(unavailable.code, "source_unavailable");
        assert!(diagnosis_allows_alternatives(&unavailable));

        let protected = failure_diagnosis("This content is DRM protected", "multimedia");
        assert_eq!(protected.code, "drm_protected");
        assert!(!protected.retryable);
    }

    #[test]
    fn deserializes_media_recovery_request_from_frontend_contract() {
        let request: MediaRecoveryRequest = serde_json::from_value(serde_json::json!({
            "jobId": 42,
            "title": "Video de prueba",
            "sourceUrl": "https://example.com/video",
            "creator": "Canal",
            "durationSeconds": 125.5,
            "limit": 8
        }))
        .expect("media recovery request");
        assert_eq!(request.job_id, 42);
        assert_eq!(request.title, "Video de prueba");
        assert_eq!(
            request.source_url.as_deref(),
            Some("https://example.com/video")
        );
        assert_eq!(request.creator.as_deref(), Some("Canal"));
        assert_eq!(request.duration_seconds, Some(125.5));
        assert_eq!(request.limit, Some(8));
    }
}
