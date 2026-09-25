use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use crate::{
    begin_window_operation, invalidate_window_operation, persist_preparation_window_settings,
    read_preparation_window_settings, PreparationWindowGeometry, PreparationWindowSettings,
};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use url::form_urlencoded::Serializer;

const MEDIA_PREPARATION_LABEL: &str = "media-prep";
const PLAYLIST_PREPARATION_LABEL: &str = "playlist-prep";
const HTTP_PREPARATION_LABEL: &str = "http-prep";
static ACTIVE_PREPARATION_LABELS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub(crate) fn active_preparation_labels() -> Vec<String> {
    let mut labels = ACTIVE_PREPARATION_LABELS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .ok()
        .map(|labels| labels.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    labels.sort();
    labels
}

fn sync_main_dimming(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "cacatools-preparation-modal-state",
            serde_json::json!({ "activeLabels": active_preparation_labels() }),
        );
    }
}

fn mark_active_preparation(app: &AppHandle, label: &str) {
    if let Ok(mut active) = ACTIVE_PREPARATION_LABELS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        active.insert(label.to_string());
    }
    sync_main_dimming(app);
}

fn clear_active_preparation(app: &AppHandle, label: &str) {
    if let Ok(mut active) = ACTIVE_PREPARATION_LABELS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        active.remove(label);
    }
    sync_main_dimming(app);
}

fn preparation_config(
    kind: &str,
) -> Result<(&'static str, &'static str, f64, f64, f64, f64), String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "playlist" => Ok((
            PLAYLIST_PREPARATION_LABEL,
            "Preparar playlist - Clear Download Manager",
            1320.0,
            900.0,
            1050.0,
            700.0,
        )),
        "direct" | "http" => Ok((
            HTTP_PREPARATION_LABEL,
            "Preparar archivo HTTP - Clear Download Manager",
            680.0,
            320.0,
            680.0,
            320.0,
        )),
        "media" | "video" | "" => Ok((
            MEDIA_PREPARATION_LABEL,
            "Preparar multimedia - Clear Download Manager",
            1320.0,
            900.0,
            1050.0,
            700.0,
        )),
        _ => Err("El tipo de subventana no es valido".into()),
    }
}

fn fit_preparation_size(
    app: &AppHandle,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, f64, f64) {
    let (screen_width, screen_height) = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .map(|monitor| {
            let scale = monitor.scale_factor().max(1.0);
            (
                f64::from(monitor.size().width) / scale,
                f64::from(monitor.size().height) / scale,
            )
        })
        .unwrap_or((2560.0, 1440.0));

    let fitted_min_width = min_width.min((screen_width * 0.96).max(720.0));
    let fitted_min_height = min_height.min((screen_height * 0.94).max(520.0));
    let fitted_width = width.min(screen_width * 0.92).max(fitted_min_width);
    let fitted_height = height.min(screen_height * 0.88).max(fitted_min_height);
    (
        fitted_width.max(fitted_min_width),
        fitted_height.max(fitted_min_height),
        fitted_min_width,
        fitted_min_height,
    )
}

fn persisted_preparation_settings(app: &AppHandle) -> PreparationWindowSettings {
    let state = app.state::<crate::LocalState>();
    state
        .connection
        .lock()
        .map(|connection| read_preparation_window_settings(&connection))
        .unwrap_or_default()
}

fn persist_preparation_settings(app: &AppHandle, settings: &PreparationWindowSettings) {
    let state = app.state::<crate::LocalState>();
    if let Ok(connection) = state.connection.lock() {
        let _ = persist_preparation_window_settings(&connection, settings);
    };
}

fn geometry_for_label<'a>(
    settings: &'a PreparationWindowSettings,
    label: &str,
) -> &'a PreparationWindowGeometry {
    if label == "main" {
        &settings.main
    } else if label == "player" {
        &settings.player
    } else if label == PLAYLIST_PREPARATION_LABEL {
        &settings.playlist
    } else if label == HTTP_PREPARATION_LABEL {
        &settings.http
    } else {
        &settings.media
    }
}

fn set_geometry_for_label(
    settings: &mut PreparationWindowSettings,
    label: &str,
    geometry: PreparationWindowGeometry,
) {
    if label == "main" {
        settings.main = geometry;
    } else if label == "player" {
        settings.player = geometry;
    } else if label == PLAYLIST_PREPARATION_LABEL {
        settings.playlist = geometry;
    } else if label == HTTP_PREPARATION_LABEL {
        settings.http = geometry;
    } else {
        settings.media = geometry;
    }
}

