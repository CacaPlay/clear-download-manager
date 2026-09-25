use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use url::Url;

use super::super::resolver;
use super::super::{
    advance_playlist_batch, classify_media_process_error, ensure_public_network_resolution,
    is_browser_cookie_copy_error, media_backoff_delay, normalize_tiktok_source_url,
    recent_kind_from_path, refresh_media_info,
};
use super::super::{
    build_media_download_command, cooperative_media_sleep, fail_media_job,
    media_extraction_profiles, media_host_is, media_job_batch, media_partial_exists,
    media_playlist_seeds, persist_media_backoff, persist_media_intervention_required,
    sanitize_media_error_for_display, saved_media_session_for_db, should_retry_without_info_json,
    tiktok_embed_source_url, tiktok_same_resolution_format_fallback, update_media_progress,
    MediaFailureClass, MediaProgressTracker, MediaSessionOptions, MEDIA_PROGRESS_DB_INTERVAL_MS,
    YOUTUBE_WEB_SAFARI_HLS_PROFILE, YOUTUBE_WEB_SAFARI_HLS_SELECTOR,
};
use super::progress::{ensure_media_job_running, set_media_processing_stage};
use super::validation::{ensure_windows_compatible_mp4, validate_downloaded_media};
use crate::dispatcher;
use crate::{
    configure_connection, kill_process_tree, register_external_process, unique_destination,
    ActiveMediaGuard, ExternalProcessKind, ExternalProcessRegistry, MediaRuntimePaths,
    WorkerCompletion, WorkerCompletionGuard, EXIT_REQUESTED,
};

use crate::progress::adapter::{
    shadow_begin_download, shadow_begin_playlist, shadow_cancel_playlist, shadow_mark_cancelled,
    shadow_mark_completed, shadow_mark_failed, shadow_mark_finalizing, shadow_mark_paused,
    shadow_mark_post_processing, shadow_mark_preparing, shadow_pause_playlist, shadow_remove,
};

pub(crate) fn run_media_worker_with_completion(
    db_path: PathBuf,
    runtime: MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
    completion: Option<WorkerCompletion>,
) -> bool {
    let session = saved_media_session_for_db(&db_path);
    run_media_worker_with_completion_options(
        db_path,
        runtime,
        active,
        external_processes,
        id,
        session,
        completion,
    )
}

pub(crate) fn run_media_worker_with_completion_options(
    db_path: PathBuf,
    runtime: MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
    session: MediaSessionOptions,
    completion: Option<WorkerCompletion>,
) -> bool {
    {
        let Ok(mut guard) = active.lock() else {
            if let Some(completion) = completion {
                completion();
            }
            return false;
        };
        if guard.contains_key(&id) {
            if let Some(completion) = completion {
                completion();
            }
            return false;
        }
        guard.insert(id, 0);
    }
    thread::spawn(move || {
        let _completion = WorkerCompletionGuard::new(completion);
        let _guard = ActiveMediaGuard {
            id,
            active: active.clone(),
        };
        let batch_id = media_job_batch(&db_path, id);
        if let Some(batch_id) = batch_id {
            shadow_begin_playlist(batch_id, media_playlist_seeds(&db_path, batch_id));
        }
        if let Err(error) = run_media_worker_inner(
            &db_path,
            &runtime,
            active.clone(),
            external_processes.clone(),
            id,
            session.clone(),
        ) {
            if EXIT_REQUESTED.load(Ordering::SeqCst) {
                shadow_remove(id);
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
            if !matches!(
                current_status.as_str(),
                "paused" | "cancelled" | "completed"
            ) {
                shadow_mark_failed(id);
                fail_media_job(&db_path, id, &error);
            }
        }
        if let Some(batch_id) = batch_id {
            let (status, batch_status) = Connection::open(&db_path)
                .ok()
                .and_then(|connection| {
                    let status = connection
                        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                            row.get::<_, String>(0)
                        })
                        .ok()?;
                    let batch_status = connection
                        .query_row(
                            "SELECT status FROM playlist_batches WHERE id=?1",
                            params![batch_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                        .unwrap_or_else(|| "failed".into());
                    Some((status, batch_status))
                })
                .unwrap_or_else(|| ("failed".into(), "failed".into()));
            match batch_status.as_str() {
                "paused" => shadow_pause_playlist(batch_id),
                "cancelled" => shadow_cancel_playlist(batch_id),
                _ => {}
            }
            if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
                advance_playlist_batch(&db_path, &runtime, active, external_processes, batch_id);
            }
        }
        shadow_remove(id);
    });
    true
}

