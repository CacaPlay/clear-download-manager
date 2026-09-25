use crate::app::runtime::ToolId;
use serde::{Deserialize, Serialize};

pub(crate) const TOOLS_OVERLAY_STORE_POLICY: &str = "UNVERIFIED";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SourceAuthority {
    CacatoolsControlled,
    YtDlpOfficial,
    DenoOfficial,
    FfmpegProvider,
    Aria2Official,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StorePolicy {
    Unverified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpdateEligibility {
    UpdateEligible,
    ConditionalCompatibilitySet,
    AppReleaseManaged,
    BundledOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ToolchainFamily {
    FfmpegSet,
    YtDlpJsRuntime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ComponentPolicy {
    pub(crate) authority: SourceAuthority,
    pub(crate) repository: &'static str,
    pub(crate) max_size_bytes: u64,
    pub(crate) eligibility: UpdateEligibility,
    pub(crate) family: Option<ToolchainFamily>,
}

const MIB: u64 = 1024 * 1024;

pub(crate) fn component_policy(id: ToolId) -> ComponentPolicy {
    match id {
        ToolId::YtDlp => ComponentPolicy {
            authority: SourceAuthority::YtDlpOfficial,
            repository: "yt-dlp/yt-dlp",
            max_size_bytes: 128 * MIB,
            eligibility: UpdateEligibility::UpdateEligible,
            family: None,
        },
        ToolId::Deno => ComponentPolicy {
            authority: SourceAuthority::DenoOfficial,
            repository: "denoland/deno",
            max_size_bytes: 256 * MIB,
            eligibility: UpdateEligibility::ConditionalCompatibilitySet,
            family: Some(ToolchainFamily::YtDlpJsRuntime),
        },
        ToolId::Ffmpeg | ToolId::Ffprobe => ComponentPolicy {
            authority: SourceAuthority::FfmpegProvider,
            repository: "GyanD/codexffmpeg",
            max_size_bytes: 512 * MIB,
            eligibility: UpdateEligibility::AppReleaseManaged,
            family: Some(ToolchainFamily::FfmpegSet),
        },
        ToolId::Aria2c => ComponentPolicy {
            authority: SourceAuthority::Aria2Official,
            repository: "aria2/aria2",
            max_size_bytes: 128 * MIB,
            eligibility: UpdateEligibility::BundledOnly,
            family: None,
        },
    }
}

pub(crate) const fn manifest_origin_policy() -> (&'static str, &'static str) {
    ("cacatools-controlled", "CacaPlay/clear-download-manager")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eligibility_is_code_owned_and_ffmpeg_is_a_set() {
        assert_eq!(
            component_policy(ToolId::YtDlp).eligibility,
            UpdateEligibility::UpdateEligible
        );
        assert_eq!(
            component_policy(ToolId::Deno).eligibility,
            UpdateEligibility::ConditionalCompatibilitySet
        );
        assert_eq!(
            component_policy(ToolId::Ffmpeg).eligibility,
            UpdateEligibility::AppReleaseManaged
        );
        assert_eq!(
            component_policy(ToolId::Ffprobe).family,
            Some(ToolchainFamily::FfmpegSet)
        );
        assert_eq!(
            component_policy(ToolId::Aria2c).eligibility,
            UpdateEligibility::BundledOnly
        );
        assert_eq!(TOOLS_OVERLAY_STORE_POLICY, "UNVERIFIED");
    }
}
