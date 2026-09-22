use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const BUNDLED_CONFIG: &str = include_str!("../resources/updater/updater-config.json");

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterFileConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_channel")]
    channel: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    repository: String,
    configured_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfigurationStatus {
    enabled: bool,
    configured: bool,
    current_version: String,
    channel: String,
    provider: String,
    endpoint: String,
    repository: String,
    configured_at: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub fn notify_app_update(app: AppHandle, version: String, locale: String) -> Result<(), String> {
    let version = version.trim();
    if version.is_empty()
        || version.len() > 80
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err("La versión de actualización no es válida".into());
    }
    let (title, body) = if locale == "en" {
        (
            "Update available",
            format!("Version {version} is available."),
        )
    } else {
        (
            "Actualización disponible",
            format!("La versión {version} está disponible."),
        )
    };
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("No se pudo mostrar la notificación: {error}"))
}

fn default_channel() -> String {
    "stable".to_string()
}

fn bundled_config() -> UpdaterFileConfig {
    serde_json::from_str(BUNDLED_CONFIG).unwrap_or_else(|_| UpdaterFileConfig {
        enabled: false,
        channel: default_channel(),
        provider: "github-releases".to_string(),
        endpoint: String::new(),
        repository: String::new(),
        configured_at: None,
    })
}

fn writable_config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|path| path.join("updater-config.json"))
}

fn effective_config(app: &AppHandle) -> UpdaterFileConfig {
    let bundled = bundled_config();
    let Some(path) = writable_config_path(app) else {
        return bundled;
    };
    let Ok(value) = fs::read_to_string(path) else {
        return bundled;
    };
    serde_json::from_str::<UpdaterFileConfig>(&value).unwrap_or(bundled)
}

fn config_is_ready(config: &UpdaterFileConfig) -> bool {
    config.enabled
        && config.endpoint.starts_with("https://")
        && !config.repository.trim().is_empty()
}

/// The updater plugin must only be loaded when the bundled build-time
/// configuration is complete. Loading it without a public key/endpoints makes
/// affected Tauri updater versions abort during application startup.
pub fn updater_plugin_is_configured() -> bool {
    config_is_ready(&bundled_config())
}

#[tauri::command]
pub fn updater_configuration_status(app: AppHandle) -> UpdaterConfigurationStatus {
    let config = effective_config(&app);
    let configured = config_is_ready(&config);
    let message = if configured {
        "Actualizaciones automáticas configuradas y firmadas".to_string()
    } else {
        "El actualizador está preparado, pero aún debes configurar el repositorio y la clave de firma"
            .to_string()
    };
    UpdaterConfigurationStatus {
        enabled: config.enabled,
        configured,
        current_version: app.package_info().version.to_string(),
        channel: config.channel,
        provider: config.provider,
        endpoint: config.endpoint,
        repository: config.repository,
        configured_at: config.configured_at,
        message,
    }
}

fn ensure_configured(app: &AppHandle) -> Result<UpdaterFileConfig, String> {
    let config = effective_config(app);
    if config_is_ready(&config) {
        Ok(config)
    } else {
        Err("El gestor de actualizaciones todavía no está configurado para producción".to_string())
    }
}

#[tauri::command]
pub async fn check_for_app_update(app: AppHandle) -> Result<Option<AppUpdateInfo>, String> {
    let _config = ensure_configured(&app)?;
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("No se pudo iniciar el actualizador: {error}"))?
        .check()
        .await
        .map_err(|error| format!("No se pudo comprobar la actualización: {error}"))?;
    Ok(update.map(|update| AppUpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    }))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: tauri::State<'_, crate::LocalState>,
) -> Result<(), String> {
    let active_jobs: i64 = state
        .connection
        .lock()
        .map_err(|_| "No se pudo comprobar la cola antes de actualizar".to_string())?
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status='running'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if active_jobs > 0 {
        return Err("La actualización esperará a que terminen las descargas activas".into());
    }
    let _config = ensure_configured(&app)?;
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("No se pudo iniciar el actualizador: {error}"))?
        .check()
        .await
        .map_err(|error| format!("No se pudo comprobar la actualización: {error}"))?
        .ok_or_else(|| "No hay una actualización nueva disponible".to_string())?;

    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded_bytes = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let percent = content_length.filter(|total| *total > 0).map(|total| {
                    (downloaded_bytes as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
                });
                let _ = progress_app.emit(
                    "cacatools-app-update-progress",
                    json!({
                        "downloadedBytes": downloaded_bytes,
                        "contentLength": content_length,
                        "percent": percent,
                        "phase": "download"
                    }),
                );
            },
            move || {
                let _ = finish_app.emit(
                    "cacatools-app-update-progress",
                    json!({ "phase": "install", "percent": 100.0 }),
                );
            },
        )
        .await
        .map_err(|error| format!("No se pudo instalar la actualización: {error}"))?;
    Ok(())
}