pub(crate) fn run_media_worker(
    db_path: PathBuf,
    runtime: MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
) {
    let session = saved_media_session_for_db(&db_path);
    run_media_worker_with_options(db_path, runtime, active, external_processes, id, session);
}

const MEDIA_WORK_PATH_BUDGET_CHARS: usize = 240;
const MEDIA_WORK_SUFFIX_BUDGET_CHARS: usize = 48;

fn media_output_name_limit(work_dir: &Path) -> usize {
    let work_path_chars = work_dir
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .count();
    MEDIA_WORK_PATH_BUDGET_CHARS
        .saturating_sub(work_path_chars.saturating_add(MEDIA_WORK_SUFFIX_BUDGET_CHARS))
        .clamp(48, 120)
}

fn clip_media_requested_filename(value: &str, max_chars: usize) -> String {
    let clipped = value
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim_end_matches([' ', '.'])
        .to_string();
    if clipped.is_empty() {
        "descarga".into()
    } else {
        clipped
    }
}

pub(crate) fn run_media_worker_with_options(
    db_path: PathBuf,
    runtime: MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
    session: MediaSessionOptions,
) {
    if dispatcher::register_media_session(id, session.clone()) {
        return;
    }
    let _ = run_media_worker_with_completion_options(
        db_path,
        runtime,
        active,
        external_processes,
        id,
        session,
        None,
    );
}

fn media_file_retry_delay(attempt: usize) -> Duration {
    let base = match attempt {
        1 => 2,
        _ => 5,
    };
    let jitter = ((std::process::id() as usize + attempt * 17) % 400) as u64;
    Duration::from_millis(base * 1_000 + jitter)
}

pub(crate) fn validation_error_is_retryable(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("ffprobe")
        || lower.contains("archivo bloqueado")
        || lower.contains("incompleto")
        || lower.contains("leer")
        || lower.contains("renombr")
}

pub(crate) fn finalize_media_file(source: &Path, destination: &Path) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        match fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(_rename_error) => {
                let temporary = destination.with_file_name(format!(
                    ".{}.finalizing",
                    destination
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("cacatools-media")
                ));
                let _ = fs::remove_file(&temporary);
                match fs::copy(source, &temporary)
                    .and_then(|_| fs::rename(&temporary, destination))
                    .and_then(|_| fs::remove_file(source))
                {
                    Ok(()) => return Ok(()),
                    Err(copy_error) => last_error = copy_error.to_string(),
                }
            }
        }
        if attempt < 2 {
            thread::sleep(media_file_retry_delay(attempt + 1));
        }
    }
    Err(format!(
        "No se pudo mover el archivo validado a su destino final: {last_error}"
    ))
}

pub(crate) fn resume_media_worker_when_idle(
    db_path: PathBuf,
    runtime: MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
) {
    thread::spawn(move || {
        for _ in 0..140 {
            let busy = active
                .lock()
                .map(|guard| guard.contains_key(&id))
                .unwrap_or(true);
            if !busy {
                if let Ok(connection) = Connection::open(&db_path) {
                    let _ = connection.execute(
                        "UPDATE jobs SET status='running',detail='Reanudando descarga multimedia…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",
                        params![id],
                    );
                    let _ = connection.execute(
                        "UPDATE playlist_items SET status='running' WHERE job_id=?1 AND status NOT IN ('completed','cancelled')",
                        params![id],
                    );
                }
                run_media_worker(db_path, runtime, active, external_processes, id);
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        fail_media_job(
            &db_path,
            id,
            "No fue posible reanudar el proceso multimedia porque yt-dlp no terminó a tiempo",
        );
    });
}

pub(crate) fn is_final_media_candidate(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    !name.ends_with(".part")
        && !name.ends_with(".ytdl")
        && !name.ends_with(".tmp")
        && !name.ends_with(".temp")
        && !name.ends_with(".json")
}

pub(crate) fn collect_completed_media(directory: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_completed_media(&path, output);
        } else if is_final_media_candidate(&path) {
            output.push(path);
        }
    }
}

pub(crate) fn resolve_reported_media_path(
    reported: &str,
    destination_dir: &Path,
) -> Option<PathBuf> {
    let cleaned = reported.trim().trim_matches('"');
    if cleaned.is_empty() {
        return None;
    }
    let direct = PathBuf::from(cleaned);
    let candidate = if direct.is_absolute() {
        direct
    } else {
        destination_dir.join(direct)
    };
    let canonical = candidate.canonicalize().ok()?;
    let canonical_destination = destination_dir.canonicalize().ok()?;
    (is_final_media_candidate(&canonical) && canonical.starts_with(canonical_destination))
        .then_some(canonical)
}

