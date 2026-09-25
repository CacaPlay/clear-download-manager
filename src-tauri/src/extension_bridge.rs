use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BRIDGE_PROTOCOL_VERSION: u32 = 1;
const BUNDLED_EXTENSION_CONFIG: &str = include_str!("../resources/extension/extension-config.json");
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_STATE_BYTES: usize = 768 * 1024;
const CAPTURE_RESPONSE_TIMEOUT_MS: u64 = 3_000;
const HOST_NAME: &str = "lat.cacaplay.cacatools.downloadmanager";
const PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "aonppfnabjnicjjeoofkfjofolfibggp";
const STORE_APP_USER_MODEL_ID: &str = "CacaPlay.CacaToolsDownloadManager_b9fexpwkvxe1m!CacaTools";
const WINDOWS_STARTUP_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const WINDOWS_STARTUP_VALUE: &str = "Clear Download Manager";
static APP_LOCK: OnceLock<File> = OnceLock::new();
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionBridgeConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    chromium_extension_ids: Vec<String>,
    #[serde(default)]
    firefox_extension_ids: Vec<String>,
    #[serde(default = "default_browsers")]
    browsers: Vec<String>,
    #[serde(default)]
    store_app_user_model_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBridgeRequest {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub origin: String,
    pub created_at: u64,
}

fn default_browsers() -> Vec<String> {
    vec![
        "chrome".to_string(),
        "edge".to_string(),
        "brave".to_string(),
        "chromium".to_string(),
    ]
}

fn extension_config() -> ExtensionBridgeConfig {
    serde_json::from_str(BUNDLED_EXTENSION_CONFIG).unwrap_or_else(|_| ExtensionBridgeConfig {
        enabled: false,
        chromium_extension_ids: Vec::new(),
        firefox_extension_ids: Vec::new(),
        browsers: default_browsers(),
        store_app_user_model_id: None,
    })
}

fn valid_chromium_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn clean_chromium_extension_ids(config: &ExtensionBridgeConfig) -> Vec<String> {
    let mut ids = vec![PUBLISHED_CHROMIUM_EXTENSION_ID.to_string()];
    for id in config
        .chromium_extension_ids
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| valid_chromium_extension_id(value))
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn clean_firefox_extension_ids(config: &ExtensionBridgeConfig) -> Vec<String> {
    config
        .firefox_extension_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_whitespace)
        })
        .collect()
}

fn registration_marker_path() -> PathBuf {
    bridge_root().join("host-registration.json")
}

#[cfg(windows)]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

#[cfg(windows)]
fn startup_command_line() -> Result<String, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let escaped = executable.to_string_lossy().replace('"', "\\\"");
    Ok(format!("\"{escaped}\" --background-startup"))
}

/// Returns whether CacaTools is registered to start silently with Windows.
/// The setting is deliberately kept in the per-user Run key so no elevation
/// or service is required and uninstallers can remove it safely.
pub fn startup_status() -> Value {
    #[cfg(windows)]
    {
        let enabled = hidden_command("reg.exe")
            .args(["QUERY", WINDOWS_STARTUP_KEY, "/v", WINDOWS_STARTUP_VALUE])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        json!({
            "supported": true,
            "enabled": enabled,
            "mode": "background",
            "valueName": WINDOWS_STARTUP_VALUE
        })
    }
    #[cfg(not(windows))]
    {
        json!({ "supported": false, "enabled": false, "mode": "background" })
    }
}

/// Enables or disables the per-user Windows startup entry. The command is
/// idempotent and never opens a console window.
pub fn set_startup_enabled(enabled: bool) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let output = if enabled {
            let command_line = startup_command_line()?;
            hidden_command("reg.exe")
                .args([
                    "ADD",
                    WINDOWS_STARTUP_KEY,
                    "/v",
                    WINDOWS_STARTUP_VALUE,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &command_line,
                    "/f",
                ])
                .output()
        } else {
            hidden_command("reg.exe")
                .args([
                    "DELETE",
                    WINDOWS_STARTUP_KEY,
                    "/v",
                    WINDOWS_STARTUP_VALUE,
                    "/f",
                ])
                .output()
        }
        .map_err(|error| format!("No se pudo actualizar el inicio de Windows: {error}"))?;

        // DELETE returns an error when the value was already absent. Treat
        // that case as success because the requested final state is disabled.
        if !output.status.success() && enabled {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Windows no pudo registrar el inicio en segundo plano".to_string()
            } else {
                detail
            });
        }
        Ok(startup_status())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("El inicio automático solo está disponible en Windows".to_string())
    }
}

