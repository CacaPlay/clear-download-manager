use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(windows)]
fn apply_window(window: &WebviewWindow, surface_mode: &str) -> bool {
    if surface_mode == "mica" {
        window_vibrancy::apply_mica(window, None).is_ok()
    } else {
        let _ = window_vibrancy::clear_mica(window);
        true
    }
}

#[cfg(not(windows))]
fn apply_window(_window: &WebviewWindow, surface_mode: &str) -> bool {
    surface_mode != "mica"
}

pub(crate) fn apply_to_window(window: &WebviewWindow, surface_mode: &str) {
    let _ = apply_window(window, surface_mode);
}

pub(crate) fn apply_to_all(app: &AppHandle, surface_mode: &str) {
    for label in ["main", "player", "media-prep", "playlist-prep", "http-prep"] {
        if let Some(window) = app.get_webview_window(label) {
            apply_to_window(&window, surface_mode);
        }
    }
}
