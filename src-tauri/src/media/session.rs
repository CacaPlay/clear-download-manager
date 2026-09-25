use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::LocalState;

const MEDIA_SESSION_SETTINGS_KEY: &str = "media_session_v1";

/// Per-job session material is kept in memory and sent only to the local
/// yt-dlp process. The global setting stores consent and an optional local
/// Netscape-file path, never the cookie contents.
#[derive(Clone, Debug, Default)]
pub(crate) struct MediaSessionOptions {
    pub(crate) use_brave_cookies: bool,
    pub(crate) cookies_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMediaSessionSettings {
    #[serde(default)]
    use_brave_cookies: bool,
    #[serde(default)]
    cookies_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSessionSettingsSnapshot {
    pub(crate) use_brave_cookies: bool,
    pub(crate) cookies_path: Option<String>,
    pub(crate) cookies_file_available: bool,
}

fn read_stored_media_session_settings(
    connection: &Connection,
) -> Result<StoredMediaSessionSettings, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![MEDIA_SESSION_SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(value
        .and_then(|json| serde_json::from_str::<StoredMediaSessionSettings>(&json).ok())
        .unwrap_or_default())
}

fn media_session_settings_snapshot(
    stored: StoredMediaSessionSettings,
) -> MediaSessionSettingsSnapshot {
    let cookies_path = stored
        .cookies_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    MediaSessionSettingsSnapshot {
        use_brave_cookies: stored.use_brave_cookies && cookies_path.is_none(),
        cookies_file_available: cookies_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file()),
        cookies_path,
    }
}

pub(crate) fn stored_media_session_options(connection: &Connection) -> MediaSessionOptions {
    let Ok(stored) = read_stored_media_session_settings(connection) else {
        return MediaSessionOptions::default();
    };
    let snapshot = media_session_settings_snapshot(stored);
    if snapshot.use_brave_cookies {
        return MediaSessionOptions {
            use_brave_cookies: true,
            cookies_path: None,
        };
    }
    snapshot
        .cookies_path
        .filter(|path| Path::new(path).is_file())
        .map(|path| MediaSessionOptions {
            use_brave_cookies: false,
            cookies_path: Some(PathBuf::from(path)),
        })
        .unwrap_or_default()
}

pub(crate) fn media_session_settings(
    state: State<'_, LocalState>,
) -> Result<MediaSessionSettingsSnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    Ok(media_session_settings_snapshot(
        read_stored_media_session_settings(&connection)?,
    ))
}

pub(crate) fn save_media_session_settings(
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    state: State<'_, LocalState>,
) -> Result<MediaSessionSettingsSnapshot, String> {
    let session = validate_media_session_options(use_brave_cookies, cookies_path)?;
    let stored = StoredMediaSessionSettings {
        use_brave_cookies: session.use_brave_cookies,
        cookies_path: session
            .cookies_path
            .map(|path| path.to_string_lossy().to_string()),
    };
    let serialized = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![MEDIA_SESSION_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(media_session_settings_snapshot(stored))
}

pub(crate) fn saved_media_session_for_db(db_path: &Path) -> MediaSessionOptions {
    Connection::open(db_path)
        .ok()
        .map(|connection| stored_media_session_options(&connection))
        .unwrap_or_default()
}

pub(crate) fn validate_media_session_options(
    use_brave_cookies: bool,
    cookies_path: Option<String>,
) -> Result<MediaSessionOptions, String> {
    if use_brave_cookies
        && cookies_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("Selecciona cookies de Brave o un archivo Netscape, no ambos".into());
    }
    let cookies_path = cookies_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| validate_netscape_cookie_file(&path))
        .transpose()?;
    Ok(MediaSessionOptions {
        use_brave_cookies,
        cookies_path,
    })
}

pub(crate) fn validate_netscape_cookie_file(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("El archivo de cookies debe ser una ruta local absoluta".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("No se pudo validar el archivo de cookies: {error}"))?;
    if !canonical.is_file() {
        return Err("El archivo seleccionado no existe o no es un archivo".into());
    }
    if !canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
    {
        return Err("El archivo de cookies debe tener extensión .txt".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > 16 * 1024 * 1024 {
        return Err("El archivo Netscape de cookies está vacío o es demasiado grande".into());
    }
    let file = File::open(&canonical)
        .map_err(|error| format!("No se pudo abrir el archivo de cookies: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut valid_rows = 0usize;
    for _ in 0..128 {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("No se pudo leer el archivo de cookies: {error}"))?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.split('\t').count() == 7 && !trimmed.contains('\0') {
            valid_rows += 1;
        }
    }
    if valid_rows == 0 {
        return Err("El archivo no parece estar en formato Netscape de cookies".into());
    }
    Ok(canonical)
}
