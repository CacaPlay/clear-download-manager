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
    ensure_public_network_resolution, host_is_public, parse_public_http_url, public_dns_resolver,
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
    runtime_binary_version, MediaRuntimePaths, MediaRuntimeSnapshot, ToolId,
};
#[cfg(test)]
pub(crate) use app::state::WindowOperationRegistry;
pub(crate) use app::state::{
    begin_window_operation, current_window_operation, invalidate_window_operation,
    register_window_process, window_operation_is_cancelled, LocalState, WindowOperation,
    WorkerCompletion, WorkerCompletionGuard,
};

#[cfg(all(feature = "github-updater", feature = "microsoft-store"))]
compile_error!(
    "The GitHub updater and Microsoft Store distribution features are mutually exclusive."
);

#[cfg(feature = "microsoft-store")]
#[path = "store_update_manager.rs"]
mod update_manager;
#[cfg(not(feature = "microsoft-store"))]
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

mod commands;

// Compatibility marker retained for the Phase 20 static UI contract while
// the active appearance defaults live in settings.rs.
fn default_ui_scale() -> u8 {
    125
}

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use std::time::UNIX_EPOCH;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{atomic::Ordering, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use url::Url;

const DOWNLOAD_PROGRESS_UPDATE_INTERVAL_MS: u64 = 500;
const MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250;

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

fn absolute_path_override(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(value?);
    path.is_absolute().then_some(path)
}

fn environment_path_override(name: &str) -> Option<PathBuf> {
    absolute_path_override(std::env::var_os(name))
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
        "aria2_version": aria2_version,
        "media_available": state.media_runtime.is_some(),
        "version": env!("CARGO_PKG_VERSION")
    })
}

fn resolver_binary(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_tool_with_arguments(Some(app), ToolId::YtDlp, &["--version"])
        .path
        .ok_or_else(|| {
            "No se encontró el componente multimedia interno. Verifica los archivos de la aplicación e inténtalo de nuevo.".into()
        })
}

fn legacy_removed_provider_error() -> String {
    "Esta tarea usa una integración retirada; su registro histórico se conserva".into()
}

// These historical markers are retained only to prevent old queued work from
// being resumed by the current generic downloader. They never delete history.
fn job_uses_legacy_removed_provider(connection: &Connection, job_id: i64) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM jobs j
                LEFT JOIN media_jobs mj ON mj.job_id=j.id
                LEFT JOIN download_jobs dj ON dj.job_id=j.id
                LEFT JOIN playlist_items pi ON pi.job_id=j.id
                WHERE j.id=?1 AND (
                    lower(COALESCE(mj.provider_id,'')) LIKE 'spotify%'
                    OR lower(COALESCE(mj.provider_id,''))='spotdl'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%scdn.co%'
                    OR lower(COALESCE(mj.download_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.metadata_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(dj.url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.provider_id,'')) LIKE 'spotify%'
                    OR lower(COALESCE(pi.provider_id,''))='spotdl'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%scdn.co%'
                    OR lower(COALESCE(pi.metadata_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.spotify_url,'')) LIKE '%spotify.com%'
                )
            )",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
}

fn playlist_batch_uses_legacy_removed_provider(
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
                    lower(COALESCE(pi.provider_id,'')) LIKE 'spotify%'
                    OR lower(COALESCE(pi.provider_id,''))='spotdl'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.source_url,'')) LIKE '%scdn.co%'
                    OR lower(COALESCE(pi.metadata_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(pi.spotify_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.provider_id,'')) LIKE 'spotify%'
                    OR lower(COALESCE(mj.provider_id,''))='spotdl'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify:%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%spotify.com%'
                    OR lower(COALESCE(mj.source_url,'')) LIKE '%scdn.co%'
                    OR lower(COALESCE(mj.metadata_url,'')) LIKE '%spotify.com%'
                )
            )",
            params![batch_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
}

