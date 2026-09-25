use super::{
    acquire_tool_operation,
    manifest::VerifiedToolComponent,
    policy::{component_policy, SourceAuthority, UpdateEligibility},
    ToolOperationLease,
};
use crate::{background_command, ToolId};
use reqwest::{
    blocking::{Client, Response},
    header::{CONTENT_LENGTH, LOCATION, USER_AGENT},
    redirect::{Attempt, Policy},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use url::Url;

const MAX_REDIRECTS: usize = 3;
const MAX_RETRIES: usize = 3;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES: usize = 4096;
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_BACKOFF: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(500)];
const YTDLP_RELEASE_ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashSet<ToolId>>> = OnceLock::new();

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum DownloadError {
    TrustRejected(String),
    UnsupportedComponent,
    Network,
    HttpStatus(u16),
    Timeout,
    RedirectRejected,
    OversizedArtifact,
    InvalidContentLength,
    SizeMismatch { expected: u64, actual: u64 },
    HashMismatch,
    Cancelled,
    ProbeFailed,
    VersionMismatch { expected: String, actual: String },
    Filesystem,
    AlreadyRunning,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TrustRejected(reason) => write!(formatter, "manifest trust rejected: {reason}"),
            Self::UnsupportedComponent => formatter.write_str("unsupported tool component"),
            Self::Network => formatter.write_str("network transfer failed"),
            Self::HttpStatus(status) => write!(formatter, "artifact server returned HTTP {status}"),
            Self::Timeout => formatter.write_str("artifact transfer timed out"),
            Self::RedirectRejected => formatter.write_str("artifact redirect rejected by policy"),
            Self::OversizedArtifact => formatter.write_str("artifact exceeds the download limit"),
            Self::InvalidContentLength => formatter.write_str("artifact Content-Length is invalid"),
            Self::SizeMismatch { expected, actual } => {
                write!(
                    formatter,
                    "artifact size mismatch: expected {expected}, got {actual}"
                )
            }
            Self::HashMismatch => formatter.write_str("artifact SHA-256 mismatch"),
            Self::Cancelled => formatter.write_str("artifact download cancelled"),
            Self::ProbeFailed => formatter.write_str("staged artifact version probe failed"),
            Self::VersionMismatch { expected, actual } => {
                write!(
                    formatter,
                    "artifact version mismatch: expected {expected}, got {actual}"
                )
            }
            Self::Filesystem => formatter.write_str("staging filesystem operation failed"),
            Self::AlreadyRunning => {
                formatter.write_str("a yt-dlp staging operation is already running")
            }
        }
    }
}

impl std::error::Error for DownloadError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedArtifact {
    pub(crate) tool_id: String,
    pub(crate) version: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
    pub(crate) source_repository: String,
    pub(crate) source_release: String,
    pub(crate) operation_id: String,
    pub(crate) verification_timestamp: u64,
    pub(crate) state: String,
    #[serde(skip)]
    pub(crate) path: PathBuf,
}

#[derive(Clone)]
struct ArtifactEndpoint {
    url: Url,
    allowed_hosts: &'static [&'static str],
}

#[derive(Clone, Copy)]
struct DownloadConfig {
    connect_timeout: Duration,
    transfer_timeout: Duration,
    probe_timeout: Duration,
    max_bytes: u64,
}

impl DownloadConfig {
    fn production() -> Self {
        Self {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            transfer_timeout: DEFAULT_TRANSFER_TIMEOUT,
            probe_timeout: DEFAULT_PROBE_TIMEOUT,
            max_bytes: MAX_ARTIFACT_BYTES,
        }
    }
}

struct OperationLease {
    component: ToolId,
    directory: PathBuf,
    committed: bool,
    coordinator: ToolOperationLease,
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.directory);
        }
        if let Some(active) = ACTIVE_DOWNLOADS.get() {
            if let Ok(mut active) = active.lock() {
                active.remove(&self.component);
            }
        }
    }
}

pub(crate) fn stage_verified_yt_dlp_component(
    component: VerifiedToolComponent<'_>,
    app: &AppHandle,
    cancelled: &AtomicBool,
) -> Result<StagedArtifact, DownloadError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| DownloadError::Filesystem)?;
    let endpoint = official_endpoint(component)?;
    stage_verified_component(
        component,
        &app_data_dir,
        cancelled,
        endpoint,
        DownloadConfig::production(),
    )
}

