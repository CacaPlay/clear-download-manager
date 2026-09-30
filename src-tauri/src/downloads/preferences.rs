use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

pub(crate) const DOWNLOAD_BEHAVIOR_SETTINGS_KEY: &str = "download_behavior_v1";
pub(crate) const DOWNLOAD_LOCATION_CANCELLED: &str = "download_location_cancelled";
pub(crate) static DOWNLOAD_DIRECTORY_PICKER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadBehaviorSettings {
    pub(crate) create_category_folders: bool,
    pub(crate) use_original_file_names: bool,
    pub(crate) ask_for_download_location: bool,
    pub(crate) resume_interrupted_downloads: bool,
}

impl Default for DownloadBehaviorSettings {
    fn default() -> Self {
        Self {
            create_category_folders: true,
            use_original_file_names: true,
            ask_for_download_location: false,
            resume_interrupted_downloads: true,
        }
    }
}

pub(crate) fn read_download_behavior_settings(connection: &Connection) -> DownloadBehaviorSettings {
    let stored = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![DOWNLOAD_BEHAVIOR_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(stored) = stored else {
        return DownloadBehaviorSettings::default();
    };
    match serde_json::from_str::<DownloadBehaviorSettings>(&stored) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[downloads] persisted behavior settings rejected; using defaults: {error}");
            DownloadBehaviorSettings::default()
        }
    }
}

pub(crate) fn persist_download_behavior_settings(
    connection: &Connection,
    settings: DownloadBehaviorSettings,
) -> Result<DownloadBehaviorSettings, String> {
    let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![DOWNLOAD_BEHAVIOR_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(settings)
}

/// Ask for a per-job folder without changing the user's default Downloads folder.
/// `None` means the preference is off; cancellation is an explicit error so the
/// caller can stop before it creates a queued job.
pub(crate) fn choose_job_download_root(
    app: &AppHandle,
    state: &crate::LocalState,
) -> Result<Option<PathBuf>, String> {
    let should_ask = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        read_download_behavior_settings(&connection).ask_for_download_location
    };
    if !should_ask {
        return Ok(None);
    }

    let _picker_guard = DOWNLOAD_DIRECTORY_PICKER_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "Ya hay un selector de destino abierto".to_string())?;
    let selected = app
        .dialog()
        .file()
        .set_title("Elegir carpeta para esta descarga")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Err(DOWNLOAD_LOCATION_CANCELLED.into());
    };
    let selected = selected
        .into_path()
        .map_err(|error| format!("La carpeta seleccionada no es válida: {error}"))?;
    std::fs::create_dir_all(&selected)
        .map_err(|error| format!("No se pudo preparar la carpeta: {error}"))?;
    let selected = selected
        .canonicalize()
        .map_err(|error| format!("No se pudo validar la carpeta: {error}"))?;
    Ok(Some(selected))
}

pub(crate) fn category_folder_for_filename(filename: &str) -> &'static str {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" | "mkv" | "webm" | "mov" | "avi" | "mpeg" | "mpg" => "Videos",
        "mp3" | "m4a" | "aac" | "flac" | "wav" | "ogg" | "opus" | "wma" => "Audio",
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "ppt" | "pptx" | "xls" | "xlsx"
        | "csv" | "epub" => "Documents",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "avif" | "tif" | "tiff" => {
            "Images"
        }
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "cab" | "jar" => "Archives",
        "exe" | "msi" | "msix" | "appx" | "appxbundle" => "Applications",
        _ => "Other",
    }
}

pub(crate) fn category_folder_for_media_mode(output_mode: &str) -> &'static str {
    if output_mode.starts_with("audio_") {
        "Audio"
    } else {
        "Videos"
    }
}

pub(crate) fn categorized_download_dir(root: &Path, category: &str, enabled: bool) -> PathBuf {
    if enabled {
        root.join(category)
    } else {
        root.to_path_buf()
    }
}

pub(crate) fn original_or_generated_filename(
    source_filename: &str,
    custom_filename: Option<&str>,
    use_original_file_names: bool,
) -> String {
    if let Some(custom) = custom_filename
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return super::sanitize_filename(custom);
    }
    if use_original_file_names {
        return super::sanitize_filename(source_filename);
    }
    let extension = Path::new(source_filename)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 16
                && value.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "bin".into());
    format!("descarga.{extension}")
}
