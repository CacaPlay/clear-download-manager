use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use zip::ZipArchive;

use crate::{tools::trust::TrustedKeys, MediaRuntimePaths};

#[cfg(test)]
mod tests;

pub(crate) mod catalog_key;
pub(crate) mod distribution;

const COMPONENT_SCHEMA_VERSION: u32 = 1;
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPONENT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPONENT_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const POINTER_NAME: &str = "active.json";
const MANIFEST_NAME: &str = "component.json";
const CATALOG_PROOF_NAME: &str = "catalog.json";
const CATALOG_STATE_NAME: &str = ".catalog-state.json";
const STAGING_DIR: &str = ".staging";

pub(crate) fn media_tools_required_error() -> String {
    "Media Tools is required for this download. Install the component from Settings > Components."
        .into()
}

pub(crate) fn torrent_engine_required_error() -> String {
    "Torrent Engine is required for this download. Install the component from Settings > Components.".into()
}

static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);
static GLOBAL_COMPONENT_MANAGER: OnceLock<Arc<ComponentManager>> = OnceLock::new();

pub(crate) fn install_global(manager: Arc<ComponentManager>) {
    let _ = GLOBAL_COMPONENT_MANAGER.set(manager);
}

pub(crate) fn global() -> Option<&'static Arc<ComponentManager>> {
    GLOBAL_COMPONENT_MANAGER.get()
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ComponentId {
    MediaTools,
    TorrentEngine,
}

impl ComponentId {
    fn as_str(self) -> &'static str {
        match self {
            Self::MediaTools => "media-tools",
            Self::TorrentEngine => "torrent-engine",
        }
    }

    fn capabilities(self) -> &'static [Capability] {
        match self {
            Self::MediaTools => &[
                Capability::MediaExtraction,
                Capability::MediaMerge,
                Capability::MediaProbe,
                Capability::MediaTranscode,
                Capability::JsRuntime,
            ],
            Self::TorrentEngine => &[Capability::Bittorrent],
        }
    }

    fn artifacts(self) -> &'static [RuntimeArtifact] {
        match self {
            Self::MediaTools => &[
                RuntimeArtifact::YtDlp,
                RuntimeArtifact::Ffmpeg,
                RuntimeArtifact::Ffprobe,
                RuntimeArtifact::Deno,
            ],
            Self::TorrentEngine => &[RuntimeArtifact::Aria2],
        }
    }
}

impl fmt::Display for ComponentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Capability {
    MediaExtraction,
    MediaMerge,
    MediaProbe,
    MediaTranscode,
    JsRuntime,
    Bittorrent,
}

impl Capability {
    fn component(self) -> ComponentId {
        match self {
            Self::MediaExtraction
            | Self::MediaMerge
            | Self::MediaProbe
            | Self::MediaTranscode
            | Self::JsRuntime => ComponentId::MediaTools,
            Self::Bittorrent => ComponentId::TorrentEngine,
        }
    }