pub(crate) fn remember_window_geometry(
    app: &AppHandle,
    label: &str,
    window: &tauri::WebviewWindow,
) {
    if label == HTTP_PREPARATION_LABEL {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut settings = persisted_preparation_settings(app);
    let geometry = if maximized {
        let mut geometry = geometry_for_label(&settings, label).clone();
        geometry.maximized = true;
        geometry
    } else {
        let Ok(size) = window.inner_size() else {
            return;
        };
        let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
        let position = window
            .outer_position()
            .ok()
            .map(|position| LogicalPosition::<f64>::from_physical(position, scale));
        PreparationWindowGeometry {
            width: (f64::from(size.width) / scale).round() as u32,
            height: (f64::from(size.height) / scale).round() as u32,
            x: position.map(|position| position.x.round() as i32),
            y: position.map(|position| position.y.round() as i32),
            maximized: false,
        }
    };
    set_geometry_for_label(&mut settings, label, geometry);
    persist_preparation_settings(app, &settings);
}

fn clamped_remembered_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    geometry: &PreparationWindowGeometry,
    width: f64,
    height: f64,
) -> Option<LogicalPosition<f64>> {
    let saved = LogicalPosition::<f64>::new(f64::from(geometry.x?), f64::from(geometry.y?));
    let saved_physical: PhysicalPosition<i32> =
        saved.to_physical(window.scale_factor().unwrap_or(1.0).max(1.0));
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            saved_physical.x >= position.x
                && saved_physical.x <= position.x.saturating_add(size.width as i32)
                && saved_physical.y >= position.y
                && saved_physical.y <= position.y.saturating_add(size.height as i32)
        })
        .or_else(|| {
            let current_name = window
                .current_monitor()
                .ok()
                .flatten()
                .and_then(|current| current.name().cloned());
            current_name
                .as_ref()
                .and_then(|name| monitors.iter().find(|monitor| monitor.name() == Some(name)))
        })
        .or_else(|| monitors.first())?;
    let scale = monitor.scale_factor().max(1.0);
    let work = monitor.work_area();
    let left = f64::from(work.position.x) / scale;
    let top = f64::from(work.position.y) / scale;
    let work_width = f64::from(work.size.width) / scale;
    let work_height = f64::from(work.size.height) / scale;
    let min_visible = 64.0;
    let min_x = left - width + min_visible;
    let max_x = (left + work_width - min_visible).max(min_x);
    let min_y = top - height + min_visible;
    let max_y = (top + work_height - min_visible).max(min_y);
    Some(LogicalPosition::<f64>::new(
        saved.x.clamp(min_x, max_x),
        saved.y.clamp(min_y, max_y),
    ))
}

pub(crate) fn schedule_geometry_persist(
    app: &AppHandle,
    label: &str,
    window: &tauri::WebviewWindow,
    revision: &Arc<AtomicU64>,
) {
    let token = revision.fetch_add(1, Ordering::Relaxed) + 1;
    let revision = Arc::clone(revision);
    let app = app.clone();
    let label = label.to_string();
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(280));
        if revision.load(Ordering::Relaxed) != token {
            return;
        }
        let app_for_callback = app.clone();
        let _ = app.run_on_main_thread(move || {
            remember_window_geometry(&app_for_callback, &label, &window);
        });
    });
}

pub(crate) fn remembered_window_size(
    app: &AppHandle,
    label: &str,
    default_width: f64,
    default_height: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, f64, f64) {
    if label == HTTP_PREPARATION_LABEL {
        return (680.0, 320.0, 680.0, 320.0);
    }
    // The main manager has a fixed readable minimum. Preparation windows keep
    // their monitor-aware fitting, but the manager must not start below the
    // size needed to show its header statistics and row actions.
    let (width, height, fitted_min_width, fitted_min_height) = if label == "main" {
        (
            default_width.max(min_width),
            default_height.max(min_height),
            min_width,
            min_height,
        )
    } else {
        fit_preparation_size(app, default_width, default_height, min_width, min_height)
    };
    let stored = persisted_preparation_settings(app);
    let geometry = geometry_for_label(&stored, label);
    let saved_width = f64::from(geometry.width);
    let saved_height = f64::from(geometry.height);
    let width = if saved_width >= fitted_min_width {
        saved_width.min(width.max(fitted_min_width))
    } else {
        width
    };
    let height = if saved_height >= fitted_min_height {
        saved_height.min(height.max(fitted_min_height))
    } else {
        height
    };
    (width, height, fitted_min_width, fitted_min_height)
}

