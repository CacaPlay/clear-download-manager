use crate::{tools::ipc::ToolUpdateStatus, LocalState};
use tauri::{AppHandle, State};

#[tauri::command]
pub(crate) fn get_tool_update_status(app: AppHandle) -> ToolUpdateStatus {
    crate::tools::ipc::get_tool_update_status(&app)
}

#[tauri::command]
pub(crate) async fn check_tool_updates_now(app: AppHandle) -> ToolUpdateStatus {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::tools::ipc::check_tool_updates_now(&worker_app)
    })
    .await
    .unwrap_or_else(|_| crate::tools::ipc::get_tool_update_status(&app))
}

#[tauri::command]
pub(crate) async fn apply_available_tool_update(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<ToolUpdateStatus, String> {
    let external_processes = state.external_processes.clone();
    let worker_app = app.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::tools::ipc::apply_available_tool_update(&worker_app, &external_processes)
    })
    .await
    .unwrap_or_else(|_| crate::tools::ipc::get_tool_update_status(&app)))
}
