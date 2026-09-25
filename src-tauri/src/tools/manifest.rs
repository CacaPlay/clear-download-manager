use super::{
    policy::{component_policy, SourceAuthority, ToolchainFamily, UpdateEligibility},
    trust::{TrustError, TrustedKeys},
    version::compare_component_versions,
};
use crate::app::runtime::ToolId;
use semver::Version;
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fmt};

const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_ID_LENGTH: usize = 128;
const MAX_KEY_ID_LENGTH: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolManifestEnvelope {
    pub(crate) payload: ToolManifest,
    pub(crate) signature: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolManifest {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    #[serde(rename = "manifestId")]
    pub(crate) manifest_id: String,
    #[serde(rename = "generatedAt")]
    pub(crate) generated_at: String,
    #[serde(rename = "keyId")]
    pub(crate) key_id: String,
    pub(crate) origin: ManifestOrigin,
    pub(crate) components: Vec<ToolComponent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) revocations: Vec<RevocationEntry>,
}

/// A manifest that has completed parsing, signature verification, schema
/// validation, compatibility checks, and revocation checks.
///
/// The downloader only accepts a component borrowed from this type so an
/// arbitrary deserialized component cannot become a network authority.
#[derive(Clone, Debug)]
pub(crate) struct VerifiedManifest {
    manifest: ToolManifest,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct VerifiedToolComponent<'a> {
    component: &'a ToolComponent,
}

impl VerifiedManifest {
    pub(crate) fn from_validated(manifest: ToolManifest) -> Self {
        Self { manifest }
    }

    pub(crate) fn component(&self, id: ToolId) -> Result<VerifiedToolComponent<'_>, ManifestError> {
        self.manifest
            .components
            .iter()
            .find(|component| component.id == id)
            .map(|component| VerifiedToolComponent { component })
            .ok_or_else(|| ManifestError::UnknownComponent(id.base_name().into()))
    }
}

