#[cfg(test)]
use super::RuntimeArtifact;
use super::{Capability, ComponentId, ComponentPackageFile};
use crate::tools::{
    manifest::reject_duplicate_keys,
    trust::{TrustError, TrustedKeys},
};
use reqwest::{
    blocking::Client,
    header::CONTENT_LENGTH,
    header::USER_AGENT,
    redirect::{Attempt, Policy},
    Client as AsyncClient,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;
use url::Url;

#[cfg(not(feature = "qa-component-manager"))]
pub(crate) const COMPONENT_CATALOG_ENDPOINT: &str =
    "https://github.com/CacaPlay/clear-download-manager/releases/latest/download/component-catalog-v1.json";
#[cfg(feature = "qa-component-manager")]
pub(crate) const COMPONENT_CATALOG_ENDPOINT: &str =
    "http://127.0.0.1:49301/component-catalog-v1.json";
pub(crate) const ALLOW_LOOPBACK_HTTP: bool = cfg!(any(test, feature = "qa-component-manager"));

const COMPONENT_CATALOG_SCHEMA: u32 = 1;
const MAX_CATALOG_BYTES: usize = 256 * 1024;
const MAX_CATALOG_LIFETIME_SECONDS: i64 = 90 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS: i64 = 5 * 60;
pub(crate) const MAX_COMPONENT_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CATALOG_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PACKAGE_READ_TIMEOUT: Duration = Duration::from_secs(45);
const RELEASE_HOST: &str = "github.com";
const RELEASE_REPOSITORY_PATH: &str = "/CacaPlay/clear-download-manager/releases/download/";
const CATALOG_PATH: &str =
    "/CacaPlay/clear-download-manager/releases/latest/download/component-catalog-v1.json";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedComponentCatalog {
    pub(crate) payload: ComponentCatalogPayload,
    pub(crate) signature: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComponentCatalogPayload {
    pub(crate) schema_version: u32,
    pub(crate) catalog_version: String,
    pub(crate) sequence: u64,
    pub(crate) key_id: String,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) components: Vec<CatalogComponent>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogComponent {
    pub(crate) id: ComponentId,
    pub(crate) version: String,
    pub(crate) release_tag: String,
    pub(crate) asset_name: String,
    pub(crate) package_url: String,
    pub(crate) package_bytes: u64,
    pub(crate) package_sha256: String,
    pub(crate) capabilities: Vec<Capability>,
    pub(crate) minimum_cdm_version: String,
    pub(crate) files: Vec<ComponentPackageFile>,
    pub(crate) corresponding_sources: Vec<CorrespondingSourceAsset>,
    pub(crate) license_notices: Vec<LicenseNotice>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CorrespondingSourceAsset {
    pub(crate) runtime_id: String,
    pub(crate) source_commit: String,
    pub(crate) asset_name: String,
    pub(crate) asset_url: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
    pub(crate) license: String,
    pub(crate) human_review: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LicenseNotice {
    pub(crate) runtime_id: String,
    pub(crate) spdx: String,
    pub(crate) notice_file: String,
    pub(crate) notice_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct VerifiedComponentCatalog {
    pub(crate) signed: SignedComponentCatalog,
    pub(crate) original_bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogValidationError {
    TooLarge,
    InvalidSchema,
    UnknownKey,
    InvalidSignature,
    Expired,
    InvalidComponent,
    InvalidPackageUrl,
    SourceReviewPending,
    Downgrade,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AssetValidationError {
    TooLarge,
    SizeMismatch,
    HashMismatch,
    ReadFailed,
    WriteFailed,
    DestinationExists,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AssetDownloadError {
    InvalidUrl,
    Network,
    HttpStatus,
    RedirectRejected,
    SizeMismatch,
    HashMismatch,
    TooLarge,
    Filesystem,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogFetchError {
    InvalidUrl,
    Network,
    HttpStatus,
    RedirectRejected,
    TooLarge,
}

pub(crate) fn fetch_catalog_bytes(
    url: &str,
    allow_loopback_http: bool,
) -> Result<Vec<u8>, CatalogFetchError> {
    if !catalog_url_allowed(url, allow_loopback_http) {
        return Err(CatalogFetchError::InvalidUrl);
    }
    let client =
        build_catalog_client(allow_loopback_http).map_err(|_| CatalogFetchError::Network)?;
    let response = client
        .get(url)
        .header(USER_AGENT, "ClearDownloadManager/component-manager")
        .send()
        .map_err(|error| {
            if error.is_redirect() {
                CatalogFetchError::RedirectRejected
            } else {
                CatalogFetchError::Network
            }
        })?;
    if !response.status().is_success() {
        return Err(CatalogFetchError::HttpStatus);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_CATALOG_BYTES)
    {
        return Err(CatalogFetchError::TooLarge);
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_CATALOG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CatalogFetchError::Network)?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(CatalogFetchError::TooLarge);
    }
    Ok(bytes)
}

pub(crate) struct AssetDownloadRequest<'a> {
    pub(crate) url: &'a str,
    pub(crate) release_tag: &'a str,
    pub(crate) asset_name: &'a str,
    pub(crate) destination: &'a Path,
    pub(crate) expected_size: u64,
    pub(crate) expected_sha256: &'a str,
    pub(crate) maximum_size: u64,
    pub(crate) allow_loopback_http: bool,
}

pub(crate) fn download_asset_to_path<F>(
    request: &AssetDownloadRequest<'_>,
    progress: F,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), AssetDownloadError>
where
    F: FnMut(u64),
{
    if !package_url_allowed(
        request.url,
        request.release_tag,
        request.asset_name,
        request.allow_loopback_http,
    ) {
        return Err(AssetDownloadError::InvalidUrl);
    }
    if request.expected_size == 0 || request.expected_size > request.maximum_size {
        return Err(AssetDownloadError::TooLarge);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| AssetDownloadError::Network)?;
    runtime.block_on(download_asset_async(request, progress, cancelled))
}

fn redirect_policy(allow_loopback_http: bool) -> Policy {
    Policy::custom(move |attempt: Attempt<'_>| {
        let target = attempt.url();
        let is_github_https = !cfg!(feature = "qa-component-manager")
            && target.scheme() == "https"
            && target.port().is_none()
            && matches!(
                target.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                        | "github-releases.githubusercontent.com"
                )
            );
        let is_test_loopback = allow_loopback_http
            && target.scheme() == "http"
            && target.host_str() == Some("127.0.0.1")
            && target.port().is_some()
            && (!cfg!(feature = "qa-component-manager") || target.port() == Some(49301));
        if attempt.previous().len() >= 3
            || !target.username().is_empty()
            || target.password().is_some()
            || !(is_github_https || is_test_loopback)
        {
            attempt.error("component download redirect rejected")
        } else {
            attempt.follow()
        }
    })
}

fn build_catalog_client(allow_loopback_http: bool) -> Result<Client, reqwest::Error> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CATALOG_REQUEST_TIMEOUT)
        .redirect(redirect_policy(allow_loopback_http))
        .build()
}

fn build_package_client(allow_loopback_http: bool) -> Result<AsyncClient, reqwest::Error> {
    AsyncClient::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(redirect_policy(allow_loopback_http))
        .build()
}

async fn download_asset_async<F>(
    request: &AssetDownloadRequest<'_>,
    mut progress: F,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), AssetDownloadError>
where
    F: FnMut(u64),
{
    let client = build_package_client(request.allow_loopback_http)
        .map_err(|_| AssetDownloadError::Network)?;
    let response_result = tokio::select! {
        response = tokio::time::timeout(
            PACKAGE_READ_TIMEOUT,
            client
            .get(request.url)
            .header(USER_AGENT, "ClearDownloadManager/component-manager")
            .send(),
        ) => response
            .map_err(|_| AssetDownloadError::Network)?
            .map_err(|error| {
        if error.is_redirect() {
            AssetDownloadError::RedirectRejected
        } else {
            AssetDownloadError::Network
        }
        }),
        _ = wait_for_cancellation(cancelled.clone()) => Err(AssetDownloadError::Cancelled),
    };
    let mut response = response_result?;
    if !response.status().is_success() {
        return Err(AssetDownloadError::HttpStatus);
    }
    if response
        .content_length()
        .is_some_and(|length| length != request.expected_size)
    {
        return Err(AssetDownloadError::SizeMismatch);
    }
    if request.expected_size > request.maximum_size {
        return Err(AssetDownloadError::TooLarge);
    }
    if request.destination.exists() {
        return Err(AssetDownloadError::Filesystem);
    }
    let mut partial_name = request.destination.as_os_str().to_os_string();
    partial_name.push(".part");
    let partial = std::path::PathBuf::from(partial_name);
    let mut cleanup = PartialCleanup(Some(partial.clone()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|_| AssetDownloadError::Filesystem)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    loop {
        let chunk_result = tokio::select! {
            chunk = tokio::time::timeout(PACKAGE_READ_TIMEOUT, response.chunk()) => chunk
                .map_err(|_| AssetDownloadError::Network)?
                .map_err(|_| AssetDownloadError::Network),
            _ = wait_for_cancellation(cancelled.clone()) => Err(AssetDownloadError::Cancelled),
        };
        let chunk = chunk_result?;
        let Some(chunk) = chunk else { break };
        total = total.saturating_add(chunk.len() as u64);
        if total > request.maximum_size {
            return Err(AssetDownloadError::TooLarge);
        }
        if total > request.expected_size {
            return Err(AssetDownloadError::SizeMismatch);
        }
        digest.update(&chunk);
        output
            .write_all(&chunk)
            .map_err(|_| AssetDownloadError::Filesystem)?;
        progress(total);
    }
    if total != request.expected_size {
        return Err(AssetDownloadError::SizeMismatch);
    }
    let actual_sha256: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual_sha256 != request.expected_sha256 {
        return Err(AssetDownloadError::HashMismatch);
    }
    output
        .sync_all()
        .map_err(|_| AssetDownloadError::Filesystem)?;
    drop(output);
    fs::rename(&partial, request.destination).map_err(|_| AssetDownloadError::Filesystem)?;
    cleanup.0 = None;
    Ok(())
}

async fn wait_for_cancellation(token: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    loop {
        if token.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn verify_asset_bytes(
    bytes: &[u8],
    expected_size: u64,
    expected_sha256: &str,
    maximum_size: u64,
) -> Result<(), AssetValidationError> {
    if expected_size > maximum_size || bytes.len() as u64 > maximum_size {
        return Err(AssetValidationError::TooLarge);
    }
    if bytes.len() as u64 != expected_size {
        return Err(AssetValidationError::SizeMismatch);
    }
    if sha256_hex(bytes) != expected_sha256 {
        return Err(AssetValidationError::HashMismatch);
    }
    Ok(())
}

pub(crate) fn write_verified_download<R, F>(
    mut reader: R,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
    maximum_size: u64,
    mut progress: F,
) -> Result<(), AssetValidationError>
where
    R: Read,
    F: FnMut(u64),
{
    if expected_size > maximum_size {
        return Err(AssetValidationError::TooLarge);
    }
    if destination.exists() {
        return Err(AssetValidationError::DestinationExists);
    }
    let mut partial_name = destination.as_os_str().to_os_string();
    partial_name.push(".part");
    let partial = std::path::PathBuf::from(partial_name);
    let mut cleanup = PartialCleanup(Some(partial.clone()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|_| AssetValidationError::WriteFailed)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| AssetValidationError::ReadFailed)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > maximum_size {
            return Err(AssetValidationError::TooLarge);
        }
        if total > expected_size {
            return Err(AssetValidationError::SizeMismatch);
        }
        digest.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| AssetValidationError::WriteFailed)?;
        progress(total);
    }
    if total != expected_size {
        return Err(AssetValidationError::SizeMismatch);
    }
    let actual_sha256: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual_sha256 != expected_sha256 {
        return Err(AssetValidationError::HashMismatch);
    }
    output
        .sync_all()
        .map_err(|_| AssetValidationError::WriteFailed)?;
    drop(output);
    fs::rename(&partial, destination).map_err(|_| AssetValidationError::WriteFailed)?;
    cleanup.0 = None;
    Ok(())
}

struct PartialCleanup(Option<std::path::PathBuf>);

impl Drop for PartialCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

impl std::fmt::Display for CatalogValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::TooLarge => "component catalog exceeds the size limit",
            Self::InvalidSchema => "component catalog schema is invalid",
            Self::UnknownKey => "component catalog signing key is not trusted",
            Self::InvalidSignature => "component catalog signature is invalid",
            Self::Expired => "component catalog freshness window is invalid or expired",
            Self::InvalidComponent => {
                "component catalog metadata does not match the release contract"
            }
            Self::InvalidPackageUrl => "component asset URL is outside the approved release route",
            Self::SourceReviewPending => "component corresponding-source review is not approved",
            Self::Downgrade => "component catalog would downgrade an installed version",
        })
    }
}