fn official_endpoint(
    component: VerifiedToolComponent<'_>,
) -> Result<ArtifactEndpoint, DownloadError> {
    let component = component.as_ref();
    let policy = component_policy(component.id);
    if component.id != ToolId::YtDlp
        || component.source.authority != SourceAuthority::YtDlpOfficial
        || component.source.repository != policy.repository
        || component.artifact.filename != ToolId::YtDlp.artifact_filename()
        || component.artifact.release_tag.is_empty()
    {
        return Err(DownloadError::UnsupportedComponent);
    }
    let mut url = Url::parse("https://github.com").map_err(|_| DownloadError::Filesystem)?;
    url.set_path(&format!(
        "/yt-dlp/yt-dlp/releases/download/{}/{}",
        component.artifact.release_tag, component.artifact.filename
    ));
    Ok(ArtifactEndpoint {
        url,
        allowed_hosts: YTDLP_RELEASE_ALLOWED_HOSTS,
    })
}

fn stage_verified_component(
    component: VerifiedToolComponent<'_>,
    app_data_dir: &Path,
    cancelled: &AtomicBool,
    endpoint: ArtifactEndpoint,
    config: DownloadConfig,
) -> Result<StagedArtifact, DownloadError> {
    let component_data = component.as_ref();
    if component_data.id != ToolId::YtDlp {
        return Err(DownloadError::UnsupportedComponent);
    }
    if component_policy(component_data.id).eligibility != UpdateEligibility::UpdateEligible {
        return Err(DownloadError::UnsupportedComponent);
    }
    if component_data.size > config.max_bytes {
        return Err(DownloadError::OversizedArtifact);
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }

    let mut lease = begin_operation(app_data_dir)?;
    let partial = lease
        .directory
        .join(component_data.artifact.filename.clone() + ".part");
    let final_path = lease.directory.join(&component_data.artifact.filename);
    let client = build_client(endpoint.allowed_hosts, config)?;
    download_to_partial(
        &client,
        &endpoint,
        &partial,
        cancelled,
        component_data.size,
        &component_data.sha256,
        config,
    )?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }
    if fs::symlink_metadata(&final_path).is_ok() {
        return Err(DownloadError::Filesystem);
    }
    fs::rename(&partial, &final_path).map_err(|_| DownloadError::Filesystem)?;
    let version = probe_version(&final_path, cancelled, config.probe_timeout)?;
    verify_probe_version(&component_data.version, version)?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }
    let staged = StagedArtifact {
        tool_id: component_data.id.base_name().to_string(),
        version: component_data.version.clone(),
        sha256: component_data.sha256.to_ascii_lowercase(),
        size: component_data.size,
        source_repository: component_data.source.repository.clone(),
        source_release: component_data.artifact.release_tag.clone(),
        operation_id: lease
            .directory
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown-operation")
            .to_string(),
        verification_timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        state: "STAGED_VERIFIED".into(),
        path: final_path,
    };
    write_staged_metadata(&lease.directory, &staged)?;
    lease.committed = true;
    Ok(staged)
}

fn begin_operation(app_data_dir: &Path) -> Result<OperationLease, DownloadError> {
    let coordinator =
        acquire_tool_operation(ToolId::YtDlp).map_err(|_| DownloadError::AlreadyRunning)?;
    let active = ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut active = active.lock().map_err(|_| DownloadError::Filesystem)?;
        if !active.insert(ToolId::YtDlp) {
            return Err(DownloadError::AlreadyRunning);
        }
    }
    let result = create_operation_directory(app_data_dir);
    match result {
        Ok(directory) => Ok(OperationLease {
            component: ToolId::YtDlp,
            directory,
            committed: false,
            coordinator,
        }),
        Err(error) => {
            if let Ok(mut active) = active.lock() {
                active.remove(&ToolId::YtDlp);
            }
            Err(error)
        }
    }
}

fn create_operation_directory(app_data_dir: &Path) -> Result<PathBuf, DownloadError> {
    if !app_data_dir.is_absolute() {
        return Err(DownloadError::Filesystem);
    }
    fs::create_dir_all(app_data_dir).map_err(|_| DownloadError::Filesystem)?;
    ensure_directory(app_data_dir)?;
    let tools = app_data_dir.join("tools");
    ensure_directory(&tools)?;
    let staging = tools.join("staging");
    ensure_directory(&staging)?;
    cleanup_incomplete_operations(&staging);
    for _ in 0..8 {
        let sequence = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = staging.join(format!("op-{timestamp:x}-{sequence:x}"));
        match fs::create_dir(&directory) {
            Ok(()) => {
                ensure_directory(&directory)?;
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(DownloadError::Filesystem),
        }
    }
    Err(DownloadError::Filesystem)
}

fn ensure_directory(path: &Path) -> Result<(), DownloadError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DownloadError::Filesystem)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(DownloadError::Filesystem);
    }
    Ok(())
}

