//! Verified yt-dlp overlay storage and activation.
//!
//! This module deliberately has no Tauri command or updater entry point. A
//! trusted `StagedArtifact` is the only production input accepted by the
//! promotion API; runtime resolution treats every on-disk value as hostile.

use super::{
    acquire_tool_operation,
    download::{probe_ytdlp_version, reverify_staged_yt_dlp, StagedArtifact},
    tool_operation_active,
    version::{classify_component_version, VersionRelation},
};
use crate::{
    app::process::{ExternalProcessKind, ExternalProcessRegistry},
    app::runtime::{resolve_bundled_tool, runtime_binary_version, ToolId},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const STORE_DIR: &str = "tools/components/yt-dlp";
const VERSIONS_DIR: &str = "tools/components/yt-dlp/versions";
const ACTIVE_FILE: &str = "active.json";
const ACTIVE_TEMP: &str = "active.json.tmp";
const ACTIVE_BACKUP: &str = "active.json.previous";
const MAX_VERSION_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OverlayError {
    Missing,
    Busy,
    InUse,
    NotStaged,
    Integrity,
    PointerCorrupt,
    VersionMismatch,
    VersionDowngrade,
    HealthCheckFailed,
    AlreadyExists,
    Filesystem,
    Revoked,
}

impl std::fmt::Display for OverlayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Missing => "yt-dlp overlay is not installed",
            Self::Busy => "yt-dlp overlay activation is already running",
            Self::InUse => "yt-dlp is currently in use",
            Self::NotStaged => "artifact is not a verified staged yt-dlp artifact",
            Self::Integrity => "yt-dlp overlay integrity validation failed",
            Self::PointerCorrupt => "yt-dlp overlay activation pointer is corrupt",
            Self::VersionMismatch => "yt-dlp overlay metadata version mismatch",
            Self::VersionDowngrade => "yt-dlp remote downgrade rejected",
            Self::HealthCheckFailed => "yt-dlp overlay health check failed",
            Self::AlreadyExists => "yt-dlp overlay version already exists",
            Self::Filesystem => "yt-dlp overlay filesystem operation failed",
            Self::Revoked => "yt-dlp overlay is revoked",
        })
    }
}

impl std::error::Error for OverlayError {}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivePointer {
    schema_version: u32,
    tool_id: String,
    active_version: String,
    expected_sha256: String,
    size: u64,
    activated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OverlayMetadata {
    schema_version: u32,
    tool_id: String,
    version: String,
    sha256: String,
    size: u64,
    source_repository: String,
    source_release: String,
    operation_id: String,
    verification_timestamp: u64,
    state: String,
    #[serde(default)]
    revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverlayResolution {
    pub(crate) path: PathBuf,
    pub(crate) version: String,
    pub(crate) sha256: String,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, OverlayError> {
    app.path()
        .app_data_dir()
        .map_err(|_| OverlayError::Filesystem)
}

fn store_root(root: &Path) -> PathBuf {
    root.join(STORE_DIR)
}

fn versions_root(root: &Path) -> PathBuf {
    root.join(VERSIONS_DIR)
}

fn active_path(root: &Path) -> PathBuf {
    store_root(root).join(ACTIVE_FILE)
}

fn version_dir(root: &Path, version: &str) -> PathBuf {
    versions_root(root).join(version)
}

fn version_exe(root: &Path, version: &str) -> PathBuf {
    version_dir(root, version).join(ToolId::YtDlp.executable_name())
}

fn metadata_path(root: &Path, version: &str) -> PathBuf {
    version_dir(root, version).join("metadata.json")
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VERSION_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && classify_component_version(ToolId::YtDlp, "2000.01.01", value).is_ok()
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_regular_file(path: &Path) -> Result<fs::Metadata, OverlayError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| OverlayError::Missing)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(OverlayError::Integrity);
    }
    Ok(metadata)
}

fn ensure_directory(path: &Path) -> Result<(), OverlayError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| OverlayError::Filesystem)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(OverlayError::Filesystem);
    }
    Ok(())
}