impl std::error::Error for CatalogValidationError {}

impl VerifiedComponentCatalog {
    pub(crate) fn component(&self, id: ComponentId) -> Option<&CatalogComponent> {
        self.signed
            .payload
            .components
            .iter()
            .find(|component| component.id == id)
    }
}

pub(crate) fn configured_trust() -> TrustedKeys {
    // Component catalogs have a dedicated trust domain. The QA build selects
    // a separate public test key at compile time; tool-catalog roots never
    // activate this path.
    let encoded = super::catalog_key::PUBLIC_KEY_BASE64;
    if encoded.is_empty() {
        return TrustedKeys::empty();
    }
    let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
    else {
        return TrustedKeys::empty();
    };
    if bytes.len() != 32
        || base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes) != encoded
    {
        return TrustedKeys::empty();
    }
    let Ok(public_key) = <[u8; 32]>::try_from(bytes) else {
        return TrustedKeys::empty();
    };
    TrustedKeys::from_public_key_bytes([(super::catalog_key::KEY_ID.to_string(), public_key)])
        .unwrap_or_else(|_| TrustedKeys::empty())
}

pub(crate) fn production_trust() -> TrustedKeys {
    #[cfg(feature = "qa-component-manager")]
    {
        TrustedKeys::empty()
    }
    #[cfg(not(feature = "qa-component-manager"))]
    {
        configured_trust()
    }
}