pub(crate) fn restore_window_geometry(
    app: &AppHandle,
    label: &str,
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) {
    if label == HTTP_PREPARATION_LABEL {
        let _ = window.unmaximize();
        let _ = window.set_size(tauri::LogicalSize::new(680.0, 320.0));
        let _ = window.center();
        return;
    }
    let settings = persisted_preparation_settings(app);
    let geometry = geometry_for_label(&settings, label);
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Some(position) = clamped_remembered_position(app, window, geometry, width, height) {
        let _ = window.set_position(position);
    }
    if geometry.maximized {
        let _ = window.maximize();
    }
}

fn center_http_preparation_over_main(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some(main) = app.get_webview_window("main") else {
        let _ = window.center();
        return;
    };
    let (Ok(main_position), Ok(main_size), Ok(window_size)) = (
        main.outer_position(),
        main.inner_size(),
        window.outer_size(),
    ) else {
        let _ = window.center();
        return;
    };
    let x = (i64::from(main_position.x)
        + (i64::from(main_size.width) - i64::from(window_size.width)) / 2)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let y = (i64::from(main_position.y)
        + (i64::from(main_size.height) - i64::from(window_size.height)) / 2)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub(crate) fn install_main_window_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (width, height, _, _) = remembered_window_size(app, "main", 1123.0, 714.0, 1123.0, 714.0);
    let _ = window.unmaximize();
    restore_window_geometry(app, "main", &window, width, height);
    let app_for_event = app.clone();
    let geometry_window = window.clone();
    let geometry_revision = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => {
            remember_window_geometry(&app_for_event, "main", &geometry_window);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            schedule_geometry_persist(&app_for_event, "main", &geometry_window, &geometry_revision);
        }
        _ => {}
    });
}

fn append_preparation_options(query: &mut Serializer<String>, options: Option<&Value>) {
    let Some(object) = options.and_then(Value::as_object) else {
        return;
    };
    // These values are presentation hints from the extension, not executable
    // instructions. Keep the allow-list and length limits here so a malformed
    // bridge request cannot inflate the native window URL.
    for key in [
        "windowMode",
        "preferredQuality",
        "preferredFormat",
        "filename",
        "mime",
        "expectedExtension",
        "title",
        "pageTitle",
    ] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() && value.chars().count() <= 180 {
                query.append_pair(key, value);
            }
        }
    }
}

fn preparation_route(kind: &str, source: &str, options: Option<&Value>) -> Result<String, String> {
    let mut query = Serializer::new(String::new());
    query.append_pair("subwindow", "preparation");
    query.append_pair("kind", kind);
    if !source.trim().is_empty() {
        query.append_pair("source", source.trim());
    }
    append_preparation_options(&mut query, options);
    Ok(format!("app-ui/subwindow.html?{}", query.finish()))
}

fn valid_label(label: &str) -> bool {
    matches!(
        label.trim(),
        MEDIA_PREPARATION_LABEL | PLAYLIST_PREPARATION_LABEL | HTTP_PREPARATION_LABEL
    )
}

fn set_main_modal_state(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let Some(main) = app.get_webview_window("main") else {
        return Ok(());
    };
    main.set_enabled(enabled).map_err(|error| {
        format!("No se pudo actualizar el estado modal de la ventana principal: {error}")
    })
}

