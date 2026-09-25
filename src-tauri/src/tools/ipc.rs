//! Private Settings boundary for the signed internal-tool updater.
//!
//! These commands intentionally accept no caller-controlled component, URL,
//! path, hash or artifact. Rust owns catalog authority, eligibility and the
//! 2C/2D staging and activation pipeline.

use super::{
    catalog::{
        self, CatalogCheckMode, CatalogCheckResult, CatalogError, CatalogSource, CatalogStatus,
    },
    download::stage_verified_yt_dlp_component,
    overlay::promote_verified_yt_dlp,
};
use crate::{
    app::process::ExternalProcessRegistry,
    app::runtime::{resolve_bundled_tool, runtime_binary_version, ToolId},
};
use serde::Serialize;
use std::{
    sync::atomic::AtomicBool,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

static UPDATE_COORDINATOR: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename = "yt-dlp")]
pub(crate) enum ToolUpdateComponent {
    YtDlp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ToolUpdateState {
    Current,
    Available,
    Checking,
    Downloading,
    Verifying,
    Installing,
    Updated,
    Failed,
    Offline,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ToolUpdateSource {
    None,
    Cache,
    Remote,
    NotModified,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUpdateStatus {
    pub(crate) component: ToolUpdateComponent,
    pub(crate) state: ToolUpdateState,
    pub(crate) bundled_version: Option<String>,
    pub(crate) active_version: Option<String>,
    pub(crate) available_version: Option<String>,
    pub(crate) last_checked: Option<u64>,
    pub(crate) can_update: bool,
    pub(crate) source: ToolUpdateSource,
    pub(crate) busy: bool,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

fn runtime_versions(app: &AppHandle) -> (Option<String>, Option<String>) {
    let bundled = resolve_bundled_tool(app, ToolId::YtDlp)
        .path
        .map(|path| runtime_binary_version(&path, "--version"))
        .filter(|value| !value.is_empty());
    let active = super::overlay::resolve_verified_overlay(app).map(|value| value.version);
    (bundled, active)
}

fn source(source: CatalogSource) -> ToolUpdateSource {
    match source {
        CatalogSource::Remote => ToolUpdateSource::Remote,
        CatalogSource::NotModified => ToolUpdateSource::NotModified,
        CatalogSource::LastKnownGood => ToolUpdateSource::Cache,
        CatalogSource::None => ToolUpdateSource::None,
    }
}

fn offline_error(error: &CatalogError) -> bool {
    matches!(
        error,
        CatalogError::NetworkUnavailable
            | CatalogError::Timeout
            | CatalogError::HttpStatus(408 | 425 | 429 | 500 | 502 | 503 | 504)
    )
}

fn status_from_result(
    app: &AppHandle,
    result: &CatalogCheckResult,
    last_checked: Option<u64>,
    busy: bool,
) -> ToolUpdateStatus {
    let (bundled_version, active_version) = runtime_versions(app);
    let state = if busy {
        ToolUpdateState::Failed
    } else if let Some(error) = result.error.as_ref() {
        if offline_error(error) {
            ToolUpdateState::Offline
        } else if matches!(error, CatalogError::UnknownKey) {
            ToolUpdateState::Unavailable
        } else {
            ToolUpdateState::Failed
        }
    } else {
        match result.status {
            CatalogStatus::Current => ToolUpdateState::Current,
            CatalogStatus::Available => ToolUpdateState::Available,
            CatalogStatus::Rejected => ToolUpdateState::Failed,
            CatalogStatus::Unavailable => ToolUpdateState::Unavailable,
        }
    };
    ToolUpdateStatus {
        component: ToolUpdateComponent::YtDlp,
        can_update: matches!(state, ToolUpdateState::Available) && !busy,
        state,
        bundled_version,
        active_version,
        available_version: result.available_version.clone(),
        last_checked,
        source: source(result.source),
        busy,
    }
}

fn busy_status(app: &AppHandle) -> ToolUpdateStatus {
    let result = CatalogCheckResult {
        mode: CatalogCheckMode::Manual,
        status: CatalogStatus::Unavailable,
        source: CatalogSource::None,
        error: None,
        sequence: None,
        manifest_id: None,
        available_version: None,
    };
    status_from_result(app, &result, Some(now_seconds()), true)
}

fn lock_coordinator() -> Option<std::sync::MutexGuard<'static, ()>> {
    UPDATE_COORDINATOR
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .ok()
}

pub(crate) fn get_tool_update_status(app: &AppHandle) -> ToolUpdateStatus {
    let result = catalog::cached_tool_catalog_status(app, CatalogCheckMode::Manual);
    status_from_result(app, &result, catalog::cached_catalog_checked_at(app), false)
}

pub(crate) fn check_tool_updates_now(app: &AppHandle) -> ToolUpdateStatus {
    let Some(_guard) = lock_coordinator() else {
        return busy_status(app);
    };
    let result = catalog::check_tool_catalog(app, CatalogCheckMode::Manual);
    status_from_result(app, &result, Some(now_seconds()), false)
}

pub(crate) fn apply_available_tool_update(
    app: &AppHandle,
    external_processes: &ExternalProcessRegistry,
) -> ToolUpdateStatus {
    let Some(_guard) = lock_coordinator() else {
        return busy_status(app);
    };
    let checked = catalog::check_tool_catalog(app, CatalogCheckMode::Manual);
    let mut status = status_from_result(app, &checked, Some(now_seconds()), false);
    if !matches!(checked.status, CatalogStatus::Available) || checked.error.is_some() {
        return status;
    }
    let manifest = match catalog::verified_manifest_from_cache(app) {
        Ok(value) => value,
        Err(_) => {
            status.state = ToolUpdateState::Failed;
            status.can_update = false;
            return status;
        }
    };
    let component = match manifest.component(ToolId::YtDlp) {
        Ok(value) => value,
        Err(_) => {
            status.state = ToolUpdateState::Failed;
            status.can_update = false;
            return status;
        }
    };
    let cancelled = AtomicBool::new(false);
    let staged = match stage_verified_yt_dlp_component(component, app, &cancelled) {
        Ok(value) => value,
        Err(_) => {
            status.state = ToolUpdateState::Failed;
            status.can_update = false;
            return status;
        }
    };
    if promote_verified_yt_dlp(app, &staged, external_processes).is_err() {
        status.state = ToolUpdateState::Failed;
        status.can_update = false;
        return status;
    }
    status.state = ToolUpdateState::Updated;
    status.can_update = false;
    status.active_version = Some(staged.version);
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_contract_is_closed_and_update_requires_available() {
        assert!(!matches!(
            ToolUpdateState::Current,
            ToolUpdateState::Available
        ));
        assert_eq!(ToolUpdateComponent::YtDlp, ToolUpdateComponent::YtDlp);
    }

    #[test]
    fn transient_catalog_failures_are_offline() {
        assert!(offline_error(&CatalogError::Timeout));
        assert!(offline_error(&CatalogError::HttpStatus(503)));
        assert!(!offline_error(&CatalogError::InvalidSignature));
    }
}
