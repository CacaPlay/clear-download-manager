#![allow(dead_code)]

mod extension_bridge;

mod app;
pub mod catalog_tooling;
mod tools;
pub(crate) use app::bootstrap::{
    acquire_instance_lock, exit_application, focus_main_window, hide_main_window, install_tray,
    is_background_launch, prepare_full_exit, repair_windows_integration, request_full_exit,
    set_application_icon, set_startup_behavior, show_main_window, startup_status, wake_main_window,
    EXIT_REQUESTED,
};
pub(crate) use app::network::{
    ensure_public_network_resolution, host_is_public, parse_public_http_url,
    url_has_public_http_target, url_has_public_network_target,
};
pub(crate) use app::process::{
    background_command, command_output_with_timeout, command_output_with_timeout_cancelable,
    command_output_with_timeout_cancelable_owned, external_processes_active,
    register_external_process, terminate_external_processes, wait_for_external_processes_idle,
    ExternalProcessKind, ExternalProcessRegistry,
};
pub(crate) use app::runtime::{
    discover_media_runtime, find_runtime_binary, resolve_tool, resolve_tool_with_arguments,
    runtime_binary_version, verify_spotdl_binary, MediaRuntimePaths, MediaRuntimeSnapshot, ToolId,
};
#[cfg(test)]
pub(crate) use app::state::WindowOperationRegistry;
pub(crate) use app::state::{
    begin_window_operation, current_window_operation, invalidate_window_operation,
    register_window_process, window_operation_is_cancelled, LocalState, WindowOperation,
    WorkerCompletion, WorkerCompletionGuard,
};

mod update_manager;

mod settings;
pub(crate) use settings::*;

mod db;
pub(crate) use db::*;

mod torrents;
pub(crate) use torrents::*;

mod downloads;
pub(crate) use downloads::*;

mod media;
pub(crate) use media::*;

mod dispatcher;
pub(crate) use dispatcher::*;

mod priority;
pub(crate) use priority::*;

mod chaos;

mod subwindows;

mod windows;
pub(crate) use windows::player::build_media_player_window;

mod progress;

mod spotify_auth;
pub(crate) use spotify_auth::*;

mod commands;

// Compatibility marker retained for the Phase 20 static UI contract while
// the active appearance defaults live in settings.rs.
fn default_ui_scale() -> u8 {
    125
}

use reqwest::{
    blocking::Client,
    header::{CONTENT_TYPE, RANGE},
    StatusCode,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use unicode_normalization::UnicodeNormalization;
use url::Url;

const DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS: u64 = 500;
const MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250;
static ACTIVE_SEARCH_REQUEST: AtomicU64 = AtomicU64::new(0);

const SPEED_SAMPLE_MIN_INTERVAL_MS: u64 = 450;
const SPEED_SPIKE_ALLOWANCE_BPS: f64 = 512.0 * 1024.0;
const PROGRESS_MIN_BYTES_DELTA: u64 = 256 * 1024;
const PROGRESS_MIN_PERCENT_DELTA: f64 = 0.5;

#[derive(Debug)]
struct TransferRateSampler {
    last_bytes: u64,
    last_sample: Instant,
    smoothed_bps: f64,
    samples: u8,
}

impl TransferRateSampler {
    fn new(initial_bytes: u64) -> Self {
        Self {
            last_bytes: initial_bytes,
            last_sample: Instant::now(),
            smoothed_bps: 0.0,
            samples: 0,
        }
    }

    fn reset(&mut self, bytes: u64) {
        self.last_bytes = bytes;
        self.last_sample = Instant::now();
        self.smoothed_bps = 0.0;
        self.samples = 0;
    }

    fn sample(&mut self, bytes: u64) -> f64 {
        let elapsed = self.last_sample.elapsed();
        if elapsed < Duration::from_millis(SPEED_SAMPLE_MIN_INTERVAL_MS) {
            return self.smoothed_bps.max(0.0);
        }
        let seconds = elapsed.as_secs_f64().max(0.001);
        let observed = bytes.saturating_sub(self.last_bytes) as f64 / seconds;
        self.last_bytes = bytes;
        self.last_sample = Instant::now();
        if self.samples == 0 {
            // The first interval can contain buffered/pre-existing process
            // output. Establish a baseline before exposing a rate to the UI.
            self.samples = 1;
            return 0.0;
        }
        self.smoothed_bps = stabilize_reported_speed(self.smoothed_bps, observed);
        self.smoothed_bps
    }
}

fn stabilize_reported_speed(previous: f64, observed: f64) -> f64 {
    let previous = if previous.is_finite() && previous > 0.0 {
        previous
    } else {
        0.0
    };
    let observed = if observed.is_finite() && observed > 0.0 {
        observed
    } else {
        0.0
    };
    if previous <= 0.0 {
        return observed;
    }
    if observed <= 0.0 {
        return previous * 0.62;
    }
    let bounded = observed.min(previous * 2.75 + SPEED_SPIKE_ALLOWANCE_BPS);
    let weight = if bounded > previous { 0.22 } else { 0.38 };
    (previous * (1.0 - weight) + bounded * weight).max(0.0)
}

#[derive(Debug)]
pub(crate) struct ProgressPersistenceGate {
    last_bytes: u64,
    last_progress: f64,
    last_persisted_at: Instant,
    has_persisted: bool,
}

impl ProgressPersistenceGate {
    pub(crate) fn new() -> Self {
        Self {
            last_bytes: 0,
            last_progress: 0.0,
            last_persisted_at: Instant::now(),
            has_persisted: false,
        }
    }

    pub(crate) fn should_persist(&self, bytes: u64, progress: f64, interval: Duration) -> bool {
        if !self.has_persisted {
            return true;
        }
        if self.last_persisted_at.elapsed() < interval {
            return false;
        }
        bytes.saturating_sub(self.last_bytes) >= PROGRESS_MIN_BYTES_DELTA
            || (progress - self.last_progress).abs() >= PROGRESS_MIN_PERCENT_DELTA
    }

    pub(crate) fn mark_persisted(&mut self, bytes: u64, progress: f64) {
        self.last_bytes = bytes;
        self.last_progress = progress;
        self.last_persisted_at = Instant::now();
        self.has_persisted = true;
    }
}
const SPOTIFY_DISABLED_CODE: &str = "spotify_disabled";
const SPOTIFY_DISABLED_MESSAGE: &str = "Spotify está desactivado temporalmente. Esta versión de CacaTools no puede procesar enlaces de Spotify.";
const SPOTIFY_AUTHENTICATED_RESTRICTED_CODE: &str = "spotify_authenticated_restricted";
const SPOTIFY_AUTHENTICATED_RESTRICTED_MESSAGE: &str = "Spotify requiere una suscripción Premium activa en la cuenta propietaria de la aplicación para permitir estas consultas. CacaTools no puede eliminar esa restricción; YouTube y el resto de la aplicación siguen funcionando normalmente.";
const SPOTDL_PLAYLIST_CONCURRENCY: usize = 2;
const SPOTDL_VERSION: &str = "4.5.2";
const SPOTDL_SHA256: &str = "4490AE3B38C4321173E17975A9990A130CF9A9AEA8132EE2978AFECEFBEEB477";

fn absolute_path_override(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(value?);
    path.is_absolute().then_some(path)
}

fn environment_path_override(name: &str) -> Option<PathBuf> {
    absolute_path_override(std::env::var_os(name))
}

fn begin_search_request() -> u64 {
    let mut next = ACTIVE_SEARCH_REQUEST
        .load(Ordering::SeqCst)
        .saturating_add(1);
    loop {
        match ACTIVE_SEARCH_REQUEST.compare_exchange(
            next.saturating_sub(1),
            next,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return next,
            Err(current) => {
                next = current.saturating_add(1);
            }
        }
    }
}

fn search_request_is_cancelled(request_id: u64) -> bool {
    ACTIVE_SEARCH_REQUEST.load(Ordering::SeqCst) != request_id
}

fn sidecar_output_with_timeout(
    command: &mut Command,
    active: &Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: &ExternalProcessRegistry,
    id: i64,
    timeout: Duration,
    context: &str,
    progress_connection: Option<&Connection>,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar {context}: {error}"))?;
    let pid = child.id();
    let _process_guard =
        match register_external_process(external_processes, id, pid, ExternalProcessKind::Spotdl) {
            Ok(guard) => guard,
            Err(error) => {
                kill_process_tree(pid);
                let _ = child.wait();
                return Err(error);
            }
        };
    if let Ok(mut guard) = active.lock() {
        guard.insert(id, pid);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_process_tree(pid);
            let _ = child.wait();
            return Err(format!("No se pudo leer la salida de {context}"));
        }
    };
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("No se pudo leer el diagnóstico de {context}"))?;
    let (line_tx, line_rx) = mpsc::channel::<Vec<u8>>();
    let stdout_tx = line_tx.clone();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let reader = BufReader::new(stdout);
        for line in reader.split(b'\n') {
            let Ok(mut line) = line else { break };
            line.push(b'\n');
            bytes.extend_from_slice(&line);
            let _ = stdout_tx.send(line);
        }
        bytes
    });
    let stderr_tx = line_tx.clone();
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let reader = BufReader::new(stderr);
        for line in reader.split(b'\n') {
            let Ok(mut line) = line else { break };
            line.push(b'\n');
            bytes.extend_from_slice(&line);
            let _ = stderr_tx.send(line);
        }
        bytes
    });
    let started = Instant::now();
    let status = loop {
        while let Ok(line) = line_rx.try_recv() {
            if let Some(connection) = progress_connection {
                update_spotdl_progress(connection, id, &line);
            }
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() >= timeout {
            terminate_external_processes(external_processes, id);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            if let Ok(mut guard) = active.lock() {
                guard.remove(&id);
            }
            return Err("La operación tardó demasiado".into());
        }
        thread::sleep(Duration::from_millis(120));
    };
    while let Ok(line) = line_rx.try_recv() {
        if let Some(connection) = progress_connection {
            update_spotdl_progress(connection, id, &line);
        }
    }
    let output = Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    };
    if let Ok(mut guard) = active.lock() {
        guard.remove(&id);
    }
    Ok(output)
}