#[cfg(windows)]
fn add_registry_manifest(registry_key: &str, manifest_path: &str) -> Result<(), String> {
    let output = hidden_command("reg.exe")
        .args([
            "ADD",
            registry_key,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            manifest_path,
            "/f",
        ])
        .output()
        .map_err(|error| format!("No se pudo ejecutar reg.exe: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn is_windows_apps_path(path: &std::path::Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\windowsapps\\")
}

#[cfg(windows)]
fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(windows)]
fn stage_store_native_host(source: &PathBuf) -> Result<PathBuf, String> {
    let source_hash = sha256_file(source)?;
    let stage_directory = bridge_root().join("native-host").join(&source_hash);
    fs::create_dir_all(&stage_directory).map_err(|error| error.to_string())?;
    let file_name = source
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("cacatools-native-host.exe"));
    let target = stage_directory.join(file_name);

    if target.is_file() {
        let staged_hash = sha256_file(&target)?;
        if staged_hash != source_hash {
            return Err(
                "El host nativo externo existe, pero no coincide con el host empaquetado".into(),
            );
        }
        return Ok(target);
    }

    let temporary = stage_directory.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id()
    ));
    let _ = fs::remove_file(&temporary);
    fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    let copied_hash = sha256_file(&temporary)?;
    if copied_hash != source_hash {
        let _ = fs::remove_file(&temporary);
        return Err("No se pudo verificar la copia externa del host nativo".into());
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        if target.is_file() && sha256_file(&target).ok().as_deref() == Some(source_hash.as_str()) {
            let _ = fs::remove_file(&temporary);
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    }
    Ok(target)
}

#[cfg(windows)]
fn valid_store_app_user_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'!' | b'-'))
}