fn ensure_store_tree(root: &Path) -> Result<(), OverlayError> {
    if !root.is_absolute() {
        return Err(OverlayError::Filesystem);
    }
    if fs::symlink_metadata(root).is_err() {
        fs::create_dir_all(root).map_err(|_| OverlayError::Filesystem)?;
    }
    ensure_directory(root)?;
    let tools = root.join("tools");
    let components = root.join("tools/components");
    let store = store_root(root);
    let versions = versions_root(root);
    for directory in [&tools, &components, &store, &versions] {
        fs::create_dir_all(directory).map_err(|_| OverlayError::Filesystem)?;
        ensure_directory(directory)?;
    }
    Ok(())
}

#[cfg(windows)]
fn has_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn sha256_file(path: &Path) -> Result<String, OverlayError> {
    let mut file = File::open(path).map_err(|_| OverlayError::Integrity)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| OverlayError::Integrity)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, OverlayError> {
    let bytes = fs::read(path).map_err(|_| OverlayError::PointerCorrupt)?;
    serde_json::from_slice(&bytes).map_err(|_| OverlayError::PointerCorrupt)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), OverlayError> {
    let temporary = path.with_extension("json.tmp");
    if fs::symlink_metadata(&temporary).is_ok() {
        fs::remove_file(&temporary).map_err(|_| OverlayError::Filesystem)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| OverlayError::Filesystem)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| OverlayError::Filesystem)?;
    file.write_all(&bytes)
        .map_err(|_| OverlayError::Filesystem)?;
    file.sync_all().map_err(|_| OverlayError::Filesystem)?;
    fs::rename(temporary, path).map_err(|_| OverlayError::Filesystem)
}

fn atomic_write_active(root: &Path, pointer: &ActivePointer) -> Result<(), OverlayError> {
    ensure_store_tree(root)?;
    let store = store_root(root);
    let active = store.join(ACTIVE_FILE);
    let temporary = store.join(ACTIVE_TEMP);
    let backup = store.join(ACTIVE_BACKUP);
    if fs::symlink_metadata(&temporary).is_ok() {
        fs::remove_file(&temporary).map_err(|_| OverlayError::Filesystem)?;
    }
    let bytes = serde_json::to_vec_pretty(pointer).map_err(|_| OverlayError::Filesystem)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| OverlayError::Filesystem)?;
    file.write_all(&bytes)
        .map_err(|_| OverlayError::Filesystem)?;
    file.sync_all().map_err(|_| OverlayError::Filesystem)?;

    let had_active = fs::symlink_metadata(&active).is_ok();
    if fs::symlink_metadata(&backup).is_ok() {
        fs::remove_file(&backup).map_err(|_| OverlayError::Filesystem)?;
    }
    if had_active {
        fs::rename(&active, &backup).map_err(|_| OverlayError::Filesystem)?;
    }
    match fs::rename(&temporary, &active) {
        Ok(()) => {
            if fs::symlink_metadata(&backup).is_ok() {
                let _ = fs::remove_file(backup);
            }
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            if had_active {
                let _ = fs::rename(&backup, &active);
            }
            Err(OverlayError::Filesystem)
        }
    }
}

pub(crate) fn recover_overlay(app: &AppHandle) {
    if let Ok(root) = app_data_dir(app) {
        recover_at(&root);
    }
}

fn recover_at(root: &Path) {
    if ensure_store_tree(root).is_err() {
        return;
    }
    if !tool_operation_active(ToolId::YtDlp) {
        super::download::recover_staging_at(root);
    }
    let store = store_root(root);
    let active = store.join(ACTIVE_FILE);
    let temporary = store.join(ACTIVE_TEMP);
    let backup = store.join(ACTIVE_BACKUP);
    if fs::symlink_metadata(&temporary).is_ok() {
        let _ = fs::remove_file(&temporary);
    }
    if fs::symlink_metadata(&active).is_err() && fs::symlink_metadata(&backup).is_ok() {
        let _ = fs::rename(&backup, &active);
    }
    let versions = versions_root(root);
    if let Ok(entries) = fs::read_dir(&versions) {
        for entry in entries.flatten() {
            let directory = entry.path();
            if !directory.is_dir() {
                continue;
            }
            let _ =
                fs::remove_file(directory.join(format!("{}.tmp", ToolId::YtDlp.executable_name())));
            for name in ["metadata.json.tmp", "metadata.tmp"] {
                let _ = fs::remove_file(directory.join(name));
            }
        }
    }
}

