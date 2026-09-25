use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const HOST_NAME: &str = "lat.cacaplay.cacatools.downloadmanager";
const MAX_MESSAGE: usize = 4 * 1024 * 1024;
const MAX_STATE_BYTES: usize = 768 * 1024;
// Cold-starting the desktop app can take longer than the old 2.85 s window.
// The extension-side native-message timeout remains 8 s, leaving room for the
// app to open the HTTP review window and report that handoff.
const CAPTURE_RESPONSE_TIMEOUT_MS: u64 = 7_000;
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn bridge_root() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("CacaTools")
        .join("DownloadManager")
        .join("ExtensionBridge")
}

fn app_lock_path() -> PathBuf {
    bridge_root().join("application.lock")
}
fn inbox_path() -> PathBuf {
    bridge_root().join("inbox")
}
fn response_path() -> PathBuf {
    bridge_root().join("responses")
}
fn state_path() -> PathBuf {
    bridge_root().join("extension-state.json")
}

fn store_launch_config_path() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("store-launch.json")))
}

fn valid_store_app_user_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'!' | b'-'))
}

fn store_app_user_model_id() -> Option<String> {
    let path = store_launch_config_path()?;
    let body = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&body).ok()?;
    let id = value.get("storeAppUserModelId")?.as_str()?.trim();
    valid_store_app_user_model_id(id).then(|| id.to_string())
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
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn next_request_id(suffix: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp}-{}-{sequence}{suffix}", std::process::id())
}

fn app_running() -> bool {
    let Ok(file) = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(app_lock_path())
    else {
        return false;
    };
    match file.try_lock_exclusive() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(_) => true,
    }
}

fn launch_app(background: bool) -> Result<bool, String> {
    if app_running() {
        return Ok(false);
    }
    if let Some(app_user_model_id) = store_app_user_model_id() {
        let target = format!("shell:AppsFolder\\{app_user_model_id}");
        Command::new("explorer.exe")
            .arg(target)
            .spawn()
            .map_err(|error| {
                format!("No se pudo abrir Clear Download Manager desde Microsoft Store: {error}")
            })?;
        return Ok(true);
    }
    let executable = env::var_os("CACATOOLS_APP_EXE")
        .map(PathBuf::from)
        .or_else(|| {
            env::current_exe().ok().and_then(|path| {
                let mut candidates = Vec::new();
                if let Some(dir) = path.parent() {
                    candidates.push(dir.join("Clear Download Manager.exe"));
                    candidates.push(dir.join("CacaTools Download Manager.exe"));
                    candidates.push(dir.join("cacatools-desktop.exe"));
                    candidates.push(dir.join("cacatools.exe"));
                    if let Some(resources) = dir.parent() {
                        if let Some(root) = resources.parent() {
                            candidates.push(root.join("Clear Download Manager.exe"));
                            candidates.push(root.join("CacaTools Download Manager.exe"));
                            candidates.push(root.join("cacatools-desktop.exe"));
                            candidates.push(root.join("cacatools.exe"));
                        }
                    }
                }
                candidates.into_iter().find(|candidate| candidate.is_file())
            })
        })
        .ok_or_else(|| "Clear Download Manager no está instalado".to_string())?;
    if !executable.is_file() {
        return Err("No se encontró Clear Download Manager.exe".into());
    }
    let mut command = Command::new(executable);
    if background {
        command.arg("--background-startup");
    }
    command
        .spawn()
        .map_err(|error| format!("No se pudo abrir Clear Download Manager: {error}"))?;
    Ok(true)
}

fn safe_url(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    (value.starts_with("https://") || value.starts_with("http://"))
        && !value.contains('\n')
        && !value.contains('\r')
}

fn background_requested(payload: &Value) -> bool {
    payload
        .get("windowMode")
        .or_else(|| payload.get("windowBehavior"))
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("background"))
}

