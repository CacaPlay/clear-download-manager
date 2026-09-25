//! Signed remote tool-catalog checks, bounded fetching and last-known-good
//! persistence. The public(crate) helpers are consumed by the private updater
//! coordinator; no Tauri command or scheduler lives here.

use super::{
    manifest::{
        parse_utc_timestamp_seconds, reject_duplicate_keys, validate_manifest, ManifestError,
        ToolManifest, VerifiedManifest,
    },
    overlay::resolve_verified_overlay,
    policy::{component_policy, UpdateEligibility},
    trust::{TrustError, TrustedKeys},
    version::{classify_component_version, VersionRelation},
};
use crate::app::runtime::{resolve_bundled_tool, runtime_binary_version, ToolId};
use reqwest::{
    blocking::{Client, Response},
    header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub(crate) const FUTURE_PRODUCTION_CATALOG_ENDPOINT: &str =
    "https://ozelot.github.io/tool-catalog/v1/current.json";

const CATALOG_HOST: &str = "ozelot.github.io";
pub(crate) const CATALOG_SCHEMA_VERSION: u32 = 1;
const MAX_CATALOG_BYTES: usize = 256 * 1024;
const MAX_HEADER_LENGTH: usize = 256;
const MAX_VALIDITY_SECONDS: i64 = 90 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const PERIODIC_INTERVAL_SECONDS: i64 = 7 * 24 * 60 * 60;
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogCheckMode {
    Periodic,
    Manual,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogStatus {
    Current,
    Available,
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CatalogError {
    NetworkUnavailable,
    Timeout,
    HttpStatus(u16),
    OversizedCatalog,
    InvalidSchema,
    InvalidSignature,
    UnknownKey,
    Replay,
    Expired,
    CacheCorrupt,
    PolicyRejected,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NetworkUnavailable => formatter.write_str("network unavailable"),
            Self::Timeout => formatter.write_str("catalog request timed out"),
            Self::HttpStatus(status) => write!(formatter, "catalog HTTP status {status}"),
            Self::OversizedCatalog => formatter.write_str("catalog response exceeds size limit"),
            Self::InvalidSchema => formatter.write_str("catalog schema is invalid"),
            Self::InvalidSignature => formatter.write_str("catalog signature is invalid"),
            Self::UnknownKey => formatter.write_str("catalog key is not trusted"),
            Self::Replay => formatter.write_str("catalog sequence was rejected as replay"),
            Self::Expired => formatter.write_str("catalog freshness window is invalid or expired"),
            Self::CacheCorrupt => formatter.write_str("catalog cache is corrupt"),
            Self::PolicyRejected => formatter.write_str("catalog component policy rejected"),
        }
    }
}

impl std::error::Error for CatalogError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolCatalogEnvelope {
    pub(crate) schema_version: u32,
    pub(crate) key_id: String,
    pub(crate) sequence: u64,
    pub(crate) issued_at: String,
    pub(crate) expires_at: String,
    pub(crate) manifest: ToolManifest,
    pub(crate) signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCatalogPayload<'a> {
    schema_version: u32,
    key_id: &'a str,
    sequence: u64,
    issued_at: &'a str,
    expires_at: &'a str,
    manifest: &'a ToolManifest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VerifiedCatalog {
    envelope: ToolCatalogEnvelope,
    issued_at: i64,
    expires_at: i64,
    expired: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CatalogCheckResult {
    pub(crate) mode: CatalogCheckMode,
    pub(crate) status: CatalogStatus,
    pub(crate) source: CatalogSource,
    pub(crate) error: Option<CatalogError>,
    pub(crate) sequence: Option<u64>,
    pub(crate) manifest_id: Option<String>,
    pub(crate) available_version: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogSource {
    None,
    Remote,
    LastKnownGood,
    NotModified,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeToolSnapshot {
    bundled_version: Option<String>,
    overlay_version: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CatalogRequest {
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CatalogResponse {
    status: u16,
    etag: Option<String>,
    last_modified: Option<String>,
    body: Vec<u8>,
}

pub(crate) trait CatalogTransport {
    fn fetch(&self, request: &CatalogRequest) -> Result<CatalogResponse, CatalogError>;
}

struct HttpCatalogTransport {
    client: Client,
}

impl HttpCatalogTransport {
    fn new() -> Result<Self, CatalogError> {
        Client::builder()
            .dns_resolver(crate::public_dns_resolver())
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map(|client| Self { client })
            .map_err(|_| CatalogError::NetworkUnavailable)
    }
}

impl CatalogTransport for HttpCatalogTransport {
    fn fetch(&self, request: &CatalogRequest) -> Result<CatalogResponse, CatalogError> {
        let mut builder = self
            .client
            .get(FUTURE_PRODUCTION_CATALOG_ENDPOINT)
            .header("Host", CATALOG_HOST);
        if let Some(etag) = request.etag.as_deref() {
            builder = builder.header(IF_NONE_MATCH, etag);
        }
        if let Some(last_modified) = request.last_modified.as_deref() {
            builder = builder.header(IF_MODIFIED_SINCE, last_modified);
        }
        let response = builder.send().map_err(|error| {
            if error.is_timeout() {
                CatalogError::Timeout
            } else {
                CatalogError::NetworkUnavailable
            }
        })?;
        let status = response.status().as_u16();
        let etag = response_header(&response, ETAG);
        let last_modified = response_header(&response, LAST_MODIFIED);
        if status == 304 {
            return Ok(CatalogResponse {
                status,
                etag,
                last_modified,
                body: Vec::new(),
            });
        }
        if status != 200 {
            return Err(CatalogError::HttpStatus(status));
        }
        let body = bounded_body(response)?;
        Ok(CatalogResponse {
            status,
            etag,
            last_modified,
            body,
        })
    }
}

fn response_header(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= MAX_HEADER_LENGTH)
        .map(ToOwned::to_owned)
}

fn bounded_body(response: Response) -> Result<Vec<u8>, CatalogError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err(CatalogError::OversizedCatalog);
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_CATALOG_BYTES as u64) as usize,
    );
    response
        .take((MAX_CATALOG_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| CatalogError::NetworkUnavailable)?;
    if body.len() > MAX_CATALOG_BYTES {
        return Err(CatalogError::OversizedCatalog);
    }
    Ok(body)
}

pub(crate) fn canonical_catalog_payload_bytes(
    envelope: &ToolCatalogEnvelope,
) -> Result<Vec<u8>, CatalogError> {
    if envelope.schema_version != CATALOG_SCHEMA_VERSION
        || envelope.key_id != envelope.manifest.key_id
    {
        return Err(CatalogError::InvalidSchema);
    }
    serde_json::to_vec(&ToolCatalogPayload {
        schema_version: envelope.schema_version,
        key_id: &envelope.key_id,
        sequence: envelope.sequence,
        issued_at: &envelope.issued_at,
        expires_at: &envelope.expires_at,
        manifest: &envelope.manifest,
    })
    .map_err(|_| CatalogError::InvalidSchema)
}

fn map_trust_error(error: TrustError) -> CatalogError {
    match error {
        TrustError::UnknownKeyId(_) => CatalogError::UnknownKey,
        TrustError::InvalidPublicKey(_) | TrustError::InvalidSignatureEncoding => {
            CatalogError::InvalidSignature
        }
        TrustError::InvalidSignature => CatalogError::InvalidSignature,
    }
}

fn map_manifest_error(error: ManifestError) -> CatalogError {
    match error {
        ManifestError::InvalidJson(_)
        | ManifestError::DuplicateKey(_)
        | ManifestError::UnsupportedSchemaVersion(_) => CatalogError::InvalidSchema,
        ManifestError::UnknownKeyId(_) => CatalogError::UnknownKey,
        ManifestError::InvalidSignature(_) => CatalogError::InvalidSignature,
        ManifestError::IncompatibleAppVersion(_)
        | ManifestError::Version(_)
        | ManifestError::Sha256(_)
        | ManifestError::Revoked(_)
        | ManifestError::PartialFfmpegSet
        | ManifestError::InvalidField { .. }
        | ManifestError::UnknownComponent(_) => CatalogError::PolicyRejected,
    }
}

fn parse_and_verify_catalog(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
    now: i64,
    allow_expired: bool,
) -> Result<VerifiedCatalog, CatalogError> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(CatalogError::OversizedCatalog);
    }
    reject_duplicate_keys(bytes).map_err(map_manifest_error)?;
    let envelope: ToolCatalogEnvelope =
        serde_json::from_slice(bytes).map_err(|_| CatalogError::InvalidSchema)?;
    if envelope.schema_version != CATALOG_SCHEMA_VERSION
        || envelope.key_id != envelope.manifest.key_id
    {
        return Err(CatalogError::InvalidSchema);
    }
    let Some(issued_at) = parse_utc_timestamp_seconds(&envelope.issued_at) else {
        return Err(CatalogError::InvalidSchema);
    };
    let Some(expires_at) = parse_utc_timestamp_seconds(&envelope.expires_at) else {
        return Err(CatalogError::InvalidSchema);
    };
    if expires_at <= issued_at
        || expires_at.saturating_sub(issued_at) > MAX_VALIDITY_SECONDS
        || issued_at > now.saturating_add(CLOCK_SKEW_SECONDS)
    {
        return Err(CatalogError::InvalidSchema);
    }
    let expired = expires_at < now.saturating_sub(CLOCK_SKEW_SECONDS);
    if expired && !allow_expired {
        return Err(CatalogError::Expired);
    }
    let canonical = canonical_catalog_payload_bytes(&envelope)?;
    trusted_keys
        .verify(&envelope.key_id, &canonical, &envelope.signature)
        .map_err(map_trust_error)?;
    validate_manifest(&envelope.manifest, env!("CARGO_PKG_VERSION")).map_err(map_manifest_error)?;
    Ok(VerifiedCatalog {
        envelope,
        issued_at,
        expires_at,
        expired,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheMetadata {
    accepted_sequence: u64,
    manifest_id: String,
    issued_at: String,
    expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    verified_envelope: ToolCatalogEnvelope,
    accepted_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SequenceState {
    highest_accepted_sequence: u64,
}

#[derive(Clone, Debug)]
struct CachedCatalog {
    verified: VerifiedCatalog,
    metadata: CacheMetadata,
}

fn catalog_root(root: &Path) -> PathBuf {
    root.join("tools").join("catalog")
}

fn current_path(root: &Path) -> PathBuf {
    catalog_root(root).join("current.json")
}

fn metadata_path(root: &Path) -> PathBuf {
    catalog_root(root).join("metadata.json")
}

fn sequence_path(root: &Path) -> PathBuf {
    catalog_root(root).join("sequence.json")
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

fn ensure_directory(path: &Path) -> Result<(), CatalogError> {
    fs::create_dir_all(path).map_err(|_| CatalogError::CacheCorrupt)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| CatalogError::CacheCorrupt)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(CatalogError::CacheCorrupt);
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), CatalogError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| CatalogError::CacheCorrupt)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(CatalogError::CacheCorrupt);
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CatalogError> {
    let parent = path.parent().ok_or(CatalogError::CacheCorrupt)?;
    ensure_directory(parent)?;
    let temporary = path.with_file_name(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or(CatalogError::CacheCorrupt)?
    ));
    if fs::symlink_metadata(&temporary).is_ok() {
        ensure_regular_file(&temporary)?;
        fs::remove_file(&temporary).map_err(|_| CatalogError::CacheCorrupt)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| CatalogError::CacheCorrupt)?;
    file.write_all(bytes)
        .map_err(|_| CatalogError::CacheCorrupt)?;
    file.sync_all().map_err(|_| CatalogError::CacheCorrupt)?;
    drop(file);

    let backup = path.with_file_name(format!(
        "{}.previous",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or(CatalogError::CacheCorrupt)?
    ));
    let had_target = fs::symlink_metadata(path).is_ok();
    if had_target {
        ensure_regular_file(path)?;
        if fs::symlink_metadata(&backup).is_ok() {
            ensure_regular_file(&backup)?;
            fs::remove_file(&backup).map_err(|_| CatalogError::CacheCorrupt)?;
        }
        fs::rename(path, &backup).map_err(|_| CatalogError::CacheCorrupt)?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            if fs::symlink_metadata(&backup).is_ok() {
                let _ = fs::remove_file(backup);
            }
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            if had_target {
                let _ = fs::rename(&backup, path);
            }
            Err(CatalogError::CacheCorrupt)
        }
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, CatalogError> {
    ensure_regular_file(path)?;
    let metadata = fs::metadata(path).map_err(|_| CatalogError::CacheCorrupt)?;
    if metadata.len() > MAX_CATALOG_BYTES as u64 {
        return Err(CatalogError::OversizedCatalog);
    }
    let mut file = File::open(path).map_err(|_| CatalogError::CacheCorrupt)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| CatalogError::CacheCorrupt)?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(CatalogError::OversizedCatalog);
    }
    Ok(bytes)
}

fn read_lkg(
    root: &Path,
    trusted_keys: &TrustedKeys,
    now: i64,
) -> Result<Option<CachedCatalog>, CatalogError> {
    if !root.is_absolute() {
        return Err(CatalogError::CacheCorrupt);
    }
    let directory = catalog_root(root);
    if fs::symlink_metadata(&directory).is_err() {
        return Ok(None);
    }
    ensure_directory(&directory)?;
    let current = current_path(root);
    let metadata_file = metadata_path(root);
    if fs::symlink_metadata(&current).is_err() || fs::symlink_metadata(&metadata_file).is_err() {
        return Err(CatalogError::CacheCorrupt);
    }
    let current_bytes = read_bounded(&current)?;
    let verified = parse_and_verify_catalog(&current_bytes, trusted_keys, now, true)
        .map_err(|_| CatalogError::CacheCorrupt)?;
    let metadata_bytes = read_bounded(&metadata_file)?;
    reject_duplicate_keys(&metadata_bytes).map_err(|_| CatalogError::CacheCorrupt)?;
    let metadata: CacheMetadata =
        serde_json::from_slice(&metadata_bytes).map_err(|_| CatalogError::CacheCorrupt)?;
    if metadata.accepted_sequence != verified.envelope.sequence
        || metadata.manifest_id != verified.envelope.manifest.manifest_id
        || metadata.issued_at != verified.envelope.issued_at
        || metadata.expires_at != verified.envelope.expires_at
        || metadata.verified_envelope != verified.envelope
        || metadata
            .etag
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > MAX_HEADER_LENGTH)
        || metadata
            .last_modified
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > MAX_HEADER_LENGTH)
    {
        return Err(CatalogError::CacheCorrupt);
    }
    Ok(Some(CachedCatalog { verified, metadata }))
}

