use crate::*;

#[tauri::command]
pub(crate) fn runtime_status(state: State<'_, LocalState>) -> serde_json::Value {
    crate::runtime_status(state)
}

#[tauri::command]
pub(crate) fn exit_application(app: AppHandle) {
    crate::exit_application(app)
}

#[tauri::command]
pub(crate) fn focus_main_window(app: AppHandle) -> Result<(), String> {
    crate::focus_main_window(app)
}

#[tauri::command]
pub(crate) fn show_main_window(app: AppHandle) -> Result<(), String> {
    crate::show_main_window(app)
}

#[tauri::command]
pub(crate) fn wake_main_window(app: AppHandle) -> Result<(), String> {
    crate::wake_main_window(app)
}

#[tauri::command]
pub(crate) fn hide_main_window(app: AppHandle) -> Result<(), String> {
    crate::hide_main_window(app)
}

#[tauri::command]
pub(crate) fn is_background_launch() -> bool {
    crate::is_background_launch()
}

#[tauri::command]
pub(crate) fn startup_status() -> Value {
    crate::startup_status()
}

#[tauri::command]
pub(crate) fn set_startup_behavior(enabled: bool) -> Result<Value, String> {
    crate::set_startup_behavior(enabled)
}

#[tauri::command]
pub(crate) fn repair_windows_integration() -> Result<Value, String> {
    crate::repair_windows_integration()
}

#[tauri::command]
pub(crate) fn set_application_icon(app: AppHandle, variant: String) -> Result<(), String> {
    crate::set_application_icon(&app, &variant)
}