fn read_active(root: &Path) -> Result<ActivePointer, OverlayError> {
    let pointer_file = active_path(root);
    let metadata = fs::symlink_metadata(&pointer_file).map_err(|_| OverlayError::Missing)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(OverlayError::PointerCorrupt);
    }
    let pointer: ActivePointer = read_json(&pointer_file)?;
    if pointer.schema_version != 1
        || pointer.tool_id != ToolId::YtDlp.base_name()
        || !valid_version(&pointer.active_version)
        || !valid_hash(&pointer.expected_sha256)
        || pointer.size == 0
        || pointer
            .previous_version
            .as_deref()
            .is_some_and(|version| !valid_version(version))
    {
        return Err(OverlayError::PointerCorrupt);
    }
    Ok(pointer)
}

fn validate_version_artifact(
    root: &Path,
    version: &str,
    expected_hash: &str,
    expected_size: u64,
) -> Result<OverlayResolution, OverlayError> {
    if !valid_version(version) || !valid_hash(expected_hash) {
        return Err(OverlayError::Integrity);
    }
    let directory = version_dir(root, version);
    let directory_metadata = fs::symlink_metadata(&directory).map_err(|_| OverlayError::Missing)?;
    if !directory_metadata.is_dir()
        || directory_metadata.file_type().is_symlink()
        || has_reparse_point(&directory_metadata)
    {
        return Err(OverlayError::Integrity);
    }
    let path = version_exe(root, version);
    let metadata = ensure_regular_file(&path)?;
    if metadata.len() != expected_size {
        return Err(OverlayError::Integrity);
    }
    let actual_hash = sha256_file(&path)?;
    if !actual_hash.eq_ignore_ascii_case(expected_hash) {
        return Err(OverlayError::Integrity);
    }
    let metadata_file = metadata_path(root, version);
    let metadata_stat =
        fs::symlink_metadata(&metadata_file).map_err(|_| OverlayError::Integrity)?;
    if !metadata_stat.is_file()
        || metadata_stat.file_type().is_symlink()
        || has_reparse_point(&metadata_stat)
    {
        return Err(OverlayError::Integrity);
    }
    let metadata_value: OverlayMetadata = read_json(&metadata_file)?;
    if metadata_value.schema_version != 1
        || metadata_value.tool_id != ToolId::YtDlp.base_name()
        || metadata_value.version != version
        || !metadata_value.sha256.eq_ignore_ascii_case(expected_hash)
        || metadata_value.size != expected_size
        || metadata_value.state != "STAGED_VERIFIED"
    {
        return Err(OverlayError::Integrity);
    }
    if metadata_value.revoked {
        return Err(OverlayError::Revoked);
    }
    Ok(OverlayResolution {
        path,
        version: version.to_string(),
        sha256: actual_hash,
    })
}

/// Resolve and verify the overlay without executing it. This is also used by
/// tests with an isolated temporary root. `None` means bundled/PATH fallback.
fn resolve_overlay_at(root: &Path) -> Result<Option<OverlayResolution>, OverlayError> {
    if ensure_store_tree(root).is_err() {
        return Ok(None);
    }
    recover_at(root);
    let pointer = match read_active(root) {
        Ok(pointer) => pointer,
        Err(OverlayError::Missing | OverlayError::PointerCorrupt) => return Ok(None),
        Err(_) => return Ok(None),
    };
    let resolved = match validate_version_artifact(
        root,
        &pointer.active_version,
        &pointer.expected_sha256,
        pointer.size,
    ) {
        Ok(resolved) => resolved,
        // Any invalid overlay is intentionally indistinguishable from a
        // missing one to the runtime resolver: bundled/PATH fallback wins.
        Err(_) => return Ok(None),
    };
    Ok(Some(resolved))
}

pub(crate) fn resolve_verified_overlay(app: &AppHandle) -> Option<OverlayResolution> {
    let root = app_data_dir(app).ok()?;
    let overlay = resolve_overlay_at(&root).ok()??;
    let bundled = resolve_bundled_tool(app, ToolId::YtDlp);
    let bundled_version = bundled
        .path
        .as_deref()
        .map(|path| runtime_binary_version(path, "--version"));
    select_overlay(overlay, bundled_version.as_deref())
}