pub(crate) fn supervised_command_output(
    command: &mut Command,
    external_processes: &ExternalProcessRegistry,
    job_id: i64,
    kind: ExternalProcessKind,
    context: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar {context}: {error}"))?;
    let pid = child.id();
    let _process_guard = match register_external_process(external_processes, job_id, pid, kind) {
        Ok(guard) => guard,
        Err(error) => {
            kill_process_tree(pid);
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_process_tree(pid);
            let _ = child.wait();
            return Err(format!("No se pudo leer la salida de {context}"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_process_tree(pid);
            let _ = child.wait();
            return Err(format!("No se pudo leer el diagnóstico de {context}"));
        }
    };
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                kill_process_tree(pid);
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("No se pudo esperar {context}: {error}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Supervised command runner for FFmpeg's machine-readable `-progress` pipe.
/// Stdout is consumed line-by-line while stderr remains independently drained,
/// so a verbose diagnostic stream cannot deadlock the live progress channel.
pub(crate) fn supervised_command_output_with_progress<F>(
    command: &mut Command,
    external_processes: &ExternalProcessRegistry,
    job_id: i64,
    kind: ExternalProcessKind,
    context: &str,
    mut on_stdout_line: F,
) -> Result<Output, String>
where
    F: FnMut(&str),
{
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar {context}: {error}"))?;
    let pid = child.id();
    let _process_guard = match register_external_process(external_processes, job_id, pid, kind) {
        Ok(guard) => guard,
        Err(error) => {
            kill_process_tree(pid);
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdout = child.stdout.take().ok_or_else(|| {
        kill_process_tree(pid);
        let _ = child.wait();
        format!("No se pudo leer la salida de {context}")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        kill_process_tree(pid);
        let _ = child.wait();
        format!("No se pudo leer el diagnóstico de {context}")
    })?;
    let (line_tx, line_rx) = mpsc::channel::<String>();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let mut stdout_lines = Vec::new();
    let status = loop {
        while let Ok(line) = line_rx.try_recv() {
            on_stdout_line(&line);
            stdout_lines.push(line);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                kill_process_tree(pid);
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("No se pudo esperar {context}: {error}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    };
    while let Ok(line) = line_rx.try_recv() {
        on_stdout_line(&line);
        stdout_lines.push(line);
    }
    let _ = stdout_reader.join();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout: stdout_lines.join("\n").into_bytes(),
        stderr,
    })
}

#[derive(Serialize)]
struct StorageSnapshot {
    free_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
struct JobSnapshot {
    id: i64,
    /// Immutable visual insertion order. For regular jobs this is the
    /// AUTOINCREMENT job id; status/progress updates must never change it.
    added_order: i64,
    title: String,
    detail: String,
    progress: f64,
    status: String,
    kind: String,
    engine: String,
    stage: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    total_bytes_estimated: bool,
    progress_estimated: bool,
    final_size: Option<u64>,
    speed_bps: f64,
    eta_seconds: Option<u64>,
    indeterminate: bool,
    extension: String,
    source_url: String,
    destination: String,
    thumbnail: String,
    priority: DownloadPriority,
    #[serde(rename = "speedLimitBps")]
    speed_limit_bps: Option<u64>,
    updated_at: String,
}

#[derive(Serialize)]
struct QueueSnapshot {
    active: u64,
    queued: u64,
    paused: u64,
    completed_today: u64,
    failed: u64,
    total_speed_bps: f64,
}

#[derive(Serialize)]
struct RecentFileSnapshot {
    id: i64,
    name: String,
    path: String,
    category: String,
    opened_at: String,
    kind: String,
}

#[derive(Serialize)]
struct PlaylistBatchSummarySnapshot {
    batch_id: i64,
    /// The first child job id gives the playlist a position in the same
    /// global sequence as regular downloads. Child jobs are inserted in the
    /// same transaction as the batch, so this remains stable for its life.
    added_order: i64,
    title: String,
    format: String,
    status: String,
    stage: String,
    indeterminate: bool,
    total_items: u64,
    completed_items: u64,
    failed_items: u64,
    active_items: u64,
    progress: f64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    total_bytes_estimated: bool,
    progress_estimated: bool,
    final_size: Option<u64>,
    speed_bps: f64,
    eta_seconds: Option<u64>,
    destination: String,
    thumbnail_stack: String,
    last_error: Option<String>,
    priority: DownloadPriority,
    #[serde(rename = "speedLimitBps")]
    speed_limit_bps: Option<u64>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct DownloadActivitySnapshot {
    queue: QueueSnapshot,
    jobs: Vec<JobSnapshot>,
    playlist_batches: Vec<PlaylistBatchSummarySnapshot>,
}

#[derive(Serialize)]
struct DesktopSnapshot {
    storage: StorageSnapshot,
    currency: CurrencySnapshot,
    queue: QueueSnapshot,
    jobs: Vec<JobSnapshot>,
    playlist_batches: Vec<PlaylistBatchSummarySnapshot>,
    recent_files: Vec<RecentFileSnapshot>,
}

#[derive(Serialize)]
struct DesktopSettingsSnapshot {
    downloads_dir: String,
    #[serde(rename = "downloadConcurrency")]
    download_concurrency: DownloadConcurrencySettings,
}

#[derive(Serialize)]
struct DownloadQueueReceipt {
    job_id: i64,
    filename: String,
    destination: String,
    resumable: bool,
}

#[derive(Serialize)]
struct FileMetadataSnapshot {
    name: String,
    path: String,
    extension: String,
    size_bytes: u64,
    modified_unix: Option<u64>,
    readonly: bool,
}

#[derive(Serialize)]
struct QueueActionReceipt {
    affected: usize,
    action: String,
}

fn runtime_status(state: State<'_, LocalState>) -> serde_json::Value {
    let aria2_version = state
        .aria2_path
        .as_deref()
        .map(|path| runtime_binary_version(path, "--version"))
        .unwrap_or_default();
    serde_json::json!({
        "mode": "local",
        "server_dependency": false,
        "loopback_only": true,
        "download_engine": "rust-http-sequential-v3",
        "torrent_engine": "aria2c",
        "aria2_available": state.aria2_path.is_some(),
        "http_aria2_enabled": false,
        "aria2_version": aria2_version,
        "media_available": state.media_runtime.is_some(),
        "version": env!("CARGO_PKG_VERSION")
    })
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
fn snapshot_extension(output_mode: Option<&str>, destination: &str) -> String {
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

fn read_download_activity(
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

#[derive(Clone, Debug, Serialize)]
struct DownloadUrlInspection {
    normalized_url: String,
    kind: String,
    host: String,
    suggested_filename: String,
    content_type: Option<String>,
    content_length: Option<u64>,
    requires_media_resolver: bool,
}

#[derive(Clone, Serialize)]
struct PageDownloadCandidate {
    url: String,
    filename: String,
    extension: String,
    kind: String,
    host: String,
    source_attribute: String,
    embedded: bool,
    same_origin: bool,
    confidence: u8,
}

#[derive(Serialize)]
struct PageDownloadDiscovery {
    page_url: String,
    page_title: String,
    candidates: Vec<PageDownloadCandidate>,
    truncated: bool,
    inspected_bytes: usize,
}

fn decode_html_attribute(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

fn html_attribute_values(html: &str, attribute: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let attribute_bytes = attribute.as_bytes();
    let mut values = Vec::new();
    let mut cursor = 0;

    while cursor + attribute_bytes.len() < bytes.len() {
        let Some(relative) = lower[cursor..].find(attribute) else {
            break;
        };
        let start = cursor + relative;
        let before_ok = start == 0
            || !bytes[start - 1].is_ascii_alphanumeric()
                && !matches!(bytes[start - 1], b'-' | b'_');
        let mut position = start + attribute_bytes.len();
        let after_ok = position >= bytes.len()
            || !bytes[position].is_ascii_alphanumeric() && !matches!(bytes[position], b'-' | b'_');
        if !before_ok || !after_ok {
            cursor = position;
            continue;
        }
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if position >= bytes.len() || bytes[position] != b'=' {
            cursor = position;
            continue;
        }
        position += 1;
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if position >= bytes.len() {
            break;
        }
        let quote = bytes[position];
        let quoted = matches!(quote, b'\'' | b'"');
        if quoted {
            position += 1;
        }
        let value_start = position;
        while position < bytes.len() {
            let current = bytes[position];
            if (quoted && current == quote)
                || (!quoted && (current.is_ascii_whitespace() || current == b'>'))
            {
                break;
            }
            position += 1;
        }
        if value_start < position {
            values.push(decode_html_attribute(&html[value_start..position]));
        }
        cursor = position.saturating_add(1);
    }
    values
}

fn html_page_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(open_start) = lower.find("<title") else {
        return String::new();
    };
    let Some(open_end_relative) = lower[open_start..].find('>') else {
        return String::new();
    };
    let content_start = open_start + open_end_relative + 1;
    let Some(close_relative) = lower[content_start..].find("</title>") else {
        return String::new();
    };
    let title = decode_html_attribute(&html[content_start..content_start + close_relative]);
    let compact = title.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(180).collect()
}

fn page_candidate_kind(extension: &str) -> &'static str {
    match extension {
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "ts" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" => "audio",
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif" | "svg" => "image",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "epub" => {
            "document"
        }
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" => "archive",
        "exe" | "msi" | "msix" | "appx" | "apk" | "deb" | "rpm" | "dmg" | "iso" => "software",
        "torrent" => "torrent",
        _ => "file",
    }
}

fn page_candidate_score(parsed: &Url, source_attribute: &str) -> Option<(String, String, u8)> {
    let path = parsed.path().to_ascii_lowercase();
    let extension = Path::new(parsed.path())
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const EXTENSIONS: &[&str] = &[
        "zip", "7z", "rar", "tar", "gz", "bz2", "xz", "zst", "exe", "msi", "msix", "appx", "apk",
        "deb", "rpm", "dmg", "iso", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
        "csv", "epub", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "svg", "mp3", "m4a",
        "aac", "wav", "flac", "ogg", "opus", "mp4", "mkv", "webm", "mov", "avi", "m4v", "ts",
        "srt", "vtt", "ass", "ttf", "otf", "woff", "woff2", "torrent",
    ];
    if EXTENSIONS.contains(&extension.as_str()) {
        let kind = page_candidate_kind(&extension).to_string();
        let embedded = source_attribute != "href" && source_attribute != "data-href";
        let confidence = if embedded {
            match kind.as_str() {
                "video" | "audio" => 86,
                "image" => 74,
                _ => 80,
            }
        } else {
            96
        };
        return Some((extension, kind, confidence));
    }
    if matches!(
        extension.as_str(),
        "html" | "htm" | "php" | "asp" | "aspx" | "jsp"
    ) {
        return None;
    }
    let query = parsed.query().unwrap_or_default().to_ascii_lowercase();
    let combined = format!("{path}?{query}");
    let strong_signal = [
        "/download",
        "download=",
        "download?",
        "/attachment",
        "attachment=",
        "/export",
        "export=",
        "/raw/",
        "raw=1",
        "file=",
        "filename=",
    ]
    .iter()
    .any(|signal| combined.contains(signal));
    strong_signal.then(|| {
        let confidence = if source_attribute == "href" || source_attribute == "data-href" {
            72
        } else {
            60
        };
        (String::new(), "file".to_string(), confidence)
    })
}

fn duration_label(seconds: Option<f64>) -> String {
    let total = seconds.unwrap_or(0.0).max(0.0).round() as u64;
    if total == 0 {
        return "—".into();
    }
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn first_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn json_exposes_reproducible_stream(value: &Value) -> bool {
    let candidate = value
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .unwrap_or(value);
    let is_public_http = |stream: &str| {
        Url::parse(stream.trim())
            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .unwrap_or(false)
    };
    candidate
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(is_public_http)
        || candidate
            .get("formats")
            .and_then(Value::as_array)
            .is_some_and(|formats| {
                formats.iter().any(|format| {
                    format
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(is_public_http)
                })
            })
}

fn safe_remote_thumbnail_url(value: &str) -> String {
    let Ok(mut parsed) = Url::parse(value.trim()) else {
        return String::new();
    };
    if parsed.scheme() != "https" || !url_has_public_http_target(&parsed) {
        return String::new();
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

fn presentation_thumbnail_url(value: &str) -> String {
    let safe = safe_remote_thumbnail_url(value);
    if safe.is_empty() {
        return safe;
    }
    safe.replace("ab67616d00001e02", "ab67616d0000b273")
}

fn thumbnail_dimension_score(value: &Value) -> u64 {
    let width = value_u32(value, "width").unwrap_or(0) as u64;
    let height = value_u32(value, "height").unwrap_or(0) as u64;
    width.saturating_mul(height)
}

fn thumbnail_from(value: &Value) -> String {
    let listed = value
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let candidate = presentation_thumbnail_url(
                        item.get("url").and_then(Value::as_str).unwrap_or_default(),
                    );
                    (!candidate.is_empty()).then_some((thumbnail_dimension_score(item), candidate))
                })
                .max_by_key(|(score, _)| *score)
                .map(|(_, candidate)| candidate)
        })
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    presentation_thumbnail_url(&first_string(value, &["thumbnail"]))
}

fn youtube_thumbnail_from_id(value: &str) -> String {
    let id = value.trim();
    if id.len() == 11
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg");
    }
    String::new()
}

fn resolver_binary(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_tool_with_arguments(Some(app), ToolId::YtDlp, &["--version"])
        .path
        .ok_or_else(|| {
            "No se encontró el componente multimedia interno. Verifica los archivos de la aplicación e inténtalo de nuevo.".into()
        })
}

#[derive(Clone, Copy)]
struct MediaFormatSize {
    bytes: u64,
    estimated: bool,
}

fn media_format_size(value: &Value) -> Option<MediaFormatSize> {
    if let Some(bytes) = json_number_as_u64(value.get("filesize")).filter(|bytes| *bytes > 0) {
        return Some(MediaFormatSize {
            bytes,
            estimated: false,
        });
    }
    json_number_as_u64(value.get("filesize_approx"))
        .filter(|bytes| *bytes > 0)
        .map(|bytes| MediaFormatSize {
            bytes,
            estimated: true,
        })
}

fn merge_media_format_sizes(
    first: Option<MediaFormatSize>,
    second: Option<MediaFormatSize>,
) -> Option<MediaFormatSize> {
    let first = first?;
    let second = second?;
    Some(MediaFormatSize {
        bytes: first.bytes.saturating_add(second.bytes),
        estimated: first.estimated || second.estimated,
    })
}

fn media_format_bitrate(value: &Value) -> f64 {
    json_number(value.get("tbr"))
        .or_else(|| json_number(value.get("abr")))
        .unwrap_or(0.0)
}

fn best_audio_format<'a>(entries: &'a [Value], requested_ext: Option<&str>) -> Option<&'a Value> {
    entries
        .iter()
        .filter(|entry| {
            let acodec = first_string(entry, &["acodec"]);
            let vcodec = first_string(entry, &["vcodec"]);
            let extension = first_string(entry, &["ext"]);
            acodec != "none"
                && vcodec == "none"
                && requested_ext.is_none_or(|requested| extension == requested)
        })
        .max_by(|left, right| {
            media_format_bitrate(left)
                .partial_cmp(&media_format_bitrate(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn best_video_format(entries: &[Value], max_height: u64) -> Option<&Value> {
    entries
        .iter()
        .filter(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let acodec = first_string(entry, &["acodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            vcodec != "none" && acodec == "none" && height > 0 && height <= max_height
        })
        .max_by(|left, right| {
            let left_height = left.get("height").and_then(Value::as_u64).unwrap_or(0);
            let right_height = right.get("height").and_then(Value::as_u64).unwrap_or(0);
            left_height.cmp(&right_height).then_with(|| {
                media_format_bitrate(left)
                    .partial_cmp(&media_format_bitrate(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
}

fn best_combined_format(entries: &[Value], max_height: u64) -> Option<&Value> {
    entries
        .iter()
        .filter(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let acodec = first_string(entry, &["acodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            vcodec != "none" && acodec != "none" && height > 0 && height <= max_height
        })
        .max_by(|left, right| {
            let left_height = left.get("height").and_then(Value::as_u64).unwrap_or(0);
            let right_height = right.get("height").and_then(Value::as_u64).unwrap_or(0);
            left_height.cmp(&right_height).then_with(|| {
                media_format_bitrate(left)
                    .partial_cmp(&media_format_bitrate(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
}

fn video_selection_size(entries: &[Value], max_height: u64) -> Option<MediaFormatSize> {
    let separated = merge_media_format_sizes(
        best_video_format(entries, max_height).and_then(media_format_size),
        best_audio_format(entries, None).and_then(media_format_size),
    );
    separated.or_else(|| best_combined_format(entries, max_height).and_then(media_format_size))
}

fn media_format_id(value: &Value) -> Option<String> {
    let id = first_string(value, &["format_id"]);
    (!id.trim().is_empty()).then_some(id)
}

fn bounded_video_selector(max_height: u64) -> String {
    format!(
        "bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best[height<={max_height}]"
    )
}

fn video_selection_selector(entries: &[Value], max_height: u64) -> Option<String> {
    let video = best_video_format(entries, max_height);
    let audio = best_audio_format(entries, None);
    if let (Some(video_id), Some(audio_id)) = (
        video.and_then(media_format_id),
        audio.and_then(media_format_id),
    ) {
        return Some(format!(
            "{video_id}+{audio_id}/best[height<={max_height}]/best[height<={max_height}]"
        ));
    }
    best_combined_format(entries, max_height)
        .and_then(media_format_id)
        .map(|format_id| {
            format!("{format_id}/best[height<={max_height}]/best[height<={max_height}]")
        })
}

fn media_format_snapshot(
    id: String,
    label: String,
    ext: String,
    resolution: String,
    audio_only: bool,
    size: Option<MediaFormatSize>,
    technical_source: Option<&Value>,
) -> MediaFormatSnapshot {
    let audio_codec = technical_source
        .map(|value| first_string(value, &["acodec"]))
        .filter(|value| value != "none")
        .unwrap_or_default();
    let bitrate_kbps = technical_source
        .and_then(|value| json_number(value.get("abr")).or_else(|| json_number(value.get("tbr"))))
        .filter(|value| value.is_finite() && *value > 0.0);
    let sample_rate_hz = technical_source
        .and_then(|value| json_number_as_u64(value.get("asr")))
        .filter(|value| *value > 0)
        .and_then(|value| u32::try_from(value).ok());
    let channels = technical_source
        .and_then(|value| json_number_as_u64(value.get("audio_channels")))
        .filter(|value| *value > 0)
        .and_then(|value| u32::try_from(value).ok());
    let detected_container = technical_source
        .map(|value| first_string(value, &["ext", "container"]))
        .unwrap_or_default();
    let container = if ext == "auto" || ext == "audio" {
        detected_container
    } else {
        ext.clone()
    };
    let lossless = matches!(
        audio_codec.to_ascii_lowercase().as_str(),
        "flac" | "alac" | "wavpack" | "ape" | "pcm_s16le" | "pcm_s24le" | "pcm_f32le"
    ) || matches!(
        container.to_ascii_lowercase().as_str(),
        "flac" | "wav" | "alac"
    );
    MediaFormatSnapshot {
        id,
        label,
        ext,
        resolution,
        audio_only,
        filesize: size.map(|value| value.bytes),
        filesize_estimated: size.is_some_and(|value| value.estimated),
        audio_codec,
        bitrate_kbps,
        sample_rate_hz,
        channels,
        container,
        lossless,
    }
}

fn media_formats(value: &Value) -> Vec<MediaFormatSnapshot> {
    let Some(entries) = value.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut video_heights = entries
        .iter()
        .filter_map(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            (vcodec != "none" && height > 0).then_some(height)
        })
        .collect::<Vec<_>>();
    video_heights.sort_unstable_by(|left, right| right.cmp(left));
    video_heights.dedup();

    let best_audio = best_audio_format(entries, None);
    let mut formats = Vec::new();
    let progressive_video = entries.iter().find(|entry| {
        let url = first_string(entry, &["url"]).to_ascii_lowercase();
        let ext = first_string(entry, &["ext", "container"]).to_ascii_lowercase();
        url.contains("mime_type=video") || ext == "mp4"
    });
    if video_heights.is_empty() {
        if let Some(entry) = progressive_video {
            formats.push(media_format_snapshot(
                "best".into(),
                "Mejor disponible · vídeo".into(),
                "mp4".into(),
                String::new(),
                false,
                media_format_size(entry),
                Some(entry),
            ));
        }
    }
    if let Some(max_height) = video_heights.first().copied() {
        formats.push(media_format_snapshot(
            video_selection_selector(entries, max_height)
                .unwrap_or_else(|| bounded_video_selector(max_height)),
            format!("Mejor disponible · hasta {max_height}p"),
            "auto".into(),
            format!("{max_height}p"),
            false,
            video_selection_size(entries, max_height),
            best_audio,
        ));
    }

    for height in video_heights.into_iter().take(10) {
        formats.push(media_format_snapshot(
            video_selection_selector(entries, height)
                .unwrap_or_else(|| bounded_video_selector(height)),
            format!("{height}p · vídeo + audio"),
            "auto".into(),
            format!("{height}p"),
            false,
            video_selection_size(entries, height),
            best_audio,
        ));
    }

    formats.push(media_format_snapshot(
        best_audio
            .and_then(media_format_id)
            .map(|format_id| format!("{format_id}/bestaudio/best"))
            .unwrap_or_else(|| "bestaudio/best".into()),
        "Original / mejor audio disponible".into(),
        "audio".into(),
        String::new(),
        true,
        best_audio.and_then(media_format_size),
        best_audio,
    ));
    let m4a_audio = best_audio_format(entries, Some("m4a")).or(best_audio);
    formats.push(media_format_snapshot(
        m4a_audio
            .and_then(media_format_id)
            .map(|format_id| format!("{format_id}/bestaudio[ext=m4a]/bestaudio/best"))
            .unwrap_or_else(|| "bestaudio[ext=m4a]/bestaudio/best".into()),
        "Audio · M4A".into(),
        "m4a".into(),
        String::new(),
        true,
        m4a_audio.and_then(media_format_size),
        m4a_audio,
    ));

    // Lossless choices are exposed only when yt-dlp reports an actual
    // lossless source and a real sample rate.  YouTube's usual Opus/AAC
    // streams therefore do not accidentally appear as FLAC or Hi-Res.
    let mut lossless_sources = entries
        .iter()
        .filter(|entry| first_string(entry, &["vcodec"]) == "none")
        .filter(|entry| {
            let codec = first_string(entry, &["acodec"]).to_ascii_lowercase();
            let ext = first_string(entry, &["ext", "container"]).to_ascii_lowercase();
            matches!(
                codec.as_str(),
                "flac" | "alac" | "wavpack" | "ape" | "pcm_s16le" | "pcm_s24le" | "pcm_f32le"
            ) || matches!(ext.as_str(), "flac" | "wav" | "alac")
        })
        .filter_map(|entry| {
            let sample_rate = json_number_as_u64(entry.get("asr"))?;
            (sample_rate >= 44_100).then_some((sample_rate, entry))
        })
        .collect::<Vec<_>>();
    lossless_sources.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut emitted_lossless = HashSet::new();
    for (sample_rate, entry) in lossless_sources {
        let (mode, label) = if sample_rate >= 176_400 {
            ("audio_flac_max", "Hi-Res FLAC Max — Máxima calidad")
        } else if sample_rate > 48_000 {
            ("audio_flac_hires", "Hi-Res FLAC — Alta resolución")
        } else {
            ("audio_flac", "FLAC — Calidad CD")
        };
        if !emitted_lossless.insert(mode) {
            continue;
        }
        let Some(format_id) = media_format_id(entry) else {
            continue;
        };
        formats.push(media_format_snapshot(
            format_id,
            format!("{label} · {} Hz", sample_rate),
            first_string(entry, &["ext", "container"]),
            "audio".into(),
            true,
            media_format_size(entry),
            Some(entry),
        ));
    }

    formats
}

#[derive(Clone)]
struct SpotifyTrackMetadata {
    id: String,
    isrc: String,
    title: String,
    creator: String,
    album: String,
    album_artist: String,
    duration_seconds: Option<f64>,
    thumbnail: String,
    spotify_url: String,
    track_number: Option<u32>,
    disc_number: Option<u32>,
    release_date: String,
    explicit: bool,
    playlist_position: Option<u32>,
}

fn spotify_source_parts(value: &str) -> Result<(String, String, String), String> {
    let clean = value.trim();
    if let Some(uri) = clean.strip_prefix("spotify:") {
        let mut parts = uri.split(':');
        let kind = parts.next().unwrap_or_default().to_ascii_lowercase();
        let id = parts.next().unwrap_or_default().trim().to_string();
        if !matches!(kind.as_str(), "track" | "playlist" | "album") {
            return Err(
                "Solo se admiten enlaces de canciones, álbumes o playlists de Spotify".into(),
            );
        }
        if id.is_empty()
            || id.len() > 128
            || !id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("El identificador de Spotify no es válido".into());
        }
        return Ok((
            kind.clone(),
            id.clone(),
            format!("https://open.spotify.com/{kind}/{id}"),
        ));
    }
    let parsed = parse_public_http_url(clean, "El enlace de Spotify no es válido")?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !(host == "spotify.com" || host == "open.spotify.com" || host.ends_with(".spotify.com")) {
        return Err("El enlace no pertenece a Spotify".into());
    }
    let segments = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    let (kind, id) = segments
        .windows(2)
        .find_map(|pair| {
            let kind = pair[0].to_ascii_lowercase();
            matches!(kind.as_str(), "track" | "playlist" | "album")
                .then(|| (kind, pair[1].to_string()))
        })
        .ok_or_else(|| {
            "El enlace de Spotify debe apuntar a una canción, álbum o playlist".to_string()
        })?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("El identificador de Spotify no es válido".into());
    }
    Ok((kind, id, parsed.to_string()))
}

fn spotify_api_get(client: &Client, token: &str, endpoint: &str) -> Result<Value, String> {
    let response = client
        .get(endpoint)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| format!("No se pudo consultar la Web API de Spotify: {error}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("desconocido")
        .to_string();
    let body = response.text().map_err(|error| {
        format!(
            "Spotify no pudo leer la respuesta HTTP {}: {error}",
            status.as_u16()
        )
    })?;
    if let Some(error) = spotify_restricted_api_error(status, &body) {
        return Err(error);
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        let sample = body
            .chars()
            .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
            .take(160)
            .collect::<String>();
        format!(
            "Spotify devolvió JSON inválido (HTTP {}, Content-Type {}): {error}; respuesta: {}",
            status.as_u16(),
            content_type,
            sample
        )
    })?;
    if !status.is_success() {
        let detail = first_string(&payload, &["message", "error_description"]);
        return Err(if detail.is_empty() {
            format!("Spotify respondió HTTP {}", status.as_u16())
        } else {
            format!("Spotify: {detail}")
        });
    }
    Ok(payload)
}

fn spotify_restricted_api_error(status: StatusCode, body: &str) -> Option<String> {
    (status == StatusCode::FORBIDDEN
        && body
            .to_ascii_lowercase()
            .contains("active premium subscription required"))
    .then(|| {
        format!(
            "{SPOTIFY_AUTHENTICATED_RESTRICTED_CODE}: {SPOTIFY_AUTHENTICATED_RESTRICTED_MESSAGE}"
        )
    })
}

fn decode_spotify_html(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0usize;
    while let Some(relative) = value[cursor..].find('&') {
        let start = cursor + relative;
        decoded.push_str(&value[cursor..start]);
        let Some(end_relative) = value[start..].find(';') else {
            decoded.push('&');
            cursor = start + 1;
            continue;
        };
        let end = start + end_relative;
        let entity = &value[start + 1..end];
        let replacement = match entity.to_ascii_lowercase().as_str() {
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" | "#39" | "#x27" => Some('\''),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32),
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = replacement {
            decoded.push(character);
        } else {
            decoded.push_str(&value[start..=end]);
        }
        cursor = end + 1;
    }
    decoded.push_str(&value[cursor..]);
    decoded.trim().to_string()
}

/// Spotify publica fragmentos HTML en algunos og/meta y Encore atributos.
/// Nunca dejamos que esos fragmentos lleguen a la UI ni a los tags.
fn sanitize_spotify_text(value: &str) -> Option<String> {
    let decoded = decode_spotify_html(value);
    let lower = decoded.to_ascii_lowercase();
    if lower.contains("<svg")
        || lower.contains("<path")
        || lower.contains("data-encore")
        || lower.contains("aria-")
        || lower.contains("data-testid")
    {
        return None;
    }
    let mut plain = String::with_capacity(decoded.len());
    let mut in_tag = false;
    for character in decoded.chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(character),
            _ => {}
        }
    }
    let normalized = plain.nfkc().collect::<String>();
    let mut collapsed = String::new();
    for character in normalized.chars() {
        if character.is_whitespace() {
            if !collapsed.ends_with(' ') {
                collapsed.push(' ');
            }
        } else if !character.is_control() {
            collapsed.push(character);
        }
    }
    let value = collapsed.trim().chars().take(200).collect::<String>();
    (!value.is_empty()).then_some(value)
}

fn sanitize_spotify_text_or_empty(value: &str) -> String {
    sanitize_spotify_text(value).unwrap_or_default()
}

fn html_attribute(tag: &str, attribute: &str) -> String {
    for quote in ['"', '\''] {
        let marker = format!("{attribute}={quote}");
        if let Some(start) = tag.find(&marker) {
            let value_start = start + marker.len();
            if let Some(end) = tag[value_start..].find(quote) {
                return decode_spotify_html(&tag[value_start..value_start + end]);
            }
        }
    }
    String::new()
}

fn html_meta_content(html: &str, key: &str) -> String {
    for fragment in html.split("<meta").skip(1) {
        let Some(end) = fragment.find('>') else {
            continue;
        };
        let tag = &fragment[..end];
        let property = html_attribute(tag, "property");
        let name = html_attribute(tag, "name");
        if property.eq_ignore_ascii_case(key) || name.eq_ignore_ascii_case(key) {
            return html_attribute(tag, "content");
        }
    }
    String::new()
}

fn html_text_after_marker(fragment: &str, marker: &str) -> String {
    let Some(marker_start) = fragment.find(marker) else {
        return String::new();
    };
    let after = &fragment[marker_start + marker.len()..];
    let Some(open_end) = after.find('>') else {
        return String::new();
    };
    let content = &after[open_end + 1..];
    let text = if let Some(inner_start) = content.find("<span") {
        let inner = &content[inner_start..];
        inner
            .find('>')
            .map(|end| &inner[end + 1..])
            .unwrap_or(inner)
    } else if let Some(inner_start) = content.find("<a") {
        let inner = &content[inner_start..];
        inner
            .find('>')
            .map(|end| &inner[end + 1..])
            .unwrap_or(inner)
    } else {
        content
    };
    let Some(close) = text.find("</") else {
        return String::new();
    };
    decode_spotify_html(text[..close].trim())
}

fn spotify_public_page(client: &Client, canonical_url: &str) -> Result<String, String> {
    let response = client
        .get(canonical_url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .map_err(|error| format!("No se pudo leer la página pública de Spotify: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Spotify devolvió una página ilegible: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Spotify respondió HTTP {} al consultar sus metadatos públicos",
            status.as_u16()
        ));
    }
    if body.len() > 12 * 1024 * 1024 {
        return Err("La página pública de Spotify excede el límite de seguridad de 12 MiB".into());
    }
    Ok(body)
}

fn spotify_oembed(client: &Client, canonical_url: &str) -> Result<Value, String> {
    let mut endpoint = Url::parse("https://open.spotify.com/oembed")
        .map_err(|error| format!("No se pudo preparar oEmbed de Spotify: {error}"))?;
    endpoint.query_pairs_mut().append_pair("url", canonical_url);
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| format!("No se pudo consultar oEmbed de Spotify: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|error| format!("oEmbed de Spotify devolvió JSON inválido: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "oEmbed de Spotify respondió HTTP {}",
            status.as_u16()
        ));
    }
    Ok(payload)
}

fn spotify_public_track(
    client: &Client,
    canonical_url: &str,
    id: &str,
) -> Result<(String, String, String, Vec<SpotifyTrackMetadata>), String> {
    let html = spotify_public_page(client, canonical_url)?;
    let oembed = spotify_oembed(client, canonical_url).unwrap_or(Value::Null);
    let title = {
        let value = html_meta_content(&html, "og:title");
        if value.is_empty() {
            first_string(&oembed, &["title"])
        } else {
            value
        }
    };
    let title = sanitize_spotify_text(&title)
        .ok_or_else(|| "metadata_incomplete: Spotify no entregó un título limpio".to_string())?;
    let description = html_meta_content(&html, "description");
    let parts = description
        .strip_prefix("Listen to ")
        .and_then(|value| value.split_once(" on Spotify").map(|(_, rest)| rest))
        .unwrap_or(description.as_str())
        .split('·')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let creator = if parts.len() >= 2 {
        sanitize_spotify_text_or_empty(parts[1])
    } else if parts.len() == 1 && parts[0] != "Song" {
        sanitize_spotify_text_or_empty(parts[0])
    } else {
        String::new()
    };
    let thumbnail = safe_remote_thumbnail_url(&html_meta_content(&html, "og:image"));
    let thumbnail = if thumbnail.is_empty() {
        safe_remote_thumbnail_url(&first_string(&oembed, &["thumbnail_url"]))
    } else {
        thumbnail
    };
    if title.is_empty() {
        return Err("Spotify no expuso el título de la canción en sus metadatos públicos".into());
    }
    Ok((
        title.clone(),
        creator.clone(),
        thumbnail.clone(),
        vec![SpotifyTrackMetadata {
            id: id.to_string(),
            isrc: String::new(),
            title: title.clone(),
            creator,
            album: String::new(),
            album_artist: String::new(),
            duration_seconds: None,
            thumbnail,
            spotify_url: canonical_url.to_string(),
            track_number: Some(1),
            disc_number: Some(1),
            release_date: String::new(),
            explicit: false,
            playlist_position: Some(1),
        }],
    ))
}

fn spotify_public_collection(
    client: &Client,
    canonical_url: &str,
    kind: &str,
) -> Result<(String, String, String, Vec<SpotifyTrackMetadata>), String> {
    let html = spotify_public_page(client, canonical_url)?;
    let oembed = spotify_oembed(client, canonical_url).unwrap_or(Value::Null);
    let title = {
        let value = html_meta_content(&html, "og:title");
        if value.is_empty() {
            first_string(&oembed, &["title"])
        } else {
            value
        }
    };
    let title = sanitize_spotify_text(&title).ok_or_else(|| {
        "metadata_incomplete: Spotify no entregó el nombre de la colección".to_string()
    })?;
    let creator = sanitize_spotify_text_or_empty(&html_meta_content(&html, "music:creator"));
    let thumbnail = {
        let value = safe_remote_thumbnail_url(&html_meta_content(&html, "og:image"));
        if value.is_empty() {
            safe_remote_thumbnail_url(&first_string(&oembed, &["thumbnail_url"]))
        } else {
            value
        }
    };
    let mut tracks = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = html[cursor..].find("data-testid=\"track-row\"") {
        let start = cursor + relative;
        let end = html[start + 24..]
            .find("data-testid=\"track-row\"")
            .map(|next| start + 24 + next)
            .unwrap_or(html.len());
        let row = &html[start..end];
        let Some(href_start) = row.find("href=\"/track/") else {
            cursor = start + 24;
            continue;
        };
        let id_start = href_start + "href=\"/track/".len();
        let Some(id_end) = row[id_start..].find('"') else {
            cursor = start + 24;
            continue;
        };
        let id = &row[id_start..id_start + id_end];
        if id.is_empty() || id.len() > 128 {
            cursor = start + 24;
            continue;
        }
        let title = {
            let title = html_text_after_marker(row, "data-encore-id=\"listRowTitle\"");
            if title.is_empty() {
                html_text_after_marker(row, "data-testid=\"listRowTitle\"")
            } else {
                title
            }
        };
        let Some(title) = sanitize_spotify_text(&title) else {
            cursor = start + 24;
            continue;
        };
        let mut artists = Vec::new();
        let mut artist_cursor = 0usize;
        while let Some(found) = row[artist_cursor..].find("data-testid=\"internal-artist-link\"") {
            let marker_start = artist_cursor + found;
            let artist = html_text_after_marker(
                &row[marker_start..],
                "data-testid=\"internal-artist-link\"",
            );
            let artist = sanitize_spotify_text_or_empty(&artist);
            if !artist.is_empty() && !artists.contains(&artist) {
                artists.push(artist);
            }
            artist_cursor = marker_start + 36;
        }
        let thumbnail = row
            .find("data-encore-id=\"image\"")
            .and_then(|marker| row[..marker].rfind("<img").map(|img| &row[img..marker]))
            .map(|tag| safe_remote_thumbnail_url(&html_attribute(tag, "src")))
            .unwrap_or_default();
        let position = tracks.len() as u32 + 1;
        let album = if kind == "album" {
            title.clone()
        } else {
            String::new()
        };
        tracks.push(SpotifyTrackMetadata {
            id: id.to_string(),
            isrc: String::new(),
            title,
            creator: artists.join(", "),
            album,
            album_artist: String::new(),
            duration_seconds: None,
            thumbnail,
            spotify_url: format!("https://open.spotify.com/track/{id}"),
            track_number: Some(position),
            disc_number: Some(1),
            release_date: String::new(),
            explicit: row.contains("aria-label=\"Explicit\""),
            playlist_position: Some(position),
        });
        if tracks.len() >= 500 {
            break;
        }
        cursor = start + 24;
    }
    if tracks.is_empty() {
        return Err("Spotify no expuso canciones públicas en la página; configura OAuth oficial para esta playlist o álbum".into());
    }
    Ok((title, creator, thumbnail, tracks))
}

fn spotify_artwork(value: &Value) -> String {
    value
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| {
            images
                .iter()
                .filter_map(|image| {
                    let candidate = presentation_thumbnail_url(
                        image.get("url").and_then(Value::as_str).unwrap_or_default(),
                    );
                    (!candidate.is_empty()).then_some((thumbnail_dimension_score(image), candidate))
                })
                .max_by_key(|(score, _)| *score)
                .map(|(_, candidate)| candidate)
        })
        .unwrap_or_default()
}

/// Spotify's public/API artwork is commonly capped at 640px.  Deezer exposes
/// the same catalogue with a `cover_xl` rendition (typically 1000px), so use
/// it as a presentation-only artwork source while keeping Spotify as the
/// metadata authority.  A failed lookup is intentionally non-fatal.
fn deezer_artwork(client: &Client, artist: &str, title: &str) -> Option<String> {
    let artist = artist.trim();
    let title = title.trim();
    if artist.is_empty() || title.is_empty() {
        return None;
    }
    let query = format!("artist:\"{artist}\" track:\"{title}\"");
    let response = client
        .get("https://api.deezer.com/search")
        .query(&[("q", query.as_str()), ("limit", "1")])
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let payload = response.json::<Value>().ok()?;
    payload
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("album"))
        .and_then(|album| {
            ["cover_xl", "cover_big", "cover_medium", "cover"]
                .iter()
                .find_map(|key| {
                    let url = safe_remote_thumbnail_url(
                        album.get(*key).and_then(Value::as_str).unwrap_or_default(),
                    );
                    (!url.is_empty()).then_some(url)
                })
        })
}

fn enrich_spotify_artwork(client: &Client, tracks: &mut [SpotifyTrackMetadata]) {
    // A 500-track playlist must remain responsive.  Reuse results for repeated
    // album/artist pairs and cap external artwork lookups to the first 80
    // visible entries; the original safe URL remains the fallback for the rest.
    let mut cache = HashMap::<String, String>::new();
    for track in tracks.iter_mut().take(80) {
        let key = format!(
            "{}\u{001f}{}",
            track.creator.to_lowercase(),
            track.title.to_lowercase()
        );
        let cover = if let Some(value) = cache.get(&key) {
            value.clone()
        } else {
            let value = deezer_artwork(client, &track.creator, &track.title).unwrap_or_default();
            cache.insert(key, value.clone());
            value
        };
        if !cover.is_empty() {
            track.thumbnail = cover;
        }
    }
}

fn spotify_artists(value: &Value) -> String {
    value
        .get("artists")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| {
                    let name = sanitize_spotify_text_or_empty(&first_string(artist, &["name"]));
                    (!name.is_empty()).then_some(name)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn value_u32(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(|entry| {
            entry
                .as_u64()
                .or_else(|| entry.as_f64().map(|number| number as u64))
        })
        .and_then(|number| u32::try_from(number).ok())
}

fn spotify_track_metadata(
    value: &Value,
    fallback_url: &str,
    playlist_position: Option<u32>,
) -> Option<SpotifyTrackMetadata> {
    let id = first_string(value, &["id"]);
    let title = sanitize_spotify_text(&first_string(value, &["name", "title"]))?;
    if id.is_empty() {
        return None;
    }
    let creator = sanitize_spotify_text_or_empty(&spotify_artists(value));
    let album_value = value.get("album").unwrap_or(&Value::Null);
    let album = sanitize_spotify_text_or_empty(&first_string(album_value, &["name"]));
    let album_artist = sanitize_spotify_text_or_empty(&spotify_artists(album_value));
    let release_date =
        sanitize_spotify_text_or_empty(&first_string(album_value, &["release_date"]));
    let duration_seconds = value
        .get("duration_ms")
        .and_then(Value::as_f64)
        .map(|milliseconds| milliseconds / 1000.0);
    let spotify_url = first_string(
        value.get("external_urls").unwrap_or(&Value::Null),
        &["spotify"],
    );
    Some(SpotifyTrackMetadata {
        id,
        isrc: sanitize_spotify_text_or_empty(&first_string(
            value.get("external_ids").unwrap_or(&Value::Null),
            &["isrc"],
        )),
        title,
        creator,
        album,
        album_artist,
        duration_seconds,
        thumbnail: spotify_artwork(album_value),
        spotify_url: if spotify_url.is_empty() {
            fallback_url.to_string()
        } else {
            spotify_url
        },
        track_number: value_u32(value, "track_number"),
        disc_number: value_u32(value, "disc_number"),
        release_date,
        explicit: value
            .get("explicit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        playlist_position,
    })
}

fn is_youtube_source(value: &str) -> bool {
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtu.be"
        || host == "music.youtube.com"
}

fn youtube_thumbnail_for_source(value: &str) -> String {
    let Ok(parsed) = Url::parse(value.trim()) else {
        return String::new();
    };
    if !is_youtube_source(value) {
        return String::new();
    }
    let path_id = parsed
        .path_segments()
        .and_then(|segments| {
            let parts = segments.collect::<Vec<_>>();
            match parts.first().copied() {
                Some("shorts") | Some("embed") | Some("live") => parts.get(1).copied(),
                _ => None,
            }
        })
        .unwrap_or_default();
    let query_id = parsed
        .query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    let id = if parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("youtu.be"))
    {
        parsed
            .path_segments()
            .and_then(|mut segments| segments.find(|part| !part.is_empty()))
            .unwrap_or_default()
            .to_string()
    } else if !query_id.is_empty() {
        query_id
    } else {
        path_id.to_string()
    };
    youtube_thumbnail_from_id(&id)
}

const SPOTIFY_VERSION_TERMS: &[&str] = &[
    "remix",
    "remaster",
    "live",
    "acoustic",
    "instrumental",
    "karaoke",
    "cover",
    "nightcore",
    "slowed",
    "reverb",
    "sped",
    "speed",
    "radio",
    "extended",
    "edit",
    "mashup",
    "demo",
    "clean",
    "explicit",
];

const SPOTIFY_RESOLUTION_STATES: &[&str] = &[
    "metadata_pending",
    "metadata_imported",
    "metadata_incomplete",
    "resolution_queued",
    "searching",
    "candidates_found",
    "inspecting",
    "ready",
    "ambiguous",
    "not_found",
    "download_queued",
    "downloading",
    "validating",
    "tagging",
    "completed",
    "failed",
    "cancelled",
];

fn is_known_spotify_resolution_state(value: &str) -> bool {
    SPOTIFY_RESOLUTION_STATES.contains(&value)
}

fn spotify_version_terms(value: &str) -> HashSet<String> {
    let tokens = normalized_search_tokens(value);
    SPOTIFY_VERSION_TERMS
        .iter()
        .filter(|term| tokens.contains(**term))
        .map(|term| (*term).to_string())
        .collect()
}

fn spotify_primary_artist_score(expected: &str, candidate: &str) -> f64 {
    let expected_tokens = normalized_search_tokens(expected);
    let candidate_tokens = normalized_search_tokens(candidate);
    if expected_tokens.is_empty() || candidate_tokens.is_empty() {
        return 0.0;
    }
    expected_tokens.intersection(&candidate_tokens).count() as f64 / expected_tokens.len() as f64
}

fn spotify_candidate_is_musical(track: &SpotifyTrackMetadata, result: &MediaSearchResult) -> bool {
    let text = format!("{} {}", result.title, result.creator).to_ascii_lowercase();
    let non_musical = [
        "tutorial",
        "gameplay",
        "reaction",
        "minecraft",
        "fortnite",
        "vlog",
        "review",
        "unboxing",
        "interview",
        "podcast",
        "walkthrough",
        "trailer",
        "compilation",
    ];
    !non_musical.iter().any(|marker| text.contains(marker)) && !track.title.trim().is_empty()
}

fn spotify_candidate_version_mismatch(
    track: &SpotifyTrackMetadata,
    result: &MediaSearchResult,
) -> bool {
    let expected = spotify_version_terms(&track.title);
    let candidate = spotify_version_terms(&result.title);
    expected != candidate
}

/// Score contract: title 30, primary artist 30, duration 25, album/ID 10,
/// musical-content confidence 5. Hard incompatibilities return zero.
fn spotify_candidate_score(track: &SpotifyTrackMetadata, result: &MediaSearchResult) -> f64 {
    if !spotify_candidate_is_musical(track, result)
        || spotify_candidate_version_mismatch(track, result)
    {
        return 0.0;
    }
    let title_score = title_similarity(&track.title, &result.title);
    if title_score < 0.45 {
        return 0.0;
    }
    let artist_score = spotify_primary_artist_score(&track.creator, &result.creator);
    if !track.creator.trim().is_empty() && !result.creator.trim().is_empty() && artist_score == 0.0
    {
        return 0.0;
    }
    if let (Some(expected), Some(candidate)) = (track.duration_seconds, result.duration_seconds) {
        if (expected - candidate).abs() > 10.0 {
            return 0.0;
        }
    }
    let duration_score = duration_similarity(track.duration_seconds, result.duration_seconds);
    let album_score = if track.album.trim().is_empty() {
        0.0
    } else {
        token_similarity(&track.album, &result.title)
    };
    let mut score =
        title_score * 30.0 + artist_score * 30.0 + duration_score * 25.0 + album_score * 10.0 + 5.0;
    if track.duration_seconds.is_none() || result.duration_seconds.is_none() {
        score = score.min(65.0);
    }
    if let (Some(expected), Some(candidate)) = (track.duration_seconds, result.duration_seconds) {
        if (expected - candidate).abs() > 6.0 {
            score = score.min(69.0);
        }
    }
    if artist_score < 0.45 {
        score = score.min(45.0);
    }
    score.clamp(0.0, 100.0)
}

fn resolve_spotify_track(track: &SpotifyTrackMetadata, app: &AppHandle) -> MediaItemSnapshot {
    let mut queries = vec![
        format!("{} {}", track.creator, track.title),
        format!("{} {}", track.title, track.creator),
        format!("{} {} official audio", track.creator, track.title),
        format!("{} {} topic", track.creator, track.title),
        format!("{} {}", track.creator, track.album),
    ];
    queries.retain(|query| query.split_whitespace().count() > 1);
    let mut candidates = Vec::<(MediaSearchResult, f64)>::new();
    let mut seen = HashSet::new();
    for query in queries.into_iter().take(5) {
        let Ok(results) =
            search_media_internal_with_timeout(&query, 5, 0, app, Duration::from_secs(9), None)
        else {
            continue;
        };
        for result in results {
            if !is_youtube_source(&result.source_url) || !seen.insert(result.source_url.clone()) {
                continue;
            }
            let score = spotify_candidate_score(track, &result);
            if score > 0.0 {
                candidates.push((result, score));
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let candidate_snapshots = candidates
        .iter()
        .take(5)
        .map(|(result, score)| SpotifyCandidateSnapshot {
            source_url: result.source_url.clone(),
            title: result.title.clone(),
            creator: result.creator.clone(),
            duration_label: result.duration_label.clone(),
            duration_seconds: result.duration_seconds,
            thumbnail: result.thumbnail.clone(),
            confidence: *score,
            provider: "YouTube Music / yt-dlp".into(),
        })
        .collect::<Vec<_>>();
    let (source_url, similarity, resolution_state, resolution_message) =
        if track.creator.trim().is_empty() || track.duration_seconds.is_none() {
            (
                String::new(),
                0.0,
                "metadata_incomplete".into(),
                "metadata_incomplete: faltan artista o duración; no se selecciona automáticamente"
                    .into(),
            )
        } else {
            candidates
                .first()
                .map(|(result, score)| {
                    let state = if *score >= 85.0 {
                        "ready"
                    } else if *score >= 50.0 {
                        "ambiguous"
                    } else {
                        "not_found"
                    };
                    let url = if state == "ready" {
                        result.source_url.clone()
                    } else {
                        String::new()
                    };
                    let message = match state {
                        "ready" => "Coincidencia verificada por título, artista y duración.".into(),
                        "ambiguous" => {
                            "Hay candidatos cercanos; revisa la coincidencia antes de descargar."
                                .into()
                        }
                        _ => "No se encontró una coincidencia suficientemente fiable.".into(),
                    };
                    (url, *score, state.to_string(), message)
                })
                .unwrap_or_else(|| {
                    (
                        String::new(),
                        0.0,
                        "not_found".into(),
                        "La búsqueda no devolvió candidatos.".into(),
                    )
                })
        };
    let selected_source_url = source_url.clone();
    MediaItemSnapshot {
        source_id: format!("spotify:track:{}", track.id),
        source_url,
        metadata_url: track.spotify_url.clone(),
        selected_source_url,
        title: track.title.clone(),
        creator: if track.creator.is_empty() {
            "Artista de Spotify".into()
        } else {
            track.creator.clone()
        },
        duration_label: duration_label(track.duration_seconds),
        duration_seconds: track.duration_seconds,
        thumbnail: track.thumbnail.clone(),
        spotify_url: track.spotify_url.clone(),
        provider: "spotify_metadata_youtube_music".into(),
        match_similarity: similarity,
        isrc: track.isrc.clone(),
        album: track.album.clone(),
        album_artist: track.album_artist.clone(),
        release_date: track.release_date.clone(),
        track_number: track.track_number,
        disc_number: track.disc_number,
        explicit: track.explicit,
        playlist_position: track.playlist_position,
        resolution_state,
        resolution_message,
        resolution_candidates: candidate_snapshots,
    }
}

fn spotify_api_source(
    client: &Client,
    token: &str,
    kind: &str,
    id: &str,
    canonical_url: &str,
) -> Result<
    (
        String,
        String,
        String,
        Vec<SpotifyTrackMetadata>,
        &'static str,
    ),
    String,
> {
    let mut tracks = Vec::new();
    if kind == "track" {
        let payload = spotify_api_get(
            client,
            token,
            &format!("https://api.spotify.com/v1/tracks/{id}"),
        )?;
        let track = spotify_track_metadata(&payload, canonical_url, Some(1))
            .ok_or_else(|| "Spotify no devolvió los datos de la canción".to_string())?;
        let title = track.title.clone();
        let creator = track.creator.clone();
        let thumbnail = track.thumbnail.clone();
        tracks.push(track);
        return Ok((title, creator, thumbnail, tracks, "video"));
    }
    let payload = if kind == "album" {
        spotify_api_get(
            client,
            token,
            &format!("https://api.spotify.com/v1/albums/{id}"),
        )?
    } else {
        spotify_api_get(
            client,
            token,
            &format!("https://api.spotify.com/v1/playlists/{id}"),
        )?
    };
    let title = sanitize_spotify_text_or_empty(&first_string(&payload, &["name", "title"]));
    let creator = if kind == "album" {
        sanitize_spotify_text_or_empty(&spotify_artists(&payload))
    } else {
        sanitize_spotify_text_or_empty(&first_string(
            payload.get("owner").unwrap_or(&Value::Null),
            &["display_name", "id"],
        ))
    };
    let thumbnail = spotify_artwork(&payload);
    if title.is_empty() {
        return Err("metadata_incomplete: Spotify no devolvió el nombre de la colección".into());
    }
    if kind == "album" {
        if let Some(items) = payload
            .get("tracks")
            .and_then(|tracks| tracks.get("items"))
            .and_then(Value::as_array)
        {
            tracks.extend(items.iter().enumerate().filter_map(|(index, item)| {
                spotify_track_metadata(item, canonical_url, Some(index as u32 + 1))
            }));
        }
    } else {
        let mut offset = 0usize;
        loop {
            let page = spotify_api_get(
                client,
                token,
                &format!(
                    "https://api.spotify.com/v1/playlists/{id}/items?limit=100&offset={offset}"
                ),
            )?;
            let items = page
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (index, item) in items
                .iter()
                .take(500usize.saturating_sub(tracks.len()))
                .enumerate()
            {
                if let Some(track) = item.get("track").and_then(|track| {
                    spotify_track_metadata(track, canonical_url, Some((offset + index) as u32 + 1))
                }) {
                    tracks.push(track);
                }
            }
            let has_next = page
                .get("next")
                .and_then(Value::as_str)
                .is_some_and(|next| !next.is_empty());
            offset += items.len();
            if !has_next || items.is_empty() || tracks.len() >= 500 {
                break;
            }
        }
    }
    Ok((title, creator, thumbnail, tracks, "playlist"))
}

fn spotify_public_source(
    client: &Client,
    kind: &str,
    id: &str,
    canonical_url: &str,
) -> Result<
    (
        String,
        String,
        String,
        Vec<SpotifyTrackMetadata>,
        &'static str,
    ),
    String,
> {
    if kind == "track" {
        let (title, creator, thumbnail, tracks) = spotify_public_track(client, canonical_url, id)?;
        Ok((title, creator, thumbnail, tracks, "video"))
    } else {
        let (title, creator, thumbnail, tracks) =
            spotify_public_collection(client, canonical_url, kind)?;
        Ok((title, creator, thumbnail, tracks, "playlist"))
    }
}

fn spotdl_json_value(output: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(output);
    for line in text.lines().rev() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            if value.is_array() || value.is_object() {
                return Ok(value);
            }
        }
    }
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if !matches!(bytes[start], b'[' | b'{') {
            continue;
        }
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for end in start..bytes.len() {
            let byte = bytes[end];
            if in_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
                continue;
            }
            match byte {
                b'"' => in_string = true,
                b'[' | b'{' => depth += 1,
                b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(value) = serde_json::from_slice::<Value>(&bytes[start..=end]) {
                            if value.is_array() || value.is_object() {
                                return Ok(value);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    Err("No se encontraron metadatos JSON estructurados de Spotify".into())
}

fn spotdl_track_text(value: &Value, key: &str) -> String {
    sanitize_spotify_text_or_empty(&first_string(value, &[key]))
}

fn spotdl_track_artists(value: &Value) -> String {
    let artists = value
        .get("artists")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(sanitize_spotify_text_or_empty)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    if artists.is_empty() {
        spotdl_track_text(value, "artist")
    } else {
        artists
    }
}

fn spotdl_track_metadata(
    value: &Value,
    fallback_url: &str,
    position: usize,
) -> Option<SpotifyTrackMetadata> {
    let id = spotdl_track_text(value, "song_id");
    let title = spotdl_track_text(value, "name");
    let creator = spotdl_track_artists(value);
    if title.is_empty() || creator.is_empty() {
        return None;
    }
    let spotify_url = {
        let direct = spotdl_track_text(value, "url");
        if direct.is_empty() && !id.is_empty() {
            format!("https://open.spotify.com/track/{id}")
        } else if direct.is_empty() {
            fallback_url.to_string()
        } else {
            direct
        }
    };
    let duration_seconds = value.get("duration").and_then(Value::as_f64).or_else(|| {
        value
            .get("duration_ms")
            .and_then(Value::as_f64)
            .map(|milliseconds| milliseconds / 1000.0)
    });
    Some(SpotifyTrackMetadata {
        id: if id.is_empty() {
            format!("spotdl-{position}")
        } else {
            id
        },
        isrc: spotdl_track_text(value, "isrc"),
        title,
        creator,
        album: spotdl_track_text(value, "album_name"),
        album_artist: spotdl_track_text(value, "album_artist"),
        duration_seconds,
        thumbnail: presentation_thumbnail_url(&spotdl_track_text(value, "cover_url")),
        spotify_url,
        track_number: value_u32(value, "track_number"),
        disc_number: value_u32(value, "disc_number"),
        release_date: spotdl_track_text(value, "date"),
        explicit: value
            .get("explicit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        playlist_position: value
            .get("list_position")
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .or(Some(position as u32)),
    })
}

fn spotdl_formats() -> Vec<MediaFormatSnapshot> {
    [
        ("best", "Mejor calidad disponible", "native"),
        ("m4a", "M4A", "m4a"),
        ("opus", "Opus", "opus"),
        ("mp3_320", "MP3 320 kbps", "mp3"),
        ("mp3_v0", "MP3 V0", "mp3"),
    ]
    .into_iter()
    .map(|(id, label, ext)| {
        media_format_snapshot(
            id.into(),
            label.into(),
            ext.into(),
            "audio".into(),
            true,
            None,
            None,
        )
    })
    .collect()
}

fn spotdl_snapshot_from_tracks(
    kind: &str,
    title: String,
    creator: String,
    thumbnail: String,
    tracks: Vec<SpotifyTrackMetadata>,
) -> Result<MediaAnalysisSnapshot, String> {
    if tracks.is_empty() {
        return Err("metadata_incomplete: no se encontraron canciones en Spotify".into());
    }
    let total_duration = tracks
        .iter()
        .filter_map(|track| track.duration_seconds)
        .sum();
    let items = tracks
        .iter()
        .map(|track| MediaItemSnapshot {
            source_id: format!("spotify:track:{}", track.id),
            source_url: track.spotify_url.clone(),
            metadata_url: track.spotify_url.clone(),
            selected_source_url: String::new(),
            title: track.title.clone(),
            creator: track.creator.clone(),
            duration_label: duration_label(track.duration_seconds),
            duration_seconds: track.duration_seconds,
            thumbnail: track.thumbnail.clone(),
            spotify_url: track.spotify_url.clone(),
            provider: "spotdl".into(),
            match_similarity: 100.0,
            isrc: track.isrc.clone(),
            album: track.album.clone(),
            album_artist: track.album_artist.clone(),
            release_date: track.release_date.clone(),
            track_number: track.track_number,
            disc_number: track.disc_number,
            explicit: track.explicit,
            playlist_position: track.playlist_position,
            resolution_state: "ready".into(),
            resolution_message: "Metadatos listos; spotDL resolverá la fuente al iniciar".into(),
            resolution_candidates: Vec::new(),
        })
        .collect();
    Ok(MediaAnalysisSnapshot {
        kind: kind.into(),
        title,
        creator,
        thumbnail: presentation_thumbnail_url(&thumbnail),
        duration_label: duration_label(Some(total_duration)),
        duration_seconds: Some(total_duration),
        formats: spotdl_formats(),
        items,
        resolver: format!("spotDL {SPOTDL_VERSION} · proveedores con fallback"),
    })
}

fn spotdl_metadata_analysis(
    client: &Client,
    canonical_url: &str,
    value: Value,
) -> Result<MediaAnalysisSnapshot, String> {
    let values = value
        .as_array()
        .ok_or_else(|| "spotDL no devolvió una lista de canciones".to_string())?;
    let mut tracks = values
        .iter()
        .enumerate()
        .filter_map(|(index, item)| spotdl_track_metadata(item, canonical_url, index + 1))
        .collect::<Vec<_>>();
    enrich_spotify_artwork(client, &mut tracks);
    let first = tracks
        .first()
        .ok_or_else(|| "metadata_incomplete: no se encontraron canciones en Spotify".to_string())?;
    let title = values
        .first()
        .map(|item| spotdl_track_text(item, "list_name"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| first.title.clone());
    spotdl_snapshot_from_tracks(
        if tracks.len() == 1 {
            "video"
        } else {
            "playlist"
        },
        title,
        first.creator.clone(),
        first.thumbnail.clone(),
        tracks,
    )
}

fn spotdl_save_metadata(
    app: &AppHandle,
    canonical_url: &str,
) -> Result<MediaAnalysisSnapshot, String> {
    let (kind, id, _) = spotify_source_parts(canonical_url)?;
    let runtime =
        discover_media_runtime(app).ok_or_else(|| "spotify_engine_unavailable".to_string())?;
    let spotdl = runtime
        .spotdl
        .as_ref()
        .ok_or_else(|| "spotify_engine_unavailable".to_string())?;
    verify_spotdl_binary(spotdl)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("CacaTools Download Manager/0.22.1")
        .gzip(true)
        .build()
        .map_err(|error| error.to_string())?;
    // Public HTML/oEmbed is a preliminary metadata phase. It returns the
    // artwork/title quickly; provider resolution and media work stay in the
    // background download worker. spotDL save is only the structured fallback.
    if let Ok((title, creator, thumbnail, mut tracks, snapshot_kind)) =
        spotify_public_source(&client, &kind, &id, canonical_url)
    {
        enrich_spotify_artwork(&client, &mut tracks);
        return spotdl_snapshot_from_tracks(snapshot_kind, title, creator, thumbnail, tracks);
    }
    if kind != "track" {
        if let Ok((title, creator, thumbnail, mut tracks)) =
            spotify_public_collection(&client, canonical_url, &kind)
        {
            enrich_spotify_artwork(&client, &mut tracks);
            return spotdl_snapshot_from_tracks("playlist", title, creator, thumbnail, tracks);
        }
    }
    let temp_root = std::env::temp_dir().join("cacatools-spotdl").join(format!(
        "{}-{}",
        std::process::id(),
        UNIX_EPOCH.elapsed().unwrap_or_default().as_millis()
    ));
    let cache_path = temp_root.join("cache");
    fs::create_dir_all(&cache_path).map_err(|error| error.to_string())?;
    let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    let mut command = background_command(spotdl);
    command
        .arg("save")
        .arg(canonical_url)
        .arg("--save-file")
        .arg("-")
        .arg("--headless")
        .arg("--ffmpeg")
        .arg(ffmpeg)
        .arg("--cache-path")
        .arg(&cache_path)
        .arg("--no-cache")
        .arg("--max-retries")
        .arg("1");
    let result = command_output_with_timeout(
        &mut command,
        Duration::from_secs(if kind == "track" { 30 } else { 120 }),
        "la lectura de metadatos de Spotify",
    )?;
    let _ = fs::remove_dir_all(&temp_root);
    if !result.status.success() {
        return Err("provider_failed: spotDL no encontró una fuente compatible".into());
    }
    spotdl_metadata_analysis(&client, canonical_url, spotdl_json_value(&result.stdout)?)
}

#[derive(Clone, Serialize)]
struct MediaSearchResult {
    source_id: String,
    source_url: String,
    title: String,
    creator: String,
    duration_label: String,
    duration_seconds: Option<f64>,
    thumbnail: String,
    extractor: String,
    similarity: f64,
    match_reasons: Vec<String>,
}

#[derive(Clone, Serialize)]
struct FailureDiagnosisSnapshot {
    code: String,
    title: String,
    summary: String,
    retryable: bool,
    likely_temporary: bool,
    requires_user_action: bool,
    suggestions: Vec<String>,
}

#[derive(Serialize)]
struct MediaRecoverySnapshot {
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
struct MediaRecoveryRequest {
    job_id: i64,
    title: String,
    source_url: Option<String>,
    creator: Option<String>,
    duration_seconds: Option<f64>,
    limit: Option<usize>,
}

fn fold_search_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut previous_space = true;
    for character in value.chars().flat_map(char::to_lowercase) {
        let folded = match character {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            value if value.is_alphanumeric() => value,
            _ => ' ',
        };
        if folded == ' ' {
            if !previous_space {
                output.push(' ');
                previous_space = true;
            }
        } else {
            output.push(folded);
            previous_space = false;
        }
    }
    output.trim().to_string()
}

fn normalized_search_tokens(value: &str) -> HashSet<String> {
    fold_search_text(value)
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(str::to_string)
        .collect()
}

fn token_similarity(left: &str, right: &str) -> f64 {
    let left = normalized_search_tokens(left);
    let right = normalized_search_tokens(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn bigram_similarity(left: &str, right: &str) -> f64 {
    let pairs = |value: &str| {
        let characters = fold_search_text(value)
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<Vec<_>>();
        characters
            .windows(2)
            .map(|pair| (pair[0], pair[1]))
            .collect::<HashSet<_>>()
    };
    let left = pairs(left);
    let right = pairs(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    (2.0 * intersection / (left.len() + right.len()) as f64).clamp(0.0, 1.0)
}

fn title_similarity(left: &str, right: &str) -> f64 {
    let left_folded = fold_search_text(left);
    let right_folded = fold_search_text(right);
    if left_folded.is_empty() || right_folded.is_empty() {
        return 0.0;
    }
    let containment = if left_folded == right_folded {
        1.0
    } else if left_folded.contains(&right_folded) || right_folded.contains(&left_folded) {
        0.82
    } else {
        0.0
    };
    (token_similarity(&left_folded, &right_folded) * 0.55
        + bigram_similarity(&left_folded, &right_folded) * 0.30
        + containment * 0.15)
        .clamp(0.0, 1.0)
}

fn match_reasons(title_score: f64, creator_score: f64, duration_score: f64) -> Vec<String> {
    let mut reasons = Vec::new();
    if title_score >= 0.76 {
        reasons.push("Título casi idéntico".into());
    } else if title_score >= 0.48 {
        reasons.push("Coincide en palabras clave".into());
    }
    if creator_score >= 0.72 {
        reasons.push("Mismo autor o canal".into());
    }
    if duration_score >= 0.90 {
        reasons.push("Duración prácticamente igual".into());
    } else if duration_score >= 0.76 {
        reasons.push("Duración muy parecida".into());
    }
    reasons
}

fn duration_similarity(expected: Option<f64>, candidate: Option<f64>) -> f64 {
    let (Some(expected), Some(candidate)) = (expected, candidate) else {
        return 0.5;
    };
    if expected <= 0.0 || candidate <= 0.0 {
        return 0.5;
    }
    let difference = (expected - candidate).abs();
    (1.0 - difference / expected.max(candidate)).clamp(0.0, 1.0)
}

fn media_search_result_from_value(value: &Value, index: usize) -> MediaSearchResult {
    let source_id = {
        let value = first_string(value, &["id", "url", "webpage_url"]);
        if value.is_empty() {
            format!("result-{}", index + 1)
        } else {
            value
        }
    };
    let extractor = first_string(value, &["ie_key", "extractor_key", "extractor"]);
    let raw_url = first_string(value, &["webpage_url", "url"]);
    let source_url = if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
        raw_url
    } else if extractor.to_ascii_lowercase().contains("youtube")
        || (source_id.len() == 11
            && source_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            }))
    {
        format!("https://www.youtube.com/watch?v={source_id}")
    } else {
        raw_url
    };
    let title = {
        let value = first_string(value, &["title", "fulltitle"]);
        if value.is_empty() {
            format!("Resultado {}", index + 1)
        } else {
            value
        }
    };
    let duration_seconds = value.get("duration").and_then(Value::as_f64);
    let thumbnail = {
        let listed = thumbnail_from(value);
        if listed.is_empty() {
            youtube_thumbnail_from_id(&source_id)
        } else {
            listed
        }
    };
    MediaSearchResult {
        source_id,
        source_url,
        title,
        creator: first_string(value, &["uploader", "channel", "creator", "artist"]),
        duration_label: duration_label(duration_seconds),
        duration_seconds,
        thumbnail,
        extractor,
        similarity: 0.0,
        match_reasons: Vec::new(),
    }
}

fn search_media_internal_with_timeout(
    query: &str,
    limit: usize,
    offset: usize,
    app: &AppHandle,
    timeout: Duration,
    request_id: Option<u64>,
) -> Result<Vec<MediaSearchResult>, String> {
    search_media_internal_with_timeout_cancelable(query, limit, offset, app, timeout, || {
        request_id.is_some_and(search_request_is_cancelled)
    })
}

pub(crate) fn search_media_internal_with_timeout_cancelable<F>(
    query: &str,
    limit: usize,
    offset: usize,
    app: &AppHandle,
    timeout: Duration,
    is_cancelled: F,
) -> Result<Vec<MediaSearchResult>, String>
where
    F: Fn() -> bool,
{
    let query = query.trim();
    if query.len() < 2 || query.len() > 220 {
        return Err("La búsqueda necesita entre 2 y 220 caracteres".into());
    }
    let limit = limit.clamp(1, 50);
    let offset = offset.min(40);
    let search_end = offset.saturating_add(limit).min(50);
    let binary = resolver_binary(app)?;
    let mut command = background_command(binary);
    enable_available_js_runtime(&mut command);
    let fast_suggestions = timeout <= Duration::from_secs(8);
    command
        .arg("--ignore-config")
        .arg("--flat-playlist")
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--socket-timeout")
        .arg(if fast_suggestions { "4" } else { "7" })
        .arg("--retries")
        .arg(if fast_suggestions { "0" } else { "1" })
        .arg("--extractor-retries")
        .arg(if fast_suggestions { "0" } else { "1" })
        .arg("--match-filter")
        .arg("availability!=private & availability!=needs_auth & availability!=premium & availability!=subscriber_only")
        .arg("--playlist-start")
        .arg(offset.saturating_add(1).to_string())
        .arg("--playlist-end")
        .arg(search_end.to_string())
        .arg(format!("ytsearch{search_end}:{query}"));
    // A newer query can invalidate the flight while the command is being
    // prepared. Check at the last safe boundary before spawn so obsolete
    // searches do not create a process unnecessarily.
    if is_cancelled() {
        return Err("search_cancelled".into());
    }
    let output = command_output_with_timeout_cancelable(
        &mut command,
        timeout,
        "la búsqueda multimedia",
        is_cancelled,
    )?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "El resolvedor local no pudo completar la búsqueda".into()
        } else {
            message
        });
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("La búsqueda devolvió una respuesta inválida: {error}"))?;
    let entries = json
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut results = entries
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, value)| media_search_result_from_value(value, index))
        .filter(|item| !item.source_url.is_empty())
        .collect::<Vec<_>>();
    let result_count = results.len().max(1) as f64;
    for (index, item) in results.iter_mut().enumerate() {
        let title_score = title_similarity(query, &item.title);
        let creator_score = token_similarity(query, &item.creator);
        let rank_score = 1.0 - index as f64 / result_count;
        item.similarity =
            (title_score * 0.82 + creator_score * 0.08 + rank_score * 0.10).clamp(0.0, 1.0) * 100.0;
        item.match_reasons = match_reasons(title_score, creator_score, 0.5);
    }
    results.sort_by(|left, right| {
        right
            .similarity
            .partial_cmp(&left.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(results)
}

fn search_media_internal(
    query: &str,
    limit: usize,
    app: &AppHandle,
) -> Result<Vec<MediaSearchResult>, String> {
    search_media_internal_with_timeout(query, limit, 0, app, Duration::from_secs(16), None)
}

fn failure_diagnosis(message: &str, source_kind: &str) -> FailureDiagnosisSnapshot {
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

#[derive(Default, Serialize)]
struct PlayerStreamTechnicalSnapshot {
    codec: String,
    bitrate_kbps: Option<f64>,
    sample_rate_hz: Option<u32>,
    channels: Option<u32>,
}

#[derive(Default, Serialize)]
struct PlayerTechnicalSnapshot {
    container: String,
    bitrate_kbps: Option<f64>,
    duration_seconds: Option<f64>,
    audio: Option<PlayerStreamTechnicalSnapshot>,
    video: Option<PlayerStreamTechnicalSnapshot>,
}

#[derive(Serialize)]
struct PlayerMediaSnapshot {
    job_id: i64,
    title: String,
    status: String,
    detail: String,
    progress: f64,
    thumbnail: String,
    output_mode: String,
    kind: String,
    playable: bool,
    local_path: String,
    state_title: String,
    message: String,
    converted: Option<bool>,
    technical: Option<PlayerTechnicalSnapshot>,
}

#[derive(Serialize)]
struct PlayerOnlinePreviewSnapshot {
    title: String,
    creator: String,
    thumbnail: String,
    stream_url: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    qualities: Vec<PlayerOnlineQualitySnapshot>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    audio_stream_url: String,
    width: Option<u32>,
    height: Option<u32>,
    max_height: Option<u32>,
    quality_limited: bool,
    technical: PlayerTechnicalSnapshot,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    progressive_stream_url: String,
    progressive_width: Option<u32>,
    progressive_height: Option<u32>,
    progressive_technical: Option<PlayerTechnicalSnapshot>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    low_progressive_stream_url: String,
    low_progressive_width: Option<u32>,
    low_progressive_height: Option<u32>,
    low_progressive_technical: Option<PlayerTechnicalSnapshot>,
}

#[derive(Serialize)]
struct PlayerOnlineEmbedSnapshot {
    url: String,
    platform: String,
}

#[derive(Serialize, Clone)]
struct PlayerOnlineQualitySnapshot {
    id: String,
    label: String,
    url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    audio_url: String,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    container: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    video_codec: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    audio_codec: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bitrate_kbps: Option<f64>,
    #[serde(default)]
    candidate_rank: u32,
    has_audio: bool,
}

fn output_mode_conversion_state(output_mode: &str) -> Option<bool> {
    match output_mode {
        "audio_mp3" | "audio_m4a" => Some(true),
        "audio_best" | "source" => Some(false),
        _ => None,
    }
}

fn player_media_kind(output_mode: &str, path: &Path) -> String {
    if output_mode.starts_with("audio_") {
        return "audio".into();
    }
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "mp3" | "m4a" | "aac" | "opus" | "ogg" | "oga" | "flac" | "wav" | "wma"
    ) {
        "audio".into()
    } else {
        "video".into()
    }
}

fn player_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|entry| {
            entry
                .as_f64()
                .or_else(|| entry.as_str()?.parse::<f64>().ok())
        })
        .filter(|entry| entry.is_finite() && *entry > 0.0)
}

fn player_u32(value: Option<&Value>) -> Option<u32> {
    let entry = player_number(value)?;
    (entry <= u32::MAX as f64).then_some(entry.round() as u32)
}

fn player_stream_technical(value: &Value) -> PlayerStreamTechnicalSnapshot {
    PlayerStreamTechnicalSnapshot {
        codec: first_string(value, &["codec_name", "codec_long_name"]),
        bitrate_kbps: player_number(value.get("bit_rate")).map(|value| value / 1000.0),
        sample_rate_hz: player_u32(value.get("sample_rate")),
        channels: player_u32(value.get("channels")),
    }
}

fn player_preview_requested_entries(value: &Value) -> Option<&Vec<Value>> {
    for key in ["requested_formats", "requested_downloads"] {
        if let Some(entries) = value.get(key).and_then(Value::as_array) {
            if entries
                .iter()
                .any(|entry| !first_string(entry, &["url"]).is_empty())
            {
                return Some(entries);
            }
        }
    }

    value
        .get("requested_formats")
        .and_then(Value::as_array)
        .or_else(|| value.get("requested_downloads").and_then(Value::as_array))
}

fn player_preview_selected_entry(value: &Value) -> &Value {
    player_preview_requested_entries(value)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| first_string(entry, &["vcodec"]) != "none")
                .or_else(|| entries.first())
        })
        .unwrap_or(value)
}

fn player_preview_audio_entry(value: &Value) -> Option<&Value> {
    player_preview_requested_entries(value).and_then(|entries| {
        entries.iter().find(|entry| {
            first_string(entry, &["acodec"]) != "none" && first_string(entry, &["vcodec"]) == "none"
        })
    })
}

fn player_preview_progressive_score(value: &Value) -> (u32, u8, u8, i64) {
    let height = value
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default();
    let container = match first_string(value, &["ext", "container"]).as_str() {
        "mp4" => 2,
        "webm" => 1,
        _ => 0,
    };
    let codec = first_string(value, &["vcodec"]);
    let h264 = u8::from(codec.starts_with("avc1") || codec.starts_with("avc3"));
    let bitrate = player_number(value.get("tbr")).unwrap_or_default().round() as i64;
    (height, container, h264, bitrate)
}

fn player_preview_progressive_entry(value: &Value) -> Option<&Value> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    let url = first_string(entry, &["url"]);
                    let ext = first_string(entry, &["ext", "container"]);
                    !url.is_empty()
                        && matches!(ext.as_str(), "mp4" | "webm")
                        && first_string(entry, &["vcodec"]) != "none"
                        && first_string(entry, &["acodec"]) != "none"
                        && Url::parse(&url)
                            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                            .unwrap_or(false)
                })
                .max_by_key(|entry| player_preview_progressive_score(entry))
        })
}

fn player_preview_quality_score(
    container: &str,
    video_codec: &str,
    audio_codec: &str,
    protocol: &str,
    has_audio: bool,
    bitrate: Option<f64>,
) -> (u8, u8, u8, u8, u8, i64) {
    let container_score = match container.to_ascii_lowercase().as_str() {
        "mp4" => 3,
        "webm" => 2,
        _ => 0,
    };
    let codec_score = if video_codec.starts_with("avc1") || video_codec.starts_with("avc3") {
        4
    } else if video_codec.starts_with("vp9") {
        3
    } else if video_codec.starts_with("av01") {
        2
    } else if !video_codec.is_empty() && video_codec != "none" {
        1
    } else {
        0
    };
    let audio_score = u8::from(has_audio || (!audio_codec.is_empty() && audio_codec != "none"));
    let protocol_score = u8::from(protocol.eq_ignore_ascii_case("https"));
    let startup_score = u8::from(has_audio);
    let bitrate_score = bitrate.unwrap_or_default().round() as i64;
    (
        container_score,
        codec_score,
        audio_score,
        protocol_score,
        startup_score,
        bitrate_score,
    )
}

fn player_preview_low_progressive_entry(value: &Value) -> Option<&Value> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    let url = first_string(entry, &["url"]);
                    let ext = first_string(entry, &["ext", "container"]);
                    !url.is_empty()
                        && matches!(ext.as_str(), "mp4" | "webm")
                        && first_string(entry, &["vcodec"]) != "none"
                        && first_string(entry, &["acodec"]) != "none"
                        && Url::parse(&url)
                            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                            .unwrap_or(false)
                })
                .min_by_key(|entry| {
                    let height = entry
                        .get("height")
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or(u32::MAX);
                    // Prefer the highest safe progressive stream up to 480p;
                    // if the source exposes only larger streams, use its
                    // smallest compatible stream as the last native fallback.
                    if height <= 480 {
                        (0_u8, 480_u32.saturating_sub(height), height)
                    } else {
                        (1_u8, height.saturating_sub(480), height)
                    }
                })
        })
}

fn player_preview_qualities(
    value: &Value,
    fallback_audio_url: &str,
) -> Vec<PlayerOnlineQualitySnapshot> {
    let Some(entries) = value.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut qualities = entries
        .iter()
        .filter_map(|entry| {
            let url = first_string(entry, &["url"]);
            let id = first_string(entry, &["format_id", "format"]);
            let ext = first_string(entry, &["ext", "container"]).to_ascii_uppercase();
            let video_codec = first_string(entry, &["vcodec"]);
            let audio_codec = first_string(entry, &["acodec"]);
            let height = player_u32(entry.get("height"));
            if url.is_empty()
                || id.is_empty()
                || height.is_none()
                || video_codec.is_empty()
                || video_codec == "none"
                || !Url::parse(&url)
                    .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                    .unwrap_or(false)
            {
                return None;
            }
            let has_audio = !audio_codec.is_empty() && audio_codec != "none";
            let fps = player_number(entry.get("fps"));
            let protocol = first_string(entry, &["protocol"]);
            let container = first_string(entry, &["ext", "container"]);
            let bitrate = player_number(entry.get("tbr"));
            let fps_label = fps
                .filter(|value| *value >= 50.0)
                .map(|value| format!(" · {:.0}fps", value))
                .unwrap_or_default();
            let label = format!(
                "{}p{} · {}{}",
                height.unwrap_or_default(),
                fps_label,
                if ext.is_empty() { "VIDEO" } else { &ext },
                if has_audio { " · audio" } else { "" }
            );
            Some(PlayerOnlineQualitySnapshot {
                id,
                label,
                url,
                audio_url: if has_audio {
                    String::new()
                } else {
                    fallback_audio_url.to_string()
                },
                width: player_u32(entry.get("width")),
                height,
                fps,
                container,
                video_codec,
                audio_codec,
                protocol,
                bitrate_kbps: bitrate,
                candidate_rank: 0,
                has_audio,
            })
        })
        .collect::<Vec<_>>();

    qualities.sort_by(|left, right| {
        right
            .height
            .cmp(&left.height)
            .then_with(|| {
                let left_score = player_preview_quality_score(
                    &left.container,
                    &left.video_codec,
                    &left.audio_codec,
                    &left.protocol,
                    left.has_audio,
                    left.bitrate_kbps,
                );
                let right_score = player_preview_quality_score(
                    &right.container,
                    &right.video_codec,
                    &right.audio_codec,
                    &right.protocol,
                    right.has_audio,
                    right.bitrate_kbps,
                );
                right_score.cmp(&left_score)
            })
            .then_with(|| {
                right
                    .fps
                    .partial_cmp(&left.fps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut ranks = HashMap::<u32, u32>::new();
    for quality in &mut qualities {
        let rank = ranks.entry(quality.height.unwrap_or_default()).or_default();
        quality.candidate_rank = *rank;
        *rank = rank.saturating_add(1);
    }
    qualities
}

fn player_preview_max_height(value: &Value) -> Option<u32> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| first_string(entry, &["vcodec"]) != "none")
        .filter_map(|entry| entry.get("height").and_then(Value::as_u64))
        .filter_map(|height| u32::try_from(height).ok())
        .max()
}

fn player_preview_quality_limited(preview_height: Option<u32>, max_height: Option<u32>) -> bool {
    match (preview_height, max_height) {
        (Some(preview), Some(maximum)) => {
            preview <= 480 && maximum >= 1080 && maximum.saturating_sub(preview) >= 540
        }
        _ => false,
    }
}

fn player_preview_technical(value: &Value) -> PlayerTechnicalSnapshot {
    let selected = player_preview_selected_entry(value);
    let audio_entry = player_preview_audio_entry(value).unwrap_or(selected);
    player_preview_technical_for_entries(value, selected, audio_entry)
}

fn player_preview_technical_for_entries(
    value: &Value,
    selected: &Value,
    audio_entry: &Value,
) -> PlayerTechnicalSnapshot {
    let audio_codec = first_string(audio_entry, &["acodec"]);
    let video_codec = first_string(selected, &["vcodec"]);
    let bitrate = player_number(selected.get("tbr"));
    let audio_bitrate = player_number(audio_entry.get("abr"))
        .or_else(|| player_number(audio_entry.get("tbr")))
        .or(bitrate);
    let audio = (audio_codec != "none" && !audio_codec.is_empty()).then_some(
        PlayerStreamTechnicalSnapshot {
            codec: audio_codec,
            bitrate_kbps: audio_bitrate,
            sample_rate_hz: audio_entry
                .get("asr")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            channels: audio_entry
                .get("audio_channels")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
        },
    );
    let video = (video_codec != "none" && !video_codec.is_empty()).then_some(
        PlayerStreamTechnicalSnapshot {
            codec: video_codec,
            bitrate_kbps: bitrate,
            sample_rate_hz: None,
            channels: None,
        },
    );
    PlayerTechnicalSnapshot {
        container: first_string(selected, &["ext", "container"]),
        bitrate_kbps: bitrate,
        duration_seconds: player_number(value.get("duration")),
        audio,
        video,
    }
}

fn probe_player_technical(
    runtime: &MediaRuntimePaths,
    path: &Path,
) -> Option<PlayerTechnicalSnapshot> {
    let ffprobe = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    let mut command = background_command(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name,bit_rate,duration:stream=codec_type,codec_name,codec_long_name,bit_rate,sample_rate,channels",
            "-of",
            "json",
        ])
        .arg(path);
    // Technical metadata is optional. Bound ffprobe so a damaged or
    // unusually large file can never hold the local player in loading.
    let output = command_output_with_timeout(
        &mut command,
        Duration::from_millis(750),
        "ffprobe del reproductor local",
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    let format = value.get("format").and_then(Value::as_object);
    let mut snapshot = PlayerTechnicalSnapshot {
        container: format
            .and_then(|entry| entry.get("format_name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .split(',')
            .next()
            .unwrap_or_default()
            .to_string(),
        bitrate_kbps: format
            .and_then(|entry| player_number(entry.get("bit_rate")))
            .map(|value| value / 1000.0),
        duration_seconds: format.and_then(|entry| player_number(entry.get("duration"))),
        audio: None,
        video: None,
    };
    if let Some(streams) = value.get("streams").and_then(Value::as_array) {
        for stream in streams {
            match stream.get("codec_type").and_then(Value::as_str) {
                Some("audio") if snapshot.audio.is_none() => {
                    snapshot.audio = Some(player_stream_technical(stream));
                }
                Some("video") if snapshot.video.is_none() => {
                    snapshot.video = Some(player_stream_technical(stream));
                }
                _ => {}
            }
        }
    }
    Some(snapshot)
}

#[derive(Serialize)]
struct PlayerPlaylistQueueItem {
    job_id: Option<i64>,
    position: i64,
    title: String,
    creator: String,
    thumbnail: String,
    status: String,
    playable: bool,
}

#[derive(Serialize)]
struct PlayerPlaylistQueueSnapshot {
    batch_id: i64,
    title: String,
    items: Vec<PlayerPlaylistQueueItem>,
}

fn spotify_disabled_error() -> String {
    format!("{SPOTIFY_DISABLED_CODE}: {SPOTIFY_DISABLED_MESSAGE}")
}

fn reject_spotify_source(value: &str) -> Result<(), String> {
    if is_spotify_url(value) {
        Err(spotify_disabled_error())
    } else {
        Ok(())
    }
}

fn validate_media_url(value: &str) -> Result<String, String> {
    reject_spotify_source(value)?;
    parse_public_http_url(value, "El enlace multimedia no es válido")
        .map(|parsed| parsed.to_string())
}

fn is_spotify_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.to_ascii_lowercase().starts_with("spotify:") {
        return true;
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "spotify.com"
        || host.ends_with(".spotify.com")
        || host == "scdn.co"
        || host.ends_with(".scdn.co")
}

fn job_uses_disabled_spotify(connection: &Connection, job_id: i64) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM jobs j
                LEFT JOIN media_jobs mj ON mj.job_id=j.id
                LEFT JOIN download_jobs dj ON dj.job_id=j.id
                LEFT JOIN playlist_items pi ON pi.job_id=j.id
                WHERE j.id=?1 AND (
                    lower(COALESCE(mj.provider_id,''))='spotdl'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.download_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(dj.url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.provider_id,''))='spotdl'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify.com%'
                )
            )",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
}

fn playlist_batch_uses_disabled_spotify(
    connection: &Connection,
    batch_id: i64,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM playlist_items pi
                LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id
                WHERE pi.batch_id=?1 AND (
                    lower(COALESCE(pi.provider_id,''))='spotdl'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.provider_id,''))='spotdl'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify.com%'
                )
            )",
            params![batch_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
}

fn disable_legacy_spotify_jobs(connection: &Connection) -> Result<(), String> {
    let spotify_jobs = "SELECT j.id FROM jobs j LEFT JOIN media_jobs mj ON mj.job_id=j.id LEFT JOIN download_jobs dj ON dj.job_id=j.id LEFT JOIN playlist_items pi ON pi.job_id=j.id WHERE lower(COALESCE(mj.provider_id,''))='spotdl' OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify:%' OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify.com%' OR lower(COALESCE(mj.download_url,'')) LIKE '%spotify.com%' OR lower(COALESCE(dj.url,'')) LIKE '%spotify.com%' OR lower(COALESCE(pi.provider_id,''))='spotdl' OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify:%' OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify.com%'";
    connection
        .execute(
            &format!(
                "UPDATE jobs SET status='cancelled',detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id IN ({spotify_jobs}) AND status IN ('queued','running','paused')"
            ),
            params![SPOTIFY_DISABLED_MESSAGE],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            &format!(
                "UPDATE media_jobs SET resolution_state='spotify_disabled',error=?1,speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id IN ({spotify_jobs}) AND job_id IN (SELECT id FROM jobs WHERE status<>'completed')"
            ),
            params![SPOTIFY_DISABLED_MESSAGE],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            &format!(
                "UPDATE download_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id IN ({spotify_jobs})"
            ),
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            &format!(
                "UPDATE playlist_items SET status='cancelled',resolution_state='spotify_disabled',last_error=?1 WHERE job_id IN ({spotify_jobs}) AND status NOT IN ('completed','cancelled')"
            ),
            params![SPOTIFY_DISABLED_MESSAGE],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            &format!(
                "UPDATE playlist_batches SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT playlist_batch_id FROM media_jobs WHERE job_id IN ({spotify_jobs}) AND playlist_batch_id IS NOT NULL) AND status NOT IN ('completed','completed_with_errors','cancelled')"
            ),
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            &format!(
                "UPDATE download_schedules SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE job_id IN ({spotify_jobs})"
            ),
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn safe_format_selector(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok("bestvideo+bestaudio/best".into());
    }
    if value.len() > 240 || value.chars().any(|character| character.is_control()) {
        return Err("El formato solicitado no es válido".into());
    }
    Ok(value.to_string())
}

fn mode_from_label(value: &str) -> (String, String) {
    let lower = value.to_ascii_lowercase();
    if lower.contains("hi-res flac max") || lower.contains("flac max") {
        ("bestaudio/best".into(), "audio_flac_max".into())
    } else if lower.contains("hi-res flac") || lower.contains("alta resoluci") {
        ("bestaudio/best".into(), "audio_flac_hires".into())
    } else if lower.contains("flac") {
        ("bestaudio/best".into(), "audio_flac".into())
    } else if lower.contains("original")
        || (lower.contains("mejor") && !lower.contains("vídeo") && !lower.contains("video"))
    {
        ("bestaudio/best".into(), "audio_best".into())
    } else if lower.contains("mp3") {
        ("bestaudio/best".into(), "audio_mp3".into())
    } else if lower.contains("m4a") {
        (
            "bestaudio[ext=m4a]/bestaudio/best".into(),
            "audio_m4a".into(),
        )
    } else if lower.contains("webm") {
        ("bestvideo+bestaudio/best".into(), "video_webm".into())
    } else {
        let height = [2160, 1440, 1080, 720, 480, 360, 240, 144]
            .into_iter()
            .find(|height| lower.contains(&height.to_string()));
        let selector = height
            .map(|height| {
                format!("bestvideo[height<={height}]+bestaudio/best[height<={height}]/best[height<={height}]")
            })
            .unwrap_or_else(|| "bestvideo+bestaudio/best".into());
        (selector, "video_mp4".into())
    }
}

fn spotdl_mode_from_label(value: &str) -> (String, String) {
    let lower = value.to_ascii_lowercase();
    if lower.contains("mp3 v0") || lower.contains("mp3_v0") {
        ("mp3".into(), "audio_mp3_v0".into())
    } else if lower.contains("mp3") {
        ("mp3".into(), "audio_mp3".into())
    } else if lower.contains("opus") {
        ("opus".into(), "audio_opus".into())
    } else if lower.contains("m4a") {
        ("m4a".into(), "audio_m4a".into())
    } else {
        ("native".into(), "audio_best".into())
    }
}

fn enable_available_js_runtime(command: &mut Command) {
    if let Some(runtime) = available_deno_runtime().or_else(available_node_runtime) {
        command.arg("--js-runtimes").arg(runtime);
    }
    // Current YouTube extractors may need the signed EJS challenge component.
    // This flag does not read or persist browser data.
    command.args(["--remote-components", "ejs:github"]);
}

fn available_deno_runtime() -> Option<String> {
    let candidate = resolve_tool(None, ToolId::Deno).path?;
    if candidate.components().count() == 1 {
        Some("deno".to_string())
    } else {
        Some(format!("deno:{}", candidate.display()))
    }
}

fn available_node_runtime() -> Option<String> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"));
    }
    if cfg!(debug_assertions) {
        if let Some(path_var) = std::env::var_os("PATH") {
            let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
            if let Some(path) = std::env::split_paths(&path_var).find_map(|directory| {
                let candidate = directory.join(binary_name);
                (candidate.is_absolute() && candidate.is_file()).then_some(candidate)
            }) {
                candidates.push(path);
            }
        }
    }
    candidates.into_iter().find_map(|candidate| {
        let mut probe = background_command(&candidate);
        let available = probe
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !available {
            return None;
        }
        if candidate.components().count() == 1 {
            Some("node".to_string())
        } else {
            Some(format!("node:{}", candidate.display()))
        }
    })
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = background_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = background_command("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn cleanup_managed_paths_when_idle(
    id: i64,
    active_downloads: Arc<Mutex<HashSet<i64>>>,
    active_external_processes: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    managed_root: PathBuf,
    paths: Vec<(PathBuf, bool)>,
) {
    thread::spawn(move || {
        let mut safe_to_delete = false;
        for _ in 0..200 {
            let direct_busy = active_downloads
                .lock()
                .map(|active| active.contains(&id))
                .unwrap_or(true);
            let external_busy = active_external_processes
                .lock()
                .map(|active| active.contains_key(&id))
                .unwrap_or(true);
            let supervised_busy = external_processes_active(&external_processes, id);
            if !direct_busy && !external_busy && !supervised_busy {
                safe_to_delete = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !safe_to_delete {
            return;
        }
        for (path, is_directory) in paths {
            let _ = remove_managed_storage_path(&managed_root, &path, is_directory);
        }
    });
}

struct ActiveMediaGuard {
    id: i64,
    active: Arc<Mutex<HashMap<i64, u32>>>,
}

impl Drop for ActiveMediaGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.id);
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistSelectionInput {
    source_id: String,
    source_url: String,
    #[serde(default)]
    metadata_url: String,
    #[serde(default)]
    spotify_url: String,
    #[serde(default)]
    selected_source_url: String,
    #[serde(default)]
    resolution_state: String,
    #[serde(default)]
    match_score: f64,
    #[serde(default)]
    provider_id: String,
    title: String,
    creator: String,
    thumbnail: String,
    duration_label: String,
    expected_duration_seconds: Option<f64>,
    #[serde(default)]
    isrc: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    album_artist: String,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    track_number: Option<u32>,
    #[serde(default)]
    disc_number: Option<u32>,
    #[serde(default)]
    explicit: bool,
}

#[derive(Serialize)]
struct PlaylistQueueReceipt {
    batch_id: i64,
    item_count: usize,
    sequential: bool,
}

fn playlist_destination_dir(downloads_dir: &Path, playlist_title: &str) -> PathBuf {
    downloads_dir.join(sanitize_filename(playlist_title.trim()))
}

#[derive(Serialize)]
struct PlaylistRuntimeItem {
    item_id: i64,
    job_id: i64,
    source_id: String,
    source_url: String,
    position: i64,
    title: String,
    creator: String,
    thumbnail: String,
    duration_label: String,
    status: String,
    progress: f64,
    detail: String,
    error: String,
}

#[derive(Serialize)]
struct PlaylistRuntimeSnapshot {
    batch_id: i64,
    title: String,
    format: String,
    status: String,
    total: i64,
    completed: i64,
    failed: i64,
    last_error: Option<String>,
    failed_item: Option<PlaylistRuntimeItem>,
    current: Option<PlaylistRuntimeItem>,
    next: Option<PlaylistRuntimeItem>,
    upcoming: Vec<PlaylistRuntimeItem>,
}

fn playlist_runtime_item_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PlaylistRuntimeItem> {
    Ok(PlaylistRuntimeItem {
        item_id: row.get(0)?,
        job_id: row.get(1)?,
        source_id: row.get(2)?,
        source_url: row.get(3)?,
        position: row.get(4)?,
        title: row.get(5)?,
        creator: row.get(6)?,
        thumbnail: row.get(7)?,
        duration_label: row.get(8)?,
        status: row.get(9)?,
        progress: row.get(10)?,
        detail: crate::media::sanitize_media_error_for_display(&row.get::<_, String>(11)?),
        error: crate::media::sanitize_media_error_for_display(&row.get::<_, String>(12)?),
    })
}

fn read_playlist_runtime_item(
    connection: &Connection,
    sql: &str,
    batch_id: i64,
) -> Result<Option<PlaylistRuntimeItem>, String> {
    connection
        .query_row(sql, params![batch_id], playlist_runtime_item_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn read_playlist_runtime_items(
    connection: &Connection,
    sql: &str,
    batch_id: i64,
) -> Result<Vec<PlaylistRuntimeItem>, String> {
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![batch_id], playlist_runtime_item_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistAlternativeInput {
    job_id: i64,
    source_url: String,
    title: String,
    creator: Option<String>,
    thumbnail: Option<String>,
    duration_label: Option<String>,
    expected_duration_seconds: Option<f64>,
}

#[derive(Clone, Serialize)]
struct DownloadScheduleSnapshot {
    id: i64,
    job_id: Option<i64>,
    action: String,
    run_at: String,
    repeat_daily: bool,
    enabled: bool,
    last_run_at: Option<String>,
}

fn validate_schedule_action(action: &str) -> Result<&str, String> {
    match action {
        "resume" | "pause" | "cancel" => Ok(action),
        _ => Err("La acción programada no es válida".into()),
    }
}

fn normalize_schedule_time(value: &str) -> Result<String, String> {
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

fn read_schedule(connection: &Connection, id: i64) -> Result<DownloadScheduleSnapshot, String> {
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
struct SchedulerRuntime {
    active_downloads: Arc<Mutex<HashSet<i64>>>,
    active_media_pids: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    media_runtime: Option<MediaRuntimePaths>,
    aria2_path: Option<PathBuf>,
    managed_root: PathBuf,
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
            if job_uses_disabled_spotify(&connection, job_id)? {
                connection
                    .execute(
                        "UPDATE download_schedules SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                        params![job_id],
                    )
                    .map_err(|error| error.to_string())?;
                return Err(spotify_disabled_error());
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

fn run_download_scheduler(db_path: PathBuf, runtime: SchedulerRuntime) {
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

pub fn run_native_messaging_host() {
    app::bootstrap::run_native_messaging_host();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::bootstrap::run();
}

fn start_media_e2e_acceptance(app: AppHandle) {
    if !(cfg!(debug_assertions)
        && std::env::var("CACATOOLS_MEDIA_E2E_ACCEPTANCE")
            .map(|value| value.trim() == "1")
            .unwrap_or(false))
    {
        return;
    }
    let urls = std::env::var("CACATOOLS_MEDIA_E2E_URLS")
        .unwrap_or_default()
        .split('|')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let report_path = std::env::var("CACATOOLS_MEDIA_E2E_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("cacatools-media-e2e.json"));
    if urls.len() < 2 {
        let _ = fs::write(
            report_path,
            br#"{"status":"FAIL","reason":"Se requieren dos fixtures multimedia"}"#,
        );
        return;
    }
    let durations = std::env::var("CACATOOLS_MEDIA_E2E_DURATIONS")
        .unwrap_or_default()
        .split('|')
        .map(|value| value.trim().parse::<f64>().ok())
        .collect::<Vec<_>>();
    let items = urls
        .iter()
        .enumerate()
        .map(|(index, url)| PlaylistSelectionInput {
            source_id: format!("fixture-{}", index + 1),
            source_url: url.clone(),
            metadata_url: String::new(),
            spotify_url: String::new(),
            selected_source_url: url.clone(),
            resolution_state: "ready".into(),
            match_score: 1.0,
            provider_id: "fixture".into(),
            title: format!("Media E2E {}", index + 1),
            creator: "CacaTools fixture".into(),
            thumbnail: String::new(),
            duration_label: durations
                .get(index)
                .and_then(|value| *value)
                .map(|value| format!("{value:.0}s"))
                .unwrap_or_else(|| "2s".into()),
            expected_duration_seconds: durations.get(index).and_then(|value| *value),
            isrc: String::new(),
            album: String::new(),
            album_artist: String::new(),
            release_date: String::new(),
            track_number: None,
            disc_number: None,
            explicit: false,
        })
        .collect::<Vec<_>>();
    let expected_item_count = items.len();
    let app_for_state = app.clone();
    let state = app_for_state.state::<LocalState>();
    let db_path = state.db_path.clone();
    let receipt = crate::media::queue_playlist_selection(
        "Media E2E playlist".into(),
        items,
        "MP3 320 kbps".into(),
        app,
        state,
    );
    let batch_id = match receipt {
        Ok(receipt) => receipt.batch_id,
        Err(error) => {
            let _ = fs::write(
                report_path,
                serde_json::to_vec_pretty(&json!({ "status": "FAIL", "reason": error }))
                    .unwrap_or_default(),
            );
            return;
        }
    };
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut next_item_observed = false;
        let mut ffmpeg_stage_observed = false;
        let mut final_report = json!({
            "status": "FAIL",
            "batchId": batch_id,
            "expectedItemCount": expected_item_count,
            "reason": "Tiempo de espera agotado"
        });
        while Instant::now() < deadline {
            let connection = match Connection::open(&db_path) {
                Ok(connection) => connection,
                Err(error) => {
                    final_report = json!({
                        "status": "RUNNING",
                        "batchId": batch_id,
                        "reason": format!("SQLite ocupado temporalmente: {error}")
                    });
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let batch = connection
                .query_row(
                    "SELECT status,COUNT(*) FROM playlist_batches pb JOIN playlist_items pi ON pi.batch_id=pb.id WHERE pb.id=?1 GROUP BY pb.status",
                    params![batch_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional();
            let (batch_status, item_count) = match batch {
                Ok(Some(snapshot)) => snapshot,
                Ok(None) | Err(_) => {
                    drop(connection);
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let jobs_total = connection
                .query_row(
                    "SELECT COUNT(*) FROM jobs WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1)",
                    params![batch_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0);
            let mut rows = Vec::<Value>::new();
            if let Ok(mut statement) = connection.prepare(
                "SELECT pi.position,pi.status,COALESCE(j.status,''),COALESCE(j.detail,''),COALESCE(mj.resolution_state,''),COALESCE(mj.output_path,''),COALESCE(mj.error,'') FROM playlist_items pi JOIN jobs j ON j.id=pi.job_id JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 ORDER BY pi.position",
            ) {
                if let Ok(mapped) = statement.query_map(params![batch_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                }) {
                    for (position, item_status, job_status, detail, stage, output, error) in
                        mapped.flatten()
                    {
                        if position == 0
                            && item_status == "completed"
                            && rows.iter().any(|row| {
                                row.get("position").and_then(Value::as_i64) == Some(1)
                                    && matches!(
                                        row.get("itemStatus").and_then(Value::as_str),
                                        Some("running" | "completed")
                                    )
                            })
                        {
                            next_item_observed = true;
                        }
                        if matches!(stage.as_str(), "validating" | "finalizing" | "completed")
                            || detail.contains("Validando")
                            || detail.contains("compatibilidad")
                        {
                            ffmpeg_stage_observed = true;
                        }
                        rows.push(json!({
                            "position": position,
                            "itemStatus": item_status,
                            "jobStatus": job_status,
                            "detail": detail,
                            "resolutionState": stage,
                            "outputPath": output,
                            "error": error
                        }));
                    }
                }
            }
            if rows.iter().any(|row| {
                row.get("position").and_then(Value::as_i64) == Some(0)
                    && row.get("itemStatus").and_then(Value::as_str) == Some("completed")
            }) && rows.iter().any(|row| {
                row.get("position").and_then(Value::as_i64) == Some(1)
                    && matches!(
                        row.get("itemStatus").and_then(Value::as_str),
                        Some("running" | "completed")
                    )
            }) {
                next_item_observed = true;
            }
            let terminal = matches!(batch_status.as_str(), "completed" | "completed_with_errors");
            let all_completed = rows.len() == expected_item_count
                && rows.iter().all(|row| {
                    row.get("itemStatus").and_then(Value::as_str) == Some("completed")
                        && row.get("jobStatus").and_then(Value::as_str) == Some("completed")
                        && row
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .is_empty()
                        && row
                            .get("outputPath")
                            .and_then(Value::as_str)
                            .map(|path| {
                                Path::new(path)
                                    .metadata()
                                    .map(|metadata| metadata.len() > 1024)
                                    .unwrap_or(false)
                            })
                            .unwrap_or(false)
                });
            final_report = json!({
                "status": if terminal && batch_status == "completed" && item_count == expected_item_count as i64 && jobs_total == expected_item_count as i64 && all_completed && next_item_observed && ffmpeg_stage_observed { "PASS" } else { "FAIL" },
                "batchId": batch_id,
                "batchStatus": batch_status,
                "itemCount": item_count,
                "jobsTotal": jobs_total,
                "items": rows,
                "nextItemObserved": next_item_observed,
                "ffmpegStageObserved": ffmpeg_stage_observed,
                "outputFilesValid": all_completed,
                "noPhantomRows": rows.len() == expected_item_count && jobs_total == expected_item_count as i64
            });
            if terminal {
                break;
            }
            drop(connection);
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(serialized) = serde_json::to_vec_pretty(&final_report) {
            let _ = fs::write(report_path, serialized);
        }
    });
}

fn run_app() {
    match extension_bridge::claim_primary_app_instance() {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            eprintln!("No se pudo iniciar CacaTools: {error}");
            return;
        }
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    // The source package intentionally ships with the updater disabled until
    // the owner configures a signed release endpoint. Some updater plugin
    // versions abort at startup when loaded without their required public key.
    if update_manager::updater_plugin_is_configured() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder = builder
        .setup(|app| {
            // Windows may create the WebView before the frontend applies the
            // `visible: false` window setting. Hide it at the native boundary
            // for startup launches so no blank window can flash on screen.
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                if is_background_launch() {
                    let _ = window.hide();
                }
            }
            extension_bridge::initialize_app_bridge().map_err(std::io::Error::other)?;
            let data_dir = match environment_path_override("CACATOOLS_DATA_DIR") {
                Some(path) => path,
                None => app.path().app_data_dir()?,
            };
            fs::create_dir_all(&data_dir)?;
            acquire_instance_lock(&data_dir).map_err(std::io::Error::other)?;
            // Fresh installations start quietly with Windows.  The marker is
            // written only after the registry operation succeeds, so this is
            // a one-time default and never overrides a user's later choice in
            // the settings panel.
            #[cfg(windows)]
            {
                let startup_marker = data_dir.join("startup-default-v1");
                if !startup_marker.exists()
                    && extension_bridge::set_startup_enabled(true).is_ok()
                {
                    let _ = fs::write(&startup_marker, b"enabled");
                }
                if extension_bridge::startup_status()
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let _ = extension_bridge::set_startup_enabled(true);
                }
            }
            let default_downloads_dir =
                match environment_path_override("CACATOOLS_DOWNLOADS_DIR") {
                    Some(path) => path,
                    None => app
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| data_dir.join("Downloads"))
                        .join("CacaTools"),
                };
            let db_path = data_dir.join("cacatools.sqlite3");
            let connection = Connection::open(&db_path)?;
            migrate(&connection)?;
            let initial_surface_mode = settings::read_appearance_settings(&connection)
                .ok()
                .flatten()
                .map(|appearance| appearance.surface_mode)
                .unwrap_or_else(|| "solid".into());
            progress::coordinator::initialize(app.handle().clone(), db_path.clone());
            disable_legacy_spotify_jobs(&connection).map_err(std::io::Error::other)?;
            let saved_downloads_dir: Option<String> = connection
                .query_row(
                    "SELECT value FROM settings WHERE key='downloads_dir'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let downloads_dir = saved_downloads_dir
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or(default_downloads_dir);
            fs::create_dir_all(&downloads_dir)?;
            let window_behavior = read_window_behavior_settings(&connection);
            let queued_ids: Vec<i64> = {
                let mut statement = connection
                    .prepare("SELECT job_id FROM download_jobs JOIN jobs ON jobs.id=download_jobs.job_id WHERE jobs.status IN ('queued','running') ORDER BY jobs.id")
                    ?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.flatten().collect::<Vec<i64>>()
            };
            let active_downloads = Arc::new(Mutex::new(HashSet::new()));
            let active_media_pids = Arc::new(Mutex::new(HashMap::new()));
            let external_processes = Arc::new(Mutex::new(HashMap::new()));
            let preparation_operations = Arc::new(Mutex::new(HashMap::new()));
            let media_runtime = discover_media_runtime(app.handle());
            let aria2_path = find_runtime_binary(app.handle(), "aria2c", "CACATOOLS_ARIA2C");
            let download_concurrency = read_download_concurrency_settings(&connection);
            let queued_torrent_ids: Vec<i64> = {
                queued_torrent_jobs_for_recovery(&connection)?
            };
            let queued_media_ids: Vec<i64> = {
                let mut statement = connection
                    .prepare("SELECT media_jobs.job_id FROM media_jobs JOIN jobs ON jobs.id=media_jobs.job_id WHERE jobs.status='queued' AND media_jobs.playlist_batch_id IS NULL AND lower(COALESCE(media_jobs.provider_id,''))<>'spotdl' AND lower(COALESCE(media_jobs.source_url,'')) NOT LIKE '%spotify.com%' AND lower(COALESCE(media_jobs.source_url,'')) NOT LIKE 'spotify:%' ORDER BY jobs.id")
                    ?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.flatten().collect::<Vec<i64>>()
            };
            let queued_playlist_jobs: Vec<i64> = {
                let mut statement = connection
                    .prepare("SELECT MIN(pi.job_id) FROM playlist_items pi JOIN playlist_batches pb ON pb.id=pi.batch_id WHERE pi.status='queued' AND pi.job_id IS NOT NULL AND lower(COALESCE(pi.provider_id,''))<>'spotdl' AND lower(COALESCE(pi.source_url,'')) NOT LIKE '%spotify.com%' AND lower(COALESCE(pi.source_url,'')) NOT LIKE 'spotify:%' GROUP BY pi.batch_id")
                    ?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.flatten().collect::<Vec<i64>>()
            };
            let scheduler_downloads_dir = downloads_dir.clone();
            let dispatcher = DownloadDispatcher::start(
                DispatcherContext {
                    db_path: db_path.clone(),
                    active_downloads: active_downloads.clone(),
                    active_media_pids: active_media_pids.clone(),
                    external_processes: external_processes.clone(),
                    media_runtime: media_runtime.clone(),
                    aria2_path: aria2_path.clone(),
                },
                download_concurrency,
            );
            install_global(dispatcher.clone());
            app.manage(LocalState {
                connection: Mutex::new(connection),
                db_path: db_path.clone(),
                downloads_dir: Mutex::new(downloads_dir),
                window_behavior: Mutex::new(window_behavior),
                active_downloads: active_downloads.clone(),
                active_media_pids: active_media_pids.clone(),
                external_processes: external_processes.clone(),
                preparation_operations,
                media_runtime: media_runtime.clone(),
                aria2_path: aria2_path.clone(),
                dispatcher: dispatcher.clone(),
            });
            subwindows::install_main_window_geometry(app.handle());
            windows::backdrop::apply_to_all(app.handle(), &initial_surface_mode);
            install_tray(app)?;
            for id in queued_ids {
                run_download_worker(db_path.clone(), active_downloads.clone(), id);
            }
            if let Some(path) = aria2_path.clone() {
                for id in queued_torrent_ids {
                    run_torrent_worker(db_path.clone(), path.clone(), active_media_pids.clone(), id);
                }
            }
            if let Some(runtime) = media_runtime.clone() {
                for id in queued_media_ids.into_iter().chain(queued_playlist_jobs) {
                    run_media_worker(
                        db_path.clone(),
                        runtime.clone(),
                        active_media_pids.clone(),
                        external_processes.clone(),
                        id,
                    );
                }
            }
            run_download_scheduler(
                db_path.clone(),
                SchedulerRuntime {
                    active_downloads: active_downloads.clone(),
                    active_media_pids: active_media_pids.clone(),
                    external_processes: external_processes.clone(),
                    media_runtime,
                    aria2_path,
                    managed_root: scheduler_downloads_dir,
                },
            );
            // Keep the initial window lifecycle native. This avoids a WebView
            // race where the frontend can show a background launch before its
            // asynchronous mode query resolves.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(focused) = event {
                        let _ = app_handle.emit(
                            "cacatools-main-focus-changed",
                            serde_json::json!({ "focused": *focused }),
                        );
                    }
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if EXIT_REQUESTED.load(Ordering::SeqCst) {
                            return;
                        }
                        let close_action = app_handle
                            .state::<LocalState>()
                            .window_behavior
                            .lock()
                            .map(|settings| settings.close_action.clone())
                            .unwrap_or_else(|_| default_close_action());
                        api.prevent_close();
                        if close_action == "exit" {
                            request_full_exit(&app_handle);
                        } else if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                });
                if is_background_launch() {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
            if cfg!(debug_assertions)
                && std::env::var("CACATOOLS_SUBWINDOW_ACCEPTANCE")
                    .map(|value| value.trim() == "1")
                    .unwrap_or(false)
            {
                let acceptance_kind = std::env::var("CACATOOLS_SUBWINDOW_ACCEPTANCE_KIND")
                    .unwrap_or_else(|_| "both".into())
                    .trim()
                    .to_ascii_lowercase();
                let media_source = std::env::var("CACATOOLS_SUBWINDOW_ACCEPTANCE_URL")
                    .unwrap_or_default();
                if acceptance_kind != "playlist" {
                    let result = subwindows::open_preparation_window_now(
                        "media".into(),
                        media_source,
                        None,
                        app.handle().clone(),
                    );
                    eprintln!(
                        "CACATOOLS_SUBWINDOW_ACCEPTANCE_RESULT kind=media status={}",
                        if result.is_ok() { "PASS" } else { "FAIL" }
                    );
                }
                if acceptance_kind != "media" {
                    let result = subwindows::open_preparation_window_now(
                        "playlist".into(),
                        String::new(),
                        None,
                        app.handle().clone(),
                    );
                    eprintln!(
                        "CACATOOLS_SUBWINDOW_ACCEPTANCE_RESULT kind=playlist status={}",
                        if result.is_ok() { "PASS" } else { "FAIL" }
                    );
                }
            }
            if cfg!(debug_assertions)
                && std::env::var("CACATOOLS_MEDIA_E2E_ACCEPTANCE")
                    .map(|value| value.trim() == "1")
                    .unwrap_or(false)
            {
                start_media_e2e_acceptance(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::clipboard::read_clipboard_text,
            commands::clipboard::set_file_clipboard,
            commands::clipboard::start_file_drag,
            commands::system::runtime_status,
            commands::downloads::desktop_snapshot,
            commands::downloads::download_activity_snapshot,
            commands::downloads::progress_v2_full_snapshot,
            commands::downloads::progress_engine_status,
            commands::downloads::progress_engine_diagnostics,
            commands::downloads::progress_v2_debug_report,
            commands::downloads::progress_acceptance_config,
            commands::downloads::progress_acceptance_report,
            commands::downloads::desktop_settings,
            commands::downloads::choose_download_directory,
            commands::downloads::open_download_directory,
            commands::downloads::reveal_local_file,
            commands::settings::get_appearance_settings,
            commands::settings::save_appearance_settings,
            commands::downloads::queue_http_download,
            commands::torrents::choose_torrent_file,
            commands::torrents::queue_torrent_download,
            commands::downloads::set_job_status,
            commands::downloads::set_download_priority,
            commands::downloads::job_storage_preview,
            commands::downloads::rename_completed_download,
            commands::downloads::emergency_stop_job,
            commands::downloads::cancel_download_job,
            commands::downloads::delete_download_job,
            commands::downloads::delete_playlist_batch,
            commands::downloads::choose_local_file,
            commands::downloads::open_local_file,
            commands::downloads::record_recent_file,
            commands::downloads::open_external_url,
            commands::downloads::choose_file_metadata,
            commands::downloads::clear_recent_files,
            commands::downloads::clear_finished_jobs,
            commands::downloads::inspect_download_url,
            commands::downloads::discover_page_downloads,
            commands::downloads::accept_browser_download_capture,
            commands::media::analyze_media_url,
            commands::media::analyze_media_url_with_session,
            commands::media::analyze_media_url_with_session_for_window,
            commands::media::choose_media_cookies_file,
            commands::media::media_session_settings,
            commands::media::save_media_session_settings,
            commands::media::resolve_spotify_source,
            commands::media::search_video_suggestions,
            commands::media::search_video_suggestions_page,
            commands::media::search_media_by_title,
            commands::media::search_media_by_title_page,
            commands::media::recover_media_source,
            commands::media::media_runtime_status,
            commands::media::player_media_snapshot,
            commands::media::player_playlist_queue_snapshot,
            commands::media::player_online_preview_snapshot,
            commands::media::resolve_online_embed,
            commands::media::open_media_player,
            commands::media::open_playlist_media_player,
            commands::media::open_online_media_player,
            commands::media::player_resize_for_media,
            commands::media::player_start_dragging,
            commands::media::player_window_action,
            commands::media::queue_media_download,
            commands::media::queue_media_download_named,
            commands::media::queue_media_download_secure,
            commands::media::queue_spotify_download,
            commands::media::queue_playlist_selection,
            commands::media::set_playlist_batch_paused,
            commands::media::retry_failed_playlist_items,
            commands::media::playlist_runtime_snapshot,
            commands::media::replace_playlist_item_with_alternative,
            commands::subwindows::open_preparation_window,
            commands::subwindows::preparation_modal_state,
            commands::subwindows::show_preparation_window,
            commands::subwindows::preparation_window_action,
            commands::subwindows::preparation_window_start_dragging,
            commands::downloads::create_download_schedule,
            commands::downloads::list_download_schedules,
            commands::downloads::delete_download_schedule,
            commands::tools::get_tool_update_status,
            commands::tools::check_tool_updates_now,
            commands::tools::apply_available_tool_update,
            update_manager::updater_configuration_status,
            update_manager::check_for_app_update,
            update_manager::install_app_update,
            update_manager::notify_app_update,
            commands::news::fetch_remote_news_feed,
            commands::news::fetch_release_metadata,
            commands::system::show_main_window,
            commands::system::wake_main_window,
            commands::system::hide_main_window,
            commands::settings::window_behavior_settings,
            commands::settings::save_window_behavior_settings,
            commands::settings::get_experience_settings,
            commands::settings::save_experience_settings,
            commands::settings::get_bandwidth_settings,
            commands::settings::save_bandwidth_settings,
            commands::settings::set_download_speed_limit,
            commands::settings::set_playlist_speed_limit,
            commands::settings::save_download_concurrency,
            commands::settings::spotify_auth_status,
            commands::settings::spotify_login,
            commands::settings::spotify_logout,
            commands::system::exit_application,
            commands::system::is_background_launch,
            commands::system::startup_status,
            commands::system::set_startup_behavior,
            commands::system::repair_windows_integration,
            commands::system::set_application_icon,
            extension_bridge::extension_bridge_status,
            extension_bridge::publish_extension_state,
            extension_bridge::drain_extension_bridge_requests
        ]);
    let application = builder
        .build(tauri::generate_context!())
        .expect("error while building CacaTools Download Manager");
    application.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // This also covers Windows shutdown and native close events, not
            // only the explicit exit_application command.
            prepare_full_exit(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn snapshot_extension_uses_media_output_mode() {
        assert_eq!(
            snapshot_extension(Some("video_mp4"), "C:/Downloads/media"),
            "mp4"
        );
        assert_eq!(
            snapshot_extension(Some("audio_mp3"), "C:/Downloads/media"),
            "mp3"
        );
        assert_eq!(
            snapshot_extension(Some("audio_m4a"), "C:/Downloads/media"),
            "m4a"
        );
    }

    #[test]
    fn snapshot_extension_uses_final_filename_without_url_tokens() {
        assert_eq!(snapshot_extension(None, r"C:\Downloads\foto.JPG"), "jpg");
        assert_eq!(
            snapshot_extension(None, "https://www.youtube.com/watch?v=abc"),
            ""
        );
    }

    #[test]
    fn generic_tiktok_embed_without_stream_is_not_accepted_as_media() {
        let fake_embed = serde_json::json!({
            "_type": "playlist",
            "title": "TikTok Embed",
            "entries": [{"title": "TikTok Embed (1)", "url": false}]
        });
        assert!(!json_exposes_reproducible_stream(&fake_embed));
    }

    #[test]
    fn media_metadata_with_public_stream_is_accepted() {
        let metadata = serde_json::json!({
            "formats": [{"url": "https://cdn.example.test/video.mp4"}]
        });
        assert!(json_exposes_reproducible_stream(&metadata));
    }

    #[test]
    fn progress_persistence_gate_batches_small_updates_but_keeps_first_and_meaningful_changes() {
        let mut gate = ProgressPersistenceGate::new();
        assert!(gate.should_persist(1, 0.0, Duration::ZERO));
        gate.mark_persisted(1, 0.0);
        assert!(!gate.should_persist(100, 0.1, Duration::ZERO));
        assert!(gate.should_persist(256 * 1024 + 1, 0.1, Duration::ZERO));
        assert!(gate.should_persist(100, 0.6, Duration::ZERO));
    }

    #[test]
    fn sqlite_worker_connections_use_a_short_busy_timeout() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        configure_connection(&connection).expect("busy timeout");
        let timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout value");
        assert_eq!(timeout, SQLITE_BUSY_TIMEOUT_MS as i64);
    }

    #[test]
    fn video_selection_size_sums_separate_video_and_audio_streams() {
        let formats = serde_json::json!([
            {
                "format_id": "v1080",
                "height": 1080,
                "vcodec": "avc1",
                "acodec": "none",
                "filesize": 1000,
                "tbr": 4000
            },
            {
                "format_id": "a1",
                "vcodec": "none",
                "acodec": "mp4a",
                "filesize": 250,
                "abr": 128
            }
        ]);
        let entries = formats.as_array().expect("formats");
        let size = video_selection_size(entries, 1080).expect("size");
        assert_eq!(size.bytes, 1250);
        assert!(!size.estimated);
    }

    #[test]
    fn spotify_premium_restriction_is_classified_without_affecting_other_errors() {
        let restricted = spotify_restricted_api_error(
            StatusCode::FORBIDDEN,
            "Active premium subscription required for the owner of the app.",
        )
        .expect("Spotify Premium restriction");
        assert!(restricted.starts_with("spotify_authenticated_restricted:"));
        assert!(restricted.contains("suscripción Premium"));
        assert!(spotify_restricted_api_error(
            StatusCode::UNAUTHORIZED,
            "active premium subscription required"
        )
        .is_none());
        assert!(spotify_restricted_api_error(StatusCode::FORBIDDEN, "access denied").is_none());
    }

    #[test]
    fn newer_search_requests_cancel_older_processes() {
        let first = begin_search_request();
        assert!(!search_request_is_cancelled(first));
        let second = begin_search_request();
        assert!(search_request_is_cancelled(first));
        assert!(!search_request_is_cancelled(second));
    }

    #[test]
    fn closing_window_operation_is_immediate_idempotent_and_blocks_late_work() {
        let registry: WindowOperationRegistry = Arc::new(Mutex::new(HashMap::new()));
        let first = begin_window_operation(&registry, "media-prep");
        invalidate_window_operation(&registry, "media-prep");
        invalidate_window_operation(&registry, "media-prep");

        assert!(window_operation_is_cancelled(&first));
        let tombstone = current_window_operation(&registry, "media-prep").expect("closed owner");
        assert!(Arc::ptr_eq(&first, &tombstone));

        let second = begin_window_operation(&registry, "media-prep");
        assert!(second.generation > first.generation);
        assert!(!window_operation_is_cancelled(&second));
    }

    #[test]
    fn window_operation_owners_are_isolated_between_windows() {
        let registry: WindowOperationRegistry = Arc::new(Mutex::new(HashMap::new()));
        let media = begin_window_operation(&registry, "media-prep");
        let player = begin_window_operation(&registry, "player");
        invalidate_window_operation(&registry, "media-prep");

        assert!(window_operation_is_cancelled(&media));
        assert!(!window_operation_is_cancelled(&player));
        assert!(Arc::ptr_eq(
            &player,
            &current_window_operation(&registry, "player").expect("player owner")
        ));
    }

    #[test]
    fn video_selection_selector_matches_the_streams_used_for_size() {
        let formats = serde_json::json!([
            {
                "format_id": "v1080",
                "height": 1080,
                "vcodec": "avc1",
                "acodec": "none",
                "filesize": 1000,
                "tbr": 4000
            },
            {
                "format_id": "a1",
                "vcodec": "none",
                "acodec": "mp4a",
                "filesize": 250,
                "abr": 128
            }
        ]);
        let entries = formats.as_array().expect("formats");
        assert_eq!(
            video_selection_selector(entries, 1080).as_deref(),
            Some("v1080+a1/best[height<=1080]/best[height<=1080]")
        );
    }

    #[test]
    fn video_selection_size_marks_approximate_streams() {
        let formats = serde_json::json!([
            {
                "format_id": "v720",
                "height": 720,
                "vcodec": "avc1",
                "acodec": "none",
                "filesize_approx": 800,
                "tbr": 2500
            },
            {
                "format_id": "a1",
                "vcodec": "none",
                "acodec": "mp4a",
                "filesize": 200,
                "abr": 128
            }
        ]);
        let entries = formats.as_array().expect("formats");
        let size = video_selection_size(entries, 720).expect("size");
        assert_eq!(size.bytes, 1000);
        assert!(size.estimated);
    }

    #[test]
    fn video_selection_size_stays_on_the_selected_quality_cap() {
        let formats = serde_json::json!([
            {"format_id":"v144","height":144,"vcodec":"avc1","acodec":"none","filesize":1000},
            {"format_id":"v360","height":360,"vcodec":"avc1","acodec":"none","filesize":2000},
            {"format_id":"v480","height":480,"vcodec":"avc1","acodec":"none","filesize":3000},
            {"format_id":"v720","height":720,"vcodec":"avc1","acodec":"none","filesize":4000},
            {"format_id":"v1080","height":1080,"vcodec":"avc1","acodec":"none","filesize":5000},
            {"format_id":"a1","vcodec":"none","acodec":"mp4a","filesize":600}
        ]);
        let entries = formats.as_array().expect("formats");
        for (height, expected_bytes) in [
            (144, 1600),
            (360, 2600),
            (480, 3600),
            (720, 4600),
            (1080, 5600),
        ] {
            let size = video_selection_size(entries, height).expect("selected size");
            assert_eq!(
                size.bytes, expected_bytes,
                "estimate exceeded {height}p cap"
            );
            assert_eq!(
                video_selection_selector(entries, height)
                    .unwrap()
                    .split('+')
                    .next(),
                Some(format!("v{height}").as_str())
            );
        }
    }

    #[test]
    fn preview_quality_notice_only_flags_extreme_quality_gaps() {
        assert!(player_preview_quality_limited(Some(360), Some(1080)));
        assert!(player_preview_quality_limited(Some(480), Some(2160)));
        assert!(!player_preview_quality_limited(Some(720), Some(2160)));
        assert!(!player_preview_quality_limited(Some(480), Some(720)));
        assert!(!player_preview_quality_limited(None, Some(2160)));
    }

    #[test]
    fn preview_progressive_selector_uses_the_best_compatible_progressive_format() {
        let value = serde_json::json!({
            "formats": [
                {
                    "url": "https://cdn.example.test/video-360.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.42001E",
                    "acodec": "mp4a.40.2",
                    "width": 640,
                    "height": 360,
                    "tbr": 500.0
                },
                {
                    "url": "https://cdn.example.test/video-720.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.4d401f",
                    "acodec": "mp4a.40.2",
                    "width": 1280,
                    "height": 720,
                    "tbr": 1800.0
                },
                {
                    "url": "https://cdn.example.test/video-only.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.640028",
                    "acodec": "none",
                    "height": 1080,
                    "tbr": 4000.0
                }
            ]
        });
        let entry = player_preview_progressive_entry(&value).expect("progressive format");
        assert_eq!(
            first_string(entry, &["url"]),
            "https://cdn.example.test/video-720.mp4"
        );
    }

    #[test]
    fn preview_quality_snapshot_exposes_all_video_heights_and_audio_strategy() {
        let value = serde_json::json!({
            "formats": [
                {
                    "format_id": "v1080",
                    "url": "https://cdn.example.test/video-1080.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.640028",
                    "acodec": "none",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30.0
                },
                {
                    "format_id": "v2160",
                    "url": "https://cdn.example.test/video-2160.mp4",
                    "ext": "mp4",
                    "vcodec": "av01.0.12M.08",
                    "acodec": "none",
                    "width": 3840,
                    "height": 2160,
                    "fps": 60.0
                },
                {
                    "format_id": "combined720",
                    "url": "https://cdn.example.test/video-720.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.4d401f",
                    "acodec": "mp4a.40.2",
                    "width": 1280,
                    "height": 720,
                    "fps": 30.0
                }
            ]
        });
        let qualities = player_preview_qualities(&value, "https://cdn.example.test/audio.m4a");
        assert_eq!(qualities.len(), 3);
        assert_eq!(qualities[0].height, Some(2160));
        assert!(!qualities[0].has_audio);
        assert_eq!(qualities[0].audio_url, "https://cdn.example.test/audio.m4a");
        assert!(qualities
            .iter()
            .any(|quality| quality.height == Some(720) && quality.has_audio));
    }

    #[test]
    fn preview_technical_snapshot_uses_selected_combined_stream() {
        let value = serde_json::json!({
            "duration": 120.0,
            "formats": [
                {"vcodec":"avc1","height":1080},
                {"vcodec":"avc1","height":2160}
            ],
            "requested_downloads": [{
                "url": "https://cdn.example.test/video.mp4",
                "ext": "mp4",
                "vcodec": "avc1.64001F",
                "acodec": "mp4a.40.2",
                "tbr": 1800.0,
                "abr": 128.0,
                "asr": 48000,
                "audio_channels": 2,
                "width": 640,
                "height": 360
            }]
        });
        assert_eq!(player_preview_max_height(&value), Some(2160));
        let technical = player_preview_technical(&value);
        assert_eq!(technical.container, "mp4");
        assert_eq!(
            technical.audio.as_ref().map(|audio| audio.channels),
            Some(Some(2))
        );
        assert_eq!(
            technical.video.as_ref().map(|video| video.codec.as_str()),
            Some("avc1.64001F")
        );
    }

    #[test]
    fn preview_snapshot_reads_ytdlp_requested_formats() {
        let value = serde_json::json!({
            "requested_downloads": [
                {
                    "ext": "mp4",
                    "vcodec": "avc1.640028",
                    "acodec": "none"
                }
            ],
            "requested_formats": [
                {
                    "url": "https://cdn.example.test/video-only.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.640028",
                    "acodec": "none",
                    "width": 1920,
                    "height": 1080
                },
                {
                    "url": "https://cdn.example.test/audio.m4a",
                    "ext": "m4a",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2"
                }
            ]
        });
        assert_eq!(
            first_string(player_preview_selected_entry(&value), &["url"]),
            "https://cdn.example.test/video-only.mp4"
        );
        assert_eq!(
            first_string(
                player_preview_audio_entry(&value).expect("audio stream"),
                &["url"]
            ),
            "https://cdn.example.test/audio.m4a"
        );
    }

    #[test]
    fn preview_technical_snapshot_keeps_adaptive_video_and_audio_streams() {
        let value = serde_json::json!({
            "duration": 180.0,
            "requested_downloads": [
                {
                    "url": "https://cdn.example.test/video.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1.640028",
                    "acodec": "none",
                    "tbr": 5200.0,
                    "width": 1920,
                    "height": 1080
                },
                {
                    "url": "https://cdn.example.test/audio.m4a",
                    "ext": "m4a",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "abr": 128.0,
                    "asr": 44100,
                    "audio_channels": 2
                }
            ]
        });
        let video = player_preview_selected_entry(&value);
        let audio = player_preview_audio_entry(&value).expect("audio stream");
        assert_eq!(first_string(video, &["vcodec"]), "avc1.640028");
        assert_eq!(first_string(audio, &["acodec"]), "mp4a.40.2");
        let technical = player_preview_technical(&value);
        assert_eq!(
            technical
                .audio
                .as_ref()
                .and_then(|stream| stream.sample_rate_hz),
            Some(44100)
        );
        assert_eq!(
            technical.video.as_ref().map(|stream| stream.codec.as_str()),
            Some("avc1.640028")
        );
    }

    #[test]
    fn transfer_speed_smoothing_limits_unrealistic_spikes() {
        let previous = 10.0 * 1024.0 * 1024.0;
        let observed = 600.0 * 1024.0 * 1024.0;
        let stabilized = stabilize_reported_speed(previous, observed);
        assert!(stabilized > previous);
        assert!(stabilized < 16.0 * 1024.0 * 1024.0);
    }

    #[test]
    fn transfer_speed_smoothing_decays_when_no_bytes_arrive() {
        let previous = 8.0 * 1024.0 * 1024.0;
        let stabilized = stabilize_reported_speed(previous, 0.0);
        assert!(stabilized > 0.0);
        assert!(stabilized < previous);
    }

    #[test]
    fn validates_window_behavior_settings() {
        assert_eq!(
            WindowBehaviorSettings::default()
                .validate()
                .expect("default"),
            WindowBehaviorSettings {
                close_action: "tray".into(),
                minimize_action: "taskbar".into(),
            }
        );
        assert!(WindowBehaviorSettings {
            close_action: "exit".into(),
            minimize_action: "taskbar".into(),
        }
        .validate()
        .is_ok());
        assert!(WindowBehaviorSettings {
            close_action: "tray".into(),
            minimize_action: "tray".into(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn persists_and_recovers_window_behavior_settings() {
        let connection = Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .expect("settings table");
        assert_eq!(
            read_window_behavior_settings(&connection),
            WindowBehaviorSettings::default()
        );
        let saved = WindowBehaviorSettings {
            close_action: "exit".into(),
            minimize_action: "taskbar".into(),
        };
        connection
            .execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)",
                params![
                    WINDOW_BEHAVIOR_SETTINGS_KEY,
                    serde_json::to_string(&saved).expect("serialize")
                ],
            )
            .expect("insert setting");
        assert_eq!(read_window_behavior_settings(&connection), saved);
    }

    #[test]
    fn accepts_only_absolute_runtime_path_overrides() {
        let absolute = std::env::temp_dir().join("cacatools-path-override");
        assert_eq!(
            absolute_path_override(Some(absolute.clone().into_os_string())),
            Some(absolute)
        );
        assert_eq!(
            absolute_path_override(Some(std::ffi::OsString::from("relative-data"))),
            None
        );
        assert_eq!(absolute_path_override(None), None);
    }

    #[test]
    fn decodes_percent_encoded_download_filenames() {
        let parsed =
            Url::parse("https://example.com/Hollow%20Knight%20Silksong.rar").expect("valid URL");
        assert_eq!(
            filename_from_url(&parsed, None),
            "Hollow Knight Silksong.rar"
        );
    }

    #[test]
    fn restores_extension_for_opaque_browser_download_names() {
        let parsed =
            Url::parse("https://github.com/CacaPlay/CacaTools/releases/download/v1/CacaTools.exe")
                .expect("valid URL");
        assert_eq!(
            filename_from_url(&parsed, Some("3a79f6a9-3989-4a78-a014-f98607515773".into())),
            "CacaTools.exe"
        );
        assert_eq!(
            filename_with_extension_hint("3a79f6a9-3989-4a78-a014-f98607515773", Some("exe")),
            "3a79f6a9-3989-4a78-a014-f98607515773.exe"
        );
        assert_eq!(
            extension_from_mime("application/x-msdownload; charset=binary"),
            Some("exe")
        );
        assert_eq!(
            extension_from_mime("application/x-msdos-program"),
            Some("exe")
        );
    }

    #[test]
    fn recovers_document_extension_from_export_format_query() {
        let pdf = Url::parse(
            "https://doc.example.test/export/opaque-document-id?format=pdf&id=opaque-document-id",
        )
        .expect("valid PDF URL");
        let docx = Url::parse(
            "https://doc.example.test/export/opaque-document-id?format=docx&id=opaque-document-id",
        )
        .expect("valid DOCX URL");

        assert_eq!(extension_from_url_query(&pdf), Some("pdf"));
        assert_eq!(extension_from_url_query(&docx), Some("docx"));
        assert_eq!(filename_from_url(&pdf, None), "opaque-document-id.pdf");
        assert_eq!(filename_from_url(&docx, None), "opaque-document-id.docx");
    }

    #[test]
    fn does_not_replace_an_explicit_filename_extension() {
        let parsed = Url::parse("https://example.com/download?id=42").expect("valid URL");
        assert_eq!(
            filename_from_url(&parsed, Some("manual.pdf".into())),
            "manual.pdf"
        );
    }

    #[test]
    fn canonicalizes_signed_google_docs_exports_without_preserving_the_token() {
        let signed = Url::parse(
            "https://doc-10-5s-docstext.googleusercontent.com/export/token/1WdV4zaid_JC_PAMqAg8M2AlETD9Fn9inpkymZC3I4Js?format=docx&id=1WdV4zaid_JC&token=secret",
        )
        .expect("valid signed URL");
        assert_eq!(
            canonical_google_docs_export_url(&signed)
                .expect("canonical export")
                .as_str(),
            "https://docs.google.com/document/d/1WdV4zaid_JC_PAMqAg8M2AlETD9Fn9inpkymZC3I4Js/export?format=docx"
        );
    }

    #[test]
    fn download_filename_uses_content_disposition_before_redirect_and_mime() {
        let original = Url::parse("https://example.com/token?id=42").expect("original URL");
        let final_url = Url::parse("https://cdn.example.com/files/provisional").expect("final URL");
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                None,
                Some("attachment; filename*=UTF-8''Paquete%20Final.zip"),
                Some("application/octet-stream"),
            ),
            "Paquete Final.zip"
        );
    }

    #[test]
    fn download_filename_uses_final_url_and_mime_for_missing_extensions() {
        let original = Url::parse("https://example.com/download?token=abc").expect("original URL");
        let final_url =
            Url::parse("https://cdn.example.com/releases/CacaTools%20Portable").expect("final URL");
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                None,
                None,
                Some("application/zip; charset=binary"),
            ),
            "CacaTools Portable.zip"
        );
    }

    #[test]
    fn browser_filename_keeps_priority_but_recovers_extension() {
        let original = Url::parse("https://example.com/download").expect("original URL");
        let final_url =
            Url::parse("https://cdn.example.com/archive/release.rar").expect("final URL");
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                Some("chrome-temporary-name"),
                None,
                Some("application/vnd.rar"),
            ),
            "chrome-temporary-name.rar"
        );
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                Some(r"C:\Users\Demo\Downloads\captura-temporal"),
                None,
                Some("application/vnd.rar"),
            ),
            "captura-temporal.rar"
        );
    }

    #[test]
    fn http_filename_preserves_reliable_extension_over_generic_bin() {
        let original = Url::parse("https://example.test/download").expect("original URL");
        let final_exe = Url::parse("https://cdn.example.test/android-studio-quail3-windows.exe")
            .expect("final URL");
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_exe,
                Some("android-studio-quail3-windows.bin"),
                None,
                Some("application/octet-stream"),
            ),
            "android-studio-quail3-windows.exe"
        );
        assert_eq!(
            resolve_extension_download_filename(
                &original,
                &final_exe,
                Some("android-studio-quail3-windows.bin"),
                None,
                None,
                Some("application/octet-stream"),
                None,
            ),
            "android-studio-quail3-windows.exe"
        );
    }

    #[test]
    fn content_disposition_filename_strips_remote_paths() {
        assert_eq!(
            content_disposition_filename(r#"attachment; filename="../../evil.exe""#).as_deref(),
            Some("evil.exe")
        );
        assert_eq!(
            content_disposition_filename("attachment; filename*=UTF-8''..%2F..%2Fevil%2Eexe")
                .as_deref(),
            Some("evil.exe")
        );
    }

    #[test]
    fn http_filename_authority_matrix() {
        let app = Url::parse("https://example.test/app.exe").expect("app URL");
        assert_eq!(
            resolve_download_filename(&app, &app, None, None, Some("application/octet-stream"),),
            "app.exe"
        );

        let download = Url::parse("https://example.test/download").expect("download URL");
        let setup = resolve_download_filename(
            &download,
            &download,
            None,
            Some(r#"attachment; filename="setup.exe""#),
            Some("application/octet-stream"),
        );
        assert_eq!(setup, "setup.exe");

        assert_eq!(
            resolve_download_filename(
                &download,
                &download,
                None,
                None,
                Some("application/octet-stream")
            ),
            "descarga.bin"
        );

        let binary_path = Url::parse("https://example.test/download.bin").expect("binary URL");
        assert_eq!(
            resolve_download_filename(
                &binary_path,
                &binary_path,
                None,
                Some("attachment; filename=document.pdf"),
                Some("application/octet-stream"),
            ),
            "document.pdf"
        );

        let installer = Url::parse("https://example.test/installer.msi").expect("installer URL");
        assert_eq!(
            resolve_download_filename(&installer, &installer, None, None, None),
            "installer.msi"
        );

        assert_eq!(
            resolve_download_filename(
                &binary_path,
                &binary_path,
                None,
                None,
                Some("application/x-msdownload"),
            ),
            "descarga.exe"
        );

        let signed_release = Url::parse(
            "https://release-assets.githubusercontent.com/opaque?response-content-disposition=attachment%3B+filename%3DCacaTools.Download.Manager_0.23.4_x64-setup.exe&rsct=application%2Foctet-stream",
        )
        .expect("signed release URL");
        assert_eq!(
            resolve_download_filename(
                &signed_release,
                &signed_release,
                Some("descarga.bin"),
                None,
                Some("application/octet-stream"),
            ),
            "CacaTools.Download.Manager_0.23.4_x64-setup.exe"
        );
    }

    #[test]
    fn archive_url_extension_beats_misreported_audio_mime() {
        let original = Url::parse("https://example.com/download").expect("original URL");
        let final_url = Url::parse("https://cdn.example.com/MiniOS10-L.rar").expect("final URL");
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                Some("MiniOS10-L"),
                None,
                Some("audio/mpeg"),
            ),
            "MiniOS10-L.rar"
        );
        assert_eq!(
            recent_kind_from_path(Path::new("MiniOS10-L.rar")),
            "archive"
        );
    }

    #[test]
    fn content_disposition_handles_quoted_semicolons_and_rfc5987() {
        assert_eq!(
            content_disposition_filename(r#"attachment; filename="Paquete; Final.zip""#).as_deref(),
            Some("Paquete; Final.zip")
        );
        assert_eq!(
            content_disposition_filename(
                "attachment; filename*=UTF-8'es'Aplicaci%C3%B3n%20Final.exe"
            )
            .as_deref(),
            Some("Aplicación Final.exe")
        );
    }

    #[test]
    fn browser_opaque_name_prefers_informative_url_and_mime() {
        let original =
            Url::parse("https://example.com/get?filename=Herramienta%20Portable.zip").unwrap();
        let final_url =
            Url::parse("https://cdn.example.com/9f7a30b21331a7c9e812dfc532a37abc").unwrap();
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                Some("Unconfirmed 81124.crdownload"),
                None,
                Some("application/zip")
            ),
            "Herramienta Portable.zip"
        );
        assert_eq!(
            resolve_download_filename(
                &original,
                &final_url,
                Some("download (1).zip"),
                None,
                Some("application/zip")
            ),
            "Herramienta Portable.zip"
        );
    }

    #[test]
    fn filename_sanitizer_preserves_extension_and_avoids_windows_devices() {
        let long = format!("{}.zip", "a".repeat(240));
        let sanitized = sanitize_filename(&long);
        assert!(sanitized.ends_with(".zip"));
        assert!(sanitized.chars().count() <= 180);
        assert_eq!(sanitize_filename("CON.zip"), "_CON.zip");
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

    #[test]
    fn deserializes_playlist_alternative_from_frontend_contract() {
        let input: PlaylistAlternativeInput = serde_json::from_value(serde_json::json!({
            "jobId": 73,
            "sourceUrl": "https://example.com/alternative",
            "title": "Alternativa oficial",
            "creator": "Canal",
            "thumbnail": "https://cdn.example.com/thumb.jpg",
            "durationLabel": "3:14",
            "expectedDurationSeconds": 194.0
        }))
        .expect("playlist alternative input");
        assert_eq!(input.job_id, 73);
        assert_eq!(input.source_url, "https://example.com/alternative");
        assert_eq!(input.title, "Alternativa oficial");
        assert_eq!(input.creator.as_deref(), Some("Canal"));
        assert_eq!(input.duration_label.as_deref(), Some("3:14"));
        assert_eq!(input.expected_duration_seconds, Some(194.0));
    }

    #[test]
    fn rejects_unsafe_remote_thumbnail_urls() {
        assert_eq!(
            safe_remote_thumbnail_url("http://example.com/thumb.jpg"),
            ""
        );
        assert_eq!(safe_remote_thumbnail_url("https://127.0.0.1/thumb.jpg"), "");
        assert_eq!(safe_remote_thumbnail_url("https://localhost/thumb.jpg"), "");
        assert_eq!(
            safe_remote_thumbnail_url("https://user:pass@example.com/thumb.jpg"),
            ""
        );
        assert_eq!(
            safe_remote_thumbnail_url("https://cdn.example.com/thumb.jpg#fragment"),
            "https://cdn.example.com/thumb.jpg"
        );
    }

    #[test]
    fn upgrades_spotify_artwork_without_upscaling_other_sources() {
        assert_eq!(
            presentation_thumbnail_url("https://i.scdn.co/image/ab67616d00001e02abcdef"),
            "https://i.scdn.co/image/ab67616d0000b273abcdef"
        );
        assert_eq!(
            presentation_thumbnail_url("https://cdn.example.com/cover-300.jpg"),
            "https://cdn.example.com/cover-300.jpg"
        );
    }

    #[test]
    fn prefers_highest_declared_thumbnail_variant_over_direct_low_resolution() {
        let value = serde_json::json!({
            "thumbnail": "https://cdn.example.com/low.jpg",
            "thumbnails": [
                {"url": "https://cdn.example.com/small.jpg", "width": 160, "height": 90},
                {"url": "https://cdn.example.com/large.jpg", "width": 1280, "height": 720}
            ]
        });
        assert_eq!(thumbnail_from(&value), "https://cdn.example.com/large.jpg");
    }

    #[test]
    fn creates_youtube_thumbnail_fallback_only_for_video_ids() {
        assert_eq!(
            youtube_thumbnail_from_id("aqz-KE-bpKQ"),
            "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg"
        );
        assert_eq!(youtube_thumbnail_from_id("not-a-video-url"), "");
        assert_eq!(
            youtube_thumbnail_for_source("https://www.youtube.com/watch?v=aqz-KE-bpKQ"),
            "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg"
        );
        assert_eq!(
            youtube_thumbnail_for_source("https://youtu.be/aqz-KE-bpKQ?t=4"),
            "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg"
        );
        assert_eq!(
            youtube_thumbnail_for_source("https://open.spotify.com/track/abc"),
            ""
        );
    }

    #[test]
    fn extracts_downloadable_links_from_html_attributes() {
        let html = r#"<html><head><title>  Recursos &amp; archivos  </title></head><body><a href='/files/manual.pdf'>Manual</a><img data-src="https://cdn.example.com/photo.webp"><script src='javascript:bad'></script></body></html>"#;
        assert_eq!(html_page_title(html), "Recursos & archivos");
        assert_eq!(
            html_attribute_values(html, "href"),
            vec!["/files/manual.pdf".to_string()]
        );
        assert_eq!(
            html_attribute_values(html, "data-src"),
            vec!["https://cdn.example.com/photo.webp".to_string()]
        );
    }

    #[test]
    fn scores_files_and_rejects_html_pages() {
        let pdf = Url::parse("https://example.com/files/guide.pdf").expect("pdf URL");
        let download = Url::parse("https://example.com/export?file=report").expect("download URL");
        let page = Url::parse("https://example.com/index.html").expect("page URL");
        assert_eq!(
            page_candidate_score(&pdf, "href").map(|item| item.2),
            Some(96)
        );
        assert_eq!(
            page_candidate_score(&pdf, "src").map(|item| item.2),
            Some(80)
        );
        assert_eq!(
            page_candidate_score(&download, "href").map(|item| item.2),
            Some(72)
        );
        assert_eq!(
            page_candidate_score(&download, "src").map(|item| item.2),
            Some(60)
        );
        assert!(page_candidate_score(&page, "href").is_none());
    }

    #[test]
    fn lowers_confidence_for_embedded_page_assets() {
        let image = Url::parse("https://cdn.example.com/assets/cover.webp").expect("image URL");
        let audio = Url::parse("https://cdn.example.com/media/song.mp3").expect("audio URL");
        let image_link = page_candidate_score(&image, "href").expect("linked image");
        let image_embed = page_candidate_score(&image, "data-src").expect("embedded image");
        let audio_embed = page_candidate_score(&audio, "src").expect("embedded audio");
        assert_eq!(image_link.2, 96);
        assert_eq!(image_embed.2, 74);
        assert_eq!(audio_embed.2, 86);
    }

    #[test]
    fn sanitizes_windows_filename_characters() {
        assert_eq!(
            sanitize_filename(r#"video:<demo>?*.mp4"#),
            "video__demo___.mp4"
        );
        assert_eq!(sanitize_filename("..."), "descarga.bin");
    }

    #[test]
    fn groups_playlist_items_inside_a_named_subfolder() {
        let downloads = Path::new(r"C:\Users\Demo\Downloads\CacaTools");
        assert_eq!(
            playlist_destination_dir(downloads, "  Good Music: 2026  "),
            downloads.join("Good Music_ 2026")
        );
    }

    #[test]
    fn validates_appearance_ranges() {
        let valid = AppearanceSettings {
            theme: "system".into(),
            preset: "caca-green".into(),
            accent: "#00FF2A".into(),
            progress_active: "#00FF2A".into(),
            progress_completed: "#43C98B".into(),
            progress_paused: "#E2A93F".into(),
            progress_error: "#EF6674".into(),
            progress_active_customized: false,
            progress_completed_customized: false,
            icon_color_mode: "accent".into(),
            icon_color: "#BBC7D4".into(),
            tone: 10,
            intensity: 80,
            contrast: 100,
            scale: 100,
            auto_scale: true,
            text_scale: 100,
            density: "normal".into(),
            thumbnail_size: "large".into(),
            motion: true,
            motion_mode: "system".into(),
            surface_mode: "solid".into(),
            radius: "standard".into(),
            revision: 0,
            appearance_revision: 7,
        };
        assert!(valid.clone().validate().is_ok());
        let mut invalid_scale = valid.clone();
        invalid_scale.scale = 118;
        assert!(invalid_scale.validate().is_err());
        let mut invalid_text_scale = valid;
        invalid_text_scale.text_scale = 101;
        assert!(invalid_text_scale.validate().is_err());
    }

    #[test]
    fn rejects_non_http_media_urls() {
        assert!(validate_media_url("file:///C:/secret.txt").is_err());
        assert!(validate_media_url("https://example.com/video").is_ok());
    }

    #[test]
    fn rejects_private_and_credentialed_http_targets() {
        for value in [
            "http://127.0.0.1/private",
            "http://10.0.0.8/file",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/private",
            "http://[::]/private",
            "http://[fc00::1]/private",
            "http://[fe80::1]/private",
            "http://[::ffff:127.0.0.1]/private",
            "https://user:secret@example.com/file",
            "https://device.local/file",
        ] {
            assert!(
                parse_public_http_url(value, "invalid").is_err(),
                "accepted unsafe URL: {value}"
            );
        }
        assert!(parse_public_http_url("https://example.com/file#fragment", "invalid").is_ok());
        assert!(parse_public_http_url("https://[2606:4700:4700::1111]/file", "invalid").is_ok());
    }

    #[test]
    fn validates_magnet_and_torrent_sources() {
        let magnet = "magnet:?XT=URN:BTIH:0123456789ABCDEF0123456789ABCDEF01234567&dn=Linux%20ISO&tr=udp%3A%2F%2Ftracker.example.com%3A6969";
        let (normalized, kind, label) = normalize_torrent_source(magnet).expect("valid magnet");
        assert!(normalized.starts_with("magnet:?"));
        assert_eq!(kind, "magnet");
        assert_eq!(label, "Linux ISO");

        let v2 = "magnet:?xt=urn:btmh:12200123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(normalize_torrent_source(v2).is_ok());
        for invalid in [
            "magnet:?dn=missing-hash",
            "magnet:?xt=urn:btih:too-short",
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&ws=http%3A%2F%2F127.0.0.1%2Fsecret",
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Flocalhost%3A6969",
        ] {
            assert!(
                normalize_torrent_source(invalid).is_err(),
                "accepted unsafe magnet: {invalid}"
            );
        }

        let path = std::env::temp_dir().join(format!(
            "cacatools-torrent-test-{}-{}.torrent",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::write(&path, b"d4:infod4:name4:testee").expect("write torrent fixture");
        let result = normalize_torrent_source(&path.to_string_lossy());
        let _ = fs::remove_file(&path);
        let (_, source_kind, file_label) = result.expect("valid torrent file");
        assert_eq!(source_kind, "file");
        assert!(file_label.starts_with("cacatools-torrent-test"));
    }

    #[test]
    fn creates_and_migrates_database() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        for table in [
            "media_jobs",
            "torrent_jobs",
            "saved_links",
            "playlist_batches",
            "progress_v2_jobs",
            "progress_v2_batches",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get(0),
                )
                .expect("table count");
            assert_eq!(count, 1, "missing table {table}");
        }
        for index in [
            "idx_jobs_status_updated",
            "idx_download_jobs_url",
            "idx_recent_files_opened",
            "idx_playlist_batches_status_updated",
            "idx_playlist_items_batch_status_position",
            "idx_playlist_items_job",
            "idx_media_jobs_playlist_batch",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![index],
                    |row| row.get(0),
                )
                .expect("index count");
            assert_eq!(count, 1, "missing index {index}");
        }
    }

    #[test]
    fn maps_audio_and_video_modes() {
        assert_eq!(mode_from_label("Audio MP3").1, "audio_mp3");
        assert_eq!(mode_from_label("Vídeo 1080p MP4").1, "video_mp4");
        assert!(mode_from_label("Vídeo 1080p MP4").0.contains("1080"));
    }

    #[test]
    fn explicit_low_video_labels_keep_a_height_cap_on_every_fallback() {
        for height in [144, 240, 360, 480, 720, 1080] {
            let (selector, mode) = mode_from_label(&format!("Vídeo {height}p MP4"));
            assert_eq!(mode, "video_mp4");
            assert!(selector.contains(&format!("height<={height}")));
            assert!(!selector.ends_with("/best"));
        }
    }

    #[test]
    fn media_format_fallback_never_escalates_an_explicit_quality() {
        let value = serde_json::json!({
            "formats": [
                {"height": 480, "vcodec": "avc1", "acodec": "none", "ext": "mp4"}
            ]
        });
        let formats = media_formats(&value);
        let video = formats
            .iter()
            .filter(|format| !format.audio_only)
            .collect::<Vec<_>>();
        assert!(!video.is_empty());
        for format in video {
            assert!(
                format.id.contains("height<=480"),
                "unbounded selector: {}",
                format.id
            );
            assert!(!format.id.contains("bestvideo*+bestaudio/best"));
        }
    }

    #[test]
    fn maps_original_best_audio_without_conversion() {
        let (selector, mode) = mode_from_label("Original / mejor audio disponible");
        assert_eq!(selector, "bestaudio/best");
        assert_eq!(mode, "audio_best");
        assert_eq!(output_mode_conversion_state(&mode), Some(false));
        assert_eq!(output_mode_conversion_state("audio_mp3"), Some(true));
    }

    #[test]
    fn media_formats_expose_audio_technical_metadata_without_false_lossless() {
        let value = serde_json::json!({
            "formats": [
                {
                    "format_id": "251",
                    "vcodec": "none",
                    "acodec": "opus",
                    "ext": "webm",
                    "abr": 160.0,
                    "asr": 48000,
                    "audio_channels": 2,
                    "filesize": 2048
                }
            ]
        });
        let formats = media_formats(&value);
        let best = formats
            .iter()
            .find(|format| format.label == "Original / mejor audio disponible")
            .expect("best audio format");
        assert!(best.id.starts_with("251/"));
        assert_eq!(best.audio_codec, "opus");
        assert_eq!(best.bitrate_kbps, Some(160.0));
        assert_eq!(best.sample_rate_hz, Some(48_000));
        assert_eq!(best.channels, Some(2));
        assert_eq!(best.container, "webm");
        assert!(!best.lossless);
    }

    #[test]
    fn parses_spotdl_json_without_confusing_log_brackets() {
        let output = br#"[debug] resolver [youtube] started
{"name":"Cancion","artist":"Artista","song_id":"abc","duration":120.0}
spotDL finished [ok]"#;
        let value = spotdl_json_value(output).expect("structured object");
        assert_eq!(value.get("song_id").and_then(Value::as_str), Some("abc"));
    }

    #[test]
    fn parses_balanced_spotdl_array_with_trailing_logs() {
        let output = br#"INFO [save]
[{"name":"Una","artist":"A","song_id":"1"},{"name":"Dos","artist":"B","song_id":"2"}]
INFO [done]"#;
        let value = spotdl_json_value(output).expect("structured array");
        assert_eq!(value.as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn rejects_malformed_spotdl_json_instead_of_slicing_logs() {
        let error = spotdl_json_value(br#"warning [not-json] {"name":"broken""#)
            .expect_err("malformed metadata");
        assert!(error.contains("JSON estructurados"));
    }

    #[test]
    fn best_spotdl_mode_does_not_select_m4a() {
        let (selector, mode) = spotdl_mode_from_label("Mejor calidad disponible");
        assert_eq!(selector, "native");
        assert_eq!(mode, "audio_best");
    }

    #[test]
    fn keeps_high_resolutions_ahead_of_720p() {
        let value = serde_json::json!({
            "formats": [
                {"format_id":"18","ext":"mp4","vcodec":"avc1","acodec":"mp4a","height":360},
                {"format_id":"22","ext":"mp4","vcodec":"avc1","acodec":"mp4a","height":720},
                {"format_id":"271","ext":"webm","vcodec":"vp9","acodec":"none","height":1440},
                {"format_id":"313","ext":"webm","vcodec":"vp9","acodec":"none","height":2160},
                {"format_id":"251","ext":"webm","vcodec":"none","acodec":"opus","abr":160}
            ]
        });
        let formats = media_formats(&value);
        assert!(formats
            .first()
            .is_some_and(|format| format.label.contains("2160p")));
        assert!(formats
            .first()
            .is_some_and(|format| format.id.contains("313+251")));
        assert!(formats
            .iter()
            .any(|format| format.label.starts_with("1440p")));
        assert!(formats
            .iter()
            .any(|format| format.label.starts_with("720p")));
    }
    #[test]
    fn identifies_recent_file_icons_by_extension() {
        assert_eq!(recent_kind_from_path(Path::new("movie.mp4")), "video");
        assert_eq!(recent_kind_from_path(Path::new("song.mp3")), "audio");
        assert_eq!(recent_kind_from_path(Path::new("budget.xlsx")), "sheet");
        assert_eq!(recent_kind_from_path(Path::new("archive.zip")), "archive");
        assert_eq!(recent_kind_from_path(Path::new("unknown.custom")), "file");
    }

    #[test]
    fn multimedia_progress_accepts_non_utf8_bytes_lossily() {
        let bytes = [b'C', b'A', b'C', b'A', 0xff, b'|', b'5', b'0'];
        let text = String::from_utf8_lossy(&bytes).into_owned();
        assert!(text.starts_with("CACA"));
        assert!(text.ends_with("|50"));
    }

    #[test]
    fn duration_guard_rejects_second_long_results() {
        assert_eq!(minimum_acceptable_duration(Some(180.0)), Some(147.6));
        assert_eq!(minimum_acceptable_duration(Some(4.0)), None);
        assert_eq!(minimum_acceptable_duration(None), None);
    }

    #[test]
    fn locates_playlist_output_even_when_source_mtime_is_old() {
        let directory = std::env::temp_dir().join(format!(
            "cacatools-final-path-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("temp directory");
        let media_path = directory.join("Mitski - My Love Mine All Mine [video123].mp3");
        fs::write(&media_path, vec![1_u8; 4096]).expect("media fixture");
        let future_start = SystemTime::now() + Duration::from_secs(86_400);
        let located = newest_completed_media(
            &directory,
            Some("video123"),
            None,
            "audio_mp3",
            future_start,
        );
        assert_eq!(
            located.and_then(|path| path.canonicalize().ok()),
            media_path.canonicalize().ok()
        );
        fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn parses_real_aria2_progress_readout() {
        let update = parse_aria2_progress_line("[#2089b0 9.5MiB/10MiB(95%) CN:8 DL:2MiB ETA:1s]")
            .expect("aria2 progress");
        assert_eq!(update.downloaded_bytes, 9_961_472);
        assert_eq!(update.total_bytes, 10_485_760);
        assert_eq!(update.speed_bps, 2_097_152.0);
        assert_eq!(update.eta_seconds, Some(1));
    }

    #[test]
    fn ignores_aria2_metadata_readout_without_total() {
        assert!(parse_aria2_progress_line("[#2089b0 0B/0B CN:1 DL:0B]").is_none());
    }

    #[test]
    fn parses_structured_ytdlp_progress_into_sqlite() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status,updated_at) VALUES(1,'Vídeo','Preparando',0,'running',CURRENT_TIMESTAMP)",
                [],
            )
            .expect("job");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(1,'https://example.com/watch?v=1','best','video_mp4','C:/Temp')",
                [],
            )
            .expect("media job");
        let mut tracker = MediaProgressTracker::new("best");
        update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"downloaded_bytes":5242880,"total_bytes":10485760,"speed":2097152,"eta":3,"_percent_str":"50.0%","_speed_str":"2.00MiB/s","_eta_str":"00:03"}"#,
            &mut tracker,
            true,
        );
        let (progress, downloaded, total, estimated, speed):
            (f64, i64, Option<i64>, i64, f64) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.downloaded_bytes,media_jobs.total_bytes,media_jobs.total_bytes_estimated,media_jobs.speed_bps FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("progress row");
        assert!((progress - 50.0).abs() < 0.01);
        assert_eq!(downloaded, 5_242_880);
        assert_eq!(total, Some(10_485_760));
        assert_eq!(estimated, 0);
        assert!((speed - 2_097_152.0).abs() < 0.01);
    }

    #[test]
    fn structured_ytdlp_estimate_remains_explicitly_approximate() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status,updated_at) VALUES(1,'Vídeo','Preparando',0,'running',CURRENT_TIMESTAMP)",
                [],
            )
            .expect("job");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(1,'https://example.com/watch?v=1','best','video_mp4','C:/Temp')",
                [],
            )
            .expect("media job");
        let mut tracker = MediaProgressTracker::new("best");
        update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"downloaded_bytes":5242880,"total_bytes_estimate":10485760,"speed":2097152,"eta":3,"_percent_str":"50.0%","_speed_str":"2.00MiB/s","_eta_str":"00:03"}"#,
            &mut tracker,
            true,
        );
        let (progress, downloaded, total, estimated, speed):
            (f64, i64, Option<i64>, i64, f64) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.downloaded_bytes,media_jobs.total_bytes,media_jobs.total_bytes_estimated,media_jobs.speed_bps FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("progress row");
        assert!((progress - 50.0).abs() < 0.01);
        assert_eq!(downloaded, 5_242_880);
        assert_eq!(total, Some(10_485_760));
        assert_eq!(estimated, 1);
        assert!((speed - 2_097_152.0).abs() < 0.01);
    }

    #[test]
    fn media_progress_throttle_keeps_precision_without_rewriting_sqlite() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status,updated_at) VALUES(1,'Vídeo','Preparando',0,'running',CURRENT_TIMESTAMP)",
                [],
            )
            .expect("job");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(1,'https://example.com/watch?v=1','best','video_mp4','C:/Temp')",
                [],
            )
            .expect("media job");
        let mut tracker = MediaProgressTracker::new("best");
        assert!(update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"downloaded_bytes":1048576,"total_bytes":10485760,"speed":1048576,"eta":9}"#,
            &mut tracker,
            false,
        ));
        let skipped: (f64, i64, Option<i64>) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.downloaded_bytes,media_jobs.total_bytes FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("skipped progress row");
        assert_eq!(skipped, (0.0, 0, None));
        assert_eq!(tracker.last_downloaded_bytes, 1_048_576);

        assert!(update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"downloaded_bytes":2097152,"total_bytes":10485760,"speed":1048576,"eta":8}"#,
            &mut tracker,
            true,
        ));
        let persisted: (f64, i64, Option<i64>) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.downloaded_bytes,media_jobs.total_bytes FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("persisted progress row");
        assert!((persisted.0 - 20.0).abs() < 0.01);
        assert_eq!(persisted.1, 2_097_152);
        assert_eq!(persisted.2, Some(10_485_760));
    }

    #[test]
    fn multimedia_progress_aggregates_separate_video_and_audio_streams() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status,updated_at) VALUES(1,'Vídeo','Preparando',0,'running',CURRENT_TIMESTAMP)",
                [],
            )
            .expect("job");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(1,'https://example.com/watch?v=1','bestvideo+bestaudio','video_mp4','C:/Temp')",
                [],
            )
            .expect("media job");
        let mut tracker = MediaProgressTracker::new("bestvideo+bestaudio");
        update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"tmpfilename":"video.f137.mp4.part","downloaded_bytes":9437184,"total_bytes":9437184,"speed":2097152}"#,
            &mut tracker,
            true,
        );
        let first: (f64, Option<i64>) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.total_bytes FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("first stream");
        assert_eq!(first, (0.0, None));

        update_media_progress(
            &connection,
            1,
            r#"CACATOOLS_PROGRESS:{"tmpfilename":"audio.f140.m4a.part","downloaded_bytes":524288,"total_bytes":1048576,"speed":524288}"#,
            &mut tracker,
            true,
        );
        let aggregate: (f64, i64, Option<i64>, i64) = connection
            .query_row(
                "SELECT jobs.progress,media_jobs.downloaded_bytes,media_jobs.total_bytes,media_jobs.total_bytes_estimated FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("aggregate progress");
        assert!((aggregate.0 - 95.0).abs() < 0.01);
        assert_eq!(aggregate.1, 9_961_472);
        assert_eq!(aggregate.2, Some(10_485_760));
        assert_eq!(aggregate.3, 0);
    }

    #[test]
    fn media_progress_uses_actual_requested_stream_count_and_percent_without_total() {
        let mut tracker = MediaProgressTracker::new("bestvideo+bestaudio/best");
        let progress: Value = serde_json::from_str(
            r#"{"downloaded_bytes":251000000,"speed":2200000,"_percent_str":"41.5%","info_dict":{"requested_downloads":[{"format_id":"18"}]}}"#,
        )
        .expect("progress json");
        let update = tracker.update_from_json(&progress);
        assert_eq!(tracker.expected_streams, 1);
        assert_eq!(update.total_bytes, None);
        assert!(update
            .progress_percent
            .is_some_and(|value| (value - 41.5).abs() < 0.01));
    }

    #[test]
    fn media_progress_uses_reported_percent_across_separate_streams_without_totals() {
        let mut tracker = MediaProgressTracker::new("bestvideo+bestaudio/best");
        let video: Value = serde_json::from_str(
            r#"{"tmpfilename":"video.part","downloaded_bytes":250000000,"_percent_str":"40.0%","info_dict":{"requested_downloads":[{"format_id":"137"},{"format_id":"140"}]}}"#,
        )
        .expect("video progress");
        let video_update = tracker.update_from_json(&video);
        assert_eq!(tracker.expected_streams, 2);
        assert_eq!(video_update.total_bytes, None);
        assert!(video_update
            .progress_percent
            .is_some_and(|value| (value - 20.0).abs() < 0.01));

        let video_done: Value = serde_json::from_str(
            r#"{"tmpfilename":"video.part","downloaded_bytes":500000000,"_percent_str":"100.0%","info_dict":{"requested_downloads":[{"format_id":"137"},{"format_id":"140"}]}}"#,
        )
        .expect("video complete");
        let video_done_update = tracker.update_from_json(&video_done);
        assert!(video_done_update
            .progress_percent
            .is_some_and(|value| (value - 49.7).abs() < 0.01));

        let audio: Value = serde_json::from_str(
            r#"{"tmpfilename":"audio.part","downloaded_bytes":30000000,"_percent_str":"50.0%","info_dict":{"requested_downloads":[{"format_id":"137"},{"format_id":"140"}]}}"#,
        )
        .expect("audio progress");
        let audio_update = tracker.update_from_json(&audio);
        assert!(audio_update
            .progress_percent
            .is_some_and(|value| (value - 74.7).abs() < 0.01));
    }

    #[test]
    fn media_progress_actual_total_replaces_declared_approximation() {
        let mut tracker = MediaProgressTracker::new("best");
        let first: Value = serde_json::from_str(
            r#"{"tmpfilename":"video.part","downloaded_bytes":100,"total_bytes_estimate":1000,"info_dict":{"requested_downloads":[{"filesize_approx":1000}]}}"#,
        )
        .expect("estimated progress");
        let first_update = tracker.update_from_json(&first);
        assert_eq!(first_update.total_bytes, Some(1000));
        assert!(first_update.total_estimated);

        let exact: Value = serde_json::from_str(
            r#"{"tmpfilename":"video.part","downloaded_bytes":200,"total_bytes":600,"info_dict":{"requested_downloads":[{"filesize_approx":1000}]}}"#,
        )
        .expect("exact progress");
        let exact_update = tracker.update_from_json(&exact);
        assert_eq!(exact_update.total_bytes, Some(600));
        assert!(!exact_update.total_estimated);
    }

    #[test]
    fn multimedia_progress_marks_mixed_dash_totals_as_estimated() {
        let mut tracker = MediaProgressTracker::new("bestvideo+bestaudio");
        let video: Value = serde_json::from_str(
            r#"{"tmpfilename":"video.part","downloaded_bytes":400,"total_bytes":1000}"#,
        )
        .expect("video progress");
        let audio: Value = serde_json::from_str(
            r#"{"tmpfilename":"audio.part","downloaded_bytes":50,"total_bytes_estimate":200}"#,
        )
        .expect("estimated audio progress");
        let video_update = tracker.update_from_json(&video);
        assert_eq!(video_update.total_bytes, None);
        let mixed_update = tracker.update_from_json(&audio);
        assert_eq!(mixed_update.total_bytes, Some(1200));
        assert!(mixed_update.total_estimated);
        assert!(mixed_update
            .progress_percent
            .is_some_and(|value| (value - 37.5).abs() < 0.01));
    }

    #[test]
    fn playlist_snapshot_classifies_exact_estimated_unknown_and_final_sizes() {
        let snapshot_for = |second_total: Option<i64>, second_estimated: i64| {
            let connection = Connection::open_in_memory().expect("sqlite in-memory");
            migrate(&connection).expect("migration");
            connection
                .execute(
                    "INSERT INTO playlist_batches(id,title,format,status) VALUES(1,'Lista','video','running')",
                    [],
                )
                .expect("playlist batch");
            for (id, progress, downloaded, total, estimated) in [
                (1_i64, 40.0_f64, 50_i64, Some(100_i64), 0_i64),
                (2_i64, 60.0_f64, 100_i64, second_total, second_estimated),
            ] {
                connection
                    .execute(
                        "INSERT INTO jobs(id,title,detail,progress,status) VALUES(?1,?2,'Descargando',?3,'running')",
                        params![id, format!("Elemento {id}"), progress],
                    )
                    .expect("playlist job");
                connection
                    .execute(
                        "INSERT INTO playlist_items(id,batch_id,source_id,position,status,progress,job_id) VALUES(?1,1,?2,?1,'running',?3,?1)",
                        params![id, format!("source-{id}"), progress],
                    )
                    .expect("playlist item");
                connection
                    .execute(
                        "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir,downloaded_bytes,total_bytes,total_bytes_estimated,playlist_batch_id,playlist_item_id) VALUES(?1,?2,'best','video_mp4','C:/Temp',?3,?4,?5,1,?1)",
                        params![id, format!("https://example.com/{id}"), downloaded, total, estimated],
                    )
                    .expect("playlist media job");
            }
            read_download_activity(&connection, false)
                .expect("download activity")
                .playlist_batches
                .into_iter()
                .next()
                .expect("playlist snapshot")
        };

        let exact = snapshot_for(Some(200), 0);
        assert_eq!(exact.total_bytes, Some(300));
        assert!(!exact.total_bytes_estimated);
        assert!((exact.progress - 50.0).abs() < 0.01);
        assert!(!exact.indeterminate);

        let estimated = snapshot_for(Some(200), 1);
        assert_eq!(estimated.total_bytes, Some(300));
        assert!(estimated.total_bytes_estimated);
        assert!((estimated.progress - 50.0).abs() < 0.01);
        assert!(!estimated.indeterminate);

        let unknown = snapshot_for(None, 0);
        assert_eq!(unknown.total_bytes, None);
        assert!(!unknown.total_bytes_estimated);
        assert!(unknown.progress_estimated);
        assert!(!unknown.indeterminate);
    }

    #[test]
    fn download_activity_keeps_insertion_order_across_status_updates() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        for (id, status, updated_at) in [
            (1_i64, "completed", "2026-01-01 00:00:01"),
            (2_i64, "running", "2026-01-01 00:00:03"),
            (3_i64, "failed", "2026-01-01 00:00:02"),
        ] {
            connection
                .execute(
                    "INSERT INTO jobs(id,title,status,updated_at) VALUES(?1,?2,?3,?4)",
                    params![id, format!("Archivo {id}"), status, updated_at],
                )
                .expect("job");
        }

        let order_for = |connection: &Connection, id: i64| {
            read_download_activity(connection, false)
                .expect("download activity")
                .jobs
                .into_iter()
                .find(|job| job.id == id)
                .map(|job| job.added_order)
        };
        assert_eq!(order_for(&connection, 1), Some(1));
        assert_eq!(order_for(&connection, 2), Some(2));
        assert_eq!(order_for(&connection, 3), Some(3));

        connection
            .execute(
                "UPDATE jobs SET status='failed',updated_at='2026-01-01 00:00:09' WHERE id=1",
                [],
            )
            .expect("status update");
        assert_eq!(order_for(&connection, 1), Some(1));
        assert_eq!(order_for(&connection, 2), Some(2));
        assert_eq!(order_for(&connection, 3), Some(3));
    }

    #[test]
    fn playlist_snapshot_uses_first_child_as_global_insertion_order() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,status) VALUES(1,'Antes','completed'),(2,'Elemento','queued'),(3,'Después','queued')",
                [],
            )
            .expect("jobs");
        connection
            .execute(
                "INSERT INTO playlist_batches(id,title,format,status) VALUES(1,'Lista','video','queued')",
                [],
            )
            .expect("playlist batch");
        connection
            .execute(
                "INSERT INTO playlist_items(id,batch_id,source_id,position,status,job_id) VALUES(1,1,'source',0,'queued',2)",
                [],
            )
            .expect("playlist item");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir,playlist_batch_id,playlist_item_id) VALUES(2,'https://example.com/video','best','video_mp4','C:/Temp',1,1)",
                [],
            )
            .expect("playlist media job");

        let snapshot = read_download_activity(&connection, false).expect("download activity");
        assert!(snapshot.jobs.iter().any(|job| job.id == 1));
        assert!(snapshot.jobs.iter().any(|job| job.id == 3));
        assert_eq!(snapshot.playlist_batches[0].added_order, 2);
    }

    #[test]
    fn snapshot_exposes_final_size_only_after_completion() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        for (id, status, progress, downloaded, total) in [
            (1_i64, "completed", 100.0_f64, 321_i64, 321_i64),
            (2_i64, "running", 50.0_f64, 500_i64, 999_i64),
        ] {
            connection
                .execute(
                    "INSERT INTO jobs(id,title,detail,progress,status) VALUES(?1,?2,'Descargando',?3,?4)",
                    params![id, format!("Archivo {id}"), progress, status],
                )
                .expect("job");
            connection
                .execute(
                    "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir,downloaded_bytes,total_bytes) VALUES(?1,?2,'best','video_mp4','C:/Temp',?3,?4)",
                    params![id, format!("https://example.com/{id}"), downloaded, total],
                )
                .expect("media job");
        }
        let snapshot = read_download_activity(&connection, false).expect("download activity");
        let completed = snapshot
            .jobs
            .iter()
            .find(|job| job.id == 1)
            .expect("completed snapshot");
        let running = snapshot
            .jobs
            .iter()
            .find(|job| job.id == 2)
            .expect("running snapshot");
        assert_eq!(completed.final_size, Some(321));
        assert_eq!(running.final_size, None);
    }

    #[test]
    fn multimedia_processing_stage_preserves_last_real_percentage() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status,updated_at) VALUES(1,'Vídeo','Descargando',72.5,'running',CURRENT_TIMESTAMP)",
                [],
            )
            .expect("job");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(1,'https://example.com/watch?v=1','bestvideo+bestaudio','video_mp4','C:/Temp')",
                [],
            )
            .expect("media job");
        let mut tracker = MediaProgressTracker::new("bestvideo+bestaudio");
        update_media_progress(
            &connection,
            1,
            "[Merger] Merging formats into final.mp4",
            &mut tracker,
            true,
        );
        let (progress, detail, state): (f64, String, String) = connection
            .query_row(
                "SELECT jobs.progress,jobs.detail,media_jobs.resolution_state FROM jobs JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("processing stage");
        assert!((progress - 72.5).abs() < 0.01);
        assert_eq!(detail, "Combinando video y audio…");
        assert_eq!(state, "merging");
    }

    #[test]
    fn detects_html_disguised_as_download() {
        let path = std::env::temp_dir().join(format!(
            "cacatools-html-download-{}.bin",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::write(
            &path,
            b"<!doctype html><html><head></head><body>login</body></html>",
        )
        .expect("html fixture");
        assert!(downloaded_file_looks_like_html(&path));
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn media_similarity_handles_accents_and_punctuation() {
        let close = title_similarity(
            "Canción del corazón (vídeo oficial)",
            "Cancion del corazon - Video Oficial",
        );
        let unrelated = title_similarity("Canción del corazón", "Tutorial de Blender 4.2");
        assert!(close > 0.88, "unexpected close score: {close}");
        assert!(unrelated < 0.18, "unexpected unrelated score: {unrelated}");
    }

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
    fn parses_spotify_urls_and_uris_without_accepting_other_hosts() {
        let (kind, id, canonical) = spotify_source_parts(
            "https://open.spotify.com/intl-es/playlist/37i9dQZF1DX4WYpdgoIcn6?si=demo",
        )
        .expect("spotify playlist");
        assert_eq!(kind, "playlist");
        assert_eq!(id, "37i9dQZF1DX4WYpdgoIcn6");
        assert!(canonical.starts_with("https://open.spotify.com/intl-es/playlist/"));

        let (kind, id, canonical) = spotify_source_parts("spotify:track:11dFghVXANMlKmJXsNCbNl")
            .expect("spotify track URI");
        assert_eq!(kind, "track");
        assert_eq!(id, "11dFghVXANMlKmJXsNCbNl");
        assert_eq!(
            canonical,
            "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl"
        );
        assert!(spotify_source_parts("https://example.com/playlist/123").is_err());
    }

    #[test]
    fn spotify_track_metadata_keeps_original_artwork_and_external_link() {
        let payload = serde_json::json!({
            "id": "abc123",
            "name": "Tema de prueba",
            "duration_ms": 187000,
            "artists": [{"name": "Artista"}],
            "album": {"name": "Álbum", "images": [{"url": "https://i.scdn.co/image/demo"}]},
            "external_urls": {"spotify": "https://open.spotify.com/track/abc123"}
        });
        let track =
            spotify_track_metadata(&payload, "https://open.spotify.com/track/abc123", Some(1))
                .expect("spotify track metadata");
        assert_eq!(track.title, "Tema de prueba");
        assert_eq!(track.creator, "Artista");
        assert_eq!(track.duration_seconds, Some(187.0));
        assert_eq!(track.thumbnail, "https://i.scdn.co/image/demo");
        assert_eq!(track.spotify_url, "https://open.spotify.com/track/abc123");
    }

    #[test]
    fn spotify_public_html_helpers_extract_metadata_without_scripts() {
        let html = r#"
            <meta property="og:title" content="Tema &amp; prueba">
            <meta name="description" content="Listen to Tema &amp; prueba on Spotify. Song · Artista · 2026">
            <div data-testid="listRowTitle"><span>Tema &amp; prueba</span></div>
            <a data-testid="internal-artist-link"><span>Artista</span></a>
        "#;
        assert_eq!(html_meta_content(html, "og:title"), "Tema & prueba");
        assert_eq!(
            html_meta_content(html, "description"),
            "Listen to Tema & prueba on Spotify. Song · Artista · 2026"
        );
        assert_eq!(
            html_text_after_marker(html, "data-testid=\"listRowTitle\""),
            "Tema & prueba"
        );
        assert_eq!(
            html_text_after_marker(html, "data-testid=\"internal-artist-link\""),
            "Artista"
        );
    }

    #[test]
    #[ignore = "requiere acceso de red a una playlist pública de Spotify"]
    fn spotify_public_playlist_contract_returns_rows_without_credentials() {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("CacaTools Download Manager/0.20.4 test")
            .build()
            .expect("spotify client");
        let result = spotify_public_collection(
            &client,
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "playlist",
        )
        .expect("public playlist metadata");
        assert!(!result.3.is_empty());
        assert!(!result.3[0].title.is_empty());
        assert!(!result.3[0].thumbnail.is_empty());
        assert!(result.3[0].playlist_position == Some(1));
    }

    #[test]
    #[ignore = "requiere acceso de red a los enlaces NOVA del usuario"]
    fn spotify_nova_links_return_preliminary_metadata() {
        let client = Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("CacaTools Download Manager/0.22.1 test")
            .build()
            .expect("spotify client");
        let playlist =
            "https://open.spotify.com/playlist/7vQNDStY3IwvHEfOOgNddB?si=b94n6t_HSfyeAE8WChKCbA";
        let track =
            "https://open.spotify.com/intl-es/track/0EF1EE8zusg3Y869e56JFd?si=a2e20eb4e4ed41b8";
        let (_, _, _, playlist_tracks, _) = spotify_source_parts(playlist)
            .and_then(|(kind, id, canonical)| {
                spotify_public_source(&client, &kind, &id, &canonical)
            })
            .expect("NOVA playlist metadata");
        let (_, _, _, track_tracks, _) = spotify_source_parts(track)
            .and_then(|(kind, id, canonical)| {
                spotify_public_source(&client, &kind, &id, &canonical)
            })
            .expect("NOVA track metadata");
        assert!(!playlist_tracks.is_empty());
        assert_eq!(track_tracks.len(), 1);
        assert!(!track_tracks[0].thumbnail.is_empty());
    }

    #[test]
    fn legacy_spotify_jobs_are_disabled_without_deleting_history() {
        let connection = Connection::open_in_memory().expect("memory database");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status) VALUES(1,'Spotify activo','',10,'running'),(2,'Spotify completado','',100,'completed')",
                [],
            )
            .expect("jobs");
        for job_id in [1_i64, 2_i64] {
            connection
                .execute(
                    "INSERT INTO media_jobs(job_id,source_url,download_url,metadata_url,provider_id,format_selector,output_mode,destination_dir) VALUES(?1,?2,'','','spotdl','best','audio_mp3','C:/Downloads')",
                    params![job_id, format!("https://open.spotify.com/track/{job_id}")],
                )
                .expect("media job");
        }
        connection
            .execute(
                "INSERT INTO download_schedules(job_id,action,run_at,enabled) VALUES(1,'resume','2099-01-01T00:00:00Z',1)",
                [],
            )
            .expect("schedule");

        disable_legacy_spotify_jobs(&connection).expect("disable Spotify");
        let active_status: String = connection
            .query_row("SELECT status FROM jobs WHERE id=1", [], |row| row.get(0))
            .expect("active status");
        let completed_status: String = connection
            .query_row("SELECT status FROM jobs WHERE id=2", [], |row| row.get(0))
            .expect("completed status");
        let schedule_enabled: i64 = connection
            .query_row(
                "SELECT enabled FROM download_schedules WHERE job_id=1",
                [],
                |row| row.get(0),
            )
            .expect("schedule state");
        assert_eq!(active_status, "cancelled");
        assert_eq!(completed_status, "completed");
        assert_eq!(schedule_enabled, 0);
        assert!(job_uses_disabled_spotify(&connection, 1).expect("Spotify job"));
    }

    #[test]
    fn spotify_boundary_rejects_every_download_entrypoint() {
        for value in [
            "https://open.spotify.com/track/abc123",
            "https://open.spotify.com/intl-es/playlist/demo",
            "spotify:track:abc123",
        ] {
            let error = validate_media_url(value).expect_err("Spotify must never be downloadable");
            assert!(error.contains(SPOTIFY_DISABLED_CODE));
            assert!(error.contains(SPOTIFY_DISABLED_MESSAGE));
            assert!(is_spotify_url(value));
        }
        assert!(!is_spotify_url("https://www.youtube.com/watch?v=abc123"));
    }

    #[test]
    fn spotify_sanitizer_removes_html_and_rejects_svg_payloads() {
        assert_eq!(
            sanitize_spotify_text("  Tema &amp; prueba   \n versión  "),
            Some("Tema & prueba versión".into())
        );
        for unsafe_value in [
            "<svg><path d='x'/></svg>",
            "<div data-encore-id='image'>Título</div>",
            "aria-label='Título'",
        ] {
            assert!(sanitize_spotify_text(unsafe_value).is_none());
        }
    }

    fn spotify_fixture_track() -> SpotifyTrackMetadata {
        SpotifyTrackMetadata {
            id: "track-1".into(),
            isrc: String::new(),
            title: "Nothing's New".into(),
            creator: "Rio Romeo".into(),
            album: "Good Grief".into(),
            album_artist: "Rio Romeo".into(),
            duration_seconds: Some(208.0),
            thumbnail: String::new(),
            spotify_url: "https://open.spotify.com/track/track-1".into(),
            track_number: Some(1),
            disc_number: Some(1),
            release_date: String::new(),
            explicit: false,
            playlist_position: Some(1),
        }
    }

    fn spotify_fixture_result(
        title: &str,
        creator: &str,
        duration: Option<f64>,
    ) -> MediaSearchResult {
        MediaSearchResult {
            source_id: "candidate".into(),
            source_url: "https://www.youtube.com/watch?v=candidate".into(),
            title: title.into(),
            creator: creator.into(),
            duration_label: duration_label(duration),
            duration_seconds: duration,
            thumbnail: String::new(),
            extractor: "youtube".into(),
            similarity: 0.0,
            match_reasons: Vec::new(),
        }
    }

    #[test]
    fn spotify_score_obeys_false_match_limits() {
        let track = spotify_fixture_track();
        let exact = spotify_fixture_result("Nothing's New", "Rio Romeo - Topic", Some(208.0));
        let exact_score = spotify_candidate_score(&track, &exact);
        assert!(exact_score >= 85.0, "exact score: {exact_score}");

        let wrong_artist = spotify_fixture_result("Nothing's New", "Unrelated Artist", Some(208.0));
        assert_eq!(spotify_candidate_score(&track, &wrong_artist), 0.0);

        let wrong_version =
            spotify_fixture_result("Nothing's New (Remix)", "Rio Romeo", Some(208.0));
        assert_eq!(spotify_candidate_score(&track, &wrong_version), 0.0);

        let no_duration = spotify_fixture_result("Nothing's New", "Rio Romeo", None);
        assert!(spotify_candidate_score(&track, &no_duration) <= 65.0);

        let long = spotify_fixture_result("Nothing's New", "Rio Romeo", Some(220.1));
        assert_eq!(spotify_candidate_score(&track, &long), 0.0);
    }

    fn process_safety_fixture_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cacatools-process-safety-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn managed_storage_validation_rejects_root_escape_and_parent_segments() {
        let root = process_safety_fixture_root("validation");
        fs::create_dir_all(root.join("nested")).expect("managed root");
        let valid = root.join("nested").join("download.part");
        assert_eq!(
            validate_managed_candidate(&root, &valid).expect("managed child"),
            valid
        );
        assert!(validate_managed_candidate(&root, &root).is_err());
        assert!(validate_managed_candidate(
            &root,
            &root.join("nested").join("..").join("escaped.bin")
        )
        .is_err());
        let outside = root
            .parent()
            .expect("temporary parent")
            .join("cacatools-outside.bin");
        assert!(validate_managed_candidate(&root, &outside).is_err());
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn managed_storage_removal_keeps_unrelated_files() {
        let root = process_safety_fixture_root("removal");
        let job_dir = root.join("job-42");
        fs::create_dir_all(&job_dir).expect("job directory");
        fs::write(job_dir.join("fragment.part"), b"partial").expect("partial fixture");
        let unrelated = root.join("keep.txt");
        fs::write(&unrelated, b"keep").expect("unrelated fixture");
        assert!(remove_managed_storage_path(&root, &job_dir, true).expect("safe removal"));
        assert!(!job_dir.exists());
        assert!(unrelated.is_file());
        assert!(root.is_dir());
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn storage_path_deduplication_preserves_first_path_kind() {
        let root = process_safety_fixture_root("deduplication");
        let file = root.join("same.part");
        let paths = deduplicate_storage_paths(vec![
            (file.clone(), false),
            (file.clone(), true),
            (root.join("other.part"), false),
        ]);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], (file, false));
    }

    #[test]
    fn completed_torrent_directory_is_not_reported_as_partial() {
        let record = JobStorageRecord {
            job_id: 7,
            title: "Torrent".into(),
            status: "completed".into(),
            direct_destination: None,
            direct_temp: None,
            media_destination_dir: None,
            media_output: None,
            torrent_destination_dir: Some(PathBuf::from("C:/Downloads/Torrents/Torrent")),
        };
        assert_eq!(job_final_storage_paths(&record).len(), 1);
        assert!(job_partial_storage_paths(&record).is_empty());
    }

    #[test]
    fn external_process_registry_tracks_multiple_processes_per_job() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let first = register_external_process(&registry, 42, 101, ExternalProcessKind::YtDlp)
            .expect("first process");
        let second = register_external_process(&registry, 42, 202, ExternalProcessKind::Ffmpeg)
            .expect("second process");
        assert!(external_processes_active(&registry, 42));
        assert_eq!(
            registry
                .lock()
                .expect("registry")
                .get(&42)
                .map(HashMap::len),
            Some(2)
        );
        drop(first);
        assert!(external_processes_active(&registry, 42));
        drop(second);
        assert!(!external_processes_active(&registry, 42));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_process_is_killed_and_unregistered_after_cancellation() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let worker_registry = registry.clone();
        let worker = thread::spawn(move || {
            let mut command = background_command("cmd.exe");
            command.args(["/C", "ping", "127.0.0.1", "-n", "30", "-w", "1000"]);
            supervised_command_output(
                &mut command,
                &worker_registry,
                73,
                ExternalProcessKind::Ffmpeg,
                "proceso de prueba",
            )
        });
        let started = Instant::now();
        while !external_processes_active(&registry, 73)
            && started.elapsed() < Duration::from_secs(30)
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(external_processes_active(&registry, 73));
        terminate_external_processes(&registry, 73);
        assert!(wait_for_external_processes_idle(
            &registry,
            73,
            Duration::from_secs(5)
        ));
        let result = worker.join().expect("supervisor worker");
        assert!(result.is_ok());
        assert!(!result.expect("process output").status.success());
    }
}