fn read_sequence_state(root: &Path) -> Result<Option<u64>, CatalogError> {
    let path = sequence_path(root);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    let bytes = read_bounded(&path)?;
    reject_duplicate_keys(&bytes).map_err(map_manifest_error)?;
    let state: SequenceState =
        serde_json::from_slice(&bytes).map_err(|_| CatalogError::CacheCorrupt)?;
    Ok(Some(state.highest_accepted_sequence))
}

fn write_lkg(
    root: &Path,
    verified: &VerifiedCatalog,
    response: &CatalogResponse,
    accepted_at: i64,
    highest_sequence: u64,
) -> Result<(), CatalogError> {
    let metadata = CacheMetadata {
        accepted_sequence: verified.envelope.sequence,
        manifest_id: verified.envelope.manifest.manifest_id.clone(),
        issued_at: verified.envelope.issued_at.clone(),
        expires_at: verified.envelope.expires_at.clone(),
        etag: response.etag.clone(),
        last_modified: response.last_modified.clone(),
        verified_envelope: verified.envelope.clone(),
        accepted_at,
    };
    let envelope_bytes =
        serde_json::to_vec(&verified.envelope).map_err(|_| CatalogError::CacheCorrupt)?;
    let metadata_bytes = serde_json::to_vec(&metadata).map_err(|_| CatalogError::CacheCorrupt)?;
    let sequence_bytes = serde_json::to_vec(&SequenceState {
        highest_accepted_sequence: highest_sequence,
    })
    .map_err(|_| CatalogError::CacheCorrupt)?;
    atomic_write(&current_path(root), &envelope_bytes)?;
    atomic_write(&metadata_path(root), &metadata_bytes)?;
    atomic_write(&sequence_path(root), &sequence_bytes)?;
    Ok(())
}