#[cfg(windows)]
fn write_store_launch_config(
    host_path: &std::path::Path,
    app_user_model_id: &str,
) -> Result<(), String> {
    let Some(parent) = host_path.parent() else {
        return Err("No se pudo determinar la carpeta del host nativo".into());
    };
    let config_path = parent.join("store-launch.json");
    let body = serde_json::to_vec_pretty(&json!({
        "storeAppUserModelId": app_user_model_id
    }))
    .map_err(|error| error.to_string())?;
    if fs::read(&config_path).ok().as_deref() == Some(body.as_slice()) {
        return Ok(());
    }
    let temporary = config_path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&config_path);
    fs::rename(&temporary, &config_path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn ensure_extension_host_registration() -> Result<bool, String> {
    let config = extension_config();
    let marker_path = registration_marker_path();
    if !config.enabled {
        let _ = fs::remove_file(marker_path);
        return Ok(false);
    }
    let _ = fs::remove_file(&marker_path);

    let chromium_ids = clean_chromium_extension_ids(&config);
    let firefox_ids = clean_firefox_extension_ids(&config);
    if chromium_ids.is_empty() && firefox_ids.is_empty() {
        return Err(
            "La integración de extensión está habilitada, pero no tiene IDs válidos".to_string(),
        );
    }

    let host_directory = bridge_root().join("hosts");
    fs::create_dir_all(&host_directory).map_err(|error| error.to_string())?;
    let executable = env::var_os("CACATOOLS_NATIVE_HOST")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            env::current_exe().ok().and_then(|path| {
                let file_name = if cfg!(windows) {
                    "cacatools-native-host.exe"
                } else {
                    "cacatools-native-host"
                };
                let parent = path.parent()?;
                [
                    parent.join("resources").join("extension").join(file_name),
                    parent.join(file_name),
                ]
                .into_iter()
                .find(|candidate| candidate.is_file())
            })
        })
        .or_else(|| env::current_exe().ok())
        .ok_or_else(|| "No se pudo localizar el host nativo de CacaTools".to_string())?;
    let executable = if is_windows_apps_path(&executable) {
        let staged = stage_store_native_host(&executable)?;
        let configured_id = config
            .store_app_user_model_id
            .as_deref()
            .filter(|value| valid_store_app_user_model_id(value.trim()))
            .map(str::trim)
            .unwrap_or(STORE_APP_USER_MODEL_ID);
        write_store_launch_config(&staged, configured_id)?;
        staged
    } else {
        executable
    };
    let executable_text = executable.to_string_lossy().into_owned();
    let mut registered_browsers = Vec::new();
    let mut registration_errors = Vec::new();

    if !chromium_ids.is_empty() {
        let manifest_path = host_directory.join(format!("{HOST_NAME}.chromium.json"));
        let allowed_origins = chromium_ids
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect::<Vec<_>>();
        let manifest = json!({
            "name": HOST_NAME,
            "description": "Puente local para Clear Download Manager",
            "path": executable_text.clone(),
            "type": "stdio",
            "allowed_origins": allowed_origins
        });
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let manifest_text = manifest_path.to_string_lossy().into_owned();
        let browser_keys = [
            (
                "chrome",
                r"HKCU\Software\Google\Chrome\NativeMessagingHosts",
            ),
            ("edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
            (
                "brave",
                r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
            ),
            ("chromium", r"HKCU\Software\Chromium\NativeMessagingHosts"),
        ];
        for (browser, root) in browser_keys {
            if config
                .browsers
                .iter()
                .any(|value| value.eq_ignore_ascii_case(browser))
            {
                match add_registry_manifest(&format!(r"{root}\{HOST_NAME}"), &manifest_text) {
                    Ok(()) => registered_browsers.push(browser.to_string()),
                    Err(error) => registration_errors.push(format!("{browser}: {error}")),
                }
            }
        }
    }

    if !firefox_ids.is_empty() {
        let manifest_path = host_directory.join(format!("{HOST_NAME}.firefox.json"));
        let manifest = json!({
            "name": HOST_NAME,
            "description": "Puente local para Clear Download Manager",
            "path": executable_text.clone(),
            "type": "stdio",
            "allowed_extensions": firefox_ids
        });
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let manifest_text = manifest_path.to_string_lossy().into_owned();
        match add_registry_manifest(
            &format!(r"HKCU\Software\Mozilla\NativeMessagingHosts\{HOST_NAME}"),
            &manifest_text,
        ) {
            Ok(()) => registered_browsers.push("firefox".to_string()),
            Err(error) => registration_errors.push(format!("firefox: {error}")),
        }
    }

    let marker = json!({
        "hostName": HOST_NAME,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "executable": executable_text,
        "registeredBrowsers": registered_browsers,
        "registrationErrors": registration_errors,
        "registeredAt": unix_timestamp_secs()
    });
    fs::write(
        marker_path,
        serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(not(windows))]
fn ensure_extension_host_registration() -> Result<bool, String> {
    Ok(false)
}

fn bridge_root() -> PathBuf {
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    root.join("CacaTools")
        .join("DownloadManager")
        .join("ExtensionBridge")
}

fn inbox_dir() -> PathBuf {
    bridge_root().join("inbox")
}

fn response_dir() -> PathBuf {
    bridge_root().join("responses")
}

fn state_path() -> PathBuf {
    bridge_root().join("extension-state.json")
}

fn read_extension_state() -> Value {
    fs::read(state_path())
        .ok()
        .filter(|bytes| bytes.len() <= MAX_STATE_BYTES)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| {
            json!({
                "appearance": {
                    "theme": "system",
                    "accent": "#24b8e8",
                    "intensity": 82,
                    "motion": true,
                    "motionMode": "system",
                    "iconColorMode": "accent",
                    "iconColor": "#596574",
                    "progressActive": "#00ff2a",
                    "progressCompleted": "#00ff2a",
                    "progressPaused": "#e2a93f",
                    "progressError": "#ef6674"
                },
                "jobs": [],
                "queue": {},
                "updatedAt": 0
            })
        })
}

#[tauri::command]
pub fn publish_extension_state(state: Value) -> Result<Value, String> {
    let mut state = state;
    if !state.is_object() {
        return Err("El estado de la extensión debe ser un objeto".to_string());
    }
    if let Some(object) = state.as_object_mut() {
        object.insert(
            "publishedAt".to_string(),
            Value::from(unix_timestamp_millis() as u64),
        );
        object.insert(
            "appVersion".to_string(),
            Value::from(env!("CARGO_PKG_VERSION")),
        );
    }
    let bytes = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err("El estado para la extensión supera el límite permitido".to_string());
    }
    fs::create_dir_all(bridge_root()).map_err(|error| error.to_string())?;
    let final_path = state_path();
    let temporary_path = final_path.with_extension("tmp");
    fs::write(&temporary_path, bytes).map_err(|error| error.to_string())?;
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": final_path.to_string_lossy() }))
}

