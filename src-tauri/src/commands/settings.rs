use crate::*;
use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

fn parse_windows_ui_language_buffer(buffer: &[u16]) -> Vec<String> {
    buffer
        .split(|unit| *unit == 0)
        .take_while(|language| !language.is_empty())
        .filter_map(|language| String::from_utf16(language).ok())
        .collect()
}

#[cfg(windows)]
fn windows_user_preferred_ui_languages() -> Vec<String> {
    const MUI_LANGUAGE_NAME: u32 = 0x8;
    const MAX_LANGUAGE_BUFFER_CHARS: u32 = 4096;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            language_count: *mut u32,
            language_buffer: *mut u16,
            buffer_chars: *mut u32,
        ) -> i32;
    }

    let mut language_count = 0_u32;
    let mut buffer_chars = 0_u32;
    // Windows returns the required buffer length on this sizing call. The
    // actual result is checked below after allocating exactly that many units.
    let _ = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            std::ptr::null_mut(),
            &mut buffer_chars,
        )
    };
    if buffer_chars == 0 || buffer_chars > MAX_LANGUAGE_BUFFER_CHARS {
        return Vec::new();
    }

    let mut buffer = vec![0_u16; buffer_chars as usize];
    let mut returned_chars = buffer_chars;
    let succeeded = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            buffer.as_mut_ptr(),
            &mut returned_chars,
        )
    };
    if succeeded == 0 || returned_chars as usize > buffer.len() {
        return Vec::new();
    }
    buffer.truncate(returned_chars as usize);
    parse_windows_ui_language_buffer(&buffer)
}

#[tauri::command]
pub(crate) fn get_system_ui_languages() -> Vec<String> {
    #[cfg(windows)]
    {
        windows_user_preferred_ui_languages()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod system_ui_language_tests {
    use super::parse_windows_ui_language_buffer;

    #[test]
    fn parses_the_ordered_windows_language_multistring() {
        let buffer: Vec<u16> = "en-US\0es-MX\0\0".encode_utf16().collect();
        assert_eq!(
            parse_windows_ui_language_buffer(&buffer),
            vec!["en-US", "es-MX"]
        );
    }
}

const APPLICATION_PREFERENCE_SETTING_KEYS: &[&str] = &[
    "appearance_v2",
    "appearance_v1",
    "window_behavior_v1",
    "preparation_window_v1",
    "experience_v1",
    "media_session_v1",
    "downloads_dir",
    "download_concurrency_v1",
    "download_behavior_v1",
    "download_bandwidth_v1",
];

fn delete_application_preference_rows(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for key in APPLICATION_PREFERENCE_SETTING_KEYS {
        transaction
            .execute("DELETE FROM settings WHERE key=?1", [key])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn default_download_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    if cfg!(feature = "qa-component-manager") {
        return Ok(app_data_dir.join("Downloads"));
    }
    if let Some(path) =
        crate::cdm_environment_path_override("CDM_DOWNLOADS_DIR", "CACATOOLS_DOWNLOADS_DIR")
    {
        return Ok(path);
    }
    let base = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| app_data_dir.join("Downloads"));
    crate::migrate_legacy_downloads_directory(&base).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn reset_application_preferences(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let default_downloads_dir = default_download_directory(&app)?;
    crate::set_startup_behavior(false)?;
    crate::set_application_icon(&app, "celeste")?;

    {
        let mut connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        delete_application_preference_rows(&mut connection)?;
    }

    *state
        .downloads_dir
        .lock()
        .map_err(|_| "No se pudo restablecer la carpeta de descargas".to_string())? =
        default_downloads_dir;
    *state
        .window_behavior
        .lock()
        .map_err(|_| "No se pudo restablecer el comportamiento de la ventana".to_string())? =
        WindowBehaviorSettings::default();
    state
        .dispatcher
        .update_concurrency(DownloadConcurrencySettings::default());
    crate::windows::backdrop::apply_to_all(&app, "mica");
    Ok(())
}

#[tauri::command]
pub(crate) fn get_appearance_settings(
    state: State<'_, LocalState>,
) -> Result<Option<AppearanceSettings>, String> {
    crate::settings::get_appearance_settings(state)
}

#[tauri::command]
pub(crate) fn save_appearance_settings(
    app: AppHandle,
    appearance: AppearanceSettings,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let saved = crate::settings::save_appearance_settings(appearance, state)?;
    let revision = saved.revision;
    crate::windows::backdrop::apply_to_all(&app, &saved.surface_mode);
    app.emit(
        "appearance-changed",
        serde_json::json!({
            "appearance": saved,
            "revision": revision,
            "persisted": true,
            "sourceWindow": "command"
        }),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn window_behavior_settings(
    state: State<'_, LocalState>,
) -> Result<WindowBehaviorSettings, String> {
    crate::settings::window_behavior_settings(state)
}

#[tauri::command]
pub(crate) fn save_window_behavior_settings(
    settings: WindowBehaviorSettings,
    state: State<'_, LocalState>,
) -> Result<WindowBehaviorSettings, String> {
    crate::settings::save_window_behavior_settings(settings, state)
}

#[tauri::command]
pub(crate) fn get_experience_settings(
    state: State<'_, LocalState>,
) -> Result<ExperienceSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    Ok(crate::settings::read_experience_settings(&connection))
}

#[tauri::command]
pub(crate) fn save_experience_settings(
    settings: ExperienceSettings,
    state: State<'_, LocalState>,
) -> Result<ExperienceSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    crate::settings::persist_experience_settings(&connection, &settings)
}

#[tauri::command]
pub(crate) fn get_bandwidth_settings(
    state: State<'_, LocalState>,
) -> Result<BandwidthSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    Ok(crate::downloads::read_bandwidth_settings(&connection))
}

#[tauri::command]
pub(crate) fn save_bandwidth_settings(
    settings: BandwidthSettings,
    state: State<'_, LocalState>,
) -> Result<BandwidthSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    crate::downloads::persist_bandwidth_settings(&connection, settings)
}

#[tauri::command]
pub(crate) fn set_download_speed_limit(
    id: i64,
    settings: BandwidthSettings,
    state: State<'_, LocalState>,
) -> Result<BandwidthSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    crate::downloads::persist_job_bandwidth_settings(&connection, id, settings)
}