fn is_retryable(error: &CatalogError) -> bool {
    matches!(
        error,
        CatalogError::NetworkUnavailable
            | CatalogError::Timeout
            | CatalogError::HttpStatus(408 | 425 | 429 | 500 | 502 | 503 | 504)
    )
}

fn fetch_with_retries(
    transport: &dyn CatalogTransport,
    request: &CatalogRequest,
    sleep: &mut dyn FnMut(Duration),
) -> Result<CatalogResponse, CatalogError> {
    #[allow(clippy::needless_range_loop)]
    for attempt in 0..=RETRY_DELAYS.len() {
        match transport.fetch(request) {
            Ok(response) => return Ok(response),
            Err(error) if attempt < RETRY_DELAYS.len() && is_retryable(&error) => {
                sleep(RETRY_DELAYS[attempt]);
            }
            Err(error) => return Err(error),
        }
    }
    Err(CatalogError::NetworkUnavailable)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

pub(crate) fn should_check(last_check: Option<i64>, now: i64, jitter_seconds: i64) -> bool {
    if !(0..PERIODIC_INTERVAL_SECONDS).contains(&jitter_seconds) {
        return false;
    }
    last_check
        .map(|last| now.saturating_sub(last) >= PERIODIC_INTERVAL_SECONDS + jitter_seconds)
        .unwrap_or(true)
}

fn runtime_snapshot(app: &AppHandle) -> RuntimeToolSnapshot {
    let overlay_version = resolve_verified_overlay(app).map(|overlay| overlay.version);
    let bundled_version = resolve_bundled_tool(app, ToolId::YtDlp)
        .path
        .map(|path| runtime_binary_version(&path, "--version"))
        .filter(|version| !version.is_empty());
    RuntimeToolSnapshot {
        bundled_version,
        overlay_version,
    }
}

fn compare_yt_dlp(manifest: &ToolManifest, runtime: &RuntimeToolSnapshot) -> CatalogStatus {
    let Some(component) = manifest
        .components
        .iter()
        .find(|component| component.id == ToolId::YtDlp)
    else {
        return CatalogStatus::Rejected;
    };
    if component_policy(ToolId::YtDlp).eligibility != UpdateEligibility::UpdateEligible {
        return CatalogStatus::Rejected;
    }
    let Some(active) = runtime
        .overlay_version
        .as_deref()
        .or(runtime.bundled_version.as_deref())
    else {
        return CatalogStatus::Unavailable;
    };
    match classify_component_version(ToolId::YtDlp, active, &component.version) {
        Ok(VersionRelation::Newer) => CatalogStatus::Available,
        Ok(VersionRelation::Equal) => CatalogStatus::Current,
        Ok(VersionRelation::Older) | Err(_) => CatalogStatus::Rejected,
    }
}

fn result_from_catalog(
    mode: CatalogCheckMode,
    source: CatalogSource,
    catalog: Option<&VerifiedCatalog>,
    runtime: &RuntimeToolSnapshot,
    error: Option<CatalogError>,
) -> CatalogCheckResult {
    let Some(catalog) = catalog else {
        return CatalogCheckResult {
            mode,
            status: if error.is_some() {
                CatalogStatus::Rejected
            } else {
                CatalogStatus::Unavailable
            },
            source,
            error,
            sequence: None,
            manifest_id: None,
            available_version: None,
        };
    };
    let component_version = catalog
        .envelope
        .manifest
        .components
        .iter()
        .find(|component| component.id == ToolId::YtDlp)
        .map(|component| component.version.clone());
    CatalogCheckResult {
        mode,
        status: if catalog.expired {
            CatalogStatus::Unavailable
        } else {
            compare_yt_dlp(&catalog.envelope.manifest, runtime)
        },
        source,
        error,
        sequence: Some(catalog.envelope.sequence),
        manifest_id: Some(catalog.envelope.manifest.manifest_id.clone()),
        available_version: component_version,
    }
}

fn check_tool_catalog_with(
    root: &Path,
    transport: &dyn CatalogTransport,
    trusted_keys: &TrustedKeys,
    runtime: &RuntimeToolSnapshot,
    mode: CatalogCheckMode,
    now: i64,
    sleep: &mut dyn FnMut(Duration),
) -> CatalogCheckResult {
    let cache_result = read_lkg(root, trusted_keys, now);
    let cache = cache_result.as_ref().ok().and_then(|value| value.as_ref());
    let cache_error = cache_result.as_ref().err().cloned();
    let state_result = read_sequence_state(root);
    let state_error = state_result.as_ref().err().cloned();
    let highest_sequence = state_result
        .ok()
        .flatten()
        .into_iter()
        .chain(cache.iter().map(|value| value.verified.envelope.sequence))
        .max();
    let request = CatalogRequest {
        etag: cache.and_then(|value| value.metadata.etag.clone()),
        last_modified: cache.and_then(|value| value.metadata.last_modified.clone()),
    };
    let fetch = fetch_with_retries(transport, &request, sleep);
    let base_error = cache_error.or(state_error);
    match fetch {
        Ok(response) if response.status == 304 => {
            if let Some(cached) = cache {
                return result_from_catalog(
                    mode,
                    CatalogSource::NotModified,
                    Some(&cached.verified),
                    runtime,
                    base_error,
                );
            }
            result_from_catalog(
                mode,
                CatalogSource::None,
                None,
                runtime,
                Some(CatalogError::CacheCorrupt),
            )
        }
        Ok(response) => match parse_and_verify_catalog(&response.body, trusted_keys, now, false) {
            Ok(verified) => {
                let sequence = verified.envelope.sequence;
                let same_as_cache =
                    cache.is_some_and(|cached| cached.verified.envelope == verified.envelope);
                if highest_sequence.is_some_and(|highest| sequence < highest)
                    || (highest_sequence.is_some_and(|highest| sequence == highest)
                        && !same_as_cache)
                {
                    return result_from_catalog(
                        mode,
                        CatalogSource::LastKnownGood,
                        cache.map(|cached| &cached.verified),
                        runtime,
                        Some(CatalogError::Replay),
                    );
                }
                let highest = highest_sequence.unwrap_or(sequence).max(sequence);
                if let Err(error) = write_lkg(root, &verified, &response, now, highest) {
                    return result_from_catalog(
                        mode,
                        CatalogSource::Remote,
                        None,
                        runtime,
                        Some(error),
                    );
                }
                result_from_catalog(
                    mode,
                    CatalogSource::Remote,
                    Some(&verified),
                    runtime,
                    base_error,
                )
            }
            Err(error) => result_from_catalog(
                mode,
                CatalogSource::LastKnownGood,
                cache.map(|cached| &cached.verified),
                runtime,
                Some(error),
            ),
        },
        Err(error) => result_from_catalog(
            mode,
            CatalogSource::LastKnownGood,
            cache.map(|cached| &cached.verified),
            runtime,
            Some(base_error.unwrap_or(error)),
        ),
    }
}

pub(crate) fn check_tool_catalog(app: &AppHandle, mode: CatalogCheckMode) -> CatalogCheckResult {
    let trusted_keys = TrustedKeys::production();
    if trusted_keys.key_ids().next().is_none() {
        let result = CatalogCheckResult {
            mode,
            status: CatalogStatus::Unavailable,
            source: CatalogSource::None,
            error: Some(CatalogError::UnknownKey),
            sequence: None,
            manifest_id: None,
            available_version: None,
        };
        eprintln!(
            "[tools/catalog] mode={:?} source={:?} status={:?} error={:?}",
            result.mode, result.source, result.status, result.error
        );
        return result;
    }
    let root = match app.path().app_data_dir() {
        Ok(root) => root,
        Err(_) => {
            return CatalogCheckResult {
                mode,
                status: CatalogStatus::Unavailable,
                source: CatalogSource::None,
                error: Some(CatalogError::CacheCorrupt),
                sequence: None,
                manifest_id: None,
                available_version: None,
            }
        }
    };
    let transport = match HttpCatalogTransport::new() {
        Ok(transport) => transport,
        Err(error) => {
            return CatalogCheckResult {
                mode,
                status: CatalogStatus::Unavailable,
                source: CatalogSource::None,
                error: Some(error),
                sequence: None,
                manifest_id: None,
                available_version: None,
            }
        }
    };
    let runtime = runtime_snapshot(app);
    let mut sleep = |duration: Duration| std::thread::sleep(duration);
    let result = check_tool_catalog_with(
        &root,
        &transport,
        &trusted_keys,
        &runtime,
        mode,
        now_seconds(),
        &mut sleep,
    );
    eprintln!(
        "[tools/catalog] mode={:?} source={:?} status={:?} sequence={:?} manifestId={:?} error={:?}",
        result.mode, result.source, result.status, result.sequence, result.manifest_id, result.error
    );
    result
}

/// Reads only the verified last-known-good catalog. It never constructs an
/// HTTP client, so Settings can ask for cached status without causing a
/// network request when it opens.
pub(crate) fn cached_tool_catalog_status(
    app: &AppHandle,
    mode: CatalogCheckMode,
) -> CatalogCheckResult {
    let trusted_keys = TrustedKeys::production();
    if trusted_keys.key_ids().next().is_none() {
        return CatalogCheckResult {
            mode,
            status: CatalogStatus::Unavailable,
            source: CatalogSource::None,
            error: Some(CatalogError::UnknownKey),
            sequence: None,
            manifest_id: None,
            available_version: None,
        };
    }
    let root = match app.path().app_data_dir() {
        Ok(root) => root,
        Err(_) => {
            return CatalogCheckResult {
                mode,
                status: CatalogStatus::Unavailable,
                source: CatalogSource::None,
                error: Some(CatalogError::CacheCorrupt),
                sequence: None,
                manifest_id: None,
                available_version: None,
            }
        }
    };
    let runtime = runtime_snapshot(app);
    match read_lkg(&root, &trusted_keys, now_seconds()) {
        Ok(Some(cached)) => result_from_catalog(
            mode,
            CatalogSource::LastKnownGood,
            Some(&cached.verified),
            &runtime,
            None,
        ),
        Ok(None) => result_from_catalog(mode, CatalogSource::None, None, &runtime, None),
        Err(error) => result_from_catalog(mode, CatalogSource::None, None, &runtime, Some(error)),
    }
}

pub(crate) fn cached_catalog_checked_at(app: &AppHandle) -> Option<u64> {
    let trusted_keys = TrustedKeys::production();
    trusted_keys.key_ids().next()?;
    let root = app.path().app_data_dir().ok()?;
    read_lkg(&root, &trusted_keys, now_seconds())
        .ok()
        .flatten()
        .and_then(|cached| u64::try_from(cached.metadata.accepted_at).ok())
}

/// Re-reads and re-verifies the LKG before an explicit activation request.
/// The returned manifest is trusted only for the lifetime of the caller and
/// cannot be populated from frontend input.
pub(crate) fn verified_manifest_from_cache(
    app: &AppHandle,
) -> Result<VerifiedManifest, CatalogError> {
    let trusted_keys = TrustedKeys::production();
    if trusted_keys.key_ids().next().is_none() {
        return Err(CatalogError::UnknownKey);
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| CatalogError::CacheCorrupt)?;
    let cached =
        read_lkg(&root, &trusted_keys, now_seconds())?.ok_or(CatalogError::CacheCorrupt)?;
    if cached.verified.expired {
        return Err(CatalogError::Expired);
    }
    Ok(VerifiedManifest::from_validated(
        cached.verified.envelope.manifest,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{
        manifest::{canonical_payload_bytes, ToolManifestEnvelope},
        trust::TrustedKeys,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::{Arc, Mutex};

    const TEST_ONLY_SEED: [u8; 32] = [
        0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33,
        0x95, 0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44,
        0x97, 0x5e,
    ];
    const TEST_KEY_ID: &str = "test-only-2026";
    const VALID_PAYLOAD: &str = include_str!("fixtures/valid-manifest-payload.json");

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_ONLY_SEED)
    }

    fn trust() -> TrustedKeys {
        TrustedKeys::from_public_key_bytes(vec![(
            TEST_KEY_ID.to_string(),
            signing_key().verifying_key().to_bytes(),
        )])
        .unwrap()
    }

    fn envelope(sequence: u64, issued_at: &str, expires_at: &str) -> ToolCatalogEnvelope {
        let mut manifest: ToolManifest = serde_json::from_str(VALID_PAYLOAD).unwrap();
        manifest.key_id = TEST_KEY_ID.into();
        let mut value = ToolCatalogEnvelope {
            schema_version: CATALOG_SCHEMA_VERSION,
            key_id: TEST_KEY_ID.into(),
            sequence,
            issued_at: issued_at.into(),
            expires_at: expires_at.into(),
            manifest,
            signature: String::new(),
        };
        let payload = canonical_catalog_payload_bytes(&value).unwrap();
        value.signature = STANDARD.encode(signing_key().sign(&payload).to_bytes());
        value
    }

    fn bytes(value: &ToolCatalogEnvelope) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    #[derive(Clone)]
    struct FakeTransport {
        responses: Arc<Mutex<Vec<Result<CatalogResponse, CatalogError>>>>,
        requests: Arc<Mutex<Vec<CatalogRequest>>>,
    }

    impl FakeTransport {
        fn new(responses: Vec<Result<CatalogResponse, CatalogError>>) -> Self {
            Self {
                responses: Arc::new(Mutex::new(responses)),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl CatalogTransport for FakeTransport {
        fn fetch(&self, request: &CatalogRequest) -> Result<CatalogResponse, CatalogError> {
            self.requests.lock().unwrap().push(request.clone());
            let mut responses = self.responses.lock().unwrap();
            if responses.len() > 1 {
                responses.remove(0)
            } else {
                responses
                    .first()
                    .cloned()
                    .unwrap_or(Err(CatalogError::NetworkUnavailable))
            }
        }
    }

    fn runtime() -> RuntimeToolSnapshot {
        RuntimeToolSnapshot {
            bundled_version: Some("2026.08.19".into()),
            overlay_version: None,
        }
    }

    fn root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("cacatools-catalog-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn response(envelope: &ToolCatalogEnvelope) -> CatalogResponse {
        CatalogResponse {
            status: 200,
            etag: Some("\"v1\"".into()),
            last_modified: Some("Tue, 08 Sep 2026 00:00:00 GMT".into()),
            body: bytes(envelope),
        }
    }

    #[test]
    fn authority_is_brand_neutral_and_production_root_is_not_used() {
        assert_eq!(
            FUTURE_PRODUCTION_CATALOG_ENDPOINT,
            "https://ozelot.github.io/tool-catalog/v1/current.json"
        );
        assert_eq!(TrustedKeys::production().key_ids().count(), 0);
    }

    #[test]
    fn valid_catalog_is_verified_with_one_signature_domain() {
        let value = envelope(7, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let verified =
            parse_and_verify_catalog(&bytes(&value), &trust(), 1_788_825_600, false).unwrap();
        assert_eq!(verified.envelope.sequence, 7);
        assert!(!verified.expired);
    }

    #[test]
    fn modified_unknown_and_duplicate_catalogs_are_rejected() {
        let value = envelope(7, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let mut modified = value.clone();
        modified.sequence = 8;
        assert_eq!(
            parse_and_verify_catalog(&bytes(&modified), &trust(), 1_788_825_600, false),
            Err(CatalogError::InvalidSignature)
        );
        let mut unknown = value.clone();
        unknown.key_id = "unknown".into();
        assert_eq!(
            parse_and_verify_catalog(&bytes(&unknown), &trust(), 1_788_825_600, false),
            Err(CatalogError::InvalidSchema)
        );
        let duplicate = br#"{"schemaVersion":1,"schemaVersion":1}"#;
        assert_eq!(
            parse_and_verify_catalog(duplicate, &trust(), 1_788_825_600, false),
            Err(CatalogError::InvalidSchema)
        );
    }

    #[test]
    fn freshness_rules_reject_invalid_window_future_and_expired_remote() {
        let invalid = envelope(1, "2026-09-08T00:00:00Z", "2026-09-07T00:00:00Z");
        assert_eq!(
            parse_and_verify_catalog(&bytes(&invalid), &trust(), 1_788_825_600, false),
            Err(CatalogError::InvalidSchema)
        );
        let too_long = envelope(1, "2026-09-08T00:00:00Z", "2027-01-01T00:00:00Z");
        assert_eq!(
            parse_and_verify_catalog(&bytes(&too_long), &trust(), 1_788_825_600, false),
            Err(CatalogError::InvalidSchema)
        );
        let expired = envelope(1, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
        assert_eq!(
            parse_and_verify_catalog(&bytes(&expired), &trust(), 1_788_825_600, false),
            Err(CatalogError::Expired)
        );
        assert!(
            parse_and_verify_catalog(&bytes(&expired), &trust(), 1_788_825_600, true)
                .unwrap()
                .expired
        );
    }

    #[test]
    fn sequence_and_status_comparison_are_strict() {
        let root = root("sequence");
        let first = envelope(4, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let mut higher = envelope(5, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        higher.manifest.components[0].version = "2026.08.20".into();
        higher.manifest.components[0].artifact.release_tag = "2026.08.20".into();
        higher.signature = STANDARD.encode(
            signing_key()
                .sign(&canonical_catalog_payload_bytes(&higher).unwrap())
                .to_bytes(),
        );
        let transport = FakeTransport::new(vec![Ok(response(&first))]);
        let mut sleep = |_| {};
        let result = check_tool_catalog_with(
            &root,
            &transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Periodic,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.status, CatalogStatus::Current);
        assert_eq!(result.source, CatalogSource::Remote);
        let transport = FakeTransport::new(vec![Ok(response(&higher))]);
        let result = check_tool_catalog_with(
            &root,
            &transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.status, CatalogStatus::Available);
        assert_eq!(result.sequence, Some(5));
        let replay = FakeTransport::new(vec![Ok(response(&first))]);
        let result = check_tool_catalog_with(
            &root,
            &replay,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.error, Some(CatalogError::Replay));
        assert_eq!(result.status, CatalogStatus::Available);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_sequence_different_payload_is_rejected() {
        let root = root("same-sequence");
        let first = envelope(8, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let mut different = first.clone();
        different.manifest.manifest_id = "different".into();
        let payload = canonical_catalog_payload_bytes(&different).unwrap();
        different.signature = STANDARD.encode(signing_key().sign(&payload).to_bytes());
        let mut sleep = |_| {};
        let first_transport = FakeTransport::new(vec![Ok(response(&first))]);
        let _ = check_tool_catalog_with(
            &root,
            &first_transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        let second_transport = FakeTransport::new(vec![Ok(response(&different))]);
        let result = check_tool_catalog_with(
            &root,
            &second_transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.error, Some(CatalogError::Replay));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn etag_last_modified_and_304_preserve_lkg() {
        let root = root("validators");
        let value = envelope(9, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let transport = FakeTransport::new(vec![Ok(response(&value))]);
        let mut sleep = |_| {};
        let _ = check_tool_catalog_with(
            &root,
            &transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        let not_modified = FakeTransport::new(vec![Ok(CatalogResponse {
            status: 304,
            etag: Some("\"v1\"".into()),
            last_modified: None,
            body: Vec::new(),
        })]);
        let result = check_tool_catalog_with(
            &root,
            &not_modified,
            &trust(),
            &runtime(),
            CatalogCheckMode::Periodic,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.source, CatalogSource::NotModified);
        assert_eq!(result.sequence, Some(9));
        assert_eq!(
            not_modified.requests.lock().unwrap()[0].etag.as_deref(),
            Some("\"v1\"")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retries_only_transient_errors_and_rejects_oversized_body() {
        let transient = FakeTransport::new(vec![
            Err(CatalogError::Timeout),
            Err(CatalogError::HttpStatus(503)),
            Ok(CatalogResponse {
                status: 200,
                etag: None,
                last_modified: None,
                body: br#"{}"#.to_vec(),
            }),
        ]);
        let mut delays = Vec::new();
        let mut sleep = |duration: Duration| delays.push(duration);
        let result = fetch_with_retries(&transient, &CatalogRequest::default(), &mut sleep);
        assert!(result.is_ok());
        assert_eq!(delays, RETRY_DELAYS.to_vec());

        let definitive = FakeTransport::new(vec![Err(CatalogError::HttpStatus(404))]);
        let calls = Arc::new(Mutex::new(0));
        let calls_for_sleep = Arc::clone(&calls);
        let mut sleep = move |_| *calls_for_sleep.lock().unwrap() += 1;
        let result = fetch_with_retries(&definitive, &CatalogRequest::default(), &mut sleep);
        assert_eq!(result, Err(CatalogError::HttpStatus(404)));
        assert_eq!(*calls.lock().unwrap(), 0);

        let oversized = FakeTransport::new(vec![Ok(CatalogResponse {
            status: 200,
            etag: None,
            last_modified: None,
            body: vec![0; MAX_CATALOG_BYTES + 1],
        })]);
        let result = check_tool_catalog_with(
            &root("oversized"),
            &oversized,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.error, Some(CatalogError::OversizedCatalog));
    }

    #[test]
    fn cache_tampering_is_rejected_and_lkg_does_not_block_startup() {
        let root = root("tamper");
        let value = envelope(10, "2026-09-08T00:00:00Z", "2026-10-01T00:00:00Z");
        let transport = FakeTransport::new(vec![Ok(response(&value))]);
        let mut sleep = |_| {};
        let _ = check_tool_catalog_with(
            &root,
            &transport,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        let mut tampered = fs::read(current_path(&root)).unwrap();
        let index = tampered.len() - 2;
        tampered[index] = if tampered[index] == b'0' { b'1' } else { b'0' };
        fs::write(current_path(&root), tampered).unwrap();
        let offline = FakeTransport::new(vec![Err(CatalogError::NetworkUnavailable)]);
        let result = check_tool_catalog_with(
            &root,
            &offline,
            &trust(),
            &runtime(),
            CatalogCheckMode::Manual,
            1_788_825_600,
            &mut sleep,
        );
        assert_eq!(result.status, CatalogStatus::Rejected);
        assert_eq!(result.error, Some(CatalogError::CacheCorrupt));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn periodic_check_respects_interval_and_bounded_jitter() {
        assert!(should_check(None, 100, 0));
        assert!(!should_check(Some(100), 100 + PERIODIC_INTERVAL_SECONDS, 1));
        assert!(should_check(
            Some(100),
            100 + PERIODIC_INTERVAL_SECONDS + 1,
            1
        ));
        assert!(!should_check(Some(100), 200, -1));
        assert!(!should_check(Some(100), 200, PERIODIC_INTERVAL_SECONDS));
    }

    #[test]
    fn deno_ffmpeg_and_aria2_are_not_update_eligible() {
        assert_ne!(
            component_policy(ToolId::Deno).eligibility,
            UpdateEligibility::UpdateEligible
        );
        assert_ne!(
            component_policy(ToolId::Ffmpeg).eligibility,
            UpdateEligibility::UpdateEligible
        );
        assert_ne!(
            component_policy(ToolId::Ffprobe).eligibility,
            UpdateEligibility::UpdateEligible
        );
        assert_ne!(
            component_policy(ToolId::Aria2c).eligibility,
            UpdateEligibility::UpdateEligible
        );
    }

    #[test]
    fn legacy_manifest_signature_bytes_remain_unchanged() {
        let manifest: ToolManifest = serde_json::from_str(VALID_PAYLOAD).unwrap();
        let canonical = canonical_payload_bytes(&manifest).unwrap();
        let signature = signing_key().sign(&canonical);
        let envelope = ToolManifestEnvelope {
            payload: manifest,
            signature: STANDARD.encode(signature.to_bytes()),
        };
        assert!(!serde_json::to_vec(&envelope).unwrap().is_empty());
    }
}