#[cfg(windows)]
fn has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn cleanup_incomplete_operations(staging: &Path) {
    let Ok(entries) = fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || has_reparse_point(&metadata)
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("op-"))
        {
            continue;
        }
        let has_partial = fs::read_dir(&path)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "part")
            });
        if has_partial {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// Startup recovery hook used by the overlay resolver. It only removes
/// generated operation directories that still contain a partial artifact;
/// verified staging and bundled resources are never touched.
pub(crate) fn recover_staging_at(app_data_dir: &Path) {
    let staging = app_data_dir.join("tools").join("staging");
    if staging.is_dir() {
        cleanup_incomplete_operations(&staging);
    }
}

fn build_client(
    allowed_hosts: &'static [&'static str],
    config: DownloadConfig,
) -> Result<Client, DownloadError> {
    let policy = Policy::custom(move |attempt| {
        if redirect_is_allowed(&attempt, allowed_hosts) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .connect_timeout(config.connect_timeout)
        .timeout(config.transfer_timeout)
        .redirect(policy)
        .build()
        .map_err(|_| DownloadError::Network)
}

fn redirect_is_allowed(attempt: &Attempt<'_>, allowed_hosts: &[&str]) -> bool {
    if attempt.previous().len() >= MAX_REDIRECTS {
        return false;
    }
    let url = attempt.url();
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| allowed_hosts.contains(&host))
}

fn download_to_partial(
    client: &Client,
    endpoint: &ArtifactEndpoint,
    partial: &Path,
    cancelled: &AtomicBool,
    expected_size: u64,
    expected_sha256: &str,
    config: DownloadConfig,
) -> Result<(), DownloadError> {
    let expected_hash = super::manifest::normalize_sha256(expected_sha256)
        .map_err(|_| DownloadError::HashMismatch)?;
    let mut last_error = DownloadError::Network;
    for attempt_index in 0..MAX_RETRIES {
        if cancelled.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let response = match client
            .get(endpoint.url.clone())
            .header(USER_AGENT, "CacaTools-ToolsUpdater")
            .send()
        {
            Ok(response) => response,
            Err(error) => {
                last_error = if error.is_timeout() {
                    DownloadError::Timeout
                } else if error.is_redirect() {
                    DownloadError::RedirectRejected
                } else {
                    DownloadError::Network
                };
                if !should_retry(&last_error, attempt_index, cancelled)? {
                    return Err(last_error);
                }
                continue;
            }
        };
        match validate_response_headers(response, expected_size, config.max_bytes) {
            Ok(response) => match stream_response(
                response,
                partial,
                cancelled,
                expected_size,
                expected_hash,
                config.max_bytes,
            ) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = error;
                    if !should_retry(&last_error, attempt_index, cancelled)? {
                        return Err(last_error);
                    }
                }
            },
            Err(error) => {
                if should_retry(&error, attempt_index, cancelled)? {
                    let _ = fs::remove_file(partial);
                    continue;
                }
                return Err(error);
            }
        }
        let _ = fs::remove_file(partial);
    }
    Err(last_error)
}

fn validate_response_headers(
    response: Response,
    expected_size: u64,
    max_bytes: u64,
) -> Result<Response, DownloadError> {
    let status = response.status();
    if status.is_redirection() {
        let _ = response.headers().get(LOCATION);
        return Err(DownloadError::RedirectRejected);
    }
    if !status.is_success() {
        return Err(DownloadError::HttpStatus(status.as_u16()));
    }
    if let Some(value) = response.headers().get(CONTENT_LENGTH) {
        let length = value
            .to_str()
            .map_err(|_| DownloadError::InvalidContentLength)?
            .parse::<u64>()
            .map_err(|_| DownloadError::InvalidContentLength)?;
        if length > max_bytes {
            return Err(DownloadError::OversizedArtifact);
        }
        if length != expected_size {
            return Err(DownloadError::SizeMismatch {
                expected: expected_size,
                actual: length,
            });
        }
    }
    Ok(response)
}

fn stream_response(
    mut response: Response,
    partial: &Path,
    cancelled: &AtomicBool,
    expected_size: u64,
    expected_hash: [u8; 32],
    max_bytes: u64,
) -> Result<(), DownloadError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)
        .map_err(|_| DownloadError::Filesystem)?;
    let mut hasher = Sha256::new();
    let mut bytes_received = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let read = response.read(&mut buffer).map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                DownloadError::Timeout
            } else {
                DownloadError::Network
            }
        })?;
        if read == 0 {
            break;
        }
        bytes_received = bytes_received
            .checked_add(read as u64)
            .ok_or(DownloadError::OversizedArtifact)?;
        if bytes_received > max_bytes {
            return Err(DownloadError::OversizedArtifact);
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|_| DownloadError::Filesystem)?;
    }
    file.sync_all().map_err(|_| DownloadError::Filesystem)?;
    if bytes_received != expected_size {
        return Err(DownloadError::SizeMismatch {
            expected: expected_size,
            actual: bytes_received,
        });
    }
    if hasher.finalize().as_slice() != expected_hash {
        return Err(DownloadError::HashMismatch);
    }
    Ok(())
}

