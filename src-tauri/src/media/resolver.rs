use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use url::Url;

use super::{
    extraction, first_string, is_browser_cookie_copy_error, media_download_profiles, media_formats,
    media_host_is, media_metadata_needs_quality_fallback, media_metadata_quality,
    media_preview_budget, retain_richer_media_metadata, sanitize_media_error_for_display,
    tiktok_embed_source_url, youtube_pot_provider_enabled, MediaPreviewBudget, MediaSessionOptions,
    YOUTUBE_POT_PROFILE,
};
use crate::{
    ensure_public_network_resolution, json_exposes_reproducible_stream,
    normalize_tiktok_source_url, parse_public_http_url, resolver_binary, validate_media_url,
    window_operation_is_cancelled, WindowOperation,
};

const ANALYSIS_CACHE_TTL: Duration = Duration::from_secs(7 * 60);
const ANALYSIS_CACHE_LIMIT: usize = 32;
const ANALYSIS_URL_SAFETY_MARGIN: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResolutionPolicy {
    Analysis,
    PreviewFast,
}

#[derive(Clone)]
pub(super) struct RawExtractionArtifact {
    pub(super) provider: String,
    pub(super) request_url: String,
    pub(super) source_url: String,
    pub(super) profile: String,
    pub(super) session_fingerprint: String,
    pub(super) policy: ResolutionPolicy,
    pub(super) captured_at: SystemTime,
    pub(super) expires_at: Option<SystemTime>,
    pub(super) raw_json: Value,
}

#[derive(Clone)]
pub(super) struct ResolvedMedia {
    pub(super) json: Value,
    pub(super) profile: String,
    pub(super) artifacts: Vec<RawExtractionArtifact>,
}

pub(super) struct DownloadReuseAttempt {
    pub(super) extractor_args: String,
    pub(super) source_url: String,
    pub(super) parsed_source: Url,
    pub(super) selector: String,
    pub(super) info_json: std::path::PathBuf,
}

pub(super) type AnalysisResolution = ResolvedMedia;
pub(super) type PreviewResolution = ResolvedMedia;

pub(crate) fn media_extraction_profiles(parsed: &Url) -> Vec<&'static str> {
    // Keep the provider's stable profile order. The resolver owns the
    // decision to iterate, stop, or continue; providers only expose the
    // available ordered configurations.
    let mut profiles = media_download_profiles(parsed).to_vec();
    if youtube_pot_provider_enabled(parsed) && !profiles.contains(&YOUTUBE_POT_PROFILE) {
        profiles.push(YOUTUBE_POT_PROFILE);
    }
    profiles
}

struct CacheEntry {
    resolution: ResolvedMedia,
    expires_at: SystemTime,
    last_used: u64,
}