    fn artifact(self) -> RuntimeArtifact {
        match self {
            Self::MediaExtraction => RuntimeArtifact::YtDlp,
            Self::MediaMerge | Self::MediaTranscode => RuntimeArtifact::Ffmpeg,
            Self::MediaProbe => RuntimeArtifact::Ffprobe,
            Self::JsRuntime => RuntimeArtifact::Deno,
            Self::Bittorrent => RuntimeArtifact::Aria2,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ComponentState {
    Missing,
    Installed,
    Corrupted,
    UpdateAvailable,
    Downloading,
    Verifying,
    Installing,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeArtifact {
    YtDlp,
    Ffmpeg,
    Ffprobe,
    Deno,
    Aria2,
}

impl RuntimeArtifact {
    fn filename(self) -> &'static str {
        match self {
            Self::YtDlp => "yt-dlp.exe",
            Self::Ffmpeg => "ffmpeg.exe",
            Self::Ffprobe => "ffprobe.exe",
            Self::Deno => "deno.exe",
            Self::Aria2 => "aria2c.exe",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ArtifactPin {
    artifact: RuntimeArtifact,
    filename: String,
    version: String,
    sha256: String,
    size: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimePins {
    artifacts: HashMap<RuntimeArtifact, ArtifactPin>,
}

impl RuntimePins {
    pub(crate) fn embedded() -> Result<Self, ComponentError> {
        Self::from_runtime_manifest(include_str!("../resources/bin/runtime-manifest.json"))
    }

    fn from_catalog_component(
        component: &distribution::CatalogComponent,
    ) -> Result<Self, ComponentError> {
        let expected = component.id.artifacts();
        if component.files.len() != expected.len() {
            return Err(ComponentError::InvalidManifest(
                "catalog file inventory does not match the component".into(),
            ));
        }
        let mut artifacts = HashMap::new();
        for (entry, artifact) in component.files.iter().zip(expected) {
            if entry.artifact != *artifact
                || entry.name != artifact.filename()
                || !is_version_token(&entry.version)
                || !is_sha256(&entry.sha256)
                || entry.size == 0
                || entry.size > MAX_COMPONENT_FILE_BYTES
                || artifacts.contains_key(artifact)
            {
                return Err(ComponentError::InvalidManifest(
                    "catalog runtime pin is invalid".into(),
                ));
            }
            artifacts.insert(
                *artifact,
                ArtifactPin {
                    artifact: *artifact,
                    filename: entry.name.clone(),
                    version: entry.version.clone(),
                    sha256: entry.sha256.clone(),
                    size: Some(entry.size),
                },
            );
        }
        Ok(Self { artifacts })
    }

    fn from_runtime_manifest(contents: &str) -> Result<Self, ComponentError> {
        let value: serde_json::Value =
            serde_json::from_str(contents.trim_start_matches('\u{feff}'))
                .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        let mut artifacts = HashMap::new();
        for (artifact, version_field, hash_field, version_mode) in [
            (RuntimeArtifact::YtDlp, "ytDlp.version", "ytDlp.sha256", 0),
            (
                RuntimeArtifact::Ffmpeg,
                "ffmpeg.version",
                "ffmpeg.ffmpegSha256",
                1,
            ),
            (
                RuntimeArtifact::Ffprobe,
                "ffmpeg.ffprobeVersion",
                "ffmpeg.ffprobeSha256",
                1,
            ),
            (
                RuntimeArtifact::Deno,
                "deno.version",
                "deno.executableSha256",
                2,
            ),
            (
                RuntimeArtifact::Aria2,
                "aria2.version",
                "aria2.executableSha256",
                3,
            ),
        ] {
            let raw_version = json_string(&value, version_field)?;
            let version = match version_mode {
                0 => raw_version.to_string(),
                1 | 3 => raw_version
                    .split_whitespace()
                    .nth(2)
                    .unwrap_or_default()
                    .to_string(),
                2 => raw_version
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            };
            let hash = json_string(&value, hash_field)?.to_ascii_lowercase();
            if !is_version_token(&version) || !is_sha256(&hash) {
                return Err(ComponentError::InvalidManifest(format!(
                    "invalid pin for {}",
                    artifact.filename()
                )));
            }
            artifacts.insert(
                artifact,
                ArtifactPin {
                    artifact,
                    filename: artifact.filename().to_string(),
                    version,
                    sha256: hash,
                    size: None,
                },
            );
        }
        Ok(Self { artifacts })
    }

    fn files_for(&self, id: ComponentId) -> Vec<ComponentPackageFile> {
        id.artifacts()
            .iter()
            .filter_map(|artifact| self.artifacts.get(artifact))
            .map(|pin| ComponentPackageFile {
                artifact: pin.artifact,
                name: pin.filename.clone(),
                version: pin.version.clone(),
                sha256: pin.sha256.clone(),
                size: pin.size.unwrap_or_default(),
            })
            .collect()
    }

    fn pin(&self, artifact: RuntimeArtifact) -> Option<&ArtifactPin> {
        self.artifacts.get(&artifact)
    }

    #[cfg(test)]
    fn from_test_files<'a>(
        files: impl IntoIterator<Item = (RuntimeArtifact, &'static str, &'static str, &'a [u8])>,
    ) -> Self {
        let artifacts = files
            .into_iter()
            .map(|(artifact, filename, version, bytes)| {
                (
                    artifact,
                    ArtifactPin {
                        artifact,
                        filename: filename.to_string(),
                        version: version.to_string(),
                        sha256: sha256_bytes(bytes),
                        size: Some(bytes.len() as u64),
                    },
                )
            })
            .collect();
        Self { artifacts }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ComponentPackageManifest {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    pub(crate) id: ComponentId,
    pub(crate) version: String,
    pub(crate) capabilities: Vec<Capability>,
    #[serde(default)]
    pub(crate) dependencies: Vec<String>,
    pub(crate) files: Vec<ComponentPackageFile>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ComponentPackageFile {
    pub(crate) artifact: RuntimeArtifact,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentStatus {
    pub(crate) id: ComponentId,
    pub(crate) state: ComponentState,
    pub(crate) schema_version: Option<u32>,
    pub(crate) version: Option<String>,
    pub(crate) directory: Option<PathBuf>,
    pub(crate) manifest: Option<ComponentPackageManifest>,
    pub(crate) error: Option<String>,
    #[serde(rename = "progressPercent")]
    pub(crate) progress_percent: Option<u8>,
    #[serde(rename = "availableVersion")]
    pub(crate) available_version: Option<String>,
}

#[derive(Debug)]
pub(crate) enum ComponentError {
    Io(io::Error),
    InvalidPackage(String),
    InvalidManifest(String),
    HashMismatch { filename: String },
    Missing(ComponentId),
    Corrupted(ComponentId),
    CapabilityUnavailable(Capability),
    Busy(ComponentId),
    Catalog(distribution::CatalogValidationError),
    CatalogFetch(distribution::CatalogFetchError),
    Download(distribution::AssetDownloadError),
    CatalogRollback,
    CatalogReplay,
    Downgrade,
    ImmutableVersionChanged,
}

impl fmt::Display for ComponentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "component storage operation failed: {error}"),
            Self::InvalidPackage(reason) => {
                write!(formatter, "invalid component package: {reason}")
            }
            Self::InvalidManifest(reason) => {
                write!(formatter, "invalid component manifest: {reason}")
            }
            Self::HashMismatch { filename } => {
                write!(formatter, "component file hash mismatch: {filename}")
            }
            Self::Missing(id) => write!(formatter, "component is missing: {id}"),
            Self::Corrupted(id) => write!(formatter, "component verification failed: {id}"),
            Self::CapabilityUnavailable(capability) => write!(
                formatter,
                "component capability is unavailable: {capability:?}"
            ),
            Self::Busy(id) => write!(formatter, "component operation is already active: {id}"),
            Self::Catalog(error) => write!(formatter, "component catalog rejected: {error}"),
            Self::CatalogFetch(error) => {
                write!(formatter, "component catalog fetch failed: {error:?}")
            }
            Self::Download(error) => write!(formatter, "component download failed: {error:?}"),
            Self::CatalogRollback => {
                formatter.write_str("component catalog sequence is older than the accepted catalog")
            }
            Self::CatalogReplay => {
                formatter.write_str("component catalog sequence was reused with different contents")
            }
            Self::Downgrade => {
                formatter.write_str("component update would downgrade the installed version")
            }
            Self::ImmutableVersionChanged => {
                formatter.write_str("catalog attempted to change an immutable component version")
            }
        }
    }
}

impl std::error::Error for ComponentError {}

impl From<io::Error> for ComponentError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivePointer {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog_sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogSequenceState {
    schema_version: u32,
    sequence: u64,
    key_id: String,
    catalog_sha256: String,
}

pub(crate) struct ComponentManager {
    root: PathBuf,
    pins: Arc<RuntimePins>,
    operation: Mutex<()>,
    installing: Mutex<HashSet<ComponentId>>,
    activity: Mutex<HashMap<ComponentId, ComponentState>>,
    progress: Mutex<HashMap<ComponentId, u8>>,
    errors: Mutex<HashMap<ComponentId, String>>,
    catalog_trust: TrustedKeys,
    catalog_cache: Mutex<Option<distribution::VerifiedComponentCatalog>>,
    allow_loopback_http: bool,
}

impl ComponentManager {
    pub(crate) fn new(root: PathBuf, pins: RuntimePins) -> Result<Self, ComponentError> {
        Self::new_with_trust(root, pins, distribution::production_trust())
    }

    fn new_with_trust(
        root: PathBuf,
        pins: RuntimePins,
        catalog_trust: TrustedKeys,
    ) -> Result<Self, ComponentError> {
        ensure_directory_without_reparse(&root)?;
        let root = fs::canonicalize(root)?;
        reject_reparse_path(&root)?;
        let staging_root = root.join(STAGING_DIR);
        let staging_setup = (|| -> Result<(), ComponentError> {
            ensure_directory_without_reparse(&staging_root)?;
            for entry in fs::read_dir(&staging_root)? {
                let entry = entry?;
                let path = entry.path();
                reject_reparse_path(&path)?;
                if entry.file_type()?.is_dir() {
                    remove_tree_without_reparse(&path)?;
                } else if entry.file_type()?.is_file() {
                    fs::remove_file(path)?;
                } else {
                    return Err(ComponentError::InvalidPackage(
                        "staging folder contains an unsupported filesystem entry".into(),
                    ));
                }
            }
            Ok(())
        })();
        let mut errors = HashMap::new();
        if let Err(error) = staging_setup {
            eprintln!("[components] startup staging recovery deferred: {error}");
            for id in [ComponentId::MediaTools, ComponentId::TorrentEngine] {
                errors.insert(id, "Component recovery required".into());
            }
        }
        Ok(Self {
            root,
            pins: Arc::new(pins),
            operation: Mutex::new(()),
            installing: Mutex::new(HashSet::new()),
            activity: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            errors: Mutex::new(errors),
            catalog_trust,
            catalog_cache: Mutex::new(None),
            allow_loopback_http: cfg!(test),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn media_runtime_paths(&self) -> Option<MediaRuntimePaths> {
        let yt_dlp = self.resolve_capability(Capability::MediaExtraction).ok()?;
        let ffmpeg = self.resolve_capability(Capability::MediaMerge).ok()?;
        let ffprobe = self.resolve_capability(Capability::MediaProbe).ok()?;
        let ffmpeg_dir = ffmpeg.parent()?.to_path_buf();
        if ffprobe.parent()? != ffmpeg_dir {
            return None;
        }
        Some(MediaRuntimePaths { yt_dlp, ffmpeg_dir })
    }

    pub(crate) fn aria2_path(&self) -> Option<PathBuf> {
        self.resolve_capability(Capability::Bittorrent).ok()
    }

    pub(crate) fn list_components(&self) -> Vec<ComponentStatus> {
        [ComponentId::MediaTools, ComponentId::TorrentEngine]
            .into_iter()
            .map(|id| self.component_status(id))
            .collect()
    }

    pub(crate) fn component_status(&self, id: ComponentId) -> ComponentStatus {
        let installing = self
            .installing
            .lock()
            .map(|items| items.contains(&id))
            .unwrap_or(false);
        let last_error = self
            .errors
            .lock()
            .ok()
            .and_then(|items| items.get(&id).cloned());
        let activity = self
            .activity
            .lock()
            .ok()
            .and_then(|items| items.get(&id).copied());
        let progress_percent = self
            .progress
            .lock()
            .ok()
            .and_then(|items| items.get(&id).copied());
        let available_version = self.catalog_cache.lock().ok().and_then(|catalog| {
            catalog
                .as_ref()
                .and_then(|catalog| catalog.component(id))
                .map(|component| component.version.clone())
        });
        let mut status = match self.read_active(id) {
            Ok(Some((directory, manifest, pins))) => {
                match self.verify_directory(id, &directory, &manifest, &pins) {
                    Ok(()) => ComponentStatus {
                        id,
                        state: ComponentState::Installed,
                        schema_version: Some(manifest.schema_version),
                        version: Some(manifest.version.clone()),
                        directory: Some(directory),
                        manifest: Some(manifest),
                        error: None,
                        progress_percent,
                        available_version,
                    },
                    Err(_) => ComponentStatus {
                        id,
                        state: ComponentState::Corrupted,
                        schema_version: Some(manifest.schema_version),
                        version: Some(manifest.version.clone()),
                        directory: Some(directory),
                        manifest: Some(manifest),
                        error: Some("Component verification failed".into()),
                        progress_percent,
                        available_version,
                    },
                }
            }
            Ok(None) => ComponentStatus {
                id,
                state: if last_error.is_some() {
                    ComponentState::Error
                } else {
                    ComponentState::Missing
                },
                schema_version: None,
                version: None,
                directory: None,
                manifest: None,
                error: last_error,
                progress_percent,
                available_version,
            },
            Err(_) => ComponentStatus {
                id,
                state: ComponentState::Corrupted,
                schema_version: None,
                version: None,
                directory: None,
                manifest: None,
                error: Some("Component metadata is invalid".into()),
                progress_percent,
                available_version,
            },
        };
        if let Some(activity) = activity {
            status.state = activity;
        } else if installing {
            status.state = ComponentState::Installing;
        } else if let (Some(installed), Some(available)) =
            (&status.version, &status.available_version)
        {
            if distribution::validate_component_upgrade(installed, available).is_ok()
                && Version::parse(available).ok() > Version::parse(installed).ok()
            {
                status.state = ComponentState::UpdateAvailable;
            }
        }
        status
    }

    pub(crate) fn verify_component(
        &self,
        id: ComponentId,
    ) -> Result<ComponentStatus, ComponentError> {
        Ok(self.component_status(id))
    }

    pub(crate) fn refresh_component_catalog(&self) -> Result<Vec<ComponentStatus>, ComponentError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.refresh_component_catalog_at(distribution::COMPONENT_CATALOG_ENDPOINT, now, false)
    }

    fn refresh_component_catalog_at(
        &self,
        endpoint: &str,
        now: i64,
        allow_loopback_http: bool,
    ) -> Result<Vec<ComponentStatus>, ComponentError> {
        let _operation = self.operation.lock().map_err(|_| {
            ComponentError::InvalidPackage("component manager is unavailable".into())
        })?;
        let bytes = distribution::fetch_catalog_bytes(endpoint, allow_loopback_http)
            .map_err(ComponentError::CatalogFetch)?;
        let verified = distribution::verify_component_catalog(
            &bytes,
            &self.catalog_trust,
            now,
            allow_loopback_http,
        )
        .map_err(ComponentError::Catalog)?;
        self.accept_catalog_sequence(&verified)?;
        *self.catalog_cache.lock().map_err(|_| {
            ComponentError::InvalidPackage("component manager is unavailable".into())
        })? = Some(verified);
        Ok(self.list_components())
    }

    pub(crate) fn install_component_from_catalog<F>(
        &self,
        id: ComponentId,
        progress: F,
    ) -> Result<ComponentStatus, ComponentError>
    where
        F: FnMut(ComponentState, u64, u64),
    {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.install_component_from_catalog_at(
            id,
            distribution::COMPONENT_CATALOG_ENDPOINT,
            now,
            false,
            progress,
        )
    }

    fn install_component_from_catalog_at<F>(
        &self,
        id: ComponentId,
        endpoint: &str,
        now: i64,
        allow_loopback_http: bool,
        mut progress: F,
    ) -> Result<ComponentStatus, ComponentError>
    where
        F: FnMut(ComponentState, u64, u64),
    {
        let _operation = self.operation.lock().map_err(|_| {
            ComponentError::InvalidPackage("component manager is unavailable".into())
        })?;
        self.set_activity(id, ComponentState::Downloading, Some(0));
        self.errors.lock().ok().map(|mut errors| errors.remove(&id));
        let result = (|| {
            let catalog_bytes = distribution::fetch_catalog_bytes(endpoint, allow_loopback_http)
                .map_err(ComponentError::CatalogFetch)?;
            let verified = distribution::verify_component_catalog(
                &catalog_bytes,
                &self.catalog_trust,
                now,
                allow_loopback_http,
            )
            .map_err(ComponentError::Catalog)?;
            self.accept_catalog_sequence(&verified)?;
            let component = verified
                .component(id)
                .cloned()
                .ok_or(ComponentError::Catalog(
                    distribution::CatalogValidationError::InvalidComponent,
                ))?;
            *self.catalog_cache.lock().map_err(|_| {
                ComponentError::InvalidPackage("component manager is unavailable".into())
            })? = Some(verified.clone());

            if let Some((_, active_manifest, _)) = self.read_active(id)? {
                distribution::validate_component_upgrade(
                    &active_manifest.version,
                    &component.version,
                )
                .map_err(|error| match error {
                    distribution::CatalogValidationError::Downgrade => ComponentError::Downgrade,
                    other => ComponentError::Catalog(other),
                })?;
                if active_manifest.version == component.version
                    && active_manifest.files != component.files
                {
                    return Err(ComponentError::ImmutableVersionChanged);
                }
            }

            let pins = RuntimePins::from_catalog_component(&component)?;
            progress(ComponentState::Downloading, 0, component.package_bytes);
            let staging_root = self.root.join(STAGING_DIR);
            ensure_directory_without_reparse(&staging_root)?;
            let download_directory = staging_root.join(unique_leaf("component-download"));
            ensure_directory_without_reparse(&download_directory)?;
            let _download_cleanup = InstallCleanupGuard::new(download_directory.clone());
            let package_path = download_directory.join(&component.asset_name);
            self.set_activity(id, ComponentState::Downloading, Some(0));
            let download_request = distribution::AssetDownloadRequest {
                url: &component.package_url,
                release_tag: &component.release_tag,
                asset_name: &component.asset_name,
                destination: &package_path,
                expected_size: component.package_bytes,
                expected_sha256: &component.package_sha256,
                maximum_size: MAX_PACKAGE_BYTES,
                allow_loopback_http,
            };
            distribution::download_asset_to_path(&download_request, |received| {
                let percent = received
                    .saturating_mul(100)
                    .checked_div(component.package_bytes)
                    .unwrap_or(0)
                    .min(100) as u8;
                self.set_activity(id, ComponentState::Downloading, Some(percent));
                progress(
                    ComponentState::Downloading,
                    received,
                    component.package_bytes,
                );
            })
            .map_err(ComponentError::Download)?;
            self.set_activity(id, ComponentState::Verifying, Some(100));
            progress(
                ComponentState::Verifying,
                component.package_bytes,
                component.package_bytes,
            );
            let package = self.validate_package_with_pins(&package_path, &pins)?;
            if package.package_sha256 != component.package_sha256
                || package.manifest.id != id
                || package.manifest.version != component.version
                || package.manifest.capabilities != component.capabilities
                || package.manifest.files != component.files
            {
                return Err(ComponentError::InvalidManifest(
                    "downloaded package differs from the signed catalog".into(),
                ));
            }
            self.set_activity(id, ComponentState::Installing, Some(100));
            progress(
                ComponentState::Installing,
                component.package_bytes,
                component.package_bytes,
            );
            self.install_validated_package(
                package,
                &pins,
                Some(&verified.original_bytes),
                Some(verified.signed.payload.sequence),
            )?;
            Ok(())
        })();
        self.clear_activity(id);
        match result {
            Ok(()) => Ok(self.component_status(id)),
            Err(error) => {
                if self.read_active(id).ok().flatten().is_none() {
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.insert(id, "Component installation failed".into());
                    }
                }
                Err(error)
            }
        }
    }

    fn set_activity(&self, id: ComponentId, state: ComponentState, progress: Option<u8>) {
        if let Ok(mut activity) = self.activity.lock() {
            activity.insert(id, state);
        }
        if let Ok(mut values) = self.progress.lock() {
            if let Some(progress) = progress {
                values.insert(id, progress);
            } else {
                values.remove(&id);
            }
        }
    }

    fn clear_activity(&self, id: ComponentId) {
        if let Ok(mut activity) = self.activity.lock() {
            activity.remove(&id);
        }
        if let Ok(mut values) = self.progress.lock() {
            values.remove(&id);
        }
    }

    fn accept_catalog_sequence(
        &self,
        catalog: &distribution::VerifiedComponentCatalog,
    ) -> Result<(), ComponentError> {
        let state_path = self.root.join(CATALOG_STATE_NAME);
        let digest = sha256_bytes(&catalog.original_bytes);
        if state_path.exists() {
            reject_reparse_path(&state_path)?;
            let current: CatalogSequenceState = serde_json::from_slice(&fs::read(&state_path)?)
                .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
            if current.schema_version != 1 || !is_sha256(&current.catalog_sha256) {
                return Err(ComponentError::InvalidManifest(
                    "catalog sequence state is invalid".into(),
                ));
            }
            if catalog.signed.payload.sequence < current.sequence {
                return Err(ComponentError::CatalogRollback);
            }
            if catalog.signed.payload.sequence == current.sequence
                && digest != current.catalog_sha256
            {
                return Err(ComponentError::CatalogReplay);
            }
            if catalog.signed.payload.sequence == current.sequence {
                return Ok(());
            }
        }
        let state = CatalogSequenceState {
            schema_version: 1,
            sequence: catalog.signed.payload.sequence,
            key_id: catalog.signed.payload.key_id.clone(),
            catalog_sha256: digest,
        };
        let bytes = serde_json::to_vec(&state)
            .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        write_atomic_file(&state_path, &bytes)?;
        Ok(())
    }

    pub(crate) fn resolve_capability(
        &self,
        capability: Capability,
    ) -> Result<PathBuf, ComponentError> {
        let id = capability.component();
        let status = self.component_status(id);
        match status.state {
            ComponentState::Missing | ComponentState::Error => {
                return Err(ComponentError::Missing(id))
            }
            ComponentState::Corrupted => return Err(ComponentError::Corrupted(id)),
            ComponentState::Downloading
            | ComponentState::Verifying
            | ComponentState::Installing => return Err(ComponentError::Busy(id)),
            ComponentState::Installed | ComponentState::UpdateAvailable => {}
        }
        let (directory, manifest, pins) =
            self.read_active(id)?.ok_or(ComponentError::Missing(id))?;
        let pin = pins
            .pin(capability.artifact())
            .ok_or(ComponentError::CapabilityUnavailable(capability))?;
        if !manifest.files.iter().any(|file| {
            file.artifact == pin.artifact
                && file.name == pin.filename
                && file.version == pin.version
                && file.sha256 == pin.sha256
        }) {
            return Err(ComponentError::Corrupted(id));
        }
        let path = directory.join(&pin.filename);
        if !is_regular_file_without_reparse(&path) || hash_file(&path)? != pin.sha256 {
            return Err(ComponentError::Corrupted(id));
        }
        Ok(path)
    }

    pub(crate) fn install_component_from_package(
        &self,
        package_path: &Path,
    ) -> Result<ComponentStatus, ComponentError> {
        let _operation = self.operation.lock().map_err(|_| {
            ComponentError::InvalidPackage("component manager is unavailable".into())
        })?;
        let package = self.validate_package(package_path)?;
        let id = package.manifest.id;
        self.installing
            .lock()
            .map_err(|_| ComponentError::InvalidPackage("component manager is unavailable".into()))?
            .insert(id);
        self.errors
            .lock()
            .map_err(|_| ComponentError::InvalidPackage("component manager is unavailable".into()))?
            .remove(&id);
        let result = self.install_validated_package(package, &self.pins, None, None);
        self.installing
            .lock()
            .ok()
            .map(|mut items| items.remove(&id));
        match result {
            Ok(()) => Ok(self.component_status(id)),
            Err(error) => {
                if self.read_active(id).ok().flatten().is_none() {
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.insert(id, "Installation failed".into());
                    }
                }
                Err(error)
            }
        }
    }

    pub(crate) fn install_component_from_package_for(
        &self,
        expected_id: ComponentId,
        package_path: &Path,
    ) -> Result<ComponentStatus, ComponentError> {
        let package = match self.validate_package(package_path) {
            Ok(package) => package,
            Err(error) => {
                self.record_install_error_if_missing(expected_id);
                return Err(error);
            }
        };
        if package.manifest.id != expected_id {
            self.record_install_error_if_missing(expected_id);
            return Err(ComponentError::InvalidManifest(
                "package does not match the selected component".into(),
            ));
        }
        self.install_component_from_package(package_path)
    }

    pub(crate) fn repair_component(
        &self,
        id: ComponentId,
        package_path: &Path,
    ) -> Result<ComponentStatus, ComponentError> {
        let package = self.validate_package(package_path)?;
        if package.manifest.id != id {
            return Err(ComponentError::InvalidManifest(
                "package does not match requested component".into(),
            ));
        }
        self.install_component_from_package(package_path)
    }

    pub(crate) fn remove_component(&self, id: ComponentId) -> Result<(), ComponentError> {
        let _operation = self.operation.lock().map_err(|_| {
            ComponentError::InvalidPackage("component manager is unavailable".into())
        })?;
        let component_root = self.component_root(id);
        if !component_root.exists() {
            return Ok(());
        }
        reject_reparse_path(&component_root)?;
        let pointer = component_root.join(POINTER_NAME);
        if pointer.exists() {
            reject_reparse_path(&pointer)?;
            fs::remove_file(&pointer)?;
        }
        remove_tree_without_reparse(&component_root)?;
        if let Ok(mut errors) = self.errors.lock() {
            errors.remove(&id);
        }
        Ok(())
    }

    fn record_install_error_if_missing(&self, id: ComponentId) {
        if self.read_active(id).ok().flatten().is_none() {
            if let Ok(mut errors) = self.errors.lock() {
                errors.insert(id, "Installation failed".into());
            }
        }
    }

    fn install_validated_package(
        &self,
        package: ValidatedPackage,
        pins: &RuntimePins,
        catalog_proof: Option<&[u8]>,
        catalog_sequence: Option<u64>,
    ) -> Result<(), ComponentError> {
        let id = package.manifest.id;
        let staging_root = self.root.join(STAGING_DIR);
        ensure_directory_without_reparse(&staging_root)?;
        let component_root = self.component_root(id);
        ensure_directory_without_reparse(&component_root)?;
        let versions_root = component_root.join("versions");
        ensure_directory_without_reparse(&versions_root)?;
        let staging = staging_root.join(unique_leaf(id.as_str()));
        fs::create_dir(&staging)?;
        let mut cleanup = InstallCleanupGuard::new(staging.clone());
        let mut archive = ZipArchive::new(File::open(&package.path)?)
            .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
        extract_validated_files(&mut archive, &staging, &package.manifest, pins)?;
        let manifest_bytes = serde_json::to_vec_pretty(&package.manifest)
            .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        let mut manifest_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staging.join(MANIFEST_NAME))?;
        manifest_file.write_all(&manifest_bytes)?;
        manifest_file.sync_all()?;
        drop(manifest_file);
        if let Some(proof) = catalog_proof {
            let mut proof_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join(CATALOG_PROOF_NAME))?;
            proof_file.write_all(proof)?;
            proof_file.sync_all()?;
        }
        for entry in &package.manifest.files {
            let path = staging.join(&entry.name);
            if !is_regular_file_without_reparse(&path) || hash_file(&path)? != entry.sha256 {
                return Err(ComponentError::HashMismatch {
                    filename: entry.name.clone(),
                });
            }
        }
        sync_directory(&staging)?;

        let base_leaf = format!(
            "{}-{}",
            package.manifest.version,
            &package.package_sha256[..16]
        );
        let final_directory = choose_version_directory(&versions_root, &base_leaf)?;
        fs::rename(&staging, &final_directory)?;
        cleanup.set_install_directory(final_directory.clone());
        sync_directory(&versions_root)?;
        let pointer = ActivePointer {
            schema_version: COMPONENT_SCHEMA_VERSION,
            directory: final_directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            package_sha256: Some(package.package_sha256.clone()),
            catalog_sequence,
            catalog_sha256: catalog_proof.map(sha256_bytes),
        };
        let pointer_path = component_root.join(POINTER_NAME);
        let pointer_tmp = component_root.join(format!("{POINTER_NAME}.{}.tmp", unique_leaf("ptr")));
        let mut pointer_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pointer_tmp)?;
        cleanup.set_pointer_temp(pointer_tmp.clone());
        pointer_file.write_all(
            &serde_json::to_vec(&pointer)
                .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?,
        )?;
        pointer_file.sync_all()?;
        drop(pointer_file);
        atomic_replace(&pointer_tmp, &pointer_path)?;
        cleanup.commit();
        if let Err(error) = sync_directory(&component_root) {
            eprintln!("[components] active pointer installed but directory sync failed: {error}");
        }
        Ok(())
    }

    fn validate_package(&self, package_path: &Path) -> Result<ValidatedPackage, ComponentError> {
        self.validate_package_with_pins(package_path, &self.pins)
    }

    fn validate_package_with_pins(
        &self,
        package_path: &Path,
        pins: &RuntimePins,
    ) -> Result<ValidatedPackage, ComponentError> {
        let metadata = fs::symlink_metadata(package_path)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || is_reparse_metadata(&metadata)
        {
            return Err(ComponentError::InvalidPackage(
                "package must be a regular, non-linked file".into(),
            ));
        }
        if metadata.len() == 0 || metadata.len() > MAX_PACKAGE_BYTES {
            return Err(ComponentError::InvalidPackage(
                "package size is outside the allowed range".into(),
            ));
        }
        let mut archive = ZipArchive::new(File::open(package_path)?)
            .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
        let names = validate_archive_entries(&mut archive)?;
        if !names.contains(MANIFEST_NAME) {
            return Err(ComponentError::InvalidPackage(
                "package manifest is missing".into(),
            ));
        }
        let manifest_bytes = read_manifest(&mut archive)?;
        let manifest: ComponentPackageManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        validate_manifest(&manifest, pins)?;
        let expected_names = manifest
            .files
            .iter()
            .map(|file| file.name.as_str())
            .chain([MANIFEST_NAME])
            .collect::<HashSet<_>>();
        if names.len() != expected_names.len()
            || names
                .iter()
                .any(|name| !expected_names.contains(name.as_str()))
        {
            return Err(ComponentError::InvalidPackage(
                "package contains missing or unlisted files".into(),
            ));
        }
        for file in &manifest.files {
            let entry = archive
                .by_name(&file.name)
                .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
            if entry.size() != file.size || file.size == 0 || file.size > MAX_COMPONENT_FILE_BYTES {
                return Err(ComponentError::InvalidPackage(format!(
                    "invalid size for {}",
                    file.name
                )));
            }
            let pin = pins
                .pin(file.artifact)
                .ok_or_else(|| ComponentError::InvalidManifest("runtime pin is missing".into()))?;
            if pin.size.is_some_and(|size| size != file.size) {
                return Err(ComponentError::InvalidManifest(format!(
                    "catalog size does not match {}",
                    file.name
                )));
            }
        }
        let package_sha256 = hash_file(package_path)?;
        Ok(ValidatedPackage {
            path: package_path.to_path_buf(),
            manifest,
            package_sha256,
        })
    }

    fn read_active(
        &self,
        id: ComponentId,
    ) -> Result<Option<(PathBuf, ComponentPackageManifest, RuntimePins)>, ComponentError> {
        let component_root = self.component_root(id);
        if !component_root.exists() {
            return Ok(None);
        }
        reject_reparse_path(&component_root)?;
        let pointer_path = component_root.join(POINTER_NAME);
        if !pointer_path.exists() {
            return Ok(None);
        }
        reject_reparse_path(&pointer_path)?;
        let pointer: ActivePointer = serde_json::from_slice(&fs::read(&pointer_path)?)
            .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        if pointer.schema_version != COMPONENT_SCHEMA_VERSION
            || !valid_directory_leaf(&pointer.directory)
        {
            return Err(ComponentError::InvalidManifest(
                "active pointer is invalid".into(),
            ));
        }
        let version_root = component_root.join("versions");
        reject_reparse_path(&version_root)?;
        let directory = version_root.join(&pointer.directory);
        reject_reparse_path(&directory)?;
        if !directory.is_dir() {
            return Err(ComponentError::InvalidManifest(
                "active component directory is missing".into(),
            ));
        }
        let proof_path = directory.join(CATALOG_PROOF_NAME);
        let catalog_pin = match (pointer.catalog_sequence, pointer.catalog_sha256.as_deref()) {
            (Some(sequence), Some(expected_catalog_hash)) => {
                if !valid_directory_leaf(&pointer.directory)
                    || !pointer.package_sha256.as_deref().is_some_and(is_sha256)
                    || !is_sha256(expected_catalog_hash)
                    || !is_regular_file_without_reparse(&proof_path)
                    || hash_file(&proof_path)? != expected_catalog_hash
                {
                    return Err(ComponentError::InvalidManifest(
                        "signed component proof is missing or invalid".into(),
                    ));
                }
                let proof_bytes = fs::read(&proof_path)?;
                let verified = distribution::verify_persisted_catalog_snapshot(
                    &proof_bytes,
                    &self.catalog_trust,
                    self.allow_loopback_http,
                )
                .map_err(ComponentError::Catalog)?;
                if verified.signed.payload.sequence != sequence {
                    return Err(ComponentError::InvalidManifest(
                        "signed component proof sequence does not match the active pointer".into(),
                    ));
                }
                let catalog_component = verified.component(id).ok_or(ComponentError::Catalog(
                    distribution::CatalogValidationError::InvalidComponent,
                ))?;
                if Some(catalog_component.package_sha256.as_str())
                    != pointer.package_sha256.as_deref()
                {
                    return Err(ComponentError::InvalidManifest(
                        "signed catalog does not approve the active component package".into(),
                    ));
                }
                let manifest_bytes = fs::read(directory.join(MANIFEST_NAME))?;
                let active_manifest: ComponentPackageManifest =
                    serde_json::from_slice(&manifest_bytes)
                        .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
                if active_manifest.id != id
                    || active_manifest.version != catalog_component.version
                    || active_manifest.capabilities != catalog_component.capabilities
                    || active_manifest.files != catalog_component.files
                {
                    return Err(ComponentError::InvalidManifest(
                        "active manifest differs from the signed catalog".into(),
                    ));
                }
                Some(RuntimePins::from_catalog_component(catalog_component)?)
            }
            (None, None) => {
                if pointer.catalog_sha256.is_some()
                    || proof_path.exists()
                    || pointer
                        .package_sha256
                        .as_deref()
                        .is_some_and(|hash| !is_sha256(hash))
                {
                    return Err(ComponentError::InvalidManifest(
                        "local component pointer contains unexpected catalog metadata".into(),
                    ));
                }
                None
            }
            _ => {
                return Err(ComponentError::InvalidManifest(
                    "active pointer has incomplete catalog metadata".into(),
                ));
            }
        };
        let manifest_path = directory.join(MANIFEST_NAME);
        reject_reparse_path(&manifest_path)?;
        let manifest: ComponentPackageManifest = serde_json::from_slice(&fs::read(manifest_path)?)
            .map_err(|error| ComponentError::InvalidManifest(error.to_string()))?;
        let pins = catalog_pin.unwrap_or_else(|| (*self.pins).clone());
        validate_manifest(&manifest, &pins)?;
        if manifest.id != id {
            return Err(ComponentError::InvalidManifest(
                "active component id does not match its directory".into(),
            ));
        }
        Ok(Some((directory, manifest, pins)))
    }

    fn verify_directory(
        &self,
        id: ComponentId,
        directory: &Path,
        manifest: &ComponentPackageManifest,
        pins: &RuntimePins,
    ) -> Result<(), ComponentError> {
        reject_reparse_path(directory)?;
        let expected = manifest
            .files
            .iter()
            .map(|file| file.name.as_str())
            .chain([MANIFEST_NAME])
            .chain(
                directory
                    .join(CATALOG_PROOF_NAME)
                    .exists()
                    .then_some(CATALOG_PROOF_NAME),
            )
            .collect::<HashSet<_>>();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !expected.contains(name.as_str()) {
                return Err(ComponentError::InvalidManifest(format!(
                    "unexpected installed file: {name}"
                )));
            }
            reject_reparse_path(&entry.path())?;
            if !entry.file_type()?.is_file() {
                return Err(ComponentError::InvalidManifest(format!(
                    "non-file in component directory: {name}"
                )));
            }
        }
        for file in &manifest.files {
            let pin = pins
                .pin(file.artifact)
                .ok_or_else(|| ComponentError::InvalidManifest("runtime pin is missing".into()))?;
            if pin.filename != file.name || pin.version != file.version || pin.sha256 != file.sha256
            {
                return Err(ComponentError::HashMismatch {
                    filename: file.name.clone(),
                });
            }
            let path = directory.join(&file.name);
            if !is_regular_file_without_reparse(&path) || hash_file(&path)? != file.sha256 {
                return Err(ComponentError::HashMismatch {
                    filename: file.name.clone(),
                });
            }
        }
        if manifest.id != id {
            return Err(ComponentError::InvalidManifest(
                "installed component id is invalid".into(),
            ));
        }
        Ok(())
    }

    fn component_root(&self, id: ComponentId) -> PathBuf {
        self.root.join(id.as_str())
    }
}

struct ValidatedPackage {
    path: PathBuf,
    manifest: ComponentPackageManifest,
    package_sha256: String,
}

struct InstallCleanupGuard {
    install_directory: Option<PathBuf>,
    pointer_temp: Option<PathBuf>,
}

impl InstallCleanupGuard {
    fn new(staging_directory: PathBuf) -> Self {
        Self {
            install_directory: Some(staging_directory),
            pointer_temp: None,
        }
    }

    fn set_install_directory(&mut self, directory: PathBuf) {
        self.install_directory = Some(directory);
    }

    fn set_pointer_temp(&mut self, pointer_temp: PathBuf) {
        self.pointer_temp = Some(pointer_temp);
    }

    fn commit(&mut self) {
        self.install_directory = None;
        self.pointer_temp = None;
    }
}

impl Drop for InstallCleanupGuard {
    fn drop(&mut self) {
        if let Some(pointer_temp) = self.pointer_temp.take() {
            let _ = fs::remove_file(pointer_temp);
        }
        if let Some(directory) = self.install_directory.take() {
            let _ = remove_tree_without_reparse(&directory);
        }
    }
}

fn json_string<'a>(value: &'a serde_json::Value, dotted: &str) -> Result<&'a str, ComponentError> {
    let mut current = value;
    for segment in dotted.split('.') {
        current = current
            .get(segment)
            .ok_or_else(|| ComponentError::InvalidManifest(format!("missing {dotted}")))?;
    }
    current
        .as_str()
        .ok_or_else(|| ComponentError::InvalidManifest(format!("invalid {dotted}")))
}

fn validate_manifest(
    manifest: &ComponentPackageManifest,
    pins: &RuntimePins,
) -> Result<(), ComponentError> {
    if manifest.schema_version != COMPONENT_SCHEMA_VERSION {
        return Err(ComponentError::InvalidManifest(
            "unsupported schemaVersion".into(),
        ));
    }
    if Version::parse(&manifest.version).is_err() {
        return Err(ComponentError::InvalidManifest(
            "component version must be semantic version text".into(),
        ));
    }
    if manifest.capabilities != manifest.id.capabilities() {
        return Err(ComponentError::InvalidManifest(
            "component capabilities do not match the supported contract".into(),
        ));
    }
    if !manifest.dependencies.is_empty() {
        return Err(ComponentError::InvalidManifest(
            "component dependencies are not supported in V1".into(),
        ));
    }
    let expected = pins.files_for(manifest.id);
    if manifest.files.len() != expected.len() {
        return Err(ComponentError::InvalidManifest(
            "component file inventory does not match the pinned runtime set".into(),
        ));
    }
    let mut names = HashSet::new();
    for (actual, expected) in manifest.files.iter().zip(expected.iter()) {
        if actual.artifact != expected.artifact
            || actual.name != expected.name
            || actual.version != expected.version
            || actual.sha256 != expected.sha256
            || !is_sha256(&actual.sha256)
            || actual.size == 0
            || actual.size > MAX_COMPONENT_FILE_BYTES
            || (expected.size != 0 && actual.size != expected.size)
            || !names.insert(actual.name.to_ascii_lowercase())
        {
            return Err(ComponentError::InvalidManifest(format!(
                "file declaration is not pinned: {}",
                actual.name
            )));
        }
    }
    let total = manifest
        .files
        .iter()
        .try_fold(0u64, |sum, file| sum.checked_add(file.size));
    if total.is_none_or(|value| value > MAX_COMPONENT_BYTES) {
        return Err(ComponentError::InvalidManifest(
            "component package exceeds the supported total size".into(),
        ));
    }
    Ok(())
}

fn validate_archive_entries(
    archive: &mut ZipArchive<File>,
) -> Result<HashSet<String>, ComponentError> {
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
        let raw_name = entry.name().to_string();
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            ComponentError::InvalidPackage("archive path escapes the package".into())
        })?;
        if enclosed.components().count() != 1
            || !matches!(enclosed.components().next(), Some(Component::Normal(_)))
            || raw_name.contains('/')
            || raw_name.contains('\\')
            || raw_name.contains(':')
            || entry.is_dir()
            || entry.is_symlink()
        {
            return Err(ComponentError::InvalidPackage(
                "package paths must be flat regular files".into(),
            ));
        }
        if !names.insert(raw_name.to_ascii_lowercase()) {
            return Err(ComponentError::InvalidPackage(
                "package contains duplicate file names".into(),
            ));
        }
        if entry.size() > MAX_COMPONENT_FILE_BYTES.max(MAX_MANIFEST_BYTES) {
            return Err(ComponentError::InvalidPackage(
                "archive entry exceeds the supported size".into(),
            ));
        }
    }
    Ok(names)
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<Vec<u8>, ComponentError> {
    let entry = archive
        .by_name(MANIFEST_NAME)
        .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
    if entry.size() == 0 || entry.size() > MAX_MANIFEST_BYTES {
        return Err(ComponentError::InvalidPackage(
            "component manifest size is invalid".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(ComponentError::InvalidPackage(
            "component manifest is too large".into(),
        ));
    }
    Ok(bytes)
}

fn extract_validated_files(
    archive: &mut ZipArchive<File>,
    staging: &Path,
    manifest: &ComponentPackageManifest,
    pins: &RuntimePins,
) -> Result<(), ComponentError> {
    let expected = manifest
        .files
        .iter()
        .map(|file| file.name.as_str())
        .collect::<HashSet<_>>();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| ComponentError::InvalidPackage(error.to_string()))?;
        if entry.name() == MANIFEST_NAME {
            continue;
        }
        if !expected.contains(entry.name()) || entry.is_symlink() || entry.is_dir() {
            return Err(ComponentError::InvalidPackage(
                "archive entry is not in the component manifest".into(),
            ));
        }
        let file = manifest
            .files
            .iter()
            .find(|file| file.name == entry.name())
            .ok_or_else(|| {
                ComponentError::InvalidPackage("archive entry has no file record".into())
            })?;
        let pin = pins
            .pin(file.artifact)
            .ok_or_else(|| ComponentError::InvalidManifest("runtime pin is missing".into()))?;
        if entry.size() != file.size || file.name != pin.filename || file.sha256 != pin.sha256 {
            return Err(ComponentError::InvalidManifest(
                "package file differs from the approved pin".into(),
            ));
        }
        let destination = staging.join(&file.name);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total = total.checked_add(read as u64).ok_or_else(|| {
                ComponentError::InvalidPackage("component file size overflow".into())
            })?;
            if total > file.size || total > MAX_COMPONENT_FILE_BYTES {
                return Err(ComponentError::InvalidPackage(
                    "component file expands beyond its declared size".into(),
                ));
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        output.sync_all()?;
        if total != file.size || format!("{:x}", hasher.finalize()) != file.sha256 {
            return Err(ComponentError::HashMismatch {
                filename: file.name.clone(),
            });
        }
    }
    Ok(())
}

fn choose_version_directory(
    versions_root: &Path,
    base_leaf: &str,
) -> Result<PathBuf, ComponentError> {
    for suffix in 0..100u32 {
        let leaf = if suffix == 0 {
            base_leaf.to_string()
        } else {
            format!("{base_leaf}-{suffix}")
        };
        let path = versions_root.join(&leaf);
        if !path.exists() {
            return Ok(path);
        }
        reject_reparse_path(&path)?;
    }
    Err(ComponentError::InvalidPackage(
        "too many component versions share this package identity".into(),
    ))
}

fn unique_leaf(prefix: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let serial = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{timestamp:x}-{}-{serial:x}", std::process::id())
}

fn valid_directory_leaf(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_version_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_file(path: &Path) -> Result<String, ComponentError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn reject_reparse_path(path: &Path) -> Result<(), ComponentError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || is_reparse_metadata(&metadata) => {
                return Err(ComponentError::InvalidPackage(
                    "component path contains a symbolic link or reparse point".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn is_regular_file_without_reparse(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && !is_reparse_metadata(&metadata)
        })
        .unwrap_or(false)
}

fn ensure_directory_without_reparse(path: &Path) -> Result<(), ComponentError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata)
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || is_reparse_metadata(&metadata) =>
            {
                return Err(ComponentError::InvalidPackage(
                    "component directory is not a safe directory".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&current)?,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn remove_tree_without_reparse(path: &Path) -> Result<(), ComponentError> {
    reject_reparse_path(path)?;
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            reject_reparse_path(&entry.path())?;
            if entry.file_type()?.is_dir() {
                remove_tree_without_reparse(&entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
        fs::remove_dir(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn sync_directory(_path: &Path) -> Result<(), ComponentError> {
    #[cfg(unix)]
    File::open(_path)?.sync_all()?;
    Ok(())
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), ComponentError> {
    let parent = path
        .parent()
        .ok_or_else(|| ComponentError::InvalidPackage("state path has no parent".into()))?;
    reject_reparse_path(parent)?;
    if fs::symlink_metadata(path).is_ok() {
        reject_reparse_path(path)?;
    }
    let mut temporary_name = path.as_os_str().to_os_string();
    temporary_name.push(format!(".{}.tmp", unique_leaf("state")));
    let temporary = PathBuf::from(temporary_name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}