pub(crate) fn expected_output_extensions(output_mode: &str) -> &'static [&'static str] {
    match output_mode {
        "audio_mp3" => &["mp3"],
        "audio_m4a" => &["m4a", "mp4"],
        "audio_flac" | "audio_flac_hires" | "audio_flac_max" => &["flac"],
        "audio_best" => &["m4a", "webm", "opus", "ogg", "aac", "flac", "wav", "mp3"],
        "video_webm" => &["webm"],
        "video_mp4" => &["mp4", "m4v"],
        _ => &[
            "mp4", "webm", "mkv", "m4a", "mp3", "opus", "ogg", "aac", "flac", "wav",
        ],
    }
}

pub(crate) fn newest_completed_media(
    destination_dir: &Path,
    media_id: Option<&str>,
    reported_path: Option<&str>,
    output_mode: &str,
    started_at: SystemTime,
) -> Option<PathBuf> {
    let canonical_destination = destination_dir.canonicalize().ok()?;
    let reported_stem = reported_path
        .map(|value| value.trim().trim_matches('"'))
        .filter(|value| !value.is_empty())
        .and_then(|value| Path::new(value).file_stem())
        .and_then(|value| value.to_str())
        .map(str::to_owned);
    let expected_extensions = expected_output_extensions(output_mode);
    let mut files = Vec::new();
    collect_completed_media(destination_dir, &mut files);
    let mut candidates = files
        .into_iter()
        .filter_map(|path| {
            let canonical = path.canonicalize().ok()?;
            if !canonical.starts_with(&canonical_destination) {
                return None;
            }
            let metadata = fs::metadata(&canonical).ok()?;
            if metadata.len() < 1024 {
                return None;
            }
            let file_name = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let extension = canonical
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let id_match = media_id
                .filter(|value| !value.trim().is_empty())
                .is_some_and(|value| file_name.contains(&format!("[{value}]")));
            let stem_match = reported_stem.as_deref().is_some_and(|value| {
                canonical
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| stem == value)
            });
            let extension_match = expected_extensions.contains(&extension.as_str());
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            let recent = modified.duration_since(started_at).is_ok()
                || started_at
                    .duration_since(modified)
                    .is_ok_and(|elapsed| elapsed <= Duration::from_secs(600));
            if !id_match && !stem_match && !recent {
                return None;
            }
            let score = u8::from(id_match) * 8
                + u8::from(stem_match) * 4
                + u8::from(extension_match) * 2
                + u8::from(recent);
            let modified_order = modified
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| duration.as_secs());
            Some((score, modified_order, canonical))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse((candidate.0, candidate.1)));
    candidates.into_iter().map(|(_, _, path)| path).next()
}

pub(crate) fn wait_for_stable_file(path: &Path) -> Result<u64, String> {
    let mut previous = None;
    let mut stable_checks = 0u8;
    for _ in 0..20 {
        let metadata = fs::metadata(path)
            .map_err(|_| "La descarga terminó, pero el archivo final no existe".to_string())?;
        if !metadata.is_file() {
            return Err("La ruta final no corresponde a un archivo".into());
        }
        let length = metadata.len();
        if previous == Some(length) && length > 0 {
            stable_checks += 1;
        } else {
            stable_checks = 0;
        }
        if stable_checks >= 3 {
            return Ok(length);
        }
        previous = Some(length);
        thread::sleep(Duration::from_millis(250));
    }
    previous.ok_or_else(|| "No fue posible determinar el tamaño final".into())
}