struct InFlight {
    result: Mutex<Option<Result<ResolvedMedia, String>>>,
    ready: Condvar,
    consumers: AtomicUsize,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct AnalysisState {
    cache: HashMap<String, CacheEntry>,
    in_flight: HashMap<String, std::sync::Arc<InFlight>>,
    clock: u64,
}

struct FlightConsumer {
    flight: Arc<InFlight>,
}

impl Drop for FlightConsumer {
    fn drop(&mut self) {
        if self.flight.consumers.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.flight.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

static ANALYSIS_STATE: OnceLock<Mutex<AnalysisState>> = OnceLock::new();

pub(super) fn resolve_analysis(
    url: String,
    app: AppHandle,
    session: MediaSessionOptions,
    operation: Option<Arc<WindowOperation>>,
) -> Result<AnalysisResolution, String> {
    resolve_with_policy(url, app, session, operation, ResolutionPolicy::Analysis)
}

pub(super) fn resolve_preview(
    url: String,
    app: AppHandle,
    operation: Option<Arc<WindowOperation>>,
) -> Result<PreviewResolution, String> {
    let validated = validate_media_url(&url)?;
    resolve_with_policy(
        validated,
        app,
        MediaSessionOptions::default(),
        operation,
        ResolutionPolicy::PreviewFast,
    )
}

fn resolve_with_policy(
    url: String,
    app: AppHandle,
    session: MediaSessionOptions,
    operation: Option<Arc<WindowOperation>>,
    policy: ResolutionPolicy,
) -> Result<ResolvedMedia, String> {
    let parsed = parse_public_http_url(&url, "El enlace no es válido")?;
    ensure_public_network_resolution(&parsed)?;
    let parsed = normalize_tiktok_source_url(parsed);
    let key = resolution_cache_key(&parsed, &session, policy);
    if let Some(resolution) = resolution_cache_get(&key) {
        return Ok(resolution);
    }
    if policy == ResolutionPolicy::PreviewFast {
        let analysis_key = resolution_cache_key(&parsed, &session, ResolutionPolicy::Analysis);
        if let Some(resolution) = resolution_cache_get(&analysis_key) {
            if preview_complete(&resolution.json) {
                return Ok(resolution);
            }
        }
    }

    let (flight, leader) = {
        let state = ANALYSIS_STATE.get_or_init(|| Mutex::new(AnalysisState::default()));
        let mut state = state
            .lock()
            .map_err(|_| "No se pudo bloquear el resolvedor".to_string())?;
        if let Some(existing) = state.in_flight.get(&key) {
            existing.consumers.fetch_add(1, Ordering::SeqCst);
            (existing.clone(), false)
        } else {
            let created = std::sync::Arc::new(InFlight {
                result: Mutex::new(None),
                ready: Condvar::new(),
                consumers: AtomicUsize::new(1),
                cancelled: Arc::new(AtomicBool::new(false)),
            });
            state.in_flight.insert(key.clone(), created.clone());
            (created, true)
        }
    };
    let _consumer = FlightConsumer {
        flight: flight.clone(),
    };
    if !leader {
        return wait_for_shared_analysis(&flight, operation.as_ref());
    }

    let result = resolve_uncached(&parsed, &app, session, operation.as_ref(), &flight, policy);
    if let Ok(resolution) = &result {
        resolution_cache_put(&key, resolution);
    }
    if let Ok(mut shared) = flight.result.lock() {
        *shared = Some(clone_resolution_result(&result));
        flight.ready.notify_all();
    }
    if let Ok(mut state) = ANALYSIS_STATE
        .get_or_init(|| Mutex::new(AnalysisState::default()))
        .lock()
    {
        state.in_flight.remove(&key);
    }
    result
}

fn resolve_uncached(
    parsed: &Url,
    app: &AppHandle,
    session: MediaSessionOptions,
    operation: Option<&Arc<WindowOperation>>,
    flight: &Arc<InFlight>,
    policy: ResolutionPolicy,
) -> Result<ResolvedMedia, String> {
    match policy {
        ResolutionPolicy::Analysis => {
            resolve_analysis_uncached(parsed, app, session, operation, flight)
        }
        ResolutionPolicy::PreviewFast => resolve_preview_uncached(parsed, app, operation, flight),
    }
}

fn resolve_analysis_uncached(
    parsed: &Url,
    app: &AppHandle,
    session: MediaSessionOptions,
    operation: Option<&Arc<WindowOperation>>,
    flight: &Arc<InFlight>,
) -> Result<AnalysisResolution, String> {
    let query = parsed.query().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path().to_ascii_lowercase();
    let likely_playlist =
        query.contains("list=") || path.contains("playlist") || path.contains("album");
    let is_tiktok = media_host_is(parsed, "tiktok.com");
    let analysis_retries = if is_tiktok { "3" } else { "1" };
    let extractor_retries = if is_tiktok { "3" } else { "1" };
    let analysis_timeout = if likely_playlist || is_tiktok { 45 } else { 28 };
    let binary = resolver_binary(app)?;
    let mut active_session = session;
    let mut selected: Option<AnalysisResolution> = None;
    let mut last_error = String::new();
    let mut previous_signature = None;
    let mut stable_attempts = 0_u8;

    for extractor_args in media_extraction_profiles(parsed) {
        if shared_operation_cancelled(flight, operation) {
            return Err("preparation_cancelled".into());
        }
        let attempt = extraction::run_analysis_attempt(
            &binary,
            parsed,
            extractor_args,
            &active_session,
            likely_playlist,
            is_tiktok,
            analysis_retries,
            extractor_retries,
            analysis_timeout,
            || shared_operation_cancelled(flight, operation),
        );
        let output = match attempt {
            Ok(output) => output,
            Err(error) => {
                if error == "preparation_cancelled" || shared_operation_cancelled(flight, operation)
                {
                    return Err("preparation_cancelled".into());
                }
                if active_session.use_brave_cookies && is_browser_cookie_copy_error(&error) {
                    active_session = MediaSessionOptions::default();
                    last_error =
                        "No se pudo abrir la sesión local; reintentando sin cookies…".into();
                } else {
                    last_error = error;
                }
                continue;
            }
        };
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            last_error = if message.is_empty() {
                "El enlace no pudo analizarse".into()
            } else {
                message
            };
            if active_session.use_brave_cookies && is_browser_cookie_copy_error(&last_error) {
                active_session = MediaSessionOptions::default();
            }
            continue;
        }
        let value = match serde_json::from_slice::<Value>(&output.stdout) {
            Ok(value) => value,
            Err(error) => {
                last_error = format!("El resolvedor devolvió una respuesta inválida: {error}");
                continue;
            }
        };
        let raw_value = value.clone();
        let mut candidate = selected.as_ref().map(|resolution| resolution.json.clone());
        retain_richer_media_metadata(&mut candidate, value);
        let Some(json) = candidate else { continue };
        let signature = analysis_selectable_signature(&json);
        let contract_complete = analysis_contract_complete(&json);
        if contract_complete && previous_signature.as_ref() == Some(&signature) {
            stable_attempts = stable_attempts.saturating_add(1);
        } else {
            stable_attempts = 0;
        }
        previous_signature = Some(signature);
        let profile = extractor_args.to_string();
        let mut artifacts = selected
            .as_ref()
            .map(|resolution| resolution.artifacts.clone())
            .unwrap_or_default();
        artifacts.push(raw_extraction_artifact(
            parsed,
            parsed.as_str(),
            &profile,
            &active_session,
            ResolutionPolicy::Analysis,
            raw_value,
        ));
        selected = Some(AnalysisResolution {
            json,
            profile,
            artifacts,
        });

        // High-quality first results already satisfy the baseline's existing
        // stop rule. For limited results, stop only after two consecutive
        // attempts leave the user-selectable contract unchanged. This retains
        // the measured P2 contribution while avoiding redundant late profiles.
        if selected
            .as_ref()
            .is_some_and(|resolution| quality_discovery_complete(&resolution.json, stable_attempts))
        {
            break;
        }
    }
    if selected.is_none() {
        if let Some(embed_source) = tiktok_embed_source_url(parsed) {
            if shared_operation_cancelled(flight, operation) {
                return Err("preparation_cancelled".into());
            }
            match extraction::run_tiktok_embed_attempt(
                &binary,
                &embed_source,
                &active_session,
                || shared_operation_cancelled(flight, operation),
            ) {
                Ok(output) if output.status.success() => {
                    match serde_json::from_slice::<Value>(&output.stdout) {
                        Ok(value) => {
                            let candidate = value
                                .get("entries")
                                .and_then(Value::as_array)
                                .and_then(|entries| entries.first())
                                .cloned()
                                .unwrap_or(value);
                            if json_exposes_reproducible_stream(&candidate) {
                                selected = Some(AnalysisResolution {
                                    json: candidate.clone(),
                                    profile: "tiktok-embed".into(),
                                    artifacts: vec![raw_extraction_artifact(
                                        parsed,
                                        &embed_source,
                                        "tiktok-embed",
                                        &active_session,
                                        ResolutionPolicy::Analysis,
                                        candidate,
                                    )],
                                });
                            } else {
                                last_error = "TikTok no entregó un flujo reproducible; la plataforma rechazó la extracción".into();
                            }
                        }
                        Err(error) => {
                            last_error = format!(
                                "yt-dlp devolvió una respuesta alternativa inválida: {error}"
                            )
                        }
                    }
                }
                Ok(output) => {
                    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if !message.is_empty() {
                        last_error = message;
                    }
                }
                Err(error) if error == "preparation_cancelled" => return Err(error),
                Err(error) => last_error = error,
            }
        }
    }
    selected.ok_or_else(|| {
        if last_error.is_empty() {
            "El enlace no pudo analizarse".to_string()
        } else {
            sanitize_media_error_for_display(&last_error)
        }
    })
}

fn resolve_preview_uncached(
    parsed: &Url,
    app: &AppHandle,
    operation: Option<&Arc<WindowOperation>>,
    flight: &Arc<InFlight>,
) -> Result<PreviewResolution, String> {
    let MediaPreviewBudget {
        retries,
        extractor_retries,
        socket_timeout,
        timeout_seconds,
    } = media_preview_budget(parsed);
    let binary = resolver_binary(app)?;
    let mut selected = None;
    let mut selected_profile = String::new();
    let mut artifacts = Vec::new();
    let mut last_error = String::new();

    for extractor_args in media_extraction_profiles(parsed) {
        if shared_operation_cancelled(flight, operation) {
            return Err("preparation_cancelled".into());
        }
        let attempt = extraction::run_preview_attempt(
            &binary,
            parsed,
            extractor_args,
            socket_timeout,
            retries,
            extractor_retries,
            timeout_seconds,
            operation,
        );
        let output = match attempt {
            Ok(output) => output,
            Err(error) => {
                if error == "preparation_cancelled" || shared_operation_cancelled(flight, operation)
                {
                    return Err("preparation_cancelled".into());
                }
                last_error = error;
                continue;
            }
        };
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            last_error = if message.is_empty() {
                "La fuente no ofrece una vista previa reproducible sin descargar".into()
            } else {
                message
            };
            continue;
        }
        let value = match serde_json::from_slice::<Value>(&output.stdout) {
            Ok(value) => value,
            Err(error) => {
                last_error = format!("yt-dlp devolvió una vista previa inválida: {error}");
                continue;
            }
        };
        let raw_value = value.clone();
        let replaces_selected = selected
            .as_ref()
            .map(|current| media_metadata_quality(&value) > media_metadata_quality(current))
            .unwrap_or(true);
        retain_richer_media_metadata(&mut selected, value);
        artifacts.push(raw_extraction_artifact(
            parsed,
            parsed.as_str(),
            extractor_args,
            &MediaSessionOptions::default(),
            ResolutionPolicy::PreviewFast,
            raw_value,
        ));
        if replaces_selected {
            selected_profile = extractor_args.to_string();
        }
        if selected.as_ref().is_some_and(preview_complete) {
            break;
        }
    }