pub(crate) fn verify_component_catalog(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
    now: i64,
    allow_loopback_http: bool,
) -> Result<VerifiedComponentCatalog, CatalogValidationError> {
    verify_component_catalog_internal(bytes, trusted_keys, now, allow_loopback_http, true)
}

pub(crate) fn verify_persisted_catalog_snapshot(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
    allow_loopback_http: bool,
) -> Result<VerifiedComponentCatalog, CatalogValidationError> {
    verify_component_catalog_internal(bytes, trusted_keys, 0, allow_loopback_http, false)
}

fn verify_component_catalog_internal(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
    now: i64,
    allow_loopback_http: bool,
    require_freshness: bool,
) -> Result<VerifiedComponentCatalog, CatalogValidationError> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(CatalogValidationError::TooLarge);
    }
    reject_duplicate_keys(bytes).map_err(|_| CatalogValidationError::InvalidSchema)?;
    let signed: SignedComponentCatalog =
        serde_json::from_slice(bytes).map_err(|_| CatalogValidationError::InvalidSchema)?;
    let payload = &signed.payload;
    if payload.schema_version != COMPONENT_CATALOG_SCHEMA
        || payload.catalog_version != "1"
        || !is_safe_token(&payload.key_id, 64)
        || payload.sequence == 0
    {
        return Err(CatalogValidationError::InvalidSchema);
    }
    if payload.issued_at < 0
        || payload.expires_at <= payload.issued_at
        || payload.expires_at.saturating_sub(payload.issued_at) > MAX_CATALOG_LIFETIME_SECONDS
        || (require_freshness
            && (payload.issued_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
                || payload.expires_at < now.saturating_sub(MAX_CLOCK_SKEW_SECONDS)))
    {
        return Err(CatalogValidationError::Expired);
    }
    validate_payload(payload, allow_loopback_http)?;
    let canonical =
        serde_json::to_vec(payload).map_err(|_| CatalogValidationError::InvalidSchema)?;
    trusted_keys
        .verify(&payload.key_id, &canonical, &signed.signature)
        .map_err(|error| match error {
            TrustError::UnknownKeyId(_) => CatalogValidationError::UnknownKey,
            TrustError::InvalidPublicKey(_) | TrustError::InvalidSignatureEncoding => {
                CatalogValidationError::InvalidSignature
            }
            TrustError::InvalidSignature => CatalogValidationError::InvalidSignature,
        })?;
    Ok(VerifiedComponentCatalog {
        signed,
        original_bytes: bytes.to_vec(),
    })
}

pub(crate) fn validate_payload(
    payload: &ComponentCatalogPayload,
    allow_loopback_http: bool,
) -> Result<(), CatalogValidationError> {
    let app_version = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| CatalogValidationError::InvalidSchema)?;
    let mut ids = HashSet::new();
    if payload.components.len() != 2 {
        return Err(CatalogValidationError::InvalidComponent);
    }
    for component in &payload.components {
        let minimum_cdm_version = Version::parse(&component.minimum_cdm_version)
            .map_err(|_| CatalogValidationError::InvalidComponent)?;
        if !ids.insert(component.id)
            || Version::parse(&component.version).is_err()
            || !is_safe_token(&component.release_tag, 64)
            || !is_safe_token(&component.asset_name, 128)
            || component.asset_name != component_asset_name(component.id, &component.version)
            || component.package_bytes == 0
            || component.package_bytes > MAX_COMPONENT_PACKAGE_BYTES
            || !is_sha256(&component.package_sha256)
            || app_version < minimum_cdm_version
            || component.capabilities != component.id.capabilities()
        {
            return Err(CatalogValidationError::InvalidComponent);
        }
        if !package_url_allowed(
            &component.package_url,
            &component.release_tag,
            &component.asset_name,
            allow_loopback_http,
        ) {
            return Err(CatalogValidationError::InvalidPackageUrl);
        }
        validate_files(component)?;
        validate_sources(component, allow_loopback_http)?;
        validate_notices(component)?;
    }
    if !ids.contains(&ComponentId::MediaTools) || !ids.contains(&ComponentId::TorrentEngine) {
        return Err(CatalogValidationError::InvalidComponent);
    }
    Ok(())
}

