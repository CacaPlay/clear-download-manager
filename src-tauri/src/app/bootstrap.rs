use std::{
    collections::HashSet,
    fs::OpenOptions,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

use serde_json::{json, Value};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

use crate::{extension_bridge, kill_process_tree, terminate_external_processes, LocalState};

static APP_INSTANCE_LOCK: OnceLock<std::fs::File> = OnceLock::new();
pub(crate) static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
pub(crate) const MAIN_TRAY_ID: &str = "main-tray";

fn application_icon_image(variant: &str) -> Result<Image<'static>, String> {
    let bytes: &'static [u8] = match variant {
        "azul" => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-azul.png"
        )),
        "morado" => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-morado.png"
        )),
        "naranja" => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-naranja.png"
        )),
        "rojo" => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-rojo.png"
        )),
        "verde" => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-verde.png"
        )),
        _ => include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/icons/brand/clear-download-manager-celeste.png"
        )),
    };
    Image::from_bytes(bytes)
        .map(Image::to_owned)
        .map_err(|error| format!("No se pudo cargar el icono de Clear Download Manager: {error}"))
}

pub(crate) fn set_application_icon(app: &AppHandle, variant: &str) -> Result<(), String> {
    let image = application_icon_image(variant)?;
    // The main window is the only native-icon authority. Preparation and
    // player windows keep their own internal brand image and must not race
    // this command with a stale appearance snapshot.
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(image.clone()).map_err(|error| {
            format!("No se pudo actualizar el icono de la ventana principal: {error}")
        })?;
    }
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        tray.set_icon(Some(image))
            .map_err(|error| format!("No se pudo actualizar el icono de la bandeja: {error}"))?;
    }
    Ok(())
}

pub(crate) fn acquire_instance_lock(data_dir: &Path) -> Result<(), String> {
    use fs2::FileExt;
    let lock_path = data_dir.join("application.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("No se pudo preparar el bloqueo de instancia: {error}"))?;
    file.try_lock_exclusive()
        .map_err(|_| "CacaTools ya está ejecutándose en segundo plano.".to_string())?;
    let _ = APP_INSTANCE_LOCK.set(file);
    Ok(())
}

pub(crate) fn install_tray(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "show",
        "Abrir Clear Download Manager",
        true,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(app, "hide", "Ocultar en la bandeja", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir completamente", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    let mut tray = TrayIconBuilder::with_id(MAIN_TRAY_ID);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.menu(&menu)
        .tooltip("Clear Download Manager")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => request_full_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub(crate) fn prepare_full_exit(app: &AppHandle) {
    if EXIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let state = app.state::<LocalState>();
    let process_ids = state
        .active_media_pids
        .lock()
        .map(|processes| {
            processes
                .values()
                .copied()
                .filter(|pid| *pid > 0)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    for pid in process_ids {
        kill_process_tree(pid);
    }
    let external_job_ids = state
        .external_processes
        .lock()
        .map(|processes| processes.keys().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    for job_id in external_job_ids {
        terminate_external_processes(&state.external_processes, job_id);
    }
    if let Ok(mut processes) = state.active_media_pids.lock() {
        processes.clear();
    }

    if let Ok(connection) = state.connection.lock() {
        let _ = connection.execute_batch(
            "UPDATE jobs
                SET status='queued',
                    detail='Interrumpida al salir · lista para continuar',
                    updated_at=CURRENT_TIMESTAMP
              WHERE status='running';
             UPDATE playlist_items SET status='queued' WHERE status='running';
             UPDATE playlist_batches
                SET status='queued', updated_at=CURRENT_TIMESTAMP
              WHERE status='running';
             UPDATE torrent_jobs
                SET speed_bps=0, eta_seconds=NULL, updated_at=CURRENT_TIMESTAMP
              WHERE job_id IN (SELECT id FROM jobs WHERE status='queued');",
        );
    };
}

pub(crate) fn request_full_exit(app: &AppHandle) {
    prepare_full_exit(app);
    app.exit(0);
}

pub(crate) fn exit_application(app: AppHandle) {
    request_full_exit(&app);
}

pub(crate) fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se encontró la ventana principal de CacaTools".to_string())?;
    let preparation_was_open = window.is_enabled().map(|enabled| !enabled).unwrap_or(false);
    // show() alone does not restore a minimized/hidden WebView on Windows.
    // Restore first, then focus so a browser page cannot keep the app behind it.
    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("No se pudo mostrar CacaTools: {error}"))?;
    let focus_result = window
        .set_focus()
        .map_err(|error| format!("No se pudo enfocar CacaTools: {error}"));
    let _ = window.set_always_on_top(false);
    focus_result?;
    crate::subwindows::restore_preparation_if_modal(&app, preparation_was_open);
    Ok(())
}

pub(crate) fn show_main_window(app: AppHandle) -> Result<(), String> {
    // The initial WebView render calls this command after loading. A process
    // launched by Windows with --background must remain hidden until a bridge
    // request explicitly wakes it.
    if is_background_launch() {
        return Ok(());
    }
    focus_main_window(app)
}

pub(crate) fn wake_main_window(app: AppHandle) -> Result<(), String> {
    focus_main_window(app)
}

pub(crate) fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn is_background_launch() -> bool {
    std::env::args()
        .any(|argument| argument == "--background" || argument == "--background-startup")
}

pub(crate) fn startup_status() -> Value {
    extension_bridge::startup_status()
}

pub(crate) fn set_startup_behavior(enabled: bool) -> Result<Value, String> {
    extension_bridge::set_startup_enabled(enabled)
}

pub(crate) fn repair_windows_integration() -> Result<Value, String> {
    extension_bridge::initialize_app_bridge()?;
    let startup = extension_bridge::set_startup_enabled(true)?;
    Ok(json!({
        "startup": startup,
        "extension": extension_bridge::extension_bridge_status(),
        "repaired": true
    }))
}

pub fn run_native_messaging_host() {
    extension_bridge::run_native_messaging_host();
}

pub(crate) fn run() {
    crate::run_app();
}