fn select_overlay(
    overlay: OverlayResolution,
    bundled_version: Option<&str>,
) -> Option<OverlayResolution> {
    match bundled_version {
        None => Some(overlay),
        Some("") => None,
        Some(version) => match classify_component_version(ToolId::YtDlp, version, &overlay.version)
        {
            Ok(VersionRelation::Newer) => Some(overlay),
            Ok(VersionRelation::Equal | VersionRelation::Older) | Err(_) => None,
        },
    }
}

fn ytdlp_in_use(registry: &ExternalProcessRegistry) -> Result<bool, OverlayError> {
    let processes = registry.lock().map_err(|_| OverlayError::Busy)?;
    Ok(processes
        .values()
        .any(|job| job.values().any(|kind| *kind == ExternalProcessKind::YtDlp)))
}

fn pointer_from_artifact(
    artifact: &StagedArtifact,
    previous_version: Option<String>,
) -> ActivePointer {
    ActivePointer {
        schema_version: 1,
        tool_id: ToolId::YtDlp.base_name().to_string(),
        active_version: artifact.version.clone(),
        expected_sha256: artifact.sha256.to_ascii_lowercase(),
        size: artifact.size,
        activated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        previous_version,
    }
}

fn copy_artifact(root: &Path, staged: &StagedArtifact) -> Result<(), OverlayError> {
    ensure_store_tree(root)?;
    let directory = version_dir(root, &staged.version);
    if fs::symlink_metadata(&directory).is_ok() {
        return Err(OverlayError::AlreadyExists);
    }
    fs::create_dir_all(&directory).map_err(|_| OverlayError::Filesystem)?;
    let target = directory.join(ToolId::YtDlp.executable_name());
    let temporary = directory.join(format!("{}.tmp", ToolId::YtDlp.executable_name()));
    let metadata_target = metadata_path(root, &staged.version);
    if fs::symlink_metadata(&temporary).is_ok() || fs::symlink_metadata(&target).is_ok() {
        return Err(OverlayError::AlreadyExists);
    }
    fs::copy(&staged.path, &temporary).map_err(|_| OverlayError::Filesystem)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| OverlayError::Filesystem)?;
    file.sync_all().map_err(|_| OverlayError::Filesystem)?;
    fs::rename(&temporary, &target).map_err(|_| OverlayError::Filesystem)?;
    let metadata = OverlayMetadata {
        schema_version: 1,
        tool_id: staged.tool_id.clone(),
        version: staged.version.clone(),
        sha256: staged.sha256.to_ascii_lowercase(),
        size: staged.size,
        source_repository: staged.source_repository.clone(),
        source_release: staged.source_release.clone(),
        operation_id: staged.operation_id.clone(),
        verification_timestamp: staged.verification_timestamp,
        state: "STAGED_VERIFIED".into(),
        revoked: false,
    };
    write_json_atomic(&metadata_target, &metadata)?;
    Ok(())
}

fn restore_previous_after_health_failure(
    root: &Path,
    pointer: &ActivePointer,
) -> Result<(), OverlayError> {
    if let Some(version) = pointer.previous_version.as_deref() {
        let path = version_exe(root, version);
        let size = ensure_regular_file(&path)?.len();
        let hash = sha256_file(&path)?;
        let previous = validate_version_artifact(root, version, &hash, size)?;
        atomic_write_active(
            root,
            &ActivePointer {
                schema_version: 1,
                tool_id: ToolId::YtDlp.base_name().into(),
                active_version: previous.version,
                expected_sha256: previous.sha256,
                size,
                activated_at: now_secs(),
                previous_version: None,
            },
        )
    } else {
        fs::remove_file(active_path(root)).map_err(|_| OverlayError::Filesystem)
    }
}

pub(crate) fn promote_verified_yt_dlp(
    app: &AppHandle,
    staged: &StagedArtifact,
    registry: &ExternalProcessRegistry,
) -> Result<(), OverlayError> {
    let root = app_data_dir(app)?;
    promote_at(&root, staged, registry)
}