pub(crate) fn validate_component_upgrade(
    installed: &str,
    incoming: &str,
) -> Result<(), CatalogValidationError> {
    let installed =
        Version::parse(installed).map_err(|_| CatalogValidationError::InvalidComponent)?;
    let incoming =
        Version::parse(incoming).map_err(|_| CatalogValidationError::InvalidComponent)?;
    if incoming < installed {
        Err(CatalogValidationError::Downgrade)
    } else {
        Ok(())
    }
}

fn validate_files(component: &CatalogComponent) -> Result<(), CatalogValidationError> {
    let expected = component.id.artifacts();
    if component.files.len() != expected.len() {
        return Err(CatalogValidationError::InvalidComponent);
    }
    let mut artifacts = HashSet::new();
    for (file, artifact) in component.files.iter().zip(expected) {
        if file.artifact != *artifact
            || !artifacts.insert(file.artifact)
            || file.name != artifact.filename()
            || !is_safe_token(&file.version, 64)
            || file.size == 0
            || file.size > 256 * 1024 * 1024
            || !is_sha256(&file.sha256)
        {
            return Err(CatalogValidationError::InvalidComponent);
        }
    }
    Ok(())
}

fn validate_sources(
    component: &CatalogComponent,
    allow_loopback_http: bool,
) -> Result<(), CatalogValidationError> {
    let expected: &[(&str, &str, &str, &str)] = match component.id {
        ComponentId::MediaTools => &[
            (
                "ffmpeg",
                "946fcce07b6dcd0331c8cc609192aeff5e1924f8",
                "ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz",
                "GPL-3.0-or-later",
            ),
            (
                "yt-dlp",
                "3a08beaf031ab68f966401ead017ac81fe8486cf",
                "yt-dlp-2026.08.19-win64-corresponding-source.tar.xz",
                "GPL-3.0-or-later",
            ),
        ],
        ComponentId::TorrentEngine => &[(
            "aria2",
            "02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a",
            "aria2-1.37.0-win64-corresponding-source.tar.xz",
            "GPL-2.0-or-later",
        )],
    };
    if component.corresponding_sources.len() != expected.len() {
        return Err(CatalogValidationError::InvalidComponent);
    }
    for ((runtime, commit, asset_name, license), source) in
        expected.iter().zip(&component.corresponding_sources)
    {
        if source.runtime_id != *runtime
            || source.source_commit != *commit
            || source.asset_name != *asset_name
            || source.license != *license
            || source.bytes == 0
            || !is_sha256(&source.sha256)
            || !is_safe_token(&source.source_commit, 40)
            || !package_url_allowed(
                &source.asset_url,
                &component.release_tag,
                &source.asset_name,
                allow_loopback_http,
            )
        {
            return Err(CatalogValidationError::InvalidComponent);
        }
        if source.human_review != "APPROVED" {
            return Err(CatalogValidationError::SourceReviewPending);
        }
    }
    Ok(())
}

fn validate_notices(component: &CatalogComponent) -> Result<(), CatalogValidationError> {
    let expected = match component.id {
        ComponentId::MediaTools => &[
            ("yt-dlp", "GPL-3.0-or-later", "YT-DLP-NOTICE.txt"),
            ("ffmpeg", "GPL-3.0-or-later", "FFMPEG-NOTICE.txt"),
            ("deno", "MIT", "DENO-NOTICE.txt"),
        ][..],
        ComponentId::TorrentEngine => &[("aria2", "GPL-2.0-or-later", "ARIA2-NOTICE.txt")][..],
    };
    if component.license_notices.len() != expected.len() {
        return Err(CatalogValidationError::InvalidComponent);
    }
    for ((runtime, spdx, notice), entry) in expected.iter().zip(&component.license_notices) {
        if entry.runtime_id != *runtime
            || entry.spdx != *spdx
            || entry.notice_file != *notice
            || !is_sha256(&entry.notice_sha256)
        {
            return Err(CatalogValidationError::InvalidComponent);
        }
    }
    Ok(())
}

fn package_url_allowed(
    url: &str,
    release_tag: &str,
    asset_name: &str,
    allow_loopback: bool,
) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }
    let segments = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    #[cfg(feature = "qa-component-manager")]
    {
        let _ = release_tag;
        return allow_loopback
            && parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.port() == Some(49301)
            && segments == [asset_name];
    }
    #[cfg(not(feature = "qa-component-manager"))]
    {
        let is_release_path = parsed.scheme() == "https"
            && parsed.host_str() == Some(RELEASE_HOST)
            && parsed.port().is_none()
            && parsed.path().starts_with(RELEASE_REPOSITORY_PATH)
            && segments
                == [
                    "CacaPlay",
                    "clear-download-manager",
                    "releases",
                    "download",
                    release_tag,
                    asset_name,
                ];
        if is_release_path {
            return true;
        }
        allow_loopback
            && parsed.scheme() == "http"
            && parsed.port().is_some()
            && parsed.host_str() == Some("127.0.0.1")
            && segments == [asset_name]
    }
}

fn catalog_url_allowed(url: &str, allow_loopback: bool) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }
    #[cfg(feature = "qa-component-manager")]
    {
        return allow_loopback
            && parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.port() == Some(49301)
            && parsed.path() == "/component-catalog-v1.json";
    }
    #[cfg(not(feature = "qa-component-manager"))]
    {
        let official = parsed.scheme() == "https"
            && parsed.host_str() == Some(RELEASE_HOST)
            && parsed.port().is_none()
            && parsed.path() == CATALOG_PATH;
        let test_loopback = allow_loopback
            && parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.port().is_some()
            && parsed.path() == "/component-catalog-v1.json";
        official || test_loopback
    }
}

fn component_asset_name(id: ComponentId, version: &str) -> String {
    format!("{}-{version}.cdmcomponent", id.as_str())
}