fn validate_media_url(value: &str) -> Result<String, String> {
    parse_public_http_url(value, "El enlace multimedia no es válido")
        .map(|parsed| parsed.to_string())
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
    selected_source_url: String,
    #[serde(default)]
    resolution_state: String,
    #[serde(default)]
    provider_id: String,
    title: String,
    creator: String,
    thumbnail: String,
    duration_label: String,
    expected_duration_seconds: Option<f64>,
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
            selected_source_url: url.clone(),
            resolution_state: "ready".into(),
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
    #[cfg(feature = "github-updater")]
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
                    .prepare("SELECT media_jobs.job_id FROM media_jobs JOIN jobs ON jobs.id=media_jobs.job_id WHERE jobs.status='queued' AND media_jobs.playlist_batch_id IS NULL AND lower(COALESCE(media_jobs.provider_id,'')) NOT LIKE 'spotify%' AND lower(COALESCE(media_jobs.provider_id,''))<>'spotdl' AND lower(COALESCE(media_jobs.source_url,'')) NOT LIKE '%spotify.com%' AND lower(COALESCE(media_jobs.source_url,'')) NOT LIKE '%scdn.co%' AND lower(COALESCE(media_jobs.source_url,'')) NOT LIKE 'spotify:%' AND lower(COALESCE(media_jobs.metadata_url,'')) NOT LIKE '%spotify.com%' ORDER BY jobs.id")
                    ?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.flatten().collect::<Vec<i64>>()
            };
            let queued_playlist_jobs: Vec<i64> = {
                let mut statement = connection
                    .prepare("SELECT MIN(pi.job_id) FROM playlist_items pi JOIN playlist_batches pb ON pb.id=pi.batch_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.status='queued' AND pi.job_id IS NOT NULL AND lower(COALESCE(pi.provider_id,'')) NOT LIKE 'spotify%' AND lower(COALESCE(pi.provider_id,''))<>'spotdl' AND lower(COALESCE(pi.source_url,'')) NOT LIKE '%spotify.com%' AND lower(COALESCE(pi.source_url,'')) NOT LIKE '%scdn.co%' AND lower(COALESCE(pi.source_url,'')) NOT LIKE 'spotify:%' AND lower(COALESCE(pi.metadata_url,'')) NOT LIKE '%spotify.com%' AND COALESCE(pi.spotify_url,'')='' AND lower(COALESCE(mj.provider_id,'')) NOT LIKE 'spotify%' AND lower(COALESCE(mj.metadata_url,'')) NOT LIKE '%spotify.com%' GROUP BY pi.batch_id")
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
        assert_eq!(youtube_thumbnail_for_source("https://vimeo.com/12345"), "");
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
    fn legacy_playlist_spotify_data_is_preserved_and_never_resumed() {
        let connection = Connection::open_in_memory().expect("memory database");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO jobs(id,title,detail,progress,status) VALUES(1,'Legacy playlist item','',0,'queued')",
                [],
            )
            .expect("legacy job");
        connection
            .execute(
                "INSERT INTO playlist_batches(id,title,format,status,current_position) VALUES(1,'Legacy playlist','audio_best','queued',0)",
                [],
            )
            .expect("legacy batch");
        connection
            .execute(
                "INSERT INTO playlist_items(batch_id,source_id,source_url,spotify_url,position,job_id) VALUES(1,'legacy-track','https://youtube.com/watch?v=legacy','https://open.spotify.com/track/legacy',1,1)",
                [],
            )
            .expect("legacy playlist item");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,download_url,metadata_url,provider_id,format_selector,output_mode,destination_dir,playlist_batch_id) VALUES(1,'https://youtube.com/watch?v=legacy','https://youtube.com/watch?v=legacy','https://open.spotify.com/track/legacy','spotify_metadata_youtube_music','best','audio_best','C:/Downloads',1)",
                [],
            )
            .expect("legacy media job");

        assert!(job_uses_legacy_removed_provider(&connection, 1).expect("legacy guard"));
        assert!(playlist_batch_uses_legacy_removed_provider(&connection, 1).expect("batch guard"));
        let stored_url: String = connection
            .query_row(
                "SELECT spotify_url FROM playlist_items WHERE job_id=1",
                [],
                |row| row.get(0),
            )
            .expect("legacy URL remains readable");
        let job_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE id=1", [], |row| row.get(0))
            .expect("legacy history count");
        let status: String = connection
            .query_row("SELECT status FROM jobs WHERE id=1", [], |row| row.get(0))
            .expect("legacy status");
        assert_eq!(stored_url, "https://open.spotify.com/track/legacy");
        assert_eq!(job_count, 1);
        assert_eq!(status, "queued");
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