fn promote_at(
    root: &Path,
    staged: &StagedArtifact,
    registry: &ExternalProcessRegistry,
) -> Result<(), OverlayError> {
    let _lease = acquire_tool_operation(ToolId::YtDlp).map_err(|_| OverlayError::Busy)?;
    if ytdlp_in_use(registry)? {
        return Err(OverlayError::InUse);
    }
    if staged.tool_id != ToolId::YtDlp.base_name() || staged.state != "STAGED_VERIFIED" {
        return Err(OverlayError::NotStaged);
    }
    reverify_staged_yt_dlp(staged, root).map_err(|error| match error {
        super::download::DownloadError::VersionMismatch { .. } => OverlayError::VersionMismatch,
        super::download::DownloadError::HashMismatch
        | super::download::DownloadError::SizeMismatch { .. } => OverlayError::Integrity,
        _ => OverlayError::NotStaged,
    })?;
    if !valid_version(&staged.version) || !valid_hash(&staged.sha256) || staged.size == 0 {
        return Err(OverlayError::Integrity);
    }
    recover_at(root);
    let previous = read_active(root).ok();
    if let Some(previous) = &previous {
        if matches!(
            classify_component_version(ToolId::YtDlp, &previous.active_version, &staged.version),
            Ok(VersionRelation::Older)
        ) {
            return Err(OverlayError::VersionDowngrade);
        }
    }
    fs::create_dir_all(versions_root(root)).map_err(|_| OverlayError::Filesystem)?;
    copy_artifact(root, staged)?;
    let promoted = version_exe(root, &staged.version);
    let health = probe_ytdlp_version(&promoted)
        .map_err(|_| OverlayError::HealthCheckFailed)
        .and_then(|version| {
            (version == staged.version)
                .then_some(())
                .ok_or(OverlayError::HealthCheckFailed)
        });
    if health.is_err() {
        let _ = fs::remove_dir_all(version_dir(root, &staged.version));
        return Err(OverlayError::HealthCheckFailed);
    }
    let pointer = pointer_from_artifact(staged, previous.map(|value| value.active_version));
    if let Err(error) = atomic_write_active(root, &pointer) {
        let _ = fs::remove_dir_all(version_dir(root, &staged.version));
        return Err(error);
    }
    // A second immediate probe detects a broken activation before callers can
    // observe it. Restore the old pointer if this technical check fails.
    if !probe_ytdlp_version(&promoted)
        .map(|version| version == staged.version)
        .unwrap_or(false)
    {
        if restore_previous_after_health_failure(root, &pointer).is_err() {
            let _ = fs::remove_file(active_path(root));
        }
        return Err(OverlayError::HealthCheckFailed);
    }
    retain_versions(
        root,
        Some(&staged.version),
        pointer.previous_version.as_deref(),
    );
    Ok(())
}

pub(crate) fn rollback_verified_yt_dlp(
    app: &AppHandle,
    registry: &ExternalProcessRegistry,
) -> Result<(), OverlayError> {
    let root = app_data_dir(app)?;
    rollback_at(&root, registry)
}