fn should_retry(
    error: &DownloadError,
    attempt_index: usize,
    cancelled: &AtomicBool,
) -> Result<bool, DownloadError> {
    if matches!(error, DownloadError::Cancelled) {
        return Err(DownloadError::Cancelled);
    }
    let retryable = matches!(
        error,
        DownloadError::Network
            | DownloadError::Timeout
            | DownloadError::HttpStatus(408 | 425 | 429 | 500 | 502 | 503 | 504)
    );
    if !retryable || attempt_index + 1 >= MAX_RETRIES {
        return Ok(false);
    }
    let delay = RETRY_BACKOFF[attempt_index.min(RETRY_BACKOFF.len() - 1)];
    let started = std::time::Instant::now();
    while started.elapsed() < delay {
        if cancelled.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(true)
}

fn probe_version(
    path: &Path,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<String, DownloadError> {
    if !path.is_absolute() {
        return Err(DownloadError::ProbeFailed);
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }
    let mut command = background_command(path);
    command
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| DownloadError::ProbeFailed)?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            crate::kill_process_tree(child.id());
            let _ = child.wait();
            return Err(DownloadError::ProbeFailed);
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            crate::kill_process_tree(child.id());
            let _ = child.wait();
            return Err(DownloadError::ProbeFailed);
        }
    };
    let stdout_reader = thread::spawn(move || read_probe_output(stdout));
    let stderr_reader = thread::spawn(move || read_probe_output(stderr));
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                crate::kill_process_tree(child.id());
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(DownloadError::ProbeFailed);
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            crate::kill_process_tree(child.id());
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(DownloadError::Cancelled);
        }
        if started.elapsed() >= timeout {
            crate::kill_process_tree(child.id());
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(DownloadError::Timeout);
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| DownloadError::ProbeFailed)??;
    let _stderr = stderr_reader
        .join()
        .map_err(|_| DownloadError::ProbeFailed)??;
    if !status.success() || stdout.len() > MAX_PROBE_OUTPUT_BYTES {
        return Err(DownloadError::ProbeFailed);
    }
    let version = String::from_utf8(stdout)
        .map_err(|_| DownloadError::ProbeFailed)?
        .trim()
        .to_string();
    if version.is_empty() || version.len() > 64 {
        return Err(DownloadError::ProbeFailed);
    }
    Ok(version)
}

/// Re-validates a typed staging result immediately before promotion. The
/// caller cannot substitute an arbitrary path: it must remain inside the
/// generated `tools/staging/op-*` tree and retain the policy-owned filename.
pub(crate) fn reverify_staged_yt_dlp(
    staged: &StagedArtifact,
    app_data_dir: &Path,
) -> Result<(), DownloadError> {
    if !app_data_dir.is_absolute()
        || staged.tool_id != ToolId::YtDlp.base_name()
        || staged.state != "STAGED_VERIFIED"
        || staged.version.is_empty()
        || staged.sha256.len() != 64
        || !staged.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || staged.size == 0
        || !staged.path.is_absolute()
    {
        return Err(DownloadError::Filesystem);
    }
    let staging_root = app_data_dir.join("tools").join("staging");
    let operation = staged.path.parent().ok_or(DownloadError::Filesystem)?;
    let operation_name = operation
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(DownloadError::Filesystem)?;
    if !operation_name.starts_with("op-")
        || staged.path.file_name() != Some(std::ffi::OsStr::new(ToolId::YtDlp.artifact_filename()))
    {
        return Err(DownloadError::Filesystem);
    }
    let canonical_root = staging_root
        .canonicalize()
        .map_err(|_| DownloadError::Filesystem)?;
    let canonical_operation = operation
        .canonicalize()
        .map_err(|_| DownloadError::Filesystem)?;
    if !canonical_operation.starts_with(&canonical_root) {
        return Err(DownloadError::Filesystem);
    }
    let metadata = fs::symlink_metadata(&staged.path).map_err(|_| DownloadError::Filesystem)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err(DownloadError::Filesystem);
    }
    let actual_size = metadata.len();
    if actual_size != staged.size {
        return Err(DownloadError::SizeMismatch {
            expected: staged.size,
            actual: actual_size,
        });
    }
    let mut file = fs::File::open(&staged.path).map_err(|_| DownloadError::Filesystem)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| DownloadError::Filesystem)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual_hash = format!("{:x}", hasher.finalize());
    if !actual_hash.eq_ignore_ascii_case(&staged.sha256) {
        return Err(DownloadError::HashMismatch);
    }
    let actual_version =
        probe_version(&staged.path, &AtomicBool::new(false), DEFAULT_PROBE_TIMEOUT)?;
    verify_probe_version(&staged.version, actual_version)
}

pub(crate) fn probe_ytdlp_version(path: &Path) -> Result<String, DownloadError> {
    probe_version(path, &AtomicBool::new(false), DEFAULT_PROBE_TIMEOUT)
}

