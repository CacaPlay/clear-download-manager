use serde::Serialize;
use tauri::AppHandle;

const UPDATE_DISABLED_MESSAGE: &str =
    "Las actualizaciones de la aplicación están desactivadas en esta build local.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfigurationStatus {
    enabled: bool,
    configured: bool,
    store_managed: bool,
    current_version: String,
    channel: String,
    provider: String,
    endpoint: String,
    repository: String,
    configured_at: Option<String>,
    message: String,
}

#[derive(Serialize)]
pub struct AppUpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

pub fn updater_plugin_is_configured() -> bool {
    false
}

#[tauri::command]
pub fn updater_configuration_status(app: AppHandle) -> UpdaterConfigurationStatus {
    UpdaterConfigurationStatus {
        enabled: false,
        configured: false,
        store_managed: false,
        current_version: app.package_info().version.to_string(),
        channel: "local-qa".into(),
        provider: "disabled".into(),
        endpoint: String::new(),
        repository: String::new(),
        configured_at: None,
        message: UPDATE_DISABLED_MESSAGE.into(),
    }
}

#[tauri::command]
pub async fn check_for_app_update(_app: AppHandle) -> Result<Option<AppUpdateInfo>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn install_app_update(
    _app: AppHandle,
    _state: tauri::State<'_, crate::LocalState>,
) -> Result<(), String> {
    Err(UPDATE_DISABLED_MESSAGE.into())
}

#[tauri::command]
pub fn notify_app_update(_app: AppHandle, _version: String, _locale: String) -> Result<(), String> {
    Err(UPDATE_DISABLED_MESSAGE.into())
}