fn rollback_at(root: &Path, registry: &ExternalProcessRegistry) -> Result<(), OverlayError> {
    let _lease = acquire_tool_operation(ToolId::YtDlp).map_err(|_| OverlayError::Busy)?;
    if ytdlp_in_use(registry)? {
        return Err(OverlayError::InUse);
    }
    recover_at(root);
    let pointer = read_active(root)?;
    let previous = pointer.previous_version.ok_or(OverlayError::Missing)?;
    let previous_hash = sha256_file(&version_exe(root, &previous))?;
    let previous_size = ensure_regular_file(&version_exe(root, &previous))?.len();
    let previous = validate_version_artifact(root, &previous, &previous_hash, previous_size)?;
    let version =
        probe_ytdlp_version(&previous.path).map_err(|_| OverlayError::HealthCheckFailed)?;
    if version != previous.version {
        return Err(OverlayError::HealthCheckFailed);
    }
    let new_pointer = ActivePointer {
        schema_version: 1,
        tool_id: ToolId::YtDlp.base_name().into(),
        active_version: previous.version,
        expected_sha256: previous.sha256,
        size: previous_size,
        activated_at: now_secs(),
        previous_version: None,
    };
    atomic_write_active(root, &new_pointer)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn retain_versions(root: &Path, active: Option<&str>, previous: Option<&str>) {
    let keep = [active, previous]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    let Ok(entries) = fs::read_dir(versions_root(root)) else {
        return;
    };
    let mut candidates = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !path.is_dir() || keep.contains(&name.as_str()) || !valid_version(&name) {
                return None;
            }
            let metadata = fs::symlink_metadata(&path).ok()?;
            if metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
                return None;
            }
            Some((name, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    while !candidates.is_empty() {
        let (_, path) = candidates.remove(0);
        let _ = fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn fixture_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cacatools-overlay-{label}-{}", now_secs()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_overlay(root: &Path, version: &str, bytes: &[u8]) {
        let dir = version_dir(root, version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(version_exe(root, version), bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let metadata = OverlayMetadata {
            schema_version: 1,
            tool_id: "yt-dlp".into(),
            version: version.into(),
            sha256: hash.clone(),
            size: bytes.len() as u64,
            source_repository: "yt-dlp/yt-dlp".into(),
            source_release: version.into(),
            operation_id: "op-test".into(),
            verification_timestamp: 1,
            state: "STAGED_VERIFIED".into(),
            revoked: false,
        };
        fs::write(
            metadata_path(root, version),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        atomic_write_active(
            root,
            &ActivePointer {
                schema_version: 1,
                tool_id: "yt-dlp".into(),
                active_version: version.into(),
                expected_sha256: hash,
                size: bytes.len() as u64,
                activated_at: 1,
                previous_version: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn valid_overlay_resolves_with_fixed_path_and_hash() {
        let root = fixture_root("valid");
        write_overlay(&root, "2026.08.20", b"verified");
        let resolved = resolve_overlay_at(&root).unwrap().unwrap();
        assert_eq!(resolved.version, "2026.08.20");
        assert_eq!(resolved.path, version_exe(&root, "2026.08.20"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn modified_overlay_fails_integrity_and_is_not_returned() {
        let root = fixture_root("tamper");
        write_overlay(&root, "2026.08.20", b"verified");
        fs::write(version_exe(&root, "2026.08.20"), b"tampered").unwrap();
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn size_mismatch_falls_back_without_executing_overlay() {
        let root = fixture_root("size-mismatch");
        write_overlay(&root, "2026.08.20", b"verified");
        let pointer_path = active_path(&root);
        let mut pointer: ActivePointer = read_json(&pointer_path).unwrap();
        pointer.size += 1;
        fs::write(pointer_path, serde_json::to_vec(&pointer).unwrap()).unwrap();
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_or_missing_pointer_falls_back_without_error() {
        let root = fixture_root("pointer");
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        fs::create_dir_all(store_root(&root)).unwrap();
        fs::write(active_path(&root), b"not-json").unwrap();
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn revoked_overlay_is_not_resolved() {
        let root = fixture_root("revoked");
        write_overlay(&root, "2026.08.20", b"verified");
        let path = metadata_path(&root, "2026.08.20");
        let mut metadata: OverlayMetadata = read_json(&path).unwrap();
        metadata.revoked = true;
        fs::write(path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pointer_schema_rejects_arbitrary_path_or_unknown_fields() {
        let root = fixture_root("strict-pointer");
        fs::create_dir_all(store_root(&root)).unwrap();
        fs::write(
            active_path(&root),
            br#"{"schemaVersion":1,"toolId":"yt-dlp","activeVersion":"2026.08.20","expectedSha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"activatedAt":1,"path":"C:\\evil.exe"}"#,
        )
        .unwrap();
        assert_eq!(resolve_overlay_at(&root).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_pointer_switch_is_atomic_and_recovery_removes_temp() {
        let root = fixture_root("atomic");
        write_overlay(&root, "2026.08.20", b"verified");
        fs::write(store_root(&root).join(ACTIVE_TEMP), b"stale").unwrap();
        recover_at(&root);
        assert!(!store_root(&root).join(ACTIVE_TEMP).exists());
        assert_eq!(read_active(&root).unwrap().active_version, "2026.08.20");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn health_failure_restores_only_the_verified_previous_pointer() {
        let root = fixture_root("health-rollback");
        write_overlay(&root, "2026.08.19", b"previous");
        write_overlay(&root, "2026.08.20", b"active");
        let previous_hash = sha256_file(&version_exe(&root, "2026.08.19")).unwrap();
        let pointer = ActivePointer {
            schema_version: 1,
            tool_id: "yt-dlp".into(),
            active_version: "2026.08.20".into(),
            expected_sha256: sha256_file(&version_exe(&root, "2026.08.20")).unwrap(),
            size: 6,
            activated_at: 2,
            previous_version: Some("2026.08.19".into()),
        };
        atomic_write_active(&root, &pointer).unwrap();
        restore_previous_after_health_failure(&root, &pointer).unwrap();
        let restored = read_active(&root).unwrap();
        assert_eq!(restored.active_version, "2026.08.19");
        assert_eq!(restored.expected_sha256, previous_hash);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_selection_prefers_new_overlay_only() {
        assert_eq!(
            classify_component_version(ToolId::YtDlp, "2026.08.19", "2026.08.20"),
            Ok(VersionRelation::Newer)
        );
        assert_eq!(
            classify_component_version(ToolId::YtDlp, "2026.08.20", "2026.08.19"),
            Ok(VersionRelation::Older)
        );
    }

    #[test]
    fn bundled_newer_or_equal_wins_and_new_overlay_is_selected() {
        let overlay = OverlayResolution {
            path: PathBuf::from("overlay/yt-dlp.exe"),
            version: "2026.08.20".into(),
            sha256: "00".repeat(32),
        };
        assert!(select_overlay(overlay.clone(), Some("2026.08.21")).is_none());
        assert!(select_overlay(overlay.clone(), Some("2026.08.20")).is_none());
        assert_eq!(
            select_overlay(overlay.clone(), Some("2026.08.19")),
            Some(overlay.clone())
        );
        assert_eq!(
            select_overlay(overlay, None),
            Some(OverlayResolution {
                path: PathBuf::from("overlay/yt-dlp.exe"),
                version: "2026.08.20".into(),
                sha256: "00".repeat(32),
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn verified_staged_artifact_promotes_without_touching_bundled_binary() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/bin/yt-dlp.exe");
        if !source.is_file() {
            eprintln!("SKIP: bundled yt-dlp promotion integration assertion requires prepare:windows-binaries; source archives intentionally omit runtime executables.");
            return;
        }
        let root = fixture_root("promotion");
        let staged_dir = root.join("tools/staging/op-test");
        fs::create_dir_all(&staged_dir).unwrap();
        let staged_path = staged_dir.join("yt-dlp.exe");
        fs::copy(&source, &staged_path).unwrap();
        let source_metadata = fs::metadata(&source).unwrap();
        let sha256 = sha256_file(&source).unwrap();
        let version = probe_ytdlp_version(&source).unwrap();
        let staged = StagedArtifact {
            tool_id: "yt-dlp".into(),
            version,
            sha256,
            size: source_metadata.len(),
            source_repository: "yt-dlp/yt-dlp".into(),
            source_release: "fixture".into(),
            operation_id: "op-test".into(),
            verification_timestamp: 1,
            state: "STAGED_VERIFIED".into(),
            path: staged_path,
        };
        let registry: ExternalProcessRegistry =
            std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
        promote_at(&root, &staged, &registry).unwrap();
        let pointer = read_active(&root).unwrap();
        assert_eq!(pointer.active_version, staged.version);
        assert!(version_exe(&root, &staged.version).is_file());
        assert!(source.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retention_keeps_active_and_previous_and_prunes_old_versions() {
        let root = fixture_root("retention");
        for version in ["2026.08.17", "2026.08.18", "2026.08.19", "2026.08.20"] {
            fs::create_dir_all(version_dir(&root, version)).unwrap();
        }
        retain_versions(&root, Some("2026.08.20"), Some("2026.08.19"));
        assert!(version_dir(&root, "2026.08.20").exists());
        assert!(version_dir(&root, "2026.08.19").exists());
        assert!(!version_dir(&root, "2026.08.18").exists());
        assert!(!version_dir(&root, "2026.08.17").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn activation_coordinator_blocks_concurrent_same_tool_operations() {
        let first = acquire_tool_operation(ToolId::YtDlp).expect("first operation lease");
        assert!(acquire_tool_operation(ToolId::YtDlp).is_err());
        drop(first);
        assert!(acquire_tool_operation(ToolId::YtDlp).is_ok());
    }

    #[test]
    fn in_use_registry_defers_activation_without_killing_processes() {
        let registry: ExternalProcessRegistry =
            std::sync::Arc::new(Mutex::new(std::collections::HashMap::from([(
                7_i64,
                std::collections::HashMap::from([(99_u32, ExternalProcessKind::YtDlp)]),
            )])));
        assert!(ytdlp_in_use(&registry).unwrap());
    }
}
