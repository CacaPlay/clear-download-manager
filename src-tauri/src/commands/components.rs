use crate::components::{ComponentId, ComponentState, ComponentStatus};
use crate::LocalState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentDownloadProgress {
    id: ComponentId,
    state: ComponentState,
    received_bytes: u64,
    total_bytes: u64,
    progress_percent: u8,
}

#[tauri::command]
pub(crate) fn list_components(state: State<'_, LocalState>) -> Vec<ComponentStatus> {
    state.component_manager.list_components()
}

#[tauri::command]
pub(crate) fn verify_component(
    id: ComponentId,
    state: State<'_, LocalState>,
) -> Result<ComponentStatus, String> {
    state
        .component_manager
        .verify_component(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn install_component_from_package(
    id: ComponentId,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Option<ComponentStatus>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Choose a local Clear component package")
        .add_filter("Clear component package", &["cdmcomponent"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("The selected package path is invalid: {error}"))?;
    let status = state
        .component_manager
        .install_component_from_package_for(id, &path)
        .map_err(|error| error.to_string())?;
    state.refresh_component_runtime_slots();
    Ok(Some(status))
}

#[tauri::command]
pub(crate) fn refresh_component_catalog(
    state: State<'_, LocalState>,
) -> Result<Vec<ComponentStatus>, String> {
    state
        .component_manager
        .refresh_component_catalog()
        .map_err(|error| {
            eprintln!("[components] signed catalog refresh failed: {error}");
            "No se pudo verificar el catálogo firmado de componentes.".to_string()
        })
}

#[tauri::command]
pub(crate) fn install_component_from_catalog(
    id: ComponentId,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<ComponentStatus, String> {
    let result =
        state
            .component_manager
            .install_component_from_catalog(id, |state, received, total| {
                let payload = ComponentDownloadProgress {
                    id,
                    state,
                    received_bytes: received,
                    total_bytes: total,
                    progress_percent: received
                        .saturating_mul(100)
                        .checked_div(total)
                        .unwrap_or(0)
                        .min(100) as u8,
                };
                let _ = app.emit("component-download-progress", payload);
            });
    match result {
        Ok(status) => {
            state.refresh_component_runtime_slots();
            Ok(status)
        }
        Err(error) => {
            eprintln!("[components] remote installation failed for {id}: {error}");
            Err("No se pudo verificar o instalar el componente. Comprueba la conexión e inténtalo más tarde.".into())
        }
    }
}

#[tauri::command]
pub(crate) fn remove_component(
    id: ComponentId,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let active_workers = state
        .active_media_pids
        .lock()
        .map(|processes| !processes.is_empty())
        .unwrap_or(true);
    let active_processes = state
        .external_processes
        .lock()
        .map(|processes| processes.values().any(|children| !children.is_empty()))
        .unwrap_or(true);
    let active_preparation = state
        .preparation_operations
        .lock()
        .map(|operations| {
            operations
                .values()
                .any(|operation| !crate::window_operation_is_cancelled(operation))
        })
        .unwrap_or(true);
    if active_workers || active_processes || active_preparation {
        return Err(
            "Pause or finish active media and torrent tasks before removing a component.".into(),
        );
    }
    state
        .component_manager
        .remove_component(id)
        .map_err(|error| error.to_string())?;
    state.refresh_component_runtime_slots();
    Ok(())
}