pub(crate) fn json_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|entry| {
        entry
            .as_f64()
            .or_else(|| entry.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

pub(crate) fn minimum_acceptable_duration(expected_duration_seconds: Option<f64>) -> Option<f64> {
    expected_duration_seconds
        .filter(|value| value.is_finite() && *value >= 5.0)
        .map(|expected| (expected * 0.82).max(3.0))
}

pub(crate) fn run_media_worker_inner(
    db_path: &Path,
    runtime: &MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    id: i64,
    session: MediaSessionOptions,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    if crate::job_uses_legacy_removed_provider(&connection, id)? {
        return Err(crate::legacy_removed_provider_error());
    }
    let (source_url, selector, output_mode, destination_dir, requested_filename, expected_duration_seconds):
        (String, String, String, String, String, Option<f64>) = connection.query_row(
        "SELECT source_url,format_selector,output_mode,destination_dir,requested_filename,expected_duration_seconds FROM media_jobs WHERE job_id=?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|error| error.to_string())?;
    let parsed_source = Url::parse(&source_url)
        .map_err(|_| "El enlace multimedia almacenado no es válido".to_string())?;
    ensure_public_network_resolution(&parsed_source)?;
    let parsed_source = normalize_tiktok_source_url(parsed_source);
    let source_url = parsed_source.to_string();
    fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
    let initial_status: String = connection
        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if matches!(
        initial_status.as_str(),
        "paused" | "cancelled" | "completed"
    ) {
        return Ok(());
    }
    let _shadow_enabled = shadow_begin_download(id, &selector);
    shadow_mark_preparing(id);
    connection.execute(
        "UPDATE jobs SET status='running', detail='Preparando descarga multimedia…', updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('queued','running')",
        params![id],
    ).map_err(|error| error.to_string())?;
    let _ = connection.execute(
        "UPDATE media_jobs SET resolution_state='downloading',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
        params![id],
    );
    connection
        .execute(
            "UPDATE playlist_items SET status='running' WHERE job_id=?1 AND status IN ('queued','running')",
            params![id],
        )
        .map_err(|error| error.to_string())?;

    let started_at = SystemTime::now();
    let destination_root = PathBuf::from(&destination_dir);
    let work_dir = destination_root
        .join(".cacatools-work")
        .join(id.to_string());
    fs::create_dir_all(&work_dir).map_err(|error| {
        format!("No se pudo preparar el directorio temporal multimedia: {error}")
    })?;
    let previous_error: Option<String> = connection
        .query_row(
            "SELECT error FROM media_jobs WHERE job_id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if previous_error.is_some() {
        let mut completed = Vec::new();
        collect_completed_media(&work_dir, &mut completed);
        for path in completed {
            let _ = fs::remove_file(path);
        }
    }
    connection
        .execute(
            "UPDATE media_jobs SET error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    let output_name_limit = media_output_name_limit(&work_dir);
    let output_template = if requested_filename.trim().is_empty() {
        format!("%(title).{output_name_limit}B [%(id)s].%(ext)s")
    } else {
        format!(
            "{}.%(ext)s",
            clip_media_requested_filename(requested_filename.trim(), output_name_limit)
        )
    };
    let mut active_session = session.clone();
    let mut download_attempts = media_extraction_profiles(&parsed_source)
        .iter()
        .map(|extractor_args| {
            (
                (*extractor_args).to_string(),
                source_url.clone(),
                parsed_source.clone(),
                selector.clone(),
                None,
            )
        })
        .collect::<Vec<_>>();
    if let Some(reuse) = resolver::prepare_download_reuse(
        &parsed_source,
        &active_session,
        &selector,
        &output_mode,
        &work_dir,
        id,
    ) {
        download_attempts.insert(
            0,
            (
                reuse.extractor_args,
                reuse.source_url,
                reuse.parsed_source,
                reuse.selector,
                Some(reuse.info_json),
            ),
        );
    }
    if let Some(embed_source) = tiktok_embed_source_url(&parsed_source) {
        if let Ok(embed_parsed) = Url::parse(&embed_source) {
            // The public embed exposes a progressive MP4 even when the normal
            // TikTok webpage extractor is rejected. It is deliberately last so
            // the primary source and its format selection remain unchanged.
            download_attempts.push((
                String::new(),
                embed_source,
                embed_parsed,
                "best".into(),
                None,
            ));
        }
    }
    let mut refresh_attempts = 0usize;
    let mut rate_limit_retries = 0usize;
    let mut output_path = None;
    let mut media_id = None;
    let mut resolved_expected_duration = expected_duration_seconds;
    let mut progress_tracker = MediaProgressTracker::new(&selector);
    let mut last_progress_persist = Instant::now() - Duration::from_secs(1);
    let mut last_output = Instant::now();
    let mut last_waiting_notice = Instant::now();
    let mut last_download_error = String::new();
    let mut download_succeeded = false;
    let mut legacy_source_retry_queued = false;
    let mut tiktok_format_retry_queued = false;
    let mut hot_chaos = crate::chaos::HotChaosController::new();
    let mut attempt_index = 0usize;
    while attempt_index < download_attempts.len() {
        let (extractor_args, attempt_source_url, attempt_parsed, attempt_selector, info_json) =
            download_attempts[attempt_index].clone();
        attempt_index += 1;
        // A refreshed metadata file is short-lived. If a previous worker,
        // cleanup pass, or failed spawn removed it, never pass a dangling
        // --load-info-json path to yt-dlp: that produces the misleading
        // Python traceback seen by users instead of a recoverable retry.
        // The active-worker registry rejects a second worker for this job_id,
        // and refresh_media_info adds a nonce, so concurrent attempts do not
        // normally share this path. The guard remains a final TOCTOU shield.
        let info_json = info_json.filter(|path: &PathBuf| path.is_file());
        // Each process invocation takes an immutable snapshot. A retry or a
        // pause/resume starts a new process and therefore reads the latest
        // persisted policy without restarting an already active transfer.
        let bandwidth_policy = crate::downloads::read_job_bandwidth_policy(&connection, id);
        output_path = None;
        media_id = None;
        let mut command = build_media_download_command(
            runtime,
            &attempt_parsed,
            &attempt_source_url,
            &attempt_selector,
            &output_mode,
            &work_dir,
            &output_template,
            &extractor_args,
            attempt_source_url.contains("/embed/v2/"),
            &active_session,
            info_json.as_deref(),
            &bandwidth_policy,
        );

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                if let Some(info_json) = info_json.as_deref() {
                    let _ = fs::remove_file(info_json);
                }
                last_download_error = format!("No se pudo iniciar yt-dlp: {error}");
                continue;
            }
        };
        let pid = child.id();
        let _yt_dlp_guard = match register_external_process(
            &external_processes,
            id,
            pid,
            ExternalProcessKind::YtDlp,
        ) {
            Ok(guard) => guard,
            Err(error) => {
                kill_process_tree(pid);
                let _ = child.wait();
                if let Some(info_json) = info_json.as_deref() {
                    let _ = fs::remove_file(info_json);
                }
                return Err(error);
            }
        };
        if let Ok(mut current) = active.lock() {
            current.insert(id, pid);
        }
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                kill_process_tree(pid);
                let _ = child.wait();
                if let Some(info_json) = info_json.as_deref() {
                    let _ = fs::remove_file(info_json);
                }
                return Err("No se pudo leer el progreso multimedia".to_string());
            }
        };
        let stderr = child.stderr.take();
        let stderr_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(stderr) = stderr {
                let _ = BufReader::new(stderr).read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let (progress_sender, progress_receiver) = mpsc::channel::<Result<String, String>>();
        let stdout_reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => break,
                    Ok(_) => {
                        while bytes
                            .last()
                            .is_some_and(|byte| matches!(*byte, b'\n' | b'\r'))
                        {
                            bytes.pop();
                        }
                        let line = String::from_utf8_lossy(&bytes).into_owned();
                        if progress_sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = progress_sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        loop {
            let current_status: String = connection
                .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                    row.get(0)
                })
                .map_err(|error| error.to_string())?;
            if matches!(current_status.as_str(), "paused" | "cancelled") {
                kill_process_tree(pid);
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                if let Some(info_json) = info_json.as_deref() {
                    let _ = fs::remove_file(info_json);
                }
                if current_status == "cancelled" {
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
                        "Cancelada · temporales conservados"
                    };
                    connection
                        .execute(
                            "UPDATE jobs SET detail=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                            params![detail, id],
                        )
                        .map_err(|error| error.to_string())?;
                    connection
                        .execute(
                            "UPDATE playlist_items SET status='cancelled' WHERE job_id=?1",
                            params![id],
                        )
                        .map_err(|error| error.to_string())?;
                } else {
                    connection.execute(
                    "UPDATE jobs SET detail='En pausa · archivos parciales conservados', updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                ).map_err(|error| error.to_string())?;
                    connection
                        .execute(
                            "UPDATE playlist_items SET status='paused' WHERE job_id=?1",
                            params![id],
                        )
                        .map_err(|error| error.to_string())?;
                }
                if current_status == "cancelled" {
                    shadow_mark_cancelled(id);
                } else {
                    shadow_mark_paused(id);
                }
                return Ok(());
            }

            match progress_receiver.recv_timeout(Duration::from_millis(180)) {
                Ok(Ok(line)) => {
                    last_output = Instant::now();
                    if let Some(payload) = line.strip_prefix("CACATOOLS_PLAN:") {
                        progress_tracker.apply_stream_plan(payload);
                        continue;
                    }
                    let persist_transfer = last_progress_persist.elapsed()
                        >= Duration::from_millis(MEDIA_PROGRESS_DB_INTERVAL_MS);
                    if update_media_progress(
                        &connection,
                        id,
                        &line,
                        &mut progress_tracker,
                        persist_transfer,
                    ) && persist_transfer
                    {
                        last_progress_persist = Instant::now();
                    }
                    if let Some(path) = line.strip_prefix("CACATOOLS_FILE:") {
                        output_path = Some(path.trim().to_string());
                    }
                    if let Some(value) = line.strip_prefix("CACATOOLS_MEDIA_ID:") {
                        media_id = Some(value.trim().to_string());
                    }
                    if let Some(value) = line.strip_prefix("CACATOOLS_EXPECTED_DURATION:") {
                        if let Ok(duration) = value.trim().parse::<f64>() {
                            if duration.is_finite() && duration >= 0.5 {
                                resolved_expected_duration = Some(duration);
                                let _ = connection.execute(
                                "UPDATE media_jobs SET expected_duration_seconds=?1,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
                                params![duration, id],
                            );
                            }
                        }
                    }
                }
                Ok(Err(error)) => {
                    kill_process_tree(pid);
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    last_download_error = format!("No se pudo leer el progreso de yt-dlp: {error}");
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if progress_tracker
                        .declared_total_bytes
                        .is_some_and(|value| value >= 32 * 1024 * 1024)
                        && hot_chaos.due()
                    {
                        let _ = connection.execute(
                            "UPDATE jobs SET status='retrying',detail='Reintentando · corte de red simulado por Hot Chaos',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                            params![id],
                        );
                        if hot_chaos.maybe_cut(pid, "yt-dlp") {
                            let _ = connection.execute(
                                "UPDATE jobs SET status='running',detail='Descarga multimedia · reanudada',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                                params![id],
                            );
                        }
                    }
                    if last_output.elapsed() >= Duration::from_secs(3)
                        && last_waiting_notice.elapsed() >= Duration::from_secs(2)
                    {
                        let progress = connection
                            .query_row(
                                "SELECT progress FROM jobs WHERE id=?1",
                                params![id],
                                |row| row.get::<_, f64>(0),
                            )
                            .unwrap_or(0.0);
                        let detail = if progress <= 0.1 {
                            "Conectando con el origen y esperando datos…"
                        } else {
                            "Descarga activa · esperando el siguiente bloque…"
                        };
                        let _ = connection.execute(
                        "UPDATE jobs SET detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='running'",
                        params![detail, id],
                    );
                        last_waiting_notice = Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = stdout_reader.join();
                    break;
                }
            }
        }
        let status = match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => status,
            None => child.wait().map_err(|error| error.to_string())?,
        };
        let stderr_output = stderr_reader.join().unwrap_or_default();
        drop(_yt_dlp_guard);
        if let Some(info_json) = info_json.as_deref() {
            // The refreshed JSON contains short-lived signed stream URLs. It
            // is only needed for this one attempt and must not remain in the
            // work directory after the child exits.
            let _ = fs::remove_file(info_json);
        }
        if let Ok(mut current) = active.lock() {
            if current.get(&id).copied() == Some(pid) {
                current.insert(id, 0);
            }
        }
        if !status.success() {
            let current_status: String = connection
                .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                    row.get(0)
                })
                .unwrap_or_else(|_| "failed".into());
            if matches!(current_status.as_str(), "paused" | "cancelled") {
                return Ok(());
            }
            let error = stderr_output.trim().chars().take(600).collect::<String>();
            if !error.is_empty() {
                last_download_error = error;
            } else if last_download_error.is_empty() {
                last_download_error = "La descarga multimedia no pudo completarse".into();
            }
            if active_session.use_brave_cookies
                && is_browser_cookie_copy_error(&last_download_error)
            {
                // A locked Chromium profile must not abort a public download.
                // Drop the one-shot session material and retry anonymously;
                // browser cookies are never silently re-read or persisted.
                active_session = MediaSessionOptions::default();
                let _ = connection.execute(
                    "UPDATE jobs SET detail='No se pudo abrir la sesión local; reintentando sin cookies…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                );
                continue;
            }
            if should_retry_without_info_json(info_json.as_deref(), &last_download_error) {
                download_attempts.insert(
                    attempt_index,
                    (
                        extractor_args.clone(),
                        attempt_source_url.clone(),
                        attempt_parsed.clone(),
                        attempt_selector.clone(),
                        None,
                    ),
                );
                let _ = connection.execute(
                    "UPDATE jobs SET detail='Metadata temporal ausente · repitiendo extracción fresca…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                );
                continue;
            }
            if media_host_is(&attempt_parsed, "tiktok.com")
                && output_mode == "video_mp4"
                && !tiktok_format_retry_queued
            {
                if let Some(fallback_selector) =
                    tiktok_same_resolution_format_fallback(&attempt_selector)
                {
                    tiktok_format_retry_queued = true;
                    download_attempts.insert(
                        attempt_index,
                        (
                            extractor_args.clone(),
                            attempt_source_url.clone(),
                            attempt_parsed.clone(),
                            fallback_selector,
                            None,
                        ),
                    );
                    let _ = connection.execute(
                        "UPDATE jobs SET detail='TikTok rechazó un candidato · probando otro flujo de la misma resolución…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                        params![id],
                    );
                    continue;
                }
            }
            let failure_class = classify_media_process_error(&last_download_error);
            if matches!(failure_class, MediaFailureClass::Forbidden)
                && (media_host_is(&attempt_parsed, "youtube.com")
                    || media_host_is(&attempt_parsed, "youtu.be"))
                && !download_attempts
                    .iter()
                    .any(|(extractor_args, _, _, _, _)| {
                        extractor_args == YOUTUBE_WEB_SAFARI_HLS_PROFILE
                    })
            {
                // Current YouTube HTTP formats can return a provider-side 403 without a
                // usable partial. web_safari exposes an HLS variant that can avoid that GVS
                // path. Queue it only after the 403, never on the normal first attempt.
                download_attempts.insert(
                    attempt_index,
                    (
                        YOUTUBE_WEB_SAFARI_HLS_PROFILE.to_string(),
                        attempt_source_url.clone(),
                        attempt_parsed.clone(),
                        YOUTUBE_WEB_SAFARI_HLS_SELECTOR.to_string(),
                        None,
                    ),
                );
                let _ = connection.execute(
                    "UPDATE jobs SET detail='Googlevideo rechazó el flujo HTTP · probando HLS Safari…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                );
                continue;
            }
            match failure_class {
                MediaFailureClass::Captcha => {
                    persist_media_intervention_required(&connection, id);
                    return Err("intervention_required: la plataforma solicitó completar un CAPTCHA o una verificación humana".into());
                }
                MediaFailureClass::TooManyRequests => {
                    if let Some(delay) = media_backoff_delay(&mut rate_limit_retries) {
                        persist_media_backoff(&connection, id, delay);
                        if !cooperative_media_sleep(&connection, id, delay) {
                            return Ok(());
                        }
                        continue;
                    }
                }
                MediaFailureClass::Forbidden
                    if refresh_attempts < 2 && media_partial_exists(&work_dir) =>
                {
                    refresh_attempts += 1;
                    match refresh_media_info(
                        runtime,
                        &attempt_parsed,
                        &attempt_source_url,
                        &attempt_selector,
                        &work_dir,
                        id,
                        &connection,
                        &active_session,
                    ) {
                        Ok(info_path) => {
                            download_attempts.push((
                                String::new(),
                                attempt_source_url.clone(),
                                attempt_parsed.clone(),
                                attempt_selector.clone(),
                                Some(info_path),
                            ));
                            let _ = connection.execute(
                                "UPDATE jobs SET detail='Enlace temporal renovado · reanudando parcial…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                                params![id],
                            );
                            continue;
                        }
                        Err(refresh_error) => {
                            last_download_error = format!(
                                "403: no se pudo renovar el enlace temporal: {refresh_error}"
                            );
                        }
                    }
                }
                _ => {}
            }
            // The pre-security worker always made one final fresh extraction
            // from the public source after all profiles had failed. Keep that
            // recovery path for partial multimedia downloads: it avoids
            // retrying a stale --load-info-json URL and lets yt-dlp reuse the
            // existing .part/.ytdl state with a newly signed stream.
            if !legacy_source_retry_queued
                && attempt_index >= download_attempts.len()
                && media_partial_exists(&work_dir)
            {
                legacy_source_retry_queued = true;
                download_attempts.push((
                    String::new(),
                    attempt_source_url.clone(),
                    attempt_parsed.clone(),
                    attempt_selector.clone(),
                    None,
                ));
                let _ = connection.execute(
                    "UPDATE jobs SET detail='Reanudando desde el origen · conservando el parcial…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                );
            }
            continue;
        }
        let has_output = output_path
            .as_deref()
            .and_then(|reported| resolve_reported_media_path(reported, &work_dir))
            .or_else(|| {
                newest_completed_media(
                    &work_dir,
                    media_id.as_deref(),
                    output_path.as_deref(),
                    &output_mode,
                    started_at,
                )
            })
            .is_some();
        if has_output {
            download_succeeded = true;
            break;
        }
        last_download_error = format!(
            "yt-dlp terminó correctamente, pero no se pudo identificar el archivo final en {}",
            work_dir.display()
        );
    }
    if !download_succeeded {
        shadow_mark_failed(id);
        let raw_error = if last_download_error.is_empty() {
            "La descarga multimedia no pudo completarse".into()
        } else {
            last_download_error
        };
        return Err(sanitize_media_error_for_display(&raw_error));
    }
    shadow_mark_post_processing(id);
    set_media_processing_stage(&connection, id, "validating", "Validando archivo final…");

    ensure_media_job_running(&connection, id)?;
    let downloaded_path = output_path
        .as_deref()
        .and_then(|reported| resolve_reported_media_path(reported, &work_dir))
        .or_else(|| {
            newest_completed_media(
                &work_dir,
                media_id.as_deref(),
                output_path.as_deref(),
                &output_mode,
                started_at,
            )
        })
        .ok_or_else(|| {
            format!(
                "yt-dlp terminó correctamente, pero no se pudo identificar el archivo final en {}",
                work_dir.display()
            )
        })?;
    ensure_media_job_running(&connection, id)?;
    if let Ok(source_size) = fs::metadata(&downloaded_path).map(|metadata| metadata.len()) {
        let _ = connection.execute(
            "UPDATE media_jobs SET downloaded_bytes=?1,total_bytes=?1,total_bytes_estimated=0,speed_bps=0,eta_seconds=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
            params![source_size.min(i64::MAX as u64) as i64, id],
        );
    }
    let compatible_path = if output_mode == "video_mp4" {
        ensure_media_job_running(&connection, id)?;
        set_media_processing_stage(
            &connection,
            id,
            "validating",
            "Comprobando compatibilidad con Windows…",
        );
        ensure_windows_compatible_mp4(
            runtime,
            &downloaded_path,
            &connection,
            id,
            &external_processes,
            resolved_expected_duration,
        )?
    } else {
        downloaded_path
    };
    ensure_media_job_running(&connection, id)?;
    validate_downloaded_media(
        runtime,
        &compatible_path,
        &output_mode,
        resolved_expected_duration,
        &connection,
        &external_processes,
        id,
    )?;
    ensure_media_job_running(&connection, id)?;
    set_media_processing_stage(
        &connection,
        id,
        "finalizing",
        "Preparando el archivo final…",
    );
    let file_name = compatible_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Multimedia completada");
    let final_path = unique_destination(&destination_root, file_name);
    ensure_media_job_running(&connection, id)?;
    fs::rename(&compatible_path, &final_path)
        .or_else(|_| {
            fs::copy(&compatible_path, &final_path)
                .map(|_| ())
                .and_then(|_| fs::remove_file(&compatible_path))
        })
        .map_err(|error| {
            format!("No se pudo mover el archivo validado a su destino final: {error}")
        })?;
    if let Err(error) = ensure_media_job_running(&connection, id) {
        let _ = fs::remove_file(&final_path);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&work_dir);
    let output_path = final_path.to_string_lossy().to_string();
    let final_size = fs::metadata(&final_path)
        .map_err(|error| format!("No se pudo leer el tamaño del archivo final: {error}"))?
        .len();
    let file_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Multimedia completada");
    shadow_mark_finalizing(id);
    let completed = connection.execute(
        "UPDATE jobs SET status='completed', progress=100, detail='Completada', updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='running'",
        params![id],
    ).map_err(|error| error.to_string())?;
    if completed == 0 {
        let _ = fs::remove_file(&final_path);
        return Err("media_job_stopped".into());
    }
    shadow_mark_completed(id, final_size);
    connection.execute(
        "UPDATE media_jobs SET output_path=?1,downloaded_bytes=?2,total_bytes=?2,total_bytes_estimated=0,speed_bps=0,eta_seconds=0,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?3 AND EXISTS (SELECT 1 FROM jobs WHERE id=?3 AND status='completed')",
        params![output_path, final_size as i64, id],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE playlist_items SET status='completed',progress=100,output_path=?1 WHERE job_id=?2 AND EXISTS (SELECT 1 FROM jobs WHERE id=?2 AND status='completed')",
        params![output_path, id],
    ).map_err(|error| error.to_string())?;
    let _ = connection.execute(
        "UPDATE media_jobs SET resolution_state='completed' WHERE job_id=?1",
        params![id],
    );
    connection.execute(
        "INSERT INTO recent_files(name,path,category,kind,opened_at) VALUES(?1,?2,'Multimedia',?3,CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET name=excluded.name, category=excluded.category, kind=excluded.kind, opened_at=CURRENT_TIMESTAMP",
        params![file_name, output_path, recent_kind_from_path(&final_path)],
    ).map_err(|error| error.to_string())?;
    Ok(())
}