    if selected.is_none() {
        if let Some(embed_source) = tiktok_embed_source_url(parsed) {
            if shared_operation_cancelled(flight, operation) {
                return Err("preparation_cancelled".into());
            }
            match extraction::run_tiktok_embed_attempt(
                &binary,
                &embed_source,
                &MediaSessionOptions::default(),
                || shared_operation_cancelled(flight, operation),
            ) {
                Ok(output) if output.status.success() => {
                    match serde_json::from_slice::<Value>(&output.stdout) {
                        Ok(value) => {
                            let candidate = value
                                .get("entries")
                                .and_then(Value::as_array)
                                .and_then(|entries| entries.first())
                                .cloned()
                                .unwrap_or(value);
                            if json_exposes_reproducible_stream(&candidate) {
                                artifacts.push(raw_extraction_artifact(
                                    parsed,
                                    &embed_source,
                                    "tiktok-embed",
                                    &MediaSessionOptions::default(),
                                    ResolutionPolicy::PreviewFast,
                                    candidate.clone(),
                                ));
                                selected = Some(candidate);
                                selected_profile = "tiktok-embed".into();
                            } else {
                                last_error = "TikTok no entregó un flujo reproducible; la plataforma rechazó la extracción".into();
                            }
                        }
                        Err(error) => {
                            last_error = format!(
                                "yt-dlp devolvió una vista previa alternativa inválida: {error}"
                            );
                        }
                    }
                }
                Ok(output) => {
                    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if !message.is_empty() {
                        last_error = message;
                    }
                }
                Err(error) if error == "preparation_cancelled" => return Err(error),
                Err(error) => last_error = error,
            }
        }
    }