fn wait_for_capture_response(request_id: &str, request_file: &PathBuf) -> Value {
    let response_file = response_path().join(format!("{request_id}.json"));
    let deadline = SystemTime::now()
        .checked_add(std::time::Duration::from_millis(
            CAPTURE_RESPONSE_TIMEOUT_MS,
        ))
        .unwrap_or(SystemTime::now());
    loop {
        if let Ok(body) = fs::read_to_string(&response_file) {
            let _ = fs::remove_file(&response_file);
            return serde_json::from_str(&body).unwrap_or_else(
                |_| json!({ "ok": false, "status": "temporary_failure", "requestId": request_id }),
            );
        }
        if SystemTime::now() >= deadline {
            let _ = fs::remove_file(request_file);
            return json!({
                "ok": false,
                "status": "temporary_failure",
                "requestId": request_id,
                "error": "Clear Download Manager no confirmó la captura a tiempo"
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn write_activation_request(origin: &str) -> Result<String, String> {
    fs::create_dir_all(inbox_path()).map_err(|error| error.to_string())?;
    let id = next_request_id("-activate");
    let request = json!({
        "id": id,
        "action": "activate_app",
        "payload": Value::Null,
        "origin": origin,
        "createdAt": now()
    });
    let temporary = inbox_path().join(format!(".{id}.tmp"));
    let final_path = inbox_path().join(format!("{id}.json"));
    fs::write(
        &temporary,
        serde_json::to_vec(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, &final_path).map_err(|error| error.to_string())?;
    Ok(id)
}

fn enqueue(action: &str, payload: &Value, origin: &str) -> Result<Value, String> {
    let source = payload
        .get("finalUrl")
        .or_else(|| payload.get("url"))
        .or_else(|| payload.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if source.is_empty() || source.len() > 4096 || !safe_url(source) {
        return Err("La fuente debe ser una URL HTTP o HTTPS válida".into());
    }
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(1);
    if items > 100 {
        return Err("El lote supera el límite permitido".into());
    }
    fs::create_dir_all(inbox_path()).map_err(|error| error.to_string())?;
    let id = next_request_id("");
    let request = json!({ "id": id, "action": action, "payload": payload, "origin": origin, "createdAt": now() });
    let temporary = inbox_path().join(format!(".{id}.tmp"));
    let final_path = inbox_path().join(format!("{id}.json"));
    fs::write(
        &temporary,
        serde_json::to_vec(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, &final_path).map_err(|error| error.to_string())?;
    let started = match launch_app(background_requested(payload)) {
        Ok(started) => started,
        Err(error) if action == "browser_download_capture" => {
            let _ = fs::remove_file(&final_path);
            return Ok(json!({ "ok": false, "status": "temporary_failure", "error": error }));
        }
        Err(error) => return Err(error),
    };
    if action == "browser_download_capture" {
        return Ok(wait_for_capture_response(&id, &final_path));
    }
    Ok(json!({ "ok": true, "requestId": id, "appStarted": started }))
}

fn open_job(payload: &Value, origin: &str) -> Result<Value, String> {
    let job_id = payload
        .get("jobId")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "La descarga seleccionada no es válida".to_string())?;
    let mode = if payload.get("mode").and_then(Value::as_str) == Some("play") {
        "play"
    } else {
        "open"
    };
    let request_id = next_request_id("-job");
    let background = mode == "play";
    let request = json!({
        "id": request_id,
        "action": "open_job",
        "payload": { "jobId": job_id, "mode": mode, "windowMode": if background { "background" } else { "foreground" } },
        "origin": origin,
        "createdAt": now()
    });
    fs::create_dir_all(inbox_path()).map_err(|error| error.to_string())?;
    let temporary = inbox_path().join(format!(".{request_id}.tmp"));
    let final_path = inbox_path().join(format!("{request_id}.json"));
    fs::write(
        &temporary,
        serde_json::to_vec(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, final_path).map_err(|error| error.to_string())?;
    let started = launch_app(background)?;
    Ok(json!({ "ok": true, "requestId": request_id, "appStarted": started }))
}

fn write_control_request(action: &str, payload: Value, origin: &str) -> Result<Value, String> {
    fs::create_dir_all(inbox_path()).map_err(|error| error.to_string())?;
    let request_id = next_request_id("-control");
    let request = json!({
        "id": request_id,
        "action": action,
        "payload": payload,
        "origin": origin,
        "createdAt": now()
    });
    let temporary = inbox_path().join(format!(".{request_id}.tmp"));
    let final_path = inbox_path().join(format!("{request_id}.json"));
    fs::write(
        &temporary,
        serde_json::to_vec(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, final_path).map_err(|error| error.to_string())?;
    let started = launch_app(true)?;
    Ok(json!({ "ok": true, "requestId": request_id, "appStarted": started }))
}

fn handle(message: Value) -> Value {
    let action = message
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("ping")
        .trim()
        .to_ascii_lowercase();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    let origin = message
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("native-messaging");
    match action.as_str() {
        "ping" => {
            json!({ "ok": true, "host": HOST_NAME, "protocolVersion": 1, "appRunning": app_running(), "appVersion": env!("CARGO_PKG_VERSION") })
        }
        "capabilities" => {
            json!({ "ok": true, "protocolVersion": 1, "actions": ["ping", "capabilities", "enqueue", "analyze", "browser_download_capture", "open_app", "activate_app", "open_job", "open_player", "list_jobs", "job_action", "set_job_options", "get_status"], "sourceTypes": ["video", "audio", "playlist", "direct_file", "generic_url"] })
        }
        "get_status" => {
            json!({ "ok": true, "appRunning": app_running(), "pendingRequests": fs::read_dir(inbox_path()).map(|items| items.count()).unwrap_or(0), "state": read_extension_state() })
        }
        "open_app" | "activate_app" => match launch_app(false) {
            Ok(started) => {
                if !started {
                    let _ = write_activation_request(origin);
                }
                json!({ "ok": true, "started": started })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "open_job" => match open_job(&payload, origin) {
            Ok(value) => value,
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "open_player" => {
            let job_id = payload
                .get("jobId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_i64)
                .filter(|value| *value > 0);
            let Some(job_id) = job_id else {
                return json!({ "ok": false, "error": "La descarga seleccionada no es válida" });
            };
            write_control_request(
                "open_player",
                json!({ "jobId": job_id, "mode": "play", "windowMode": "background" }),
                origin,
            )
            .unwrap_or_else(|error| json!({ "ok": false, "error": error }))
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
            write_control_request(
                "job_action",
                json!({ "jobId": job_id, "action": action_name, "confirmed": payload.get("confirmed").and_then(Value::as_bool).unwrap_or(false), "windowMode": "background" }),
                origin,
            )
            .unwrap_or_else(|error| json!({ "ok": false, "error": error }))
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
            write_control_request("set_job_options", json!({ "jobId": payload.get("jobId").or_else(|| payload.get("id")), "options": payload.get("options"), "windowMode": "background" }), origin)
                .unwrap_or_else(|error| json!({ "ok": false, "error": error }))
        }
        "enqueue" | "analyze" | "browser_download_capture" => {
            match enqueue(&action, &payload, origin) {
                Ok(value) => value,
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        _ => json!({ "ok": false, "error": "Acción no compatible" }),
    }
}

fn read_message(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Tamaño de mensaje no permitido",
        ));
    }
    let mut body = vec![0_u8; size];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    loop {
        match read_message(&mut reader) {
            Ok(Some(message)) => {
                if write_message(&mut writer, &handle(message)).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                let _ = write_message(
                    &mut writer,
                    &json!({ "ok": false, "error": error.to_string() }),
                );
                break;
            }
        }
    }
    let _ = File::open(app_lock_path());
}