#[tauri::command]
pub(crate) fn set_playlist_speed_limit(
    batch_id: i64,
    settings: BandwidthSettings,
    state: State<'_, LocalState>,
) -> Result<BandwidthSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    crate::downloads::persist_playlist_bandwidth_settings(&connection, batch_id, settings)
}

#[tauri::command]
pub(crate) fn save_download_concurrency(
    settings: DownloadConcurrencySettings,
    state: State<'_, LocalState>,
) -> Result<DownloadConcurrencySettings, String> {
    let saved = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        crate::downloads::persist_download_concurrency_settings(&connection, settings)?
    };
    state.dispatcher.update_concurrency(saved);
    Ok(saved)
}

#[tauri::command]
pub(crate) fn save_download_behavior_settings(
    settings: DownloadBehaviorSettings,
    state: State<'_, LocalState>,
) -> Result<DownloadBehaviorSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    crate::downloads::persist_download_behavior_settings(&connection, settings)
}

#[cfg(test)]
mod preference_reset_tests {
    use super::*;

    #[test]
    fn reset_removes_only_preference_rows_and_preserves_download_records() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        connection
            .execute_batch(
                "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
                 CREATE TABLE jobs(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
                 INSERT INTO settings(key,value) VALUES('appearance_v2','{}'),('custom-retained','value');
                 INSERT INTO jobs(id,title) VALUES(1,'Keeps download history');",
            )
            .expect("create fixture tables and rows");

        delete_application_preference_rows(&mut connection).expect("reset preference rows");

        let setting_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key='appearance_v2'",
                [],
                |row| row.get(0),
            )
            .expect("count reset preferences");
        let retained_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key='custom-retained'",
                [],
                |row| row.get(0),
            )
            .expect("count unrelated settings");
        let job_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
            .expect("count download records");
        assert_eq!(setting_count, 0);
        assert_eq!(retained_count, 1);
        assert_eq!(job_count, 1);
    }
}