fn lock_path() -> PathBuf {
    bridge_root().join("application.lock")
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn claim_primary_app_instance() -> Result<bool, String> {
    fs::create_dir_all(inbox_dir()).map_err(|error| error.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path())
        .map_err(|error| error.to_string())?;
    match lock.try_lock_exclusive() {
        Ok(()) => {
            let _ = APP_LOCK.set(lock);
            Ok(true)
        }
        Err(_) => {
            write_request("activate_app", Value::Null, "application-launch")?;
            Ok(false)
        }
    }
}

pub fn initialize_app_bridge() -> Result<(), String> {
    fs::create_dir_all(inbox_dir()).map_err(|error| error.to_string())?;
    let _ = ensure_extension_host_registration();
    if APP_LOCK.get().is_none() && !claim_primary_app_instance()? {
        return Err("CacaTools ya está ejecutándose".to_string());
    }
    Ok(())
}

fn app_is_running() -> bool {
    let Ok(lock) = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path())
    else {
        return false;
    };
    match lock.try_lock_exclusive() {
        Ok(()) => {
            let _ = FileExt::unlock(&lock);
            false
        }
        Err(_) => true,
    }
}

fn ensure_app_running(background: bool) -> Result<bool, String> {
    if app_is_running() {
        return Ok(false);
    }
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let mut command = hidden_command(executable);
    if background {
        command.arg("--background-startup");
    }
    command
        .spawn()
        .map_err(|error| format!("No se pudo abrir CacaTools: {error}"))?;
    Ok(true)
}

fn valid_origin(value: &str) -> bool {
    value.starts_with("chrome-extension://")
        || value.starts_with("extension://")
        || value.starts_with("moz-extension://")
}

fn background_requested(payload: &Value) -> bool {
    payload
        .get("windowMode")
        .or_else(|| payload.get("windowBehavior"))
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("background"))
}

fn write_request(action: &str, payload: Value, origin: &str) -> Result<String, String> {
    fs::create_dir_all(inbox_dir()).map_err(|error| error.to_string())?;
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let id = format!(
        "{}-{}-{sequence}",
        unix_timestamp_millis(),
        std::process::id()
    );
    let request = ExtensionBridgeRequest {
        id: id.clone(),
        action: action.to_string(),
        payload,
        origin: origin.to_string(),
        created_at: unix_timestamp_secs(),
    };
    let final_path = inbox_dir().join(format!("{id}.json"));
    let temporary_path = inbox_dir().join(format!(".{id}.tmp"));
    let bytes = serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?;
    fs::write(&temporary_path, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string())?;
    Ok(id)
}