fn is_safe_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value == value.trim()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::{
        io::{self, Read, Write},
        net::TcpListener,
        thread,
    };

    const NOW: i64 = 1_800_000_000;
    const TEST_SEED: [u8; 32] = [
        0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33,
        0x95, 0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44,
        0x97, 0x5e,
    ];

    fn key() -> SigningKey {
        SigningKey::from_bytes(&TEST_SEED)
    }

    fn trust() -> TrustedKeys {
        TrustedKeys::from_public_key_bytes(vec![(
            "component-test-2026".into(),
            key().verifying_key().to_bytes(),
        )])
        .unwrap()
    }

    fn source(
        runtime_id: &str,
        commit: &str,
        asset_name: &str,
        license: &str,
    ) -> CorrespondingSourceAsset {
        CorrespondingSourceAsset {
            runtime_id: runtime_id.into(),
            source_commit: commit.into(),
            asset_name: asset_name.into(),
            asset_url: format!("https://github.com/CacaPlay/clear-download-manager/releases/download/v0.95.5/{asset_name}"),
            bytes: 20,
            sha256: "a".repeat(64),
            license: license.into(),
            human_review: "APPROVED".into(),
        }
    }

    fn file(artifact: RuntimeArtifact, version: &str) -> ComponentPackageFile {
        ComponentPackageFile {
            artifact,
            name: artifact.filename().into(),
            version: version.into(),
            sha256: "b".repeat(64),
            size: 100,
        }
    }

    fn component(id: ComponentId) -> CatalogComponent {
        let (files, sources, notices) = match id {
            ComponentId::MediaTools => (
                vec![
                    file(RuntimeArtifact::YtDlp, "2026.08.19"),
                    file(RuntimeArtifact::Ffmpeg, "9.0.2"),
                    file(RuntimeArtifact::Ffprobe, "9.0.2"),
                    file(RuntimeArtifact::Deno, "2.9.7"),
                ],
                vec![
                    source(
                        "ffmpeg",
                        "946fcce07b6dcd0331c8cc609192aeff5e1924f8",
                        "ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz",
                        "GPL-3.0-or-later",
                    ),
                    source(
                        "yt-dlp",
                        "3a08beaf031ab68f966401ead017ac81fe8486cf",
                        "yt-dlp-2026.08.19-win64-corresponding-source.tar.xz",
                        "GPL-3.0-or-later",
                    ),
                ],
                vec![
                    LicenseNotice {
                        runtime_id: "yt-dlp".into(),
                        spdx: "GPL-3.0-or-later".into(),
                        notice_file: "YT-DLP-NOTICE.txt".into(),
                        notice_sha256: "c".repeat(64),
                    },
                    LicenseNotice {
                        runtime_id: "ffmpeg".into(),
                        spdx: "GPL-3.0-or-later".into(),
                        notice_file: "FFMPEG-NOTICE.txt".into(),
                        notice_sha256: "c".repeat(64),
                    },
                    LicenseNotice {
                        runtime_id: "deno".into(),
                        spdx: "MIT".into(),
                        notice_file: "DENO-NOTICE.txt".into(),
                        notice_sha256: "c".repeat(64),
                    },
                ],
            ),
            ComponentId::TorrentEngine => (
                vec![file(RuntimeArtifact::Aria2, "1.37.0")],
                vec![source(
                    "aria2",
                    "02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a",
                    "aria2-1.37.0-win64-corresponding-source.tar.xz",
                    "GPL-2.0-or-later",
                )],
                vec![LicenseNotice {
                    runtime_id: "aria2".into(),
                    spdx: "GPL-2.0-or-later".into(),
                    notice_file: "ARIA2-NOTICE.txt".into(),
                    notice_sha256: "c".repeat(64),
                }],
            ),
        };
        let version = "1.0.0";
        let asset_name = component_asset_name(id, version);
        CatalogComponent {
            id,
            version: version.into(),
            release_tag: "v0.95.5".into(),
            package_url: format!("https://github.com/CacaPlay/clear-download-manager/releases/download/v0.95.5/{asset_name}"),
            package_bytes: 1000,
            package_sha256: "d".repeat(64),
            asset_name,
            capabilities: id.capabilities().to_vec(),
            minimum_cdm_version: "0.95.4".into(),
            files,
            corresponding_sources: sources,
            license_notices: notices,
        }
    }

    fn signed_catalog() -> SignedComponentCatalog {
        SignedComponentCatalog {
            payload: ComponentCatalogPayload {
                schema_version: COMPONENT_CATALOG_SCHEMA,
                catalog_version: "1".into(),
                sequence: 4,
                key_id: "component-test-2026".into(),
                issued_at: NOW - 10,
                expires_at: NOW + 3600,
                components: vec![
                    component(ComponentId::MediaTools),
                    component(ComponentId::TorrentEngine),
                ],
            },
            signature: String::new(),
        }
    }

    fn bytes(mut signed: SignedComponentCatalog) -> Vec<u8> {
        let payload = serde_json::to_vec(&signed.payload).unwrap();
        signed.signature = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            key().sign(&payload).to_bytes(),
        );
        serde_json::to_vec(&signed).unwrap()
    }

    #[test]
    fn component_assets_must_use_the_immutable_clear_release_route() {
        let id = ComponentId::MediaTools;
        assert!(package_url_allowed(
            "https://github.com/CacaPlay/clear-download-manager/releases/download/v0.95.5/media-tools-1.0.0.cdmcomponent",
            "v0.95.5",
            "media-tools-1.0.0.cdmcomponent",
            false,
        ));
        assert!(!package_url_allowed(
            "https://example.net/anything/media-tools-1.0.0.cdmcomponent",
            "v0.95.5",
            "media-tools-1.0.0.cdmcomponent",
            false,
        ));
        assert!(!package_url_allowed(
            "http://127.0.0.1:49152/media-tools-1.0.0.cdmcomponent",
            "v0.95.5",
            "media-tools-1.0.0.cdmcomponent",
            false,
        ));
        assert!(package_url_allowed(
            "http://127.0.0.1:49152/media-tools-1.0.0.cdmcomponent",
            "v0.95.5",
            &component_asset_name(id, "1.0.0"),
            true,
        ));
    }

    #[test]
    fn catalog_endpoint_is_fixed_and_test_http_is_loopback_only() {
        #[cfg(not(feature = "qa-component-manager"))]
        {
            assert!(catalog_url_allowed(COMPONENT_CATALOG_ENDPOINT, false));
            assert!(!catalog_url_allowed(
                "https://example.net/component-catalog-v1.json",
                false
            ));
            assert!(!catalog_url_allowed(
                "http://127.0.0.1:49152/component-catalog-v1.json",
                false
            ));
            assert!(catalog_url_allowed(
                "http://127.0.0.1:49152/component-catalog-v1.json",
                true
            ));
            assert!(!catalog_url_allowed(
                "http://127.0.0.1:49152/component-catalog-v1.json?redirect=https://example.net",
                true
            ));
        }
    }

    #[cfg(feature = "qa-component-manager")]
    #[test]
    fn qa_build_trusts_only_its_fixed_loopback_component_route() {
        assert_eq!(
            COMPONENT_CATALOG_ENDPOINT,
            "http://127.0.0.1:49301/component-catalog-v1.json"
        );
        assert!(catalog_url_allowed(COMPONENT_CATALOG_ENDPOINT, true));
        assert!(!catalog_url_allowed(
            "https://github.com/CacaPlay/clear-download-manager/releases/latest/download/component-catalog-v1.json",
            true
        ));
        assert!(!catalog_url_allowed(
            "http://localhost:49301/component-catalog-v1.json",
            true
        ));
        assert!(!catalog_url_allowed(
            "http://127.0.0.1:49302/component-catalog-v1.json",
            true
        ));
        assert!(!catalog_url_allowed(
            "http://127.0.0.1:49301/component-catalog-v1.json?redirect=https://example.net",
            true
        ));
        assert!(package_url_allowed(
            "http://127.0.0.1:49301/media-tools-1.0.0.cdmcomponent",
            "qa-local-20260927",
            "media-tools-1.0.0.cdmcomponent",
            true
        ));
        assert!(!package_url_allowed(
            "http://127.0.0.1:49302/media-tools-1.0.0.cdmcomponent",
            "qa-local-20260927",
            "media-tools-1.0.0.cdmcomponent",
            true
        ));
        assert!(!package_url_allowed(
            "https://github.com/CacaPlay/clear-download-manager/releases/download/qa-local-20260927/media-tools-1.0.0.cdmcomponent",
            "qa-local-20260927",
            "media-tools-1.0.0.cdmcomponent",
            true
        ));
        assert_eq!(
            super::super::catalog_key::KEY_ID,
            "component-catalog-qa-20260927"
        );
        let public_key = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            super::super::catalog_key::PUBLIC_KEY_BASE64,
        )
        .unwrap();
        assert_eq!(
            sha256_hex(&public_key),
            "7910b5251d799b5160471f860db7de4bd478dea5280e5ebd7a63a1ec2a655313"
        );
    }

    #[cfg(feature = "qa-component-manager")]
    #[test]
    fn qa_redirect_policy_rejects_external_and_wrong_port_targets() {
        for destination in [
            "http://example.invalid/component-catalog-v1.json",
            "http://127.0.0.1:49302/component-catalog-v1.json",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let location = destination.to_string();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                write!(
                    stream,
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let client = build_catalog_client(true).unwrap();
            let response = client
                .get(format!("http://{address}/component-catalog-v1.json"))
                .send();
            assert!(
                response.is_err(),
                "QA redirect unexpectedly followed {destination}"
            );
            server.join().unwrap();
        }
    }

    #[cfg(feature = "qa-component-manager")]
    #[test]
    fn prepared_qa_catalog_signature_is_valid_when_catalog_path_is_supplied() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let Some(path) = std::env::var_os("CDM_QA_CATALOG_PATH") else {
            return;
        };
        let bytes = fs::read(path).expect("read the prepared local QA catalog");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let verified = verify_component_catalog(&bytes, &configured_trust(), now, true)
            .expect("the prepared QA catalog verifies under its QA key");
        assert_eq!(
            verified.signed.payload.key_id,
            "component-catalog-qa-20260927"
        );
    }

    #[test]
    fn signed_component_files_are_the_runtime_pins_for_that_component_only() {
        let media = component(ComponentId::MediaTools);
        let pins = crate::components::RuntimePins::from_catalog_component(&media)
            .expect("catalog files form runtime pins");
        assert_eq!(pins.files_for(ComponentId::MediaTools), media.files);
        assert!(pins.pin(RuntimeArtifact::Aria2).is_none());
    }

    #[test]
    fn catalog_update_rejects_downgrades_and_accepts_same_or_newer_versions() {
        assert_eq!(
            validate_component_upgrade("2.0.0", "1.9.9"),
            Err(CatalogValidationError::Downgrade)
        );
        assert_eq!(validate_component_upgrade("1.0.0", "1.0.0"), Ok(()));
        assert_eq!(validate_component_upgrade("1.0.0", "1.0.1"), Ok(()));
        assert_eq!(
            validate_component_upgrade("invalid", "1.0.1"),
            Err(CatalogValidationError::InvalidComponent)
        );
    }

    #[test]
    fn signed_catalog_verifies_and_production_root_stays_empty() {
        let verified = verify_component_catalog(&bytes(signed_catalog()), &trust(), NOW, false)
            .expect("valid signed catalog");
        assert_eq!(verified.signed.payload.sequence, 4);
        let production_keys = production_trust();
        let production_ids: Vec<_> = production_keys.key_ids().collect();
        if crate::components::catalog_key::PUBLIC_KEY_BASE64.is_empty() {
            assert!(production_ids.is_empty());
        } else {
            assert_eq!(production_ids, [crate::components::catalog_key::KEY_ID]);
        }
        assert_eq!(
            verify_component_catalog(&bytes(signed_catalog()), &production_trust(), NOW, false)
                .unwrap_err(),
            CatalogValidationError::UnknownKey
        );
    }

    #[test]
    fn signed_payload_tampering_is_rejected_for_release_pins_and_sequence() {
        let original = serde_json::to_value(signed_catalog()).unwrap();
        let mut cases = Vec::new();
        let mut sequence = original.clone();
        sequence["payload"]["sequence"] = serde_json::json!(5);
        cases.push(("sequence", sequence));
        let mut version = original.clone();
        version["payload"]["components"][0]["version"] = serde_json::json!("1.0.1");
        version["payload"]["components"][0]["assetName"] =
            serde_json::json!("media-tools-1.0.1.cdmcomponent");
        version["payload"]["components"][0]["packageUrl"] = serde_json::json!(
            "https://github.com/CacaPlay/clear-download-manager/releases/download/v0.95.5/media-tools-1.0.1.cdmcomponent"
        );
        cases.push(("component version", version));
        let mut package_hash = original.clone();
        package_hash["payload"]["components"][0]["packageSha256"] =
            serde_json::json!("e".repeat(64));
        cases.push(("package hash", package_hash));
        let mut source_hash = original.clone();
        source_hash["payload"]["components"][0]["correspondingSources"][0]["sha256"] =
            serde_json::json!("f".repeat(64));
        cases.push(("source hash", source_hash));
        for (label, changed) in cases {
            let bytes = serde_json::to_vec(&changed).unwrap();
            assert_eq!(
                verify_component_catalog(&bytes, &trust(), NOW, false).unwrap_err(),
                CatalogValidationError::InvalidSignature,
                "tampering was accepted at {label}"
            );
        }
    }

    #[cfg(feature = "maintainer-tooling")]
    #[test]
    fn component_catalog_tooling_signs_the_runtime_canonical_payload_inline() {
        let mut payload_value = signed_catalog().payload;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        payload_value.issued_at = now - 60;
        payload_value.expires_at = now + 3600;
        let payload = serde_json::to_vec(&payload_value).unwrap();
        let seed = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, TEST_SEED);
        let signed = crate::component_catalog_tooling::sign_payload(&payload, &seed)
            .expect("maintainer tool signs valid payload");
        let parsed: SignedComponentCatalog = serde_json::from_slice(&signed).unwrap();
        assert!(!parsed.signature.is_empty());
        let verified = verify_component_catalog(&signed, &trust(), now, false)
            .expect("runtime verifier accepts maintainer-tool signature");
        assert_eq!(verified.signed.payload.sequence, 4);
        let public = key().verifying_key().to_bytes();
        let inspection = crate::component_catalog_tooling::verify_catalog(
            &signed,
            public,
            "component-test-2026",
            now,
        )
        .expect("maintainer verifier accepts the production-format catalog");
        assert_eq!(inspection.signature_model, "inline");
        assert!(crate::component_catalog_tooling::verify_catalog(
            &signed,
            SigningKey::from_bytes(&[0x19_u8; 32])
                .verifying_key()
                .to_bytes(),
            "component-test-2026",
            now,
        )
        .is_err());
        assert!(crate::component_catalog_tooling::verify_catalog(
            &signed,
            public,
            "wrong-key-id",
            now,
        )
        .is_err());
    }

    #[test]
    fn signature_tampering_unknown_keys_and_duplicate_fields_are_rejected() {
        let mut changed: SignedComponentCatalog =
            serde_json::from_slice(&bytes(signed_catalog())).unwrap();
        changed.signature =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0_u8; 64]);
        assert_eq!(
            verify_component_catalog(&serde_json::to_vec(&changed).unwrap(), &trust(), NOW, false)
                .unwrap_err(),
            CatalogValidationError::InvalidSignature
        );
        assert_eq!(
            verify_component_catalog(&bytes(signed_catalog()), &TrustedKeys::empty(), NOW, false)
                .unwrap_err(),
            CatalogValidationError::UnknownKey
        );
        assert_eq!(
            verify_component_catalog(
                br#"{"payload":{},"payload":{},"signature":""}"#,
                &trust(),
                NOW,
                false
            )
            .unwrap_err(),
            CatalogValidationError::InvalidSchema
        );
    }

    #[test]
    fn pending_source_review_and_unapproved_asset_urls_fail_closed() {
        let mut pending = signed_catalog();
        pending.payload.components[0].corresponding_sources[1].human_review = "PENDING".into();
        assert_eq!(
            verify_component_catalog(&bytes(pending), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::SourceReviewPending
        );
        let mut external = signed_catalog();
        external.payload.components[0].package_url =
            "https://example.net/media-tools-1.0.0.cdmcomponent".into();
        assert_eq!(
            verify_component_catalog(&bytes(external), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::InvalidPackageUrl
        );
    }

    #[test]
    fn wrong_component_contents_versions_and_source_asset_names_are_rejected() {
        let mut wrong_files = signed_catalog();
        wrong_files.payload.components[0].files.pop();
        assert_eq!(
            verify_component_catalog(&bytes(wrong_files), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::InvalidComponent
        );
        let mut wrong_source = signed_catalog();
        wrong_source.payload.components[1].corresponding_sources[0].asset_name =
            "source.tar.xz".into();
        assert_eq!(
            verify_component_catalog(&bytes(wrong_source), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::InvalidComponent
        );
        let mut future = signed_catalog();
        future.payload.components[0].minimum_cdm_version = "99.0.0".into();
        assert_eq!(
            verify_component_catalog(&bytes(future), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::InvalidComponent
        );
    }

    #[test]
    fn expired_catalogs_are_rejected_before_any_download() {
        let mut expired = signed_catalog();
        expired.payload.issued_at = NOW - 3600;
        expired.payload.expires_at = NOW - 600;
        assert_eq!(
            verify_component_catalog(&bytes(expired), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::Expired
        );
    }

    #[test]
    fn issued_at_beyond_allowed_clock_skew_is_rejected() {
        let mut future = signed_catalog();
        future.payload.issued_at = NOW + 5 * 60 + 1;
        future.payload.expires_at = future.payload.issued_at + 3600;
        assert_eq!(
            verify_component_catalog(&bytes(future), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::Expired
        );
    }

    #[test]
    fn installed_component_proof_remains_verifiable_after_catalog_expiry() {
        let mut expired = signed_catalog();
        expired.payload.issued_at = NOW - 3600;
        expired.payload.expires_at = NOW - 600;
        let proof = bytes(expired);
        assert_eq!(
            verify_component_catalog(&proof, &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::Expired
        );
        let persisted = verify_persisted_catalog_snapshot(&proof, &trust(), false);
        assert!(persisted.is_ok(), "persisted proof rejected: {persisted:?}");
    }

    #[test]
    fn unsupported_catalog_schema_is_rejected_before_signature_use() {
        let mut unsupported = signed_catalog();
        unsupported.payload.schema_version += 1;
        assert_eq!(
            verify_component_catalog(&bytes(unsupported), &trust(), NOW, false).unwrap_err(),
            CatalogValidationError::InvalidSchema
        );
    }

    #[test]
    fn downloaded_package_requires_exact_size_hash_and_maximum() {
        let bytes = b"package fixture";
        let digest = sha256_hex(bytes);
        assert!(verify_asset_bytes(bytes, bytes.len() as u64, &digest, 100).is_ok());
        assert_eq!(
            verify_asset_bytes(bytes, (bytes.len() + 1) as u64, &digest, 100),
            Err(AssetValidationError::SizeMismatch)
        );
        assert_eq!(
            verify_asset_bytes(bytes, bytes.len() as u64, &"0".repeat(64), 100),
            Err(AssetValidationError::HashMismatch)
        );
        assert_eq!(
            verify_asset_bytes(bytes, bytes.len() as u64, &digest, 2),
            Err(AssetValidationError::TooLarge)
        );
    }

    #[test]
    fn interrupted_download_removes_partial_file() {
        struct Interrupted;
        impl Read for Interrupted {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if buffer.is_empty() {
                    return Ok(0);
                }
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "fixture interruption",
                ))
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("media-tools.cdmcomponent");
        let result = write_verified_download(
            Interrupted,
            &destination,
            32,
            &"a".repeat(64),
            MAX_COMPONENT_PACKAGE_BYTES,
            |_| {},
        );
        assert_eq!(result, Err(AssetValidationError::ReadFailed));
        assert!(!destination.exists());
        assert!(!temp.path().join("media-tools.cdmcomponent.part").exists());
    }

    fn serve_once(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        format!("http://{address}/fixture.cdmcomponent")
    }

    #[test]
    fn loopback_fixture_download_is_verified_before_final_path_appears() {
        let body = b"signed catalog package fixture".to_vec();
        let url = serve_once(body.clone());
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("fixture.cdmcomponent");
        let mut progress = Vec::new();
        let expected_sha256 = sha256_hex(&body);
        let request = AssetDownloadRequest {
            url: &url,
            release_tag: "v0.95.5",
            asset_name: "fixture.cdmcomponent",
            destination: &target,
            expected_size: body.len() as u64,
            expected_sha256: &expected_sha256,
            maximum_size: 1024,
            allow_loopback_http: true,
        };
        download_asset_to_path(
            &request,
            |received| progress.push(received),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .expect("valid local fixture transfer");
        assert_eq!(fs::read(&target).unwrap(), body);
        assert!(!temp.path().join("fixture.cdmcomponent.part").exists());
        assert!(!progress.is_empty());
    }

    #[test]
    fn package_hash_mismatch_does_not_leave_partial_or_final_file() {
        let body = b"tampered package".to_vec();
        let url = serve_once(body.clone());
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("fixture.cdmcomponent");
        let expected_sha256 = "0".repeat(64);
        let request = AssetDownloadRequest {
            url: &url,
            release_tag: "v0.95.5",
            asset_name: "fixture.cdmcomponent",
            destination: &target,
            expected_size: body.len() as u64,
            expected_sha256: &expected_sha256,
            maximum_size: 1024,
            allow_loopback_http: true,
        };
        let result = download_asset_to_path(
            &request,
            |_| {},
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        assert_eq!(result, Err(AssetDownloadError::HashMismatch));
        assert!(!target.exists());
        assert!(!temp.path().join("fixture.cdmcomponent.part").exists());
    }

    #[test]
    fn package_download_uses_signed_size_without_http_content_length() {
        let body = b"catalog sized body".to_vec();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server_body = body.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n").unwrap();
            stream.write_all(&server_body).unwrap();
        });
        let url = format!("http://{address}/fixture.cdmcomponent");
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("fixture.cdmcomponent");
        let digest = sha256_hex(&body);
        let request = AssetDownloadRequest {
            url: &url,
            release_tag: "v0.95.5",
            asset_name: "fixture.cdmcomponent",
            destination: &target,
            expected_size: body.len() as u64,
            expected_sha256: &digest,
            maximum_size: 1024,
            allow_loopback_http: true,
        };
        download_asset_to_path(
            &request,
            |_| {},
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .expect("signed catalog size is sufficient");
        server.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), body);
    }

    #[test]
    fn package_download_aborts_first_oversize_read_before_eof_and_cleans_partial() {
        struct OversizeThenMustNotReadAgain(bool);
        impl Read for OversizeThenMustNotReadAgain {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                assert!(!self.0, "reader was polled after signed size was exceeded");
                self.0 = true;
                buffer[..4].copy_from_slice(b"over");
                Ok(4)
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("fixture.cdmcomponent");
        let result = write_verified_download(
            OversizeThenMustNotReadAgain(false),
            &target,
            3,
            &"0".repeat(64),
            1024,
            |_| {},
        );
        assert_eq!(result, Err(AssetValidationError::SizeMismatch));
        assert!(!target.exists());
        assert!(!temp.path().join("fixture.cdmcomponent.part").exists());
    }

    #[test]
    fn package_download_cancellation_aborts_waiting_transfer_and_cleans_partial() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            stream.write_all(b"partial").unwrap();
            thread::sleep(Duration::from_millis(500));
        });
        let url = format!("http://{address}/fixture.cdmcomponent");
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("fixture.cdmcomponent");
        let cancellation = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let progress_token = cancellation.clone();
        let expected_sha256 = "0".repeat(64);
        let request = AssetDownloadRequest {
            url: &url,
            release_tag: "v0.95.5",
            asset_name: "fixture.cdmcomponent",
            destination: &target,
            expected_size: 64,
            expected_sha256: &expected_sha256,
            maximum_size: 1024,
            allow_loopback_http: true,
        };
        let started = std::time::Instant::now();
        let result = download_asset_to_path(
            &request,
            move |received| {
                if received > 0 {
                    progress_token.store(true, std::sync::atomic::Ordering::Release);
                }
            },
            cancellation,
        );
        assert_eq!(result, Err(AssetDownloadError::Cancelled));
        assert!(started.elapsed() < Duration::from_millis(400));
        assert!(!target.exists());
        assert!(!temp.path().join("fixture.cdmcomponent.part").exists());
        server.join().unwrap();
    }

    #[test]
    fn catalog_and_package_timeout_policies_are_separate() {
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(20));
        assert_eq!(CATALOG_REQUEST_TIMEOUT, Duration::from_secs(30));
        assert_eq!(PACKAGE_READ_TIMEOUT, Duration::from_secs(45));
        let catalog = build_catalog_client(true);
        let package = build_package_client(true);
        assert!(catalog.is_ok());
        assert!(package.is_ok());
    }
}
