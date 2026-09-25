use crate::*;

#[tauri::command]
pub(crate) fn preparation_modal_state() -> Vec<String> {
    crate::subwindows::active_preparation_labels()
}

#[tauri::command]
pub(crate) async fn open_preparation_window(
    kind: String,
    source: String,
    options: Option<Value>,
    app: AppHandle,
) -> Result<(), String> {
    crate::subwindows::open_preparation_window(kind, source, options, app).await
}

#[tauri::command]
pub(crate) async fn show_preparation_window(label: String, app: AppHandle) -> Result<(), String> {
    crate::subwindows::show_preparation_window(label, app).await
}

#[tauri::command]
pub(crate) async fn preparation_window_action(
    label: String,
    action: String,
    app: AppHandle,
) -> Result<(), String> {
    crate::subwindows::preparation_window_action(label, action, app).await
}

#[tauri::command]
pub(crate) async fn preparation_window_start_dragging(
    label: String,
    app: AppHandle,
) -> Result<(), String> {
    crate::subwindows::preparation_window_start_dragging(label, app).await
}