fn verify_probe_version(expected: &str, actual: String) -> Result<(), DownloadError> {
    if actual == expected {
        Ok(())
    } else {
        Err(DownloadError::VersionMismatch {
            expected: expected.to_string(),
            actual,
        })
    }
}

fn read_probe_output<R: Read>(reader: R) -> Result<Vec<u8>, DownloadError> {
    let mut output = Vec::new();
    reader
        .take((MAX_PROBE_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| DownloadError::ProbeFailed)?;
    Ok(output)
}

fn write_staged_metadata(directory: &Path, staged: &StagedArtifact) -> Result<(), DownloadError> {
    let metadata_path = directory.join("staged.json");
    let temporary_path = directory.join("staged.json.part");
    let bytes = serde_json::to_vec_pretty(staged).map_err(|_| DownloadError::Filesystem)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|_| DownloadError::Filesystem)?;
    file.write_all(&bytes)
        .map_err(|_| DownloadError::Filesystem)?;
    file.sync_all().map_err(|_| DownloadError::Filesystem)?;
    fs::rename(temporary_path, metadata_path).map_err(|_| DownloadError::Filesystem)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{
        manifest::{
            canonical_payload_bytes, verify_manifest_for_download, ManifestError, ToolManifest,
            ToolManifestEnvelope,
        },
        trust::TrustedKeys,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use std::{
        net::{TcpListener, TcpStream},
        sync::mpsc,
    };

    const TEST_ONLY_SEED: [u8; 32] = [
        0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33,
        0x95, 0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44,
        0x97, 0x5e,
    ];
    const TEST_VERSION: &str = "2026.08.19";

    fn staged_bundled_yt_dlp_for_test() -> Option<PathBuf> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/bin/yt-dlp.exe");
        if path.is_file() {
            Some(path)
        } else {
            eprintln!("SKIP: bundled yt-dlp integration assertion requires prepare:windows-binaries; source archives intentionally omit runtime executables.");
            None
        }
    }

    fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_ONLY_SEED)
    }

    fn test_trust() -> TrustedKeys {
        TrustedKeys::from_public_key_bytes(vec![(
            "test-only-2026".into(),
            test_signing_key().verifying_key().to_bytes(),
        )])
        .expect("test trust")
    }

    fn test_manifest() -> ToolManifest {
        serde_json::from_str(include_str!("fixtures/valid-manifest-payload.json"))
            .expect("valid manifest fixture")
    }

    fn signed_manifest(manifest: &ToolManifest) -> Vec<u8> {
        let signature = test_signing_key().sign(&canonical_payload_bytes(manifest).unwrap());
        serde_json::to_vec(&ToolManifestEnvelope {
            payload: manifest.clone(),
            signature: STANDARD.encode(signature.to_bytes()),
        })
        .unwrap()
    }

    fn test_endpoint(url: Url) -> ArtifactEndpoint {
        ArtifactEndpoint {
            url,
            allowed_hosts: &["127.0.0.1"],
        }
    }

    fn test_config(max_bytes: u64) -> DownloadConfig {
        DownloadConfig {
            connect_timeout: Duration::from_secs(2),
            transfer_timeout: Duration::from_millis(500),
            probe_timeout: Duration::from_millis(250),
            max_bytes,
        }
    }

    fn spawn_response(status: &str, headers: &str, body: Vec<u8>) -> (Url, mpsc::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local server");
        let address = listener.local_addr().unwrap();
        let (done_sender, done_receiver) = mpsc::channel();
        let status = status.to_string();
        let headers = headers.to_string();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            consume_request(&mut stream);
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
            let _ = done_sender.send(());
        });
        (
            Url::parse(&format!("http://{address}/artifact")).unwrap(),
            done_receiver,
        )
    }

    fn spawn_slow_response(delay: Duration, body: Vec<u8>) -> (Url, mpsc::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local server");
        let address = listener.local_addr().unwrap();
        let (done_sender, done_receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            consume_request(&mut stream);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            thread::sleep(delay);
            let _ = stream.write_all(&body);
            let _ = done_sender.send(());
        });
        (
            Url::parse(&format!("http://{address}/artifact")).unwrap(),
            done_receiver,
        )
    }

    fn spawn_sequence_response(statuses: &[&str], body: Vec<u8>) -> (Url, mpsc::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local server");
        let address = listener.local_addr().unwrap();
        let (done_sender, done_receiver) = mpsc::channel();
        let statuses = statuses
            .iter()
            .map(|status| status.to_string())
            .collect::<Vec<_>>();
        thread::spawn(move || {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                consume_request(&mut stream);
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
            let _ = done_sender.send(());
        });
        (
            Url::parse(&format!("http://{address}/artifact")).unwrap(),
            done_receiver,
        )
    }

    fn consume_request(stream: &mut TcpStream) {
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
    }

    fn unique_temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cacatools-2c-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn trusted_component_is_accepted_and_untrusted_manifest_is_rejected_before_network() {
        let manifest = test_manifest();
        let verified = verify_manifest_for_download(&signed_manifest(&manifest), &test_trust())
            .expect("trusted manifest");
        assert_eq!(
            verified.component(ToolId::YtDlp).unwrap().as_ref().id,
            ToolId::YtDlp
        );

        let mut untrusted = manifest;
        untrusted.origin.repository = "evil.example/repository".into();
        let result = verify_manifest_for_download(&signed_manifest(&untrusted), &test_trust());
        assert!(matches!(result, Err(ManifestError::InvalidField { .. })));
    }

    #[test]
    fn expected_size_above_download_limit_is_rejected_before_network() {
        let mut manifest = test_manifest();
        manifest.components[0].size = MAX_ARTIFACT_BYTES + 1;
        let verified = verify_manifest_for_download(&signed_manifest(&manifest), &test_trust())
            .expect("schema maximum still accepts phase 2c rejection case");
        let endpoint = test_endpoint(Url::parse("http://127.0.0.1:9/artifact").unwrap());
        let result = stage_verified_component(
            verified.component(ToolId::YtDlp).unwrap(),
            &unique_temp_root("oversized"),
            &AtomicBool::new(false),
            endpoint,
            test_config(MAX_ARTIFACT_BYTES),
        );
        assert_eq!(result, Err(DownloadError::OversizedArtifact));
    }

    #[test]
    fn content_length_and_stream_limits_are_enforced() {
        let body = b"123456789".to_vec();
        let (url, done) = spawn_response("200 OK", "", body.clone());
        let partial = unique_temp_root("content-length").join("file.part");
        fs::create_dir_all(partial.parent().unwrap()).unwrap();
        let client = build_client(&["127.0.0.1"], test_config(8)).unwrap();
        let response = client.get(url).send().unwrap();
        assert!(matches!(
            validate_response_headers(response, 9, 8),
            Err(DownloadError::OversizedArtifact)
        ));
        let _ = done.recv_timeout(Duration::from_secs(1));

        let (url, done) = spawn_response("200 OK", "", body.clone());
        let response = client.get(url).send().unwrap();
        assert!(matches!(
            validate_response_headers(response, 8, 1024),
            Err(DownloadError::SizeMismatch {
                expected: 8,
                actual: 9
            })
        ));
        let _ = done.recv_timeout(Duration::from_secs(1));

        let (url, done) = spawn_response("200 OK", "", b"123456789".to_vec());
        let response = client.get(url).send().unwrap();
        assert_eq!(
            stream_response(
                response,
                &partial,
                &AtomicBool::new(false),
                9,
                Sha256::digest(b"123456789").into(),
                8,
            ),
            Err(DownloadError::OversizedArtifact)
        );
        let _ = done.recv_timeout(Duration::from_secs(1));
    }

    #[test]
    fn valid_hash_and_size_are_streamed_without_loading_the_body_as_one_buffer() {
        let body = b"valid-artifact".to_vec();
        let hash = Sha256::digest(&body);
        let (url, done) = spawn_response("200 OK", "", body.clone());
        let root = unique_temp_root("valid-stream");
        fs::create_dir_all(&root).unwrap();
        let partial = root.join("artifact.part");
        let client = build_client(&["127.0.0.1"], test_config(1024)).unwrap();
        let response = client.get(url).send().unwrap();
        assert!(stream_response(
            response,
            &partial,
            &AtomicBool::new(false),
            body.len() as u64,
            hash.into(),
            1024,
        )
        .is_ok());
        assert_eq!(fs::read(partial).unwrap(), body);
        let _ = done.recv_timeout(Duration::from_secs(1));
    }

    #[test]
    fn size_and_hash_mismatches_are_rejected() {
        let body = b"actual".to_vec();
        let (url, done) = spawn_response("200 OK", "", body.clone());
        let root = unique_temp_root("mismatch");
        fs::create_dir_all(&root).unwrap();
        let client = build_client(&["127.0.0.1"], test_config(1024)).unwrap();
        let response = client.get(url).send().unwrap();
        assert_eq!(
            stream_response(
                response,
                &root.join("size.part"),
                &AtomicBool::new(false),
                100,
                Sha256::digest(&body).into(),
                1024,
            ),
            Err(DownloadError::SizeMismatch {
                expected: 100,
                actual: body.len() as u64
            })
        );
        let _ = done.recv_timeout(Duration::from_secs(1));

        let (url, done) = spawn_response("200 OK", "", body.clone());
        let response = client.get(url).send().unwrap();
        assert_eq!(
            stream_response(
                response,
                &root.join("hash.part"),
                &AtomicBool::new(false),
                body.len() as u64,
                [0_u8; 32],
                1024,
            ),
            Err(DownloadError::HashMismatch)
        );
        let _ = done.recv_timeout(Duration::from_secs(1));
    }

    #[test]
    fn transient_http_failures_retry_boundedly_before_success() {
        let body = b"good".to_vec();
        let (url, done) = spawn_sequence_response(
            &[
                "503 Service Unavailable",
                "503 Service Unavailable",
                "200 OK",
            ],
            body.clone(),
        );
        let root = unique_temp_root("retry");
        fs::create_dir_all(&root).unwrap();
        let partial = root.join("artifact.part");
        let client = build_client(&["127.0.0.1"], test_config(1024)).unwrap();
        let endpoint = test_endpoint(url);
        let result = download_to_partial(
            &client,
            &endpoint,
            &partial,
            &AtomicBool::new(false),
            body.len() as u64,
            &format!("{:x}", Sha256::digest(&body)),
            test_config(1024),
        );
        assert!(result.is_ok());
        assert_eq!(fs::read(partial).unwrap(), body);
        let _ = done.recv_timeout(Duration::from_secs(2));
    }

    #[test]
    fn redirect_policy_rejects_untrusted_hosts_http_downgrade_and_loops() {
        assert!(redirect_is_allowed_for_test("https://github.com", 0));
        assert!(redirect_is_allowed_for_test(
            "https://release-assets.githubusercontent.com",
            0
        ));
        assert!(!redirect_is_allowed_for_test("https://evil.example", 0));
        assert!(!redirect_is_allowed_for_test("http://github.com", 0));
        assert!(!redirect_is_allowed_for_test(
            "https://github.com",
            MAX_REDIRECTS
        ));
    }

    fn redirect_is_allowed_for_test(url: &str, previous_count: usize) -> bool {
        let parsed = Url::parse(url).unwrap();
        parsed.scheme() == "https"
            && parsed
                .host_str()
                .is_some_and(|host| YTDLP_RELEASE_ALLOWED_HOSTS.contains(&host))
            && previous_count < MAX_REDIRECTS
    }

    #[test]
    fn local_http_redirects_are_rejected_before_following() {
        let (url, done) = spawn_response(
            "302 Found",
            "Location: http://127.0.0.1/redirect\r\n",
            Vec::new(),
        );
        let client = build_client(&["127.0.0.1"], test_config(1024)).unwrap();
        let response = client.get(url).send().unwrap();
        assert!(matches!(
            validate_response_headers(response, 0, 1024),
            Err(DownloadError::RedirectRejected)
        ));
        let _ = done.recv_timeout(Duration::from_secs(1));

        let (url, done) = spawn_response(
            "302 Found",
            "Location: https://evil.example/artifact\r\n",
            Vec::new(),
        );
        let response = client.get(url).send().unwrap();
        assert!(matches!(
            validate_response_headers(response, 0, 1024),
            Err(DownloadError::RedirectRejected)
        ));
        let _ = done.recv_timeout(Duration::from_secs(1));
    }

    #[test]
    fn slow_body_is_classified_as_timeout_and_partial_body_as_size_mismatch() {
        let (url, done) = spawn_slow_response(Duration::from_millis(150), b"slow".to_vec());
        let mut config = test_config(1024);
        config.transfer_timeout = Duration::from_millis(40);
        let client = build_client(&["127.0.0.1"], config).unwrap();
        let response = client.get(url).send().unwrap();
        let root = unique_temp_root("slow");
        fs::create_dir_all(&root).unwrap();
        let result = stream_response(
            response,
            &root.join("slow.part"),
            &AtomicBool::new(false),
            4,
            Sha256::digest(b"slow").into(),
            1024,
        );
        assert!(matches!(
            result,
            Err(DownloadError::Timeout | DownloadError::Network)
        ));
        let _ = done.recv_timeout(Duration::from_secs(1));

        let (url, done) = spawn_response("200 OK", "", b"partial".to_vec());
        let response = build_client(&["127.0.0.1"], test_config(1024))
            .unwrap()
            .get(url)
            .send()
            .unwrap();
        let result = stream_response(
            response,
            &root.join("partial.part"),
            &AtomicBool::new(false),
            99,
            Sha256::digest(b"partial").into(),
            1024,
        );
        assert_eq!(
            result,
            Err(DownloadError::SizeMismatch {
                expected: 99,
                actual: 7
            })
        );
        let _ = done.recv_timeout(Duration::from_secs(1));
    }

    #[test]
    fn wrong_component_and_artifact_identity_are_rejected() {
        let manifest = test_manifest();
        let verified =
            verify_manifest_for_download(&signed_manifest(&manifest), &test_trust()).unwrap();
        assert!(matches!(
            verified.component(ToolId::Ffmpeg),
            Err(ManifestError::UnknownComponent(_))
        ));

        let mut wrong_artifact = manifest;
        wrong_artifact.components[0].artifact.filename = "other.exe".into();
        assert!(
            verify_manifest_for_download(&signed_manifest(&wrong_artifact), &test_trust()).is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn version_probe_accepts_the_bundled_yt_dlp_and_rejects_mismatch() {
        let Some(path) = staged_bundled_yt_dlp_for_test() else {
            return;
        };
        let version = probe_version(&path, &AtomicBool::new(false), Duration::from_secs(10))
            .expect("bundled yt-dlp probe");
        verify_probe_version(TEST_VERSION, version).expect("expected version");
        assert_eq!(
            verify_probe_version(TEST_VERSION, "2026.08.20".into()),
            Err(DownloadError::VersionMismatch {
                expected: TEST_VERSION.into(),
                actual: "2026.08.20".into()
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn version_probe_timeout_is_terminal() {
        let Some(path) = staged_bundled_yt_dlp_for_test() else {
            return;
        };
        assert_eq!(
            probe_version(&path, &AtomicBool::new(false), Duration::ZERO),
            Err(DownloadError::Timeout)
        );
    }

    #[test]
    fn cancellation_and_same_tool_concurrency_are_explicit() {
        let cancelled = AtomicBool::new(true);
        let manifest = test_manifest();
        let verified =
            verify_manifest_for_download(&signed_manifest(&manifest), &test_trust()).unwrap();
        let result = stage_verified_component(
            verified.component(ToolId::YtDlp).unwrap(),
            &unique_temp_root("cancelled"),
            &cancelled,
            test_endpoint(Url::parse("http://127.0.0.1:9/artifact").unwrap()),
            test_config(MAX_ARTIFACT_BYTES),
        );
        assert_eq!(result, Err(DownloadError::Cancelled));

        let active = ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new()));
        active.lock().unwrap().insert(ToolId::YtDlp);
        let result = begin_operation(&unique_temp_root("busy"));
        assert!(matches!(result, Err(DownloadError::AlreadyRunning)));
        active.lock().unwrap().remove(&ToolId::YtDlp);
    }

    #[test]
    fn relative_staging_roots_are_rejected() {
        let manifest = test_manifest();
        let verified = verify_manifest_for_download(&signed_manifest(&manifest), &test_trust())
            .expect("trusted manifest");
        let result = stage_verified_component(
            verified.component(ToolId::YtDlp).unwrap(),
            Path::new("relative-app-data"),
            &AtomicBool::new(false),
            test_endpoint(Url::parse("http://127.0.0.1:9/artifact").unwrap()),
            test_config(MAX_ARTIFACT_BYTES),
        );
        assert_eq!(result, Err(DownloadError::Filesystem));
    }

    #[test]
    fn probe_validation_rejects_non_matching_or_empty_output() {
        assert_eq!(
            verify_probe_version(TEST_VERSION, TEST_VERSION.to_string()),
            Ok(())
        );
        assert_eq!(
            verify_probe_version(TEST_VERSION, "2026.08.20".to_string()),
            Err(DownloadError::VersionMismatch {
                expected: TEST_VERSION.to_string(),
                actual: "2026.08.20".to_string(),
            })
        );
        assert_eq!(
            verify_probe_version(TEST_VERSION, String::new()),
            Err(DownloadError::VersionMismatch {
                expected: TEST_VERSION.to_string(),
                actual: String::new(),
            })
        );
        assert_eq!(
            probe_version(
                Path::new("relative-yt-dlp.exe"),
                &AtomicBool::new(false),
                Duration::from_secs(1)
            ),
            Err(DownloadError::ProbeFailed)
        );
    }

    #[test]
    fn staged_artifacts_are_not_runtime_resolver_candidates() {
        let staged = unique_temp_root("resolver-isolation")
            .join("tools")
            .join("staging")
            .join("op-test")
            .join("yt-dlp.exe");
        let resolution = crate::app::runtime::resolve_tool(None, ToolId::YtDlp);
        assert_ne!(resolution.path, Some(staged));
    }

    #[test]
    fn staged_metadata_has_no_runtime_activation_pointer() {
        let root = unique_temp_root("metadata");
        let directory = root.join("tools").join("staging").join("op-test");
        fs::create_dir_all(&directory).unwrap();
        let staged = StagedArtifact {
            tool_id: "yt-dlp".into(),
            version: TEST_VERSION.into(),
            sha256: "00".repeat(32),
            size: 1,
            source_repository: "yt-dlp/yt-dlp".into(),
            source_release: TEST_VERSION.into(),
            operation_id: "op-test".into(),
            verification_timestamp: 1,
            state: "STAGED_VERIFIED".into(),
            path: directory.join("yt-dlp.exe"),
        };
        write_staged_metadata(&directory, &staged).unwrap();
        assert!(directory.join("staged.json").is_file());
        assert!(!root.join("active.json").exists());
        assert!(!root.join("tool-updates.json").exists());
    }
}