fn wait_for_capture_response(request_id: &str) -> Value {
    let response_file = response_dir().join(format!("{request_id}.json"));
    let request_file = inbox_dir().join(format!("{request_id}.json"));
    let deadline = SystemTime::now()
        .checked_add(std::time::Duration::from_millis(
            CAPTURE_RESPONSE_TIMEOUT_MS,
        ))
        .unwrap_or(SystemTime::now());
    loop {
        if let Ok(body) = fs::read_to_string(&response_file) {
            let _ = fs::remove_file(&response_file);
            return serde_json::from_str(&body).unwrap_or_else(|_| {
                json!({
                    "ok": false,
                    "status": "temporary_failure",
                    "requestId": request_id
                })
            });
        }
        if SystemTime::now() >= deadline {
            let _ = fs::remove_file(&request_file);
            return json!({
                "ok": false,
                "status": "temporary_failure",
                "requestId": request_id,
                "error": "CacaTools no confirmó la captura a tiempo"
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn native_origin_from_args() -> String {
    env::args()
        .skip(1)
        .find(|value| valid_origin(value))
        .unwrap_or_default()
}

fn handle_native_message(message: Value, origin: &str) -> Value {
    let action = message
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("ping")
        .trim()
        .to_ascii_lowercase();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    match action.as_str() {
        "ping" => json!({
            "ok": true,
            "host": HOST_NAME,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "appRunning": app_is_running(),
            "appVersion": env!("CARGO_PKG_VERSION")
        }),
        "capabilities" => json!({
            "ok": true,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "actions": ["ping", "capabilities", "enqueue", "analyze", "browser_download_capture", "open_app", "activate_app", "open_job", "open_player", "list_jobs", "job_action", "set_job_options", "get_status"],
            "sourceTypes": ["http", "https", "magnet", "torrent", "video", "audio", "playlist", "direct_file", "generic_url"]
        }),
        "get_status" => json!({
            "ok": true,
            "appRunning": app_is_running(),
            "pendingRequests": fs::read_dir(inbox_dir()).map(|entries| entries.count()).unwrap_or(0),
            "state": read_extension_state()
        }),
        "open_app" | "activate_app" => match ensure_app_running(false) {
            Ok(started) => {
                if !started {
                    let _ = write_request("activate_app", Value::Null, origin);
                }
                json!({ "ok": true, "started": started })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "open_job" => {
            let job_id = payload
                .get("jobId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_i64)
                .filter(|value| *value > 0);
            let Some(job_id) = job_id else {
                return json!({ "ok": false, "error": "La descarga seleccionada no es válida" });
            };
            let mode = if payload.get("mode").and_then(Value::as_str) == Some("play") {
                "play"
            } else {
                "open"
            };
            let request_payload = json!({
                "jobId": job_id,
                "mode": mode,
                "windowMode": if mode == "play" { "background" } else { "foreground" }
            });
            match write_request("open_job", request_payload, origin)
                .and_then(|id| ensure_app_running(mode != "open").map(|started| (id, started)))
            {
                Ok((id, started)) => json!({ "ok": true, "requestId": id, "appStarted": started }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "open_player" => {
            let job_id = payload
                .get("jobId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_i64)
                .filter(|value| *value > 0);
            let Some(job_id) = job_id else {
                return json!({ "ok": false, "error": "La descarga seleccionada no es válida" });
            };
            let request_payload =
                json!({ "jobId": job_id, "mode": "play", "windowMode": "background" });
            match write_request("open_player", request_payload, origin)
                .and_then(|id| ensure_app_running(true).map(|started| (id, started)))
            {
                Ok((id, started)) => json!({ "ok": true, "requestId": id, "appStarted": started }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "list_jobs" => json!({ "ok": true, "state": read_extension_state() }),
        "job_action" => {
            let job_id = payload
                .get("jobId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_i64)
                .filter(|value| *value > 0);
            let action_name = payload
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let allowed = [
                "pause",
                "resume",
                "retry",
                "cancel",
                "open_player",
                "open_file",
                "reveal_file",
                "delete_history",
                "delete_file",
            ];
            let Some(job_id) = job_id.filter(|_| allowed.contains(&action_name)) else {
                return json!({ "ok": false, "error": "La acción de descarga no es válida" });
            };
            let request_payload = json!({
                "jobId": job_id,
                "action": action_name,
                "confirmed": payload.get("confirmed").and_then(Value::as_bool).unwrap_or(false),
                "windowMode": "background"
            });
            match write_request("job_action", request_payload, origin)
                .and_then(|id| ensure_app_running(true).map(|started| (id, started)))
            {
                Ok((id, started)) => json!({ "ok": true, "requestId": id, "appStarted": started }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "set_job_options" => {
            let valid_id = payload
                .get("jobId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_i64)
                .is_some_and(|value| value > 0);
            if !valid_id || !payload.get("options").is_some_and(Value::is_object) {
                return json!({ "ok": false, "error": "Las opciones de descarga no son válidas" });
            }
            match write_request("set_job_options", json!({ "jobId": payload.get("jobId").or_else(|| payload.get("id")), "options": payload.get("options"), "windowMode": "background" }), origin)
                .and_then(|id| ensure_app_running(true).map(|started| (id, started)))
            {
                Ok((id, started)) => json!({ "ok": true, "requestId": id, "appStarted": started }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "enqueue" | "analyze" | "browser_download_capture" => {
            let source = payload
                .get("finalUrl")
                .or_else(|| payload.get("url"))
                .or_else(|| payload.get("source"))
                .or_else(|| payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if source.is_empty() {
                return json!({
                    "ok": false,
                    "error": "La solicitud no contiene un enlace o fuente"
                });
            }
            let background = background_requested(&payload);
            match write_request(&action, payload, origin)
                .and_then(|id| ensure_app_running(background).map(|started| (id, started)))
            {
                Ok((id, started)) if action == "browser_download_capture" => {
                    let mut response = wait_for_capture_response(&id);
                    if let Some(object) = response.as_object_mut() {
                        object.insert("appStarted".into(), Value::Bool(started));
                    }
                    response
                }
                Ok((id, started)) => {
                    json!({ "ok": true, "requestId": id, "appStarted": started })
                }
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        _ => json!({ "ok": false, "error": format!("Acción no compatible: {action}") }),
    }
}

#[cfg(windows)]
fn configure_binary_stdio() {
    const O_BINARY: i32 = 0x8000;
    extern "C" {
        fn _setmode(file_descriptor: i32, mode: i32) -> i32;
    }
    unsafe {
        let _ = _setmode(0, O_BINARY);
        let _ = _setmode(1, O_BINARY);
    }
}

#[cfg(not(windows))]
fn configure_binary_stdio() {}

fn read_message(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_ne_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_INPUT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Tamaño de mensaje nativo no permitido",
        ));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "La respuesta supera el límite del navegador",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

pub fn run_native_messaging_host() {
    configure_binary_stdio();
    let origin = native_origin_from_args();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    loop {
        let message = match read_message(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(error) => {
                let _ = write_message(
                    &mut writer,
                    &json!({ "ok": false, "error": error.to_string() }),
                );
                break;
            }
        };
        let response = handle_native_message(message, &origin);
        if write_message(&mut writer, &response).is_err() {
            break;
        }
    }
}

#[tauri::command]
pub fn extension_bridge_status() -> Value {
    let config = extension_config();
    let chromium_ids = clean_chromium_extension_ids(&config);
    let firefox_ids = clean_firefox_extension_ids(&config);
    json!({
        "prepared": true,
        "configured": config.enabled && (!chromium_ids.is_empty() || !firefox_ids.is_empty()),
        "registered": registration_marker_path().is_file(),
        "automaticRegistration": true,
        "hostName": HOST_NAME,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "appRunning": true,
        "inbox": inbox_dir().to_string_lossy(),
        "publishedChromiumExtensionId": PUBLISHED_CHROMIUM_EXTENSION_ID,
        "chromiumExtensionIds": chromium_ids,
        "supportedBrowsers": ["Google Chrome", "Microsoft Edge", "Chromium", "Brave", "Firefox"]
    })
}

#[tauri::command]
pub fn drain_extension_bridge_requests(
    limit: Option<usize>,
) -> Result<Vec<ExtensionBridgeRequest>, String> {
    fs::create_dir_all(inbox_dir()).map_err(|error| error.to_string())?;
    let mut paths = fs::read_dir(inbox_dir())
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    paths.truncate(limit.unwrap_or(20).clamp(1, 100));
    let mut requests = Vec::new();
    for path in paths {
        let parsed = fs::read_to_string(&path)
            .ok()
            .and_then(|value| serde_json::from_str::<ExtensionBridgeRequest>(&value).ok());
        let _ = fs::remove_file(&path);
        if let Some(request) = parsed {
            requests.push(request);
        }
    }
    Ok(requests)
}

pub fn write_capture_response(request_id: &str, response: &Value) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 160
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Identificador de captura no válido".to_string());
    }
    fs::create_dir_all(response_dir()).map_err(|error| error.to_string())?;
    let final_path = response_dir().join(format!("{request_id}.json"));
    let temporary_path = response_dir().join(format!(".{request_id}.tmp"));
    fs::write(
        &temporary_path,
        serde_json::to_vec(response).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary_path, final_path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_chromium_id_is_always_first_and_deduplicated() {
        let config = ExtensionBridgeConfig {
            enabled: true,
            chromium_extension_ids: vec![
                "abcdefghijklmnopabcdefghijklmnop".into(),
                PUBLISHED_CHROMIUM_EXTENSION_ID.into(),
                PUBLISHED_CHROMIUM_EXTENSION_ID.to_ascii_uppercase(),
                "invalid-extension-id".into(),
            ],
            firefox_extension_ids: Vec::new(),
            browsers: default_browsers(),
            store_app_user_model_id: None,
        };
        let ids = clean_chromium_extension_ids(&config);
        assert_eq!(
            ids.first().map(String::as_str),
            Some(PUBLISHED_CHROMIUM_EXTENSION_ID)
        );
        assert_eq!(
            ids.iter()
                .filter(|id| id.as_str() == PUBLISHED_CHROMIUM_EXTENSION_ID)
                .count(),
            1
        );
        assert!(ids
            .iter()
            .any(|id| id == "abcdefghijklmnopabcdefghijklmnop"));
        assert!(!ids.iter().any(|id| id == "invalid-extension-id"));
    }
}
