use std::sync::{atomic::AtomicU64, Arc};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{invalidate_window_operation, LocalState};

pub(crate) async fn build_media_player_window(
    app: AppHandle,
    url: WebviewUrl,
) -> Result<(), String> {
    crate::subwindows::run_on_main_thread(app.clone(), move || {
        let (width, height, min_width, min_height) =
            crate::subwindows::remembered_window_size(&app, "player", 1470.0, 900.0, 880.0, 520.0);
        let window = WebviewWindowBuilder::new(&app, "player", url)
            .title("Reproductor · Clear Download Manager")
            .inner_size(width, height)
            .min_inner_size(min_width, min_height)
            .center()
            .resizable(true)
            .decorations(false)
            .visible(true)
            .build()
            .map_err(|error| format!("No se pudo abrir el reproductor: {error}"))?;
        crate::subwindows::restore_window_geometry(&app, "player", &window, width, height);
        let app_for_event = app.clone();
        let geometry_window = window.clone();
        let geometry_revision = Arc::new(AtomicU64::new(0));
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { .. } => {
                crate::subwindows::remember_window_geometry(
                    &app_for_event,
                    "player",
                    &geometry_window,
                );
                invalidate_window_operation(
                    &app_for_event.state::<LocalState>().preparation_operations,
                    "player",
                );
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                crate::subwindows::schedule_geometry_persist(
                    &app_for_event,
                    "player",
                    &geometry_window,
                    &geometry_revision,
                );
            }
            _ => {}
        });
        Ok(())
    })
    .await
}