impl<'a> VerifiedToolComponent<'a> {
    pub(crate) fn as_ref(&self) -> &'a ToolComponent {
        self.component
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestOrigin {
    pub(crate) authority: SourceAuthority,
    pub(crate) repository: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolComponent {
    #[serde(
        deserialize_with = "deserialize_tool_id",
        serialize_with = "serialize_tool_id"
    )]
    pub(crate) id: ToolId,
    pub(crate) platform: SupportedPlatform,
    pub(crate) arch: SupportedArch,
    pub(crate) version: String,
    pub(crate) artifact: ArtifactIdentity,
    pub(crate) source: SourceIdentity,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) compatibility: CompatibilityBounds,
    pub(crate) license: LicenseReference,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) profile: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArtifactIdentity {
    #[serde(rename = "releaseTag")]
    pub(crate) release_tag: String,
    pub(crate) filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) family: Option<ToolchainFamily>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceIdentity {
    pub(crate) authority: SourceAuthority,
    pub(crate) repository: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompatibilityBounds {
    #[serde(rename = "minimumAppVersion")]
    pub(crate) minimum_app_version: String,
    #[serde(
        rename = "maximumAppVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) maximum_app_version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LicenseReference {
    pub(crate) spdx: String,
    pub(crate) notices: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RevocationEntry {
    #[serde(
        deserialize_with = "deserialize_tool_id",
        serialize_with = "serialize_tool_id"
    )]
    pub(crate) component: ToolId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sha256: Option<String>,
    pub(crate) reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum SupportedPlatform {
    #[serde(rename = "windows")]
    Windows,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum SupportedArch {
    #[serde(rename = "x86_64")]
    X86_64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManifestError {
    InvalidJson(String),
    DuplicateKey(String),
    UnsupportedSchemaVersion(u32),
    InvalidField { field: &'static str, reason: String },
    UnknownComponent(String),
    UnknownKeyId(String),
    InvalidSignature(String),
    IncompatibleAppVersion(String),
    Version(String),
    Sha256(String),
    Revoked(String),
    PartialFfmpegSet,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(reason) => write!(formatter, "invalid manifest JSON: {reason}"),
            Self::DuplicateKey(key) => write!(formatter, "duplicate JSON key: {key}"),
            Self::UnsupportedSchemaVersion(version) => {
                write!(formatter, "unsupported manifest schema version: {version}")
            }
            Self::InvalidField { field, reason } => write!(formatter, "invalid {field}: {reason}"),
            Self::UnknownComponent(id) => write!(formatter, "unknown component id: {id}"),
            Self::UnknownKeyId(key_id) => write!(formatter, "unknown keyId: {key_id}"),
            Self::InvalidSignature(reason) => {
                write!(formatter, "invalid manifest signature: {reason}")
            }
            Self::IncompatibleAppVersion(version) => {
                write!(
                    formatter,
                    "manifest is incompatible with app version {version}"
                )
            }
            Self::Version(reason) => write!(formatter, "invalid component version: {reason}"),
            Self::Sha256(reason) => write!(formatter, "invalid sha256: {reason}"),
            Self::Revoked(reason) => write!(formatter, "revoked component: {reason}"),
            Self::PartialFfmpegSet => {
                formatter.write_str("FFMPEG_SET must contain both ffmpeg and ffprobe")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<TrustError> for ManifestError {
    fn from(error: TrustError) -> Self {
        match error {
            TrustError::UnknownKeyId(key_id) => Self::UnknownKeyId(key_id),
            TrustError::InvalidPublicKey(key_id) => {
                Self::InvalidSignature(format!("trusted public key is invalid for keyId {key_id}"))
            }
            TrustError::InvalidSignatureEncoding => {
                Self::InvalidSignature("signature is not valid base64 Ed25519".into())
            }
            TrustError::InvalidSignature => Self::InvalidSignature("signature mismatch".into()),
        }
    }
}

pub(crate) fn parse_and_verify_signed_manifest(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
) -> Result<ToolManifest, ManifestError> {
    reject_duplicate_keys(bytes)?;
    let envelope: ToolManifestEnvelope = serde_json::from_slice(bytes)
        .map_err(|error| ManifestError::InvalidJson(error.to_string()))?;
    let canonical = canonical_payload_bytes(&envelope.payload)?;
    trusted_keys
        .verify(&envelope.payload.key_id, &canonical, &envelope.signature)
        .map_err(ManifestError::from)?;
    validate_manifest(&envelope.payload, env!("CARGO_PKG_VERSION"))?;
    Ok(envelope.payload)
}

pub(crate) fn verify_manifest_for_download(
    bytes: &[u8],
    trusted_keys: &TrustedKeys,
) -> Result<VerifiedManifest, ManifestError> {
    Ok(VerifiedManifest {
        manifest: parse_and_verify_signed_manifest(bytes, trusted_keys)?,
    })
}

pub(crate) fn canonical_payload_bytes(manifest: &ToolManifest) -> Result<Vec<u8>, ManifestError> {
    serde_json::to_vec(manifest).map_err(|error| ManifestError::InvalidJson(error.to_string()))
}

pub(crate) fn validate_manifest(
    manifest: &ToolManifest,
    app_version: &str,
) -> Result<(), ManifestError> {
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(ManifestError::UnsupportedSchemaVersion(
            manifest.schema_version,
        ));
    }
    if !is_safe_token(&manifest.manifest_id, MAX_MANIFEST_ID_LENGTH) {
        return Err(ManifestError::InvalidField {
            field: "manifestId",
            reason: "must be a bounded identifier".into(),
        });
    }
    if !is_utc_timestamp(&manifest.generated_at) {
        return Err(ManifestError::InvalidField {
            field: "generatedAt",
            reason: "must be an explicit UTC timestamp".into(),
        });
    }
    if !is_safe_token(&manifest.key_id, MAX_KEY_ID_LENGTH) {
        return Err(ManifestError::InvalidField {
            field: "keyId",
            reason: "must be a bounded identifier".into(),
        });
    }
    let (origin_authority, origin_repository) = super::policy::manifest_origin_policy();
    if manifest.origin.authority != SourceAuthority::CacatoolsControlled
        || origin_authority != "cacatools-controlled"
        || manifest.origin.repository != origin_repository
    {
        return Err(ManifestError::InvalidField {
            field: "origin",
            reason: "manifest origin is not allowlisted".into(),
        });
    }
    if manifest.components.is_empty() {
        return Err(ManifestError::InvalidField {
            field: "components",
            reason: "must not be empty".into(),
        });
    }
    let app_version = Version::parse(app_version).map_err(|error| ManifestError::InvalidField {
        field: "appVersion",
        reason: error.to_string(),
    })?;
    let mut component_ids = HashSet::new();
    for component in &manifest.components {
        if !component_ids.insert(component.id) {
            return Err(ManifestError::InvalidField {
                field: "components",
                reason: format!("duplicate component {}", component.id.base_name()),
            });
        }
        validate_component(component, &app_version)?;
    }
    validate_ffmpeg_set(manifest)?;
    for revocation in &manifest.revocations {
        validate_revocation(revocation)?;
        if manifest.components.iter().any(|component| {
            component.id == revocation.component
                && revocation
                    .version
                    .as_deref()
                    .is_some_and(|version| version == component.version)
                || component.id == revocation.component
                    && revocation.sha256.as_deref().is_some_and(|hash| {
                        normalize_sha256(hash).ok() == normalize_sha256(&component.sha256).ok()
                    })
        }) {
            return Err(ManifestError::Revoked(
                revocation.component.base_name().into(),
            ));
        }
    }
    Ok(())
}

fn validate_component(
    component: &ToolComponent,
    app_version: &Version,
) -> Result<(), ManifestError> {
    if component.platform != SupportedPlatform::Windows {
        return Err(ManifestError::InvalidField {
            field: "platform",
            reason: "only windows is supported".into(),
        });
    }
    if component.arch != SupportedArch::X86_64 {
        return Err(ManifestError::InvalidField {
            field: "arch",
            reason: "only x86_64 is supported".into(),
        });
    }
    let policy = component_policy(component.id);
    if component.source.authority != policy.authority {
        return Err(ManifestError::InvalidField {
            field: "source.authority",
            reason: "component authority is not allowlisted".into(),
        });
    }
    if component.source.repository != policy.repository {
        return Err(ManifestError::InvalidField {
            field: "source.repository",
            reason: "repository is not allowlisted for this component".into(),
        });
    }
    if component.size == 0 || component.size > policy.max_size_bytes {
        return Err(ManifestError::InvalidField {
            field: "size",
            reason: format!("must be between 1 and {} bytes", policy.max_size_bytes),
        });
    }
    normalize_sha256(&component.sha256).map_err(ManifestError::Sha256)?;
    if component.artifact.filename.is_empty()
        || component.artifact.filename.contains(['/', '\\'])
        || component.artifact.filename != component.artifact.filename.trim()
        || component.artifact.filename != component.id.artifact_filename()
        || !component
            .artifact
            .filename
            .to_ascii_lowercase()
            .ends_with(".exe")
    {
        return Err(ManifestError::InvalidField {
            field: "artifact.filename",
            reason: "must be a single .exe filename".into(),
        });
    }
    if !is_safe_token(&component.artifact.release_tag, 128) {
        return Err(ManifestError::InvalidField {
            field: "artifact.releaseTag",
            reason: "must be a bounded release identifier".into(),
        });
    }
    compare_component_versions(component.id, &component.version, &component.version)
        .map_err(|error| ManifestError::Version(error.to_string()))?;
    let minimum =
        Version::parse(&component.compatibility.minimum_app_version).map_err(|error| {
            ManifestError::InvalidField {
                field: "minimumAppVersion",
                reason: error.to_string(),
            }
        })?;
    if let Some(maximum) = &component.compatibility.maximum_app_version {
        let maximum = Version::parse(maximum).map_err(|error| ManifestError::InvalidField {
            field: "maximumAppVersion",
            reason: error.to_string(),
        })?;
        if maximum < minimum {
            return Err(ManifestError::InvalidField {
                field: "maximumAppVersion",
                reason: "must not be below minimumAppVersion".into(),
            });
        }
    }
    if app_version < &minimum {
        return Err(ManifestError::IncompatibleAppVersion(
            app_version.to_string(),
        ));
    }
    validate_license(&component.license)?;
    if let Some(family) = policy.family {
        if component.artifact.family != Some(family) {
            return Err(ManifestError::InvalidField {
                field: "artifact.family",
                reason: "must match the code-owned toolchain family".into(),
            });
        }
    } else if component.artifact.family.is_some() {
        return Err(ManifestError::InvalidField {
            field: "artifact.family",
            reason: "unexpected family for independent component".into(),
        });
    }
    if matches!(policy.eligibility, UpdateEligibility::BundledOnly) && component.profile.is_some() {
        return Err(ManifestError::InvalidField {
            field: "profile",
            reason: "aria2c has no remote update profile".into(),
        });
    }
    for dependency in &component.dependencies {
        if !is_safe_token(dependency, 128) {
            return Err(ManifestError::InvalidField {
                field: "dependencies",
                reason: "dependency names must not contain paths or commands".into(),
            });
        }
    }
    if let Some(profile) = &component.profile {
        if !is_safe_token(profile, 128) {
            return Err(ManifestError::InvalidField {
                field: "profile",
                reason: "profile must be a bounded identifier".into(),
            });
        }
    }
    Ok(())
}

fn validate_license(license: &LicenseReference) -> Result<(), ManifestError> {
    if !is_safe_token(&license.spdx, 64)
        || license.notices.is_empty()
        || license.notices.contains(['/', '\\', ':'])
    {
        return Err(ManifestError::InvalidField {
            field: "license",
            reason: "requires a bounded SPDX id and notice filename".into(),
        });
    }
    Ok(())
}

fn validate_revocation(revocation: &RevocationEntry) -> Result<(), ManifestError> {
    if revocation.version.is_none() && revocation.sha256.is_none() {
        return Err(ManifestError::InvalidField {
            field: "revocations",
            reason: "each entry needs version or sha256".into(),
        });
    }
    if let Some(version) = &revocation.version {
        compare_component_versions(revocation.component, version, version)
            .map_err(|error| ManifestError::Version(error.to_string()))?;
    }
    if let Some(sha256) = &revocation.sha256 {
        normalize_sha256(sha256).map_err(ManifestError::Sha256)?;
    }
    if revocation.reason.trim().is_empty() {
        return Err(ManifestError::InvalidField {
            field: "revocations.reason",
            reason: "must not be empty".into(),
        });
    }
    Ok(())
}

fn validate_ffmpeg_set(manifest: &ToolManifest) -> Result<(), ManifestError> {
    let ffmpeg = manifest
        .components
        .iter()
        .find(|component| component.id == ToolId::Ffmpeg);
    let ffprobe = manifest
        .components
        .iter()
        .find(|component| component.id == ToolId::Ffprobe);
    if ffmpeg.is_some() != ffprobe.is_some() {
        return Err(ManifestError::PartialFfmpegSet);
    }
    if let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) {
        if ffmpeg.platform != ffprobe.platform
            || ffmpeg.arch != ffprobe.arch
            || ffmpeg.version != ffprobe.version
            || ffmpeg.artifact.release_tag != ffprobe.artifact.release_tag
            || ffmpeg.artifact.family != ffprobe.artifact.family
        {
            return Err(ManifestError::InvalidField {
                field: "components",
                reason: "ffmpeg and ffprobe must share one compatibility set".into(),
            });
        }
    }
    Ok(())
}

pub(crate) fn normalize_sha256(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64
        || value.trim() != value
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("must be exactly 64 hexadecimal characters without whitespace".into());
    }
    let mut output = [0_u8; 32];
    let (chunks, remainder) = value.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    for (index, chunk) in chunks.iter().enumerate() {
        output[index] = (hex_value(chunk[0]) << 4) | hex_value(chunk[1]);
    }
    Ok(output)
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn hex_value(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => unreachable!("hex_value called only after validation"),
    }
}

fn is_safe_token(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub(crate) fn parse_utc_timestamp_seconds(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || ![0..4, 5..7, 8..10, 11..13, 14..16, 17..19]
            .into_iter()
            .flatten()
            .all(|index| bytes[index].is_ascii_digit())
    {
        return None;
    }
    let timestamp_end = match bytes[19] {
        b'Z' => 20,
        b'.' => {
            let zero_index = bytes[20..].iter().position(|byte| *byte == b'Z')?;
            let fraction = &bytes[20..20 + zero_index];
            if fraction.is_empty() || !fraction.iter().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            20 + zero_index + 1
        }
        _ => return None,
    };
    if timestamp_end != bytes.len() {
        return None;
    }
    let parse = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range])
            .ok()
            .and_then(|part| part.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse(0..4),
        parse(5..7),
        parse(8..10),
        parse(11..13),
        parse(14..16),
        parse(17..19),
    ) else {
        return None;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    let valid = (2000..=9999).contains(&year)
        && day >= 1
        && day <= days_in_month
        && hour <= 23
        && minute <= 59
        && second <= 59;
    if !valid {
        return None;
    }
    let year = i64::from(year);
    let month = i64::from(month);
    let day = i64::from(day);
    let year_adjusted = year - if month <= 2 { 1 } else { 0 };
    let era = if year_adjusted >= 0 {
        year_adjusted / 400
    } else {
        (year_adjusted - 399) / 400
    };
    let year_of_era = year_adjusted - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    Some(
        days_since_epoch * 86_400
            + i64::from(hour) * 3_600
            + i64::from(minute) * 60
            + i64::from(second),
    )
}

fn is_utc_timestamp(value: &str) -> bool {
    parse_utc_timestamp_seconds(value).is_some()
}

fn serialize_tool_id<S>(id: &ToolId, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(tool_id_name(*id))
}

fn deserialize_tool_id<'de, D>(deserializer: D) -> Result<ToolId, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    tool_id_from_name(&value)
        .ok_or_else(|| D::Error::custom(format!("unknown component id: {value}")))
}

fn tool_id_name(id: ToolId) -> &'static str {
    match id {
        ToolId::YtDlp => "yt-dlp",
        ToolId::Ffmpeg => "ffmpeg",
        ToolId::Ffprobe => "ffprobe",
        ToolId::Deno => "deno",
        ToolId::Aria2c => "aria2c",
    }
}

fn tool_id_from_name(value: &str) -> Option<ToolId> {
    match value {
        "yt-dlp" => Some(ToolId::YtDlp),
        "ffmpeg" => Some(ToolId::Ffmpeg),
        "ffprobe" => Some(ToolId::Ffprobe),
        "deno" => Some(ToolId::Deno),
        "aria2c" => Some(ToolId::Aria2c),
        _ => None,
    }
}

pub(crate) fn reject_duplicate_keys(bytes: &[u8]) -> Result<(), ManifestError> {
    let mut parser = DuplicateKeyParser { bytes, index: 0 };
    parser.parse_document().map_err(|error| match error {
        DuplicateKeyError::Duplicate(key) => ManifestError::DuplicateKey(key),
        DuplicateKeyError::Syntax(reason) => ManifestError::InvalidJson(reason),
    })
}

enum DuplicateKeyError {
    Duplicate(String),
    Syntax(String),
}

struct DuplicateKeyParser<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> DuplicateKeyParser<'a> {
    fn parse_document(&mut self) -> Result<(), DuplicateKeyError> {
        self.skip_whitespace();
        self.parse_value()?;
        self.skip_whitespace();
        if self.index == self.bytes.len() {
            Ok(())
        } else {
            Err(DuplicateKeyError::Syntax("trailing bytes".into()))
        }
    }

    fn parse_value(&mut self) -> Result<(), DuplicateKeyError> {
        self.skip_whitespace();
        match self.bytes.get(self.index).copied() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => {
                self.parse_string()?;
                Ok(())
            }
            Some(b't') => self.parse_literal(b"true"),
            Some(b'f') => self.parse_literal(b"false"),
            Some(b'n') => self.parse_literal(b"null"),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            _ => Err(DuplicateKeyError::Syntax(format!(
                "unexpected byte at {}",
                self.index
            ))),
        }
    }

    fn parse_object(&mut self) -> Result<(), DuplicateKeyError> {
        self.index += 1;
        self.skip_whitespace();
        let mut keys = HashSet::new();
        if self.take_if(b'}') {
            return Ok(());
        }
        loop {
            self.skip_whitespace();
            let key_bytes = self.parse_string()?;
            let key = serde_json::from_slice::<String>(key_bytes)
                .map_err(|error| DuplicateKeyError::Syntax(error.to_string()))?;
            if !keys.insert(key.clone()) {
                return Err(DuplicateKeyError::Duplicate(key));
            }
            self.skip_whitespace();
            self.expect(b':')?;
            self.parse_value()?;
            self.skip_whitespace();
            if self.take_if(b'}') {
                return Ok(());
            }
            self.expect(b',')?;
        }
    }

    fn parse_array(&mut self) -> Result<(), DuplicateKeyError> {
        self.index += 1;
        self.skip_whitespace();
        if self.take_if(b']') {
            return Ok(());
        }
        loop {
            self.parse_value()?;
            self.skip_whitespace();
            if self.take_if(b']') {
                return Ok(());
            }
            self.expect(b',')?;
        }
    }

    fn parse_string(&mut self) -> Result<&'a [u8], DuplicateKeyError> {
        let start = self.index;
        if !self.take_if(b'"') {
            return Err(DuplicateKeyError::Syntax("expected JSON string".into()));
        }
        while let Some(byte) = self.bytes.get(self.index).copied() {
            self.index += 1;
            match byte {
                b'"' => return Ok(&self.bytes[start..self.index]),
                b'\\' => {
                    if self.index >= self.bytes.len() {
                        return Err(DuplicateKeyError::Syntax("unterminated escape".into()));
                    }
                    self.index += 1;
                }
                _ => {}
            }
        }
        Err(DuplicateKeyError::Syntax("unterminated JSON string".into()))
    }

    fn parse_literal(&mut self, literal: &[u8]) -> Result<(), DuplicateKeyError> {
        if self.bytes.get(self.index..self.index + literal.len()) == Some(literal) {
            self.index += literal.len();
            Ok(())
        } else {
            Err(DuplicateKeyError::Syntax("invalid JSON literal".into()))
        }
    }

    fn parse_number(&mut self) -> Result<(), DuplicateKeyError> {
        let start = self.index;
        while let Some(byte) = self.bytes.get(self.index).copied() {
            if matches!(byte, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t') {
                break;
            }
            self.index += 1;
        }
        if start == self.index {
            Err(DuplicateKeyError::Syntax("invalid JSON number".into()))
        } else {
            Ok(())
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), DuplicateKeyError> {
        if self.take_if(expected) {
            Ok(())
        } else {
            Err(DuplicateKeyError::Syntax(format!(
                "expected byte {expected}"
            )))
        }
    }

    fn take_if(&mut self, expected: u8) -> bool {
        if self.bytes.get(self.index).copied() == Some(expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(
            self.bytes.get(self.index),
            Some(b' ' | b'\n' | b'\r' | b'\t')
        ) {
            self.index += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::trust::TrustedKeys;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    const TEST_ONLY_SEED: [u8; 32] = [
        0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33,
        0x95, 0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44,
        0x97, 0x5e,
    ];
    const TEST_ONLY_KEY_ID: &str = "test-only-2026";
    const VALID_PAYLOAD: &str = include_str!("fixtures/valid-manifest-payload.json");
    const FIXTURE_INDEX: &str = include_str!("fixtures/manifest-case-index.json");

    fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_ONLY_SEED)
    }

    fn test_trust() -> TrustedKeys {
        TrustedKeys::from_public_key_bytes(vec![(
            TEST_ONLY_KEY_ID.to_string(),
            test_signing_key().verifying_key().to_bytes(),
        )])
        .expect("test public key is valid")
    }

    fn valid_manifest() -> ToolManifest {
        serde_json::from_str(VALID_PAYLOAD).expect("valid manifest fixture")
    }

    #[test]
    fn fixture_index_is_data_only_and_covers_required_cases() {
        let index: serde_json::Value = serde_json::from_str(FIXTURE_INDEX).expect("fixture index");
        assert_eq!(index["valid"], "valid-manifest-payload.json");
        assert_eq!(index["rejectionCases"].as_array().map(Vec::len), Some(14));
    }

    fn signed_bytes(manifest: &ToolManifest) -> Vec<u8> {
        let canonical = canonical_payload_bytes(manifest).expect("canonical payload");
        let signature = test_signing_key().sign(&canonical);
        serde_json::to_vec(&ToolManifestEnvelope {
            payload: manifest.clone(),
            signature: STANDARD.encode(signature.to_bytes()),
        })
        .expect("signed fixture")
    }

    #[test]
    fn valid_signed_manifest_is_verified_offline() {
        let manifest = valid_manifest();
        let verified = parse_and_verify_signed_manifest(&signed_bytes(&manifest), &test_trust())
            .expect("valid test-only signature");
        assert_eq!(verified.key_id, TEST_ONLY_KEY_ID);
    }

    #[test]
    fn invalid_signature_and_unknown_key_are_rejected() {
        let manifest = valid_manifest();
        let mut bytes = signed_bytes(&manifest);
        let last = bytes.len() - 3;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        assert!(parse_and_verify_signed_manifest(&bytes, &test_trust()).is_err());

        let mut unknown = manifest;
        unknown.key_id = "unknown-key".into();
        assert!(matches!(
            parse_and_verify_signed_manifest(&signed_bytes(&unknown), &test_trust()),
            Err(ManifestError::UnknownKeyId(_))
        ));
    }

    #[test]
    fn duplicate_keys_are_rejected_before_serde_last_wins_behavior() {
        let duplicate =
            br#"{"payload":{"schemaVersion":1},"payload":{"schemaVersion":1},"signature":""}"#;
        assert!(matches!(
            parse_and_verify_signed_manifest(duplicate, &test_trust()),
            Err(ManifestError::DuplicateKey(key)) if key == "payload"
        ));
    }

    #[test]
    fn forbidden_fields_and_unknown_components_are_rejected() {
        let forbidden =
            VALID_PAYLOAD.replace("\"components\": [", "\"commands\": [], \"components\": [");
        let forbidden_envelope = format!("{{\"payload\":{},\"signature\":\"\"}}", forbidden);
        assert!(
            parse_and_verify_signed_manifest(forbidden_envelope.as_bytes(), &test_trust()).is_err()
        );

        let unknown = VALID_PAYLOAD.replace("\"id\": \"yt-dlp\"", "\"id\": \"unknown-tool\"");
        let unknown_envelope = format!("{{\"payload\":{},\"signature\":\"\"}}", unknown);
        assert!(
            parse_and_verify_signed_manifest(unknown_envelope.as_bytes(), &test_trust()).is_err()
        );
    }

    #[test]
    fn platform_arch_hash_and_size_constraints_are_enforced() {
        let mut manifest = valid_manifest();
        manifest.components[0].platform = SupportedPlatform::Windows;
        manifest.components[0].sha256 = "not-a-sha".into();
        assert!(validate_manifest(&manifest, "0.45.4").is_err());

        let mut oversized = valid_manifest();
        oversized.components[0].size = 129 * 1024 * 1024;
        assert!(validate_manifest(&oversized, "0.45.4").is_err());

        let mut wrong_artifact = valid_manifest();
        wrong_artifact.components[0].artifact.filename = "other.exe".into();
        assert!(validate_manifest(&wrong_artifact, "0.45.4").is_err());

        let wrong_platform =
            VALID_PAYLOAD.replace("\"platform\": \"windows\"", "\"platform\": \"linux\"");
        assert!(serde_json::from_str::<ToolManifest>(&wrong_platform).is_err());
        let wrong_arch = VALID_PAYLOAD.replace("\"arch\": \"x86_64\"", "\"arch\": \"aarch64\"");
        assert!(serde_json::from_str::<ToolManifest>(&wrong_arch).is_err());
    }

    #[test]
    fn compatibility_revocation_and_downgrade_are_rejected() {
        let mut incompatible = valid_manifest();
        incompatible.components[0].compatibility.minimum_app_version = "9.0.0".into();
        assert!(validate_manifest(&incompatible, "0.45.4").is_err());

        let mut above_maximum = valid_manifest();
        above_maximum.components[0]
            .compatibility
            .maximum_app_version = Some("0.40.0".into());
        assert!(validate_manifest(&above_maximum, "0.45.4").is_err());

        let mut revoked = valid_manifest();
        revoked.revocations.push(RevocationEntry {
            component: ToolId::YtDlp,
            version: Some("2026.08.19".into()),
            sha256: None,
            reason: "test-only revocation".into(),
        });
        assert!(validate_manifest(&revoked, "0.45.4").is_err());

        assert_eq!(
            compare_component_versions(ToolId::YtDlp, "2026.08.19", "2026.07.01"),
            Ok(std::cmp::Ordering::Greater)
        );
    }

    #[test]
    fn ffmpeg_set_and_untrusted_repository_are_rejected() {
        let mut partial = valid_manifest();
        partial.components[0].id = ToolId::Ffmpeg;
        partial.components[0].artifact.filename = "ffmpeg.exe".into();
        partial.components[0].artifact.family = Some(ToolchainFamily::FfmpegSet);
        partial.components[0].source.authority = SourceAuthority::FfmpegProvider;
        partial.components[0].source.repository = "GyanD/codexffmpeg".into();
        partial.components[0].version = "8.1.2".into();
        assert!(matches!(
            validate_manifest(&partial, "0.45.4"),
            Err(ManifestError::PartialFfmpegSet)
        ));

        let mut untrusted = valid_manifest();
        untrusted.components[0].source.repository = "evil.example/tools".into();
        assert!(validate_manifest(&untrusted, "0.45.4").is_err());

        let mut untrusted_origin = valid_manifest();
        untrusted_origin.origin.repository = "evil.example/manifest".into();
        assert!(validate_manifest(&untrusted_origin, "0.45.4").is_err());
    }

    #[test]
    fn sha256_helper_accepts_uppercase_and_rejects_ambiguous_hashes() {
        let uppercase = "66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A";
        assert!(normalize_sha256(uppercase).is_ok());
        assert!(normalize_sha256(
            "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a "
        )
        .is_err());
        assert!(normalize_sha256("d41d8cd98f00b204e9800998ecf8427e").is_err());
        assert!(normalize_sha256("").is_err());

        let mut invalid_timestamp = valid_manifest();
        invalid_timestamp.generated_at = "2026-99-99T99:99:99Z".into();
        assert!(validate_manifest(&invalid_timestamp, "0.45.4").is_err());

        let mut fractional_timestamp = valid_manifest();
        fractional_timestamp.generated_at = "2026-09-07T00:00:00.123Z".into();
        assert!(validate_manifest(&fractional_timestamp, "0.45.4").is_ok());
    }
}