fn restore_main_window(app: &AppHandle) {
    let _ = set_main_modal_state(app, true);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn restore_main_if_no_preparation(app: &AppHandle) {
    if active_preparation_labels().is_empty() {
        restore_main_window(app);
    }
}

fn close_other_preparation_window(app: &AppHandle, active_label: &str) {
    for label in [
        MEDIA_PREPARATION_LABEL,
        PLAYLIST_PREPARATION_LABEL,
        HTTP_PREPARATION_LABEL,
    ] {
        if label == active_label {
            continue;
        }
        if let Some(window) = app.get_webview_window(label) {
            remember_window_geometry(app, label, &window);
            invalidate_window_operation(
                &app.state::<crate::LocalState>().preparation_operations,
                label,
            );
            // Keep the native window reusable without firing a close lifecycle
            // while another preparation window is being opened.
            let _ = window.hide();
            clear_active_preparation(app, label);
        }
    }
}

/// Performs the actual native window work. This must run on Tauri's UI thread.
/// The acceptance launcher calls this directly from setup, which already runs
/// on that thread; IPC commands use the async wrapper below.
pub(crate) fn open_preparation_window_now(
    kind: String,
    source: String,
    options: Option<Value>,
    app: AppHandle,
) -> Result<(), String> {
    let (
        label,
        title,
        preferred_width,
        preferred_height,
        preferred_min_width,
        preferred_min_height,
    ) = preparation_config(&kind)?;
    // When the reusable preparation window is opened for another URL, it is
    // still alive and therefore has not emitted a close event. Capture its
    // current size before reading the remembered geometry so a manual resize
    // survives the next video/playlist without writing on every drag tick.
    if let Some(existing) = app.get_webview_window(label) {
        if !existing.is_maximized().unwrap_or(false) {
            remember_window_geometry(&app, label, &existing);
        }
    }
    let (width, height, min_width, min_height) = remembered_window_size(
        &app,
        label,
        preferred_width,
        preferred_height,
        preferred_min_width,
        preferred_min_height,
    );
    let route = preparation_route(&kind, &source, options.as_ref())?;
    close_other_preparation_window(&app, label);
    // A failed replacement must not leave Main disabled after the previous
    // reusable preparation window was hidden.
    let _ = set_main_modal_state(&app, true);
    begin_window_operation(
        &app.state::<crate::LocalState>().preparation_operations,
        label,
    );
    if let Some(window) = app.get_webview_window(label) {
        if label == HTTP_PREPARATION_LABEL {
            let _ = window.set_resizable(false);
            let _ = window.set_maximizable(false);
            let _ = window.set_minimizable(false);
        }
        window
            .eval(format!(
                "window.location.replace({});",
                serde_json::to_string(&format!(
                    "./subwindow.html?{}",
                    route
                        .split_once('?')
                        .map(|(_, value)| value)
                        .unwrap_or_default()
                ))
                .map_err(|error| error.to_string())?
            ))
            .map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        let _ = window.unmaximize();
        restore_window_geometry(&app, label, &window, width, height);
        let _ = window.set_always_on_top(false);
        set_main_modal_state(&app, false)?;
        if let Err(error) = window.show() {
            restore_main_if_no_preparation(&app);
            return Err(error.to_string());
        }
        mark_active_preparation(&app, label);
        if label == HTTP_PREPARATION_LABEL {
            center_http_preparation_over_main(&app, &window);
        }
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()));
    if let Some(main) = app.get_webview_window("main") {
        builder = builder
            .parent(&main)
            .map_err(|error| format!("No se pudo asociar la subventana a CacaTools: {error}"))?;
    }
    let mut builder = builder
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .center()
        .resizable(label != HTTP_PREPARATION_LABEL)
        .decorations(false)
        .visible(false);
    if label == HTTP_PREPARATION_LABEL {
        builder = builder.maximizable(false).minimizable(false);
    }
    let window = builder
        .build()
        .map_err(|error| format!("No se pudo abrir la subventana de preparacion: {error}"))?;
    restore_window_geometry(&app, label, &window, width, height);
    let surface_mode = app
        .state::<crate::LocalState>()
        .connection
        .lock()
        .ok()
        .and_then(|connection| crate::settings::read_appearance_settings(&connection).ok())
        .flatten()
        .map(|appearance| appearance.surface_mode)
        .unwrap_or_else(|| "solid".into());
    crate::windows::backdrop::apply_to_window(&window, &surface_mode);
    let app_for_event = app.clone();
    let event_label = label.to_string();
    let geometry_window = window.clone();
    let geometry_revision = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => {
            invalidate_window_operation(
                &app_for_event
                    .state::<crate::LocalState>()
                    .preparation_operations,
                &event_label,
            );
            remember_window_geometry(&app_for_event, &event_label, &geometry_window);
            clear_active_preparation(&app_for_event, &event_label);
            restore_main_if_no_preparation(&app_for_event);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            schedule_geometry_persist(
                &app_for_event,
                &event_label,
                &geometry_window,
                &geometry_revision,
            );
        }
        WindowEvent::Destroyed => {
            invalidate_window_operation(
                &app_for_event
                    .state::<crate::LocalState>()
                    .preparation_operations,
                &event_label,
            );
            clear_active_preparation(&app_for_event, &event_label);
            if app_for_event.get_webview_window(&event_label).is_none() {
                restore_main_if_no_preparation(&app_for_event);
            }
        }
        _ => {}
    });
    set_main_modal_state(&app, false)?;
    if let Err(error) = window.show() {
        restore_main_if_no_preparation(&app);
        return Err(error.to_string());
    }
    mark_active_preparation(&app, label);
    if label == HTTP_PREPARATION_LABEL {
        center_http_preparation_over_main(&app, &window);
    }
    window.set_focus().map_err(|error| error.to_string())
}