    selected
        .map(|json| ResolvedMedia {
            json,
            profile: selected_profile,
            artifacts,
        })
        .ok_or_else(|| {
            if last_error.is_empty() {
                "La fuente no ofrece una vista previa reproducible sin descargar".to_string()
            } else {
                sanitize_media_error_for_display(&last_error)
            }
        })
}

fn preview_complete(value: &Value) -> bool {
    let selected = super::player_preview_selected_entry(value);
    let selected_codec = first_string(selected, &["acodec"]);
    let selected_has_audio = !selected_codec.is_empty() && selected_codec != "none";
    let separate_audio = super::player_preview_audio_entry(value).is_some();
    !first_string(value, &["title", "fulltitle"]).is_empty()
        && json_exposes_reproducible_stream(value)
        && !first_string(selected, &["url"]).is_empty()
        && (selected_has_audio || separate_audio)
        && value
            .get("formats")
            .and_then(Value::as_array)
            .is_some_and(|formats| {
                formats.iter().any(|format| {
                    !first_string(format, &["url"]).is_empty()
                        && first_string(format, &["vcodec"]) != "none"
                })
            })
}

fn shared_operation_cancelled(
    flight: &Arc<InFlight>,
    operation: Option<&Arc<WindowOperation>>,
) -> bool {
    flight.cancelled.load(Ordering::SeqCst)
        || operation.is_some_and(|owner| {
            flight.consumers.load(Ordering::SeqCst) <= 1 && window_operation_is_cancelled(owner)
        })
}

fn clone_resolution_result(
    result: &Result<ResolvedMedia, String>,
) -> Result<ResolvedMedia, String> {
    result
        .as_ref()
        .map(|resolution| AnalysisResolution {
            json: resolution.json.clone(),
            profile: resolution.profile.clone(),
            artifacts: resolution.artifacts.clone(),
        })
        .map_err(Clone::clone)
}

fn wait_for_shared_analysis(
    flight: &std::sync::Arc<InFlight>,
    operation: Option<&Arc<WindowOperation>>,
) -> Result<AnalysisResolution, String> {
    let mut shared = flight
        .result
        .lock()
        .map_err(|_| "No se pudo esperar al resolvedor".to_string())?;
    loop {
        if let Some(result) = shared.as_ref() {
            return clone_resolution_result(result);
        }
        if flight.cancelled.load(Ordering::SeqCst)
            || operation.is_some_and(|owner| window_operation_is_cancelled(owner))
        {
            return Err("preparation_cancelled".into());
        }
        let (next, _) = flight
            .ready
            .wait_timeout(shared, Duration::from_millis(100))
            .map_err(|_| "No se pudo esperar al resolvedor".to_string())?;
        shared = next;
    }
}

fn analysis_cache_key(parsed: &Url, session: &MediaSessionOptions) -> String {
    resolution_cache_key(parsed, session, ResolutionPolicy::Analysis)
}

fn preview_cache_key(parsed: &Url) -> String {
    resolution_cache_key(
        parsed,
        &MediaSessionOptions::default(),
        ResolutionPolicy::PreviewFast,
    )
}

fn resolution_cache_key(
    parsed: &Url,
    session: &MediaSessionOptions,
    policy: ResolutionPolicy,
) -> String {
    let mut url_hasher = Sha256::new();
    url_hasher.update(parsed.as_str().as_bytes());
    let url_fingerprint = format!("{:x}", url_hasher.finalize());
    let session_key = if session.use_brave_cookies {
        "brave".to_string()
    } else if let Some(path) = &session.cookies_path {
        format!("netscape:{}", path.to_string_lossy())
    } else {
        "anonymous".to_string()
    };
    let policy_key = match policy {
        ResolutionPolicy::Analysis => "analysis",
        ResolutionPolicy::PreviewFast => "preview-fast",
    };
    format!(
        "media:v1|url:{}|{}|{}|policy={policy_key}",
        url_fingerprint,
        media_provider_key(parsed),
        session_key
    )
}

fn media_provider_key(parsed: &Url) -> String {
    if media_host_is(parsed, "youtube.com") || media_host_is(parsed, "youtu.be") {
        "youtube".into()
    } else if media_host_is(parsed, "tiktok.com") {
        "tiktok".into()
    } else {
        parsed.host_str().unwrap_or("unknown").into()
    }
}

fn session_fingerprint(session: &MediaSessionOptions) -> String {
    let identity = if session.use_brave_cookies {
        "brave".to_string()
    } else if let Some(path) = &session.cookies_path {
        format!("netscape:{}", path.to_string_lossy())
    } else {
        "anonymous".to_string()
    };
    let mut hasher = Sha256::new();
    hasher.update(identity.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn raw_extraction_artifact(
    request_url: &Url,
    source_url: &str,
    profile: &str,
    session: &MediaSessionOptions,
    policy: ResolutionPolicy,
    raw_json: Value,
) -> RawExtractionArtifact {
    let expires_at =
        collect_stream_expiration(&raw_json).map(|unix| UNIX_EPOCH + Duration::from_secs(unix));
    RawExtractionArtifact {
        provider: media_provider_key(request_url),
        request_url: request_url.as_str().to_string(),
        source_url: source_url.to_string(),
        profile: profile.to_string(),
        session_fingerprint: session_fingerprint(session),
        policy,
        captured_at: SystemTime::now(),
        expires_at,
        raw_json,
    }
}

pub(super) fn prepare_download_reuse(
    parsed: &Url,
    session: &MediaSessionOptions,
    selector: &str,
    output_mode: &str,
    work_dir: &std::path::Path,
    job_id: i64,
) -> Option<DownloadReuseAttempt> {
    let candidates = [
        resolution_cache_get(&analysis_cache_key(parsed, session)),
        if session.use_brave_cookies || session.cookies_path.is_some() {
            None
        } else {
            resolution_cache_get(&preview_cache_key(parsed))
        },
    ];
    let session_key = session_fingerprint(session);
    for resolution in candidates.into_iter().flatten() {
        for artifact in resolution.artifacts.iter().rev() {
            if !download_artifact_compatible(artifact, parsed, &session_key, selector, output_mode)
            {
                continue;
            }
            let source_url = artifact.source_url.clone();
            let Some(parsed_source) = Url::parse(&source_url).ok() else {
                continue;
            };
            let Some(info_json) =
                materialize_download_artifact(&artifact.raw_json, work_dir, job_id)
            else {
                continue;
            };
            return Some(DownloadReuseAttempt {
                extractor_args: artifact.profile.clone(),
                source_url,
                parsed_source,
                selector: selector.to_string(),
                info_json,
            });
        }
    }
    None
}

fn download_artifact_compatible(
    artifact: &RawExtractionArtifact,
    parsed: &Url,
    expected_session: &str,
    selector: &str,
    output_mode: &str,
) -> bool {
    if artifact.provider != media_provider_key(parsed)
        || artifact.request_url != parsed.as_str()
        || artifact.session_fingerprint != expected_session
        || !matches!(
            artifact.policy,
            ResolutionPolicy::Analysis | ResolutionPolicy::PreviewFast
        )
        || artifact.raw_json.get("entries").is_some()
    {
        return false;
    }
    if artifact
        .expires_at
        .is_some_and(|expires| expires <= SystemTime::now() + ANALYSIS_URL_SAFETY_MARGIN)
    {
        return false;
    }
    if artifact.source_url.trim().is_empty() {
        return false;
    }

    let formats = artifact
        .raw_json
        .get("formats")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let has_audio = formats.iter().any(usable_audio_format);
    let height_limit = selector_height_limit(selector);
    let has_video = formats.iter().any(|format| {
        usable_video_format(format)
            && height_limit.is_none_or(|limit| {
                format
                    .get("height")
                    .and_then(Value::as_u64)
                    .is_some_and(|height| height <= u64::from(limit))
            })
    });
    let explicit_format_id = selector_explicit_format_id(selector);
    if let Some(format_id) = explicit_format_id {
        if !formats.iter().any(|format| {
            first_string(format, &["format_id"]) == format_id
                && (!format
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .is_empty())
        }) {
            return false;
        }
    }

    match output_mode {
        "audio_best" | "audio_mp3" | "audio_m4a" | "audio_flac" | "audio_flac_hires"
        | "audio_flac_max" => has_audio,
        "source" => has_audio || has_video,
        "video_mp4" | "video_webm" => has_video && has_audio,
        _ => false,
    }
}

fn usable_audio_format(format: &Value) -> bool {
    !first_string(format, &["url"]).is_empty()
        && !matches!(first_string(format, &["acodec"]).as_str(), "" | "none")
}

fn usable_video_format(format: &Value) -> bool {
    !first_string(format, &["url"]).is_empty()
        && !matches!(first_string(format, &["vcodec"]).as_str(), "" | "none")
}

fn selector_height_limit(selector: &str) -> Option<u32> {
    let lower = selector.to_ascii_lowercase();
    let marker = "height<=";
    let start = lower.find(marker)? + marker.len();
    let digits: String = lower[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn selector_explicit_format_id(selector: &str) -> Option<String> {
    let candidate = selector.split('/').next()?.trim();
    if candidate.is_empty()
        || candidate.contains('[')
        || candidate.contains('*')
        || candidate.contains('+')
        || candidate.starts_with("best")
    {
        return None;
    }
    candidate
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .then(|| candidate.to_string())
}

fn materialize_download_artifact(
    raw_json: &Value,
    work_dir: &std::path::Path,
    job_id: i64,
) -> Option<std::path::PathBuf> {
    std::fs::create_dir_all(work_dir).ok()?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let path = work_dir.join(format!("reuse-{job_id}-{nonce}.info.json"));
    let temporary = work_dir.join(format!(".reuse-{job_id}-{nonce}.tmp"));
    let bytes = serde_json::to_vec(raw_json).ok()?;
    if std::fs::write(&temporary, bytes).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return None;
    }
    if std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(path)
}

fn analysis_cache_get(key: &str) -> Option<AnalysisResolution> {
    resolution_cache_get(key)
}

fn resolution_cache_get(key: &str) -> Option<ResolvedMedia> {
    let state = ANALYSIS_STATE.get_or_init(|| Mutex::new(AnalysisState::default()));
    let mut state = state.lock().ok()?;
    let now = SystemTime::now();
    let expired = state
        .cache
        .get(key)
        .is_some_and(|entry| entry.expires_at <= now);
    if expired {
        state.cache.remove(key);
        return None;
    }
    state.clock = state.clock.saturating_add(1);
    let tick = state.clock;
    state.cache.get_mut(key).map(|entry| {
        entry.last_used = tick;
        AnalysisResolution {
            json: entry.resolution.json.clone(),
            profile: entry.resolution.profile.clone(),
            artifacts: entry.resolution.artifacts.clone(),
        }
    })
}

fn analysis_cache_put(key: &str, resolution: &AnalysisResolution) {
    resolution_cache_put(key, resolution)
}

fn resolution_cache_put(key: &str, resolution: &ResolvedMedia) {
    let Some(expires_at) = effective_stream_expiration(&resolution.json) else {
        return;
    };
    let state = ANALYSIS_STATE.get_or_init(|| Mutex::new(AnalysisState::default()));
    let Ok(mut state) = state.lock() else { return };
    state.clock = state.clock.saturating_add(1);
    let tick = state.clock;
    state.cache.insert(
        key.to_string(),
        CacheEntry {
            resolution: AnalysisResolution {
                json: resolution.json.clone(),
                profile: resolution.profile.clone(),
                artifacts: resolution.artifacts.clone(),
            },
            expires_at,
            last_used: tick,
        },
    );
    while state.cache.len() > ANALYSIS_CACHE_LIMIT {
        if let Some(oldest) = state
            .cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        {
            state.cache.remove(&oldest);
        } else {
            break;
        }
    }
}

fn effective_stream_expiration(value: &Value) -> Option<SystemTime> {
    let now = SystemTime::now();
    let configured = now.checked_add(ANALYSIS_CACHE_TTL)?;
    let known = collect_stream_expiration(value).map(|unix| UNIX_EPOCH + Duration::from_secs(unix));
    Some(match known {
        Some(expiration) => configured.min(
            expiration
                .checked_sub(ANALYSIS_URL_SAFETY_MARGIN)
                .unwrap_or(UNIX_EPOCH),
        ),
        None => configured,
    })
}

fn collect_stream_expiration(value: &Value) -> Option<u64> {
    let mut earliest = None;
    fn visit(value: &Value, earliest: &mut Option<u64>) {
        match value {
            Value::Object(map) => {
                if let Some(url) = map.get("url").and_then(Value::as_str) {
                    if let Ok(parsed) = Url::parse(url) {
                        for (name, value) in parsed.query_pairs() {
                            if matches!(name.as_ref(), "expire" | "expires") {
                                if let Ok(timestamp) = value.parse::<u64>() {
                                    *earliest =
                                        Some(earliest.map_or(timestamp, |old| old.min(timestamp)));
                                }
                            }
                        }
                    }
                }
                for child in map.values() {
                    visit(child, earliest);
                }
            }
            Value::Array(values) => {
                for child in values {
                    visit(child, earliest);
                }
            }
            _ => {}
        }
    }
    visit(value, &mut earliest);
    earliest
}

fn metadata_complete(value: &Value) -> bool {
    !first_string(value, &["title", "fulltitle"]).is_empty()
        && (value.get("duration").and_then(Value::as_f64).is_some()
            || value.get("entries").is_some())
}

fn analysis_contract_complete(value: &Value) -> bool {
    metadata_complete(value)
        && json_exposes_reproducible_stream(value)
        && !media_formats(value).is_empty()
}

fn quality_discovery_complete(value: &Value, stable_attempts: u8) -> bool {
    if !analysis_contract_complete(value) {
        return false;
    }
    !media_metadata_needs_quality_fallback(value) || stable_attempts >= 2
}

fn analysis_selectable_signature(value: &Value) -> Vec<(String, String, bool)> {
    media_formats(value)
        .into_iter()
        .map(|format| (format.id, format.resolution, format.audio_only))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reusable_artifact() -> RawExtractionArtifact {
        let request_url = Url::parse("https://www.youtube.com/watch?v=reusable").unwrap();
        let raw_json = serde_json::json!({
            "title": "Reusable",
            "duration": 12,
            "formats": [
                {"format_id":"137","height":1080,"vcodec":"avc1","acodec":"none","url":"https://cdn.example.test/video.mp4?expire=4102444800"},
                {"format_id":"140","height":null,"vcodec":"none","acodec":"mp4a","url":"https://cdn.example.test/audio.m4a?expire=4102444800"}
            ]
        });
        raw_extraction_artifact(
            &request_url,
            request_url.as_str(),
            "",
            &MediaSessionOptions::default(),
            ResolutionPolicy::Analysis,
            raw_json,
        )
    }

    #[test]
    fn analysis_cache_key_scopes_provider_and_session_without_cookie_contents() {
        let parsed = Url::parse("https://www.youtube.com/watch?v=abc").unwrap();
        let anonymous = MediaSessionOptions::default();
        let brave = MediaSessionOptions {
            use_brave_cookies: true,
            cookies_path: None,
        };
        assert_ne!(
            analysis_cache_key(&parsed, &anonymous),
            analysis_cache_key(&parsed, &brave)
        );
        assert!(analysis_cache_key(&parsed, &brave).contains("brave"));
        assert!(!analysis_cache_key(&parsed, &brave).contains("cookie"));
    }

    #[test]
    fn analysis_cache_key_scopes_distinct_urls() {
        let first = Url::parse("https://www.youtube.com/watch?v=first").unwrap();
        let second = Url::parse("https://www.youtube.com/watch?v=second").unwrap();
        let session = MediaSessionOptions::default();

        assert_ne!(
            analysis_cache_key(&first, &session),
            analysis_cache_key(&second, &session)
        );
    }

    #[test]
    fn compatible_raw_artifact_can_seed_video_and_audio_downloads() {
        let artifact = reusable_artifact();
        let parsed = Url::parse("https://www.youtube.com/watch?v=reusable").unwrap();
        let session_key = session_fingerprint(&MediaSessionOptions::default());
        assert!(download_artifact_compatible(
            &artifact,
            &parsed,
            &session_key,
            "bestvideo[height<=1080]+bestaudio/best",
            "video_mp4"
        ));
        assert!(download_artifact_compatible(
            &artifact,
            &parsed,
            &session_key,
            "bestaudio/best",
            "audio_m4a"
        ));
    }

    #[test]
    fn raw_artifact_reuse_isolated_by_session_selector_and_expiration() {
        let parsed = Url::parse("https://www.youtube.com/watch?v=reusable").unwrap();
        let anonymous_key = session_fingerprint(&MediaSessionOptions::default());
        let brave_key = session_fingerprint(&MediaSessionOptions {
            use_brave_cookies: true,
            cookies_path: None,
        });
        let artifact = reusable_artifact();
        assert!(!download_artifact_compatible(
            &artifact,
            &parsed,
            &brave_key,
            "bestvideo[height<=1080]+bestaudio/best",
            "video_mp4"
        ));
        assert!(!download_artifact_compatible(
            &artifact,
            &parsed,
            &anonymous_key,
            "bestvideo[height<=720]+bestaudio/best",
            "video_mp4"
        ));

        let mut expired = artifact.clone();
        expired.expires_at = Some(UNIX_EPOCH);
        assert!(!download_artifact_compatible(
            &expired,
            &parsed,
            &anonymous_key,
            "bestvideo[height<=1080]+bestaudio/best",
            "video_mp4"
        ));
        let mut near_expired = artifact;
        near_expired.expires_at = Some(SystemTime::now() + Duration::from_secs(10));
        assert!(!download_artifact_compatible(
            &near_expired,
            &parsed,
            &anonymous_key,
            "bestvideo[height<=1080]+bestaudio/best",
            "video_mp4"
        ));
    }

    #[test]
    fn search_metadata_and_invalid_raw_artifacts_never_seed_downloads() {
        let parsed = Url::parse("https://www.youtube.com/watch?v=reusable").unwrap();
        let session_key = session_fingerprint(&MediaSessionOptions::default());
        let mut search = reusable_artifact();
        search.raw_json = serde_json::json!({
            "_type": "url",
            "entries": [{"id":"reusable","title":"Search only"}]
        });
        assert!(!download_artifact_compatible(
            &search,
            &parsed,
            &session_key,
            "bestvideo*+bestaudio/best",
            "video_mp4"
        ));

        let mut invalid = reusable_artifact();
        invalid.raw_json = serde_json::json!({"title":"No streams"});
        assert!(!download_artifact_compatible(
            &invalid,
            &parsed,
            &session_key,
            "bestvideo*+bestaudio/best",
            "video_mp4"
        ));
    }

    #[test]
    fn materialized_raw_artifact_is_exact_and_has_a_cleanup_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let work_dir = std::env::temp_dir().join(format!("cacatools-reuse-test-{unique}"));
        let raw_json = serde_json::json!({"title":"exact","formats":[]});
        let path = materialize_download_artifact(&raw_json, &work_dir, 77).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written, raw_json);
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("reuse-77-"));
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(work_dir).unwrap();
    }

    #[test]
    fn compatible_cached_artifact_is_selected_for_download_without_synthetic_json() {
        let parsed = Url::parse("https://www.youtube.com/watch?v=reusable").unwrap();
        let artifact = reusable_artifact();
        let key = analysis_cache_key(&parsed, &MediaSessionOptions::default());
        let resolution = AnalysisResolution {
            json: artifact.raw_json.clone(),
            profile: artifact.profile.clone(),
            artifacts: vec![artifact],
        };
        analysis_cache_put(&key, &resolution);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let work_dir = std::env::temp_dir().join(format!("cacatools-reuse-select-{unique}"));
        let selected = prepare_download_reuse(
            &parsed,
            &MediaSessionOptions::default(),
            "bestvideo[height<=1080]+bestaudio/best",
            "video_mp4",
            &work_dir,
            78,
        )
        .unwrap();
        assert!(selected.info_json.is_file());
        assert_eq!(selected.extractor_args, "");
        let written: Value =
            serde_json::from_slice(&std::fs::read(&selected.info_json).unwrap()).unwrap();
        assert_eq!(written, resolution.json);
        std::fs::remove_file(selected.info_json).unwrap();
        std::fs::remove_dir(work_dir).unwrap();
    }

    #[test]
    fn signed_url_expiration_can_reduce_metadata_cache_lifetime() {
        let value = serde_json::json!({
            "formats":[{"url":"https://cdn.example.test/x?expire=4102444800"}]
        });
        assert!(effective_stream_expiration(&value).is_some());
    }

    #[test]
    fn completeness_levels_keep_a_limited_result_on_the_fallback_path() {
        let limited = serde_json::json!({
            "title": "Example",
            "duration": 10,
            "formats": [{"format_id":"18","height":720,"vcodec":"avc1","acodec":"mp4a","url":"https://cdn.example.test/720.mp4"}]
        });
        assert!(metadata_complete(&limited));
        assert!(analysis_contract_complete(&limited));
        assert!(!quality_discovery_complete(&limited, 0));
        assert!(quality_discovery_complete(&limited, 2));
    }

    #[test]
    fn cache_isolates_urls_sessions_expiration_and_errors() {
        let first = Url::parse("https://www.youtube.com/watch?v=cache-isolation-first").unwrap();
        let second = Url::parse("https://www.youtube.com/watch?v=cache-isolation-second").unwrap();
        let anonymous = MediaSessionOptions::default();
        let brave = MediaSessionOptions {
            use_brave_cookies: true,
            cookies_path: None,
        };
        let first_key = analysis_cache_key(&first, &anonymous);
        let second_key = analysis_cache_key(&second, &anonymous);
        let first_resolution = AnalysisResolution {
            json: serde_json::json!({
                "title": "FIRST",
                "duration": 1,
                "formats": [{
                    "format_id": "18",
                    "height": 720,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "url": "https://cdn.example.test/first.mp4?expire=4102444800"
                }]
            }),
            profile: "first".into(),
            artifacts: vec![],
        };

        analysis_cache_put(&first_key, &first_resolution);
        assert_eq!(
            analysis_cache_get(&first_key)
                .and_then(|resolution| resolution.json.get("title").cloned()),
            Some(Value::String("FIRST".into()))
        );
        assert!(analysis_cache_get(&second_key).is_none());
        assert!(analysis_cache_get(&analysis_cache_key(&first, &brave)).is_none());
        assert!(analysis_cache_get(&analysis_cache_key(
            &Url::parse("https://www.youtube.com/watch?v=cache-isolation-error").unwrap(),
            &anonymous
        ))
        .is_none());

        let expired_key = analysis_cache_key(
            &Url::parse("https://www.youtube.com/watch?v=cache-isolation-expired").unwrap(),
            &anonymous,
        );
        if let Ok(mut state) = ANALYSIS_STATE
            .get_or_init(|| Mutex::new(AnalysisState::default()))
            .lock()
        {
            state.cache.insert(
                expired_key.clone(),
                CacheEntry {
                    resolution: first_resolution,
                    expires_at: UNIX_EPOCH,
                    last_used: 0,
                },
            );
        }
        assert!(analysis_cache_get(&expired_key).is_none());
    }

    #[test]
    fn identical_analysis_waiters_receive_one_shared_result() {
        let flight = std::sync::Arc::new(InFlight {
            result: Mutex::new(None),
            ready: Condvar::new(),
            consumers: AtomicUsize::new(2),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        let waiter_flight = flight.clone();
        let waiter = std::thread::spawn(move || wait_for_shared_analysis(&waiter_flight, None));
        std::thread::sleep(Duration::from_millis(20));
        if let Ok(mut shared) = flight.result.lock() {
            *shared = Some(Ok(AnalysisResolution {
                json: serde_json::json!({"title":"SHARED"}),
                profile: "shared".into(),
                artifacts: vec![],
            }));
            flight.ready.notify_all();
        }
        let result = waiter.join().unwrap().unwrap();
        assert_eq!(
            result.json.get("title").and_then(Value::as_str),
            Some("SHARED")
        );
    }

    #[test]
    fn preview_complete_primary_can_stop_before_secondary_profile() {
        let complete = serde_json::json!({
            "title": "Preview",
            "duration": 10,
            "requested_formats": [
                {"url":"https://cdn.example.test/video.mp4","vcodec":"avc1","acodec":"none"},
                {"url":"https://cdn.example.test/audio.m4a","vcodec":"none","acodec":"mp4a"}
            ],
            "formats": [
                {"format_id":"18","height":360,"vcodec":"avc1","acodec":"mp4a","url":"https://cdn.example.test/video.mp4"}
            ]
        });
        assert!(preview_complete(&complete));
    }

    #[test]
    fn preview_incomplete_result_continues_to_compatibility_profiles() {
        let incomplete = serde_json::json!({
            "title": "Preview",
            "duration": 10,
            "formats": [{"format_id":"137","height":1080,"vcodec":"avc1","acodec":"none"}]
        });
        assert!(!preview_complete(&incomplete));
        let youtube = Url::parse("https://www.youtube.com/watch?v=preview-fallback").unwrap();
        assert!(media_extraction_profiles(&youtube).len() >= 3);
    }

    #[test]
    fn preview_policy_cache_key_is_distinct_from_analysis() {
        let parsed = Url::parse("https://www.youtube.com/watch?v=preview-policy").unwrap();
        let session = MediaSessionOptions::default();
        assert_ne!(
            resolution_cache_key(&parsed, &session, ResolutionPolicy::Analysis),
            preview_cache_key(&parsed)
        );
    }

    #[test]
    fn four_preview_consumers_share_one_flight() {
        let flight = std::sync::Arc::new(InFlight {
            result: Mutex::new(None),
            ready: Condvar::new(),
            consumers: AtomicUsize::new(1),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        for _ in 0..3 {
            flight.consumers.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(flight.consumers.load(Ordering::SeqCst), 4);
        assert!(!flight.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn dropping_one_preview_consumer_keeps_another_active() {
        let flight = std::sync::Arc::new(InFlight {
            result: Mutex::new(None),
            ready: Condvar::new(),
            consumers: AtomicUsize::new(0),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        flight.consumers.fetch_add(2, Ordering::SeqCst);
        let peer = FlightConsumer {
            flight: flight.clone(),
        };
        drop(peer);
        assert_eq!(flight.consumers.load(Ordering::SeqCst), 1);
        assert!(!flight.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn analysis_reuse_requires_preview_complete() {
        let analysis_only = serde_json::json!({
            "title": "Analysis",
            "duration": 10,
            "formats": [{"format_id":"137","height":1080,"vcodec":"avc1","acodec":"none","url":"https://cdn.example.test/video.mp4"}]
        });
        assert!(!preview_complete(&analysis_only));
    }
}
