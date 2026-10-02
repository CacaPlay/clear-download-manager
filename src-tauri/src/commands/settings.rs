use crate::*;
use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

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