pub(crate) async fn run_on_main_thread<T, F>(app: AppHandle, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.try_send(task());
    })
    .map_err(|error| format!("No se pudo programar la operacion de ventana: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "La operacion de ventana fue cancelada antes de completarse".to_string())?
}

pub(crate) async fn open_preparation_window(
    kind: String,
    source: String,
    options: Option<Value>,
    app: AppHandle,
) -> Result<(), String> {
    run_on_main_thread(app.clone(), move || {
        open_preparation_window_now(kind, source, options, app)
    })
    .await
}

fn show_preparation_window_now(label: String, app: AppHandle) -> Result<(), String> {
    let label = label.trim();
    if !valid_label(label) {
        return Err("La etiqueta de subventana no es valida".into());
    }
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| "La subventana de preparacion ya no esta disponible".to_string())?;
    set_main_modal_state(&app, false)?;
    let _ = window.set_always_on_top(false);
    if let Err(error) = window.show() {
        restore_main_if_no_preparation(&app);
        return Err(error.to_string());
    }
    mark_active_preparation(&app, label);
    window.set_focus().map_err(|error| error.to_string())
}

pub(crate) async fn show_preparation_window(label: String, app: AppHandle) -> Result<(), String> {
    run_on_main_thread(app.clone(), move || show_preparation_window_now(label, app)).await
}

fn preparation_window_action_now(
    label: String,
    action: String,
    app: AppHandle,
) -> Result<(), String> {
    let label = label.trim();
    if !valid_label(label) {
        return Err("La etiqueta de subventana no es valida".into());
    }
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| "La subventana de preparacion no esta disponible".to_string())?;
    if action.trim() == "minimize" {
        return Err("Minimizar no está disponible en ventanas de preparación".into());
    }
    if label == HTTP_PREPARATION_LABEL && action.trim() == "maximize" {
        return Err("Maximizar no está disponible en la preparación HTTP".into());
    }
    let is_close = action.trim() == "close";
    match action.trim() {
        "maximize" => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => {
            // Persist explicitly before a programmatic close. Relying only on
            // CloseRequested is not sufficient on every WebView2/Tauri path,
            // so a new media URL cannot silently reset the user's geometry.
            remember_window_geometry(&app, label, &window);
            invalidate_window_operation(
                &app.state::<crate::LocalState>().preparation_operations,
                label,
            );
            let result = window.close();
            if result.is_ok() {
                clear_active_preparation(&app, label);
                restore_main_if_no_preparation(&app);
            }
            result
        }
        _ => return Err("La accion de subventana no es valida".into()),
    }
    .map_err(|error| error.to_string())
    .inspect(|_result| {
        if is_close {
            let _ = set_main_modal_state(&app, true);
        }
    })
}

pub(crate) fn restore_preparation_if_modal(app: &AppHandle, main_was_disabled: bool) {
    if !main_was_disabled {
        return;
    }
    let Some(label) = active_preparation_labels().into_iter().next() else {
        return;
    };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) async fn preparation_window_action(
    label: String,
    action: String,
    app: AppHandle,
) -> Result<(), String> {
    if action.trim() == "close" {
        invalidate_window_operation(
            &app.state::<crate::LocalState>().preparation_operations,
            label.trim(),
        );
    }
    run_on_main_thread(app.clone(), move || {
        preparation_window_action_now(label, action, app)
    })
    .await
}

pub(crate) async fn preparation_window_start_dragging(
    label: String,
    app: AppHandle,
) -> Result<(), String> {
    if !valid_label(&label) {
        return Err("La etiqueta de subventana no es valida".into());
    }
    run_on_main_thread(app.clone(), move || {
        let window = app
            .get_webview_window(label.trim())
            .ok_or_else(|| "La subventana de preparacion no esta disponible".to_string())?;
        window.start_dragging().map_err(|error| error.to_string())
    })
    .await
}
