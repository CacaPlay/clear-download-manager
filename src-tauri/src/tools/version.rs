use crate::app::runtime::ToolId;
use semver::Version;
use std::{cmp::Ordering, fmt};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VersionError {
    pub(crate) tool: ToolId,
    pub(crate) value: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VersionRelation {
    Newer,
    Equal,
    Older,
}

impl fmt::Display for VersionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid {} version: {}",
            self.tool.base_name(),
            self.value
        )
    }
}

impl std::error::Error for VersionError {}

pub(crate) fn compare_component_versions(
    id: ToolId,
    active: &str,
    candidate: &str,
) -> Result<Ordering, VersionError> {
    match id {
        ToolId::YtDlp => compare_yt_dlp(active, candidate),
        ToolId::Deno => compare_semver(id, active, candidate),
        ToolId::Ffmpeg | ToolId::Ffprobe | ToolId::Aria2c => compare_numeric(id, active, candidate),
    }
}

pub(crate) fn classify_component_version(
    id: ToolId,
    active: &str,
    candidate: &str,
) -> Result<VersionRelation, VersionError> {
    match compare_component_versions(id, active, candidate)? {
        Ordering::Less => Ok(VersionRelation::Newer),
        Ordering::Equal => Ok(VersionRelation::Equal),
        Ordering::Greater => Ok(VersionRelation::Older),
    }
}

fn compare_yt_dlp(active: &str, candidate: &str) -> Result<Ordering, VersionError> {
    Ok(parse_yt_dlp(active)?.cmp(&parse_yt_dlp(candidate)?))
}

fn parse_yt_dlp(value: &str) -> Result<(u32, u32, u32), VersionError> {
    let invalid = || VersionError {
        tool: ToolId::YtDlp,
        value: value.to_string(),
    };
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(invalid());
    }
    let year = parts[0].parse::<u32>().map_err(|_| invalid())?;
    let month = parts[1].parse::<u32>().map_err(|_| invalid())?;
    let day = parts[2].parse::<u32>().map_err(|_| invalid())?;
    if !(2000..=9999).contains(&year) || !(1..=12).contains(&month) {
        return Err(invalid());
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return Err(invalid());
    }
    Ok((year, month, day))
}

fn compare_semver(id: ToolId, active: &str, candidate: &str) -> Result<Ordering, VersionError> {
    let active = Version::parse(active).map_err(|_| VersionError {
        tool: id,
        value: active.to_string(),
    })?;
    let candidate = Version::parse(candidate).map_err(|_| VersionError {
        tool: id,
        value: candidate.to_string(),
    })?;
    Ok(active.cmp(&candidate))
}

fn compare_numeric(id: ToolId, active: &str, candidate: &str) -> Result<Ordering, VersionError> {
    let active = parse_numeric(id, active)?;
    let candidate = parse_numeric(id, candidate)?;
    Ok(compare_numeric_parts(&active, &candidate))
}

fn parse_numeric(id: ToolId, value: &str) -> Result<Vec<u64>, VersionError> {
    if value.is_empty() {
        return Err(VersionError {
            tool: id,
            value: value.to_string(),
        });
    }
    value
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(VersionError {
                    tool: id,
                    value: value.to_string(),
                });
            }
            part.parse::<u64>().map_err(|_| VersionError {
                tool: id,
                value: value.to_string(),
            })
        })
        .collect()
}

fn compare_numeric_parts(active: &[u64], candidate: &[u64]) -> Ordering {
    let width = active.len().max(candidate.len());
    (0..width)
        .map(|index| {
            (
                active.get(index).copied().unwrap_or(0),
                candidate.get(index).copied().unwrap_or(0),
            )
        })
        .find_map(|(left, right)| (left != right).then_some(left.cmp(&right)))
        .unwrap_or(Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yt_dlp_date_versions_compare_newer_equal_and_older() {
        assert_eq!(
            compare_component_versions(ToolId::YtDlp, "2026.08.19", "2026.09.01"),
            Ok(Ordering::Less)
        );
        assert_eq!(
            compare_component_versions(ToolId::YtDlp, "2026.08.19", "2026.08.19"),
            Ok(Ordering::Equal)
        );
        assert_eq!(
            compare_component_versions(ToolId::YtDlp, "2026.08.19", "2026.07.01"),
            Ok(Ordering::Greater)
        );
    }

    #[test]
    fn invalid_and_prerelease_semver_are_rejected_or_ordered() {
        assert!(compare_component_versions(ToolId::YtDlp, "2026.08.19", "latest").is_err());
        assert_eq!(
            compare_component_versions(ToolId::Deno, "2.9.5-alpha.1", "2.9.5"),
            Ok(Ordering::Less)
        );
        assert!(compare_component_versions(ToolId::Deno, "2.9", "2.9.5").is_err());
    }

    #[test]
    fn numeric_upstream_versions_compare_without_string_ordering() {
        assert_eq!(
            compare_component_versions(ToolId::Ffmpeg, "8.9.0", "8.10.0"),
            Ok(Ordering::Less)
        );
        assert_eq!(
            compare_component_versions(ToolId::Aria2c, "1.37", "1.37.0"),
            Ok(Ordering::Equal)
        );
        assert!(compare_component_versions(ToolId::Ffprobe, "8.1.2", "8.1.x").is_err());
        assert_eq!(
            classify_component_version(ToolId::YtDlp, "2026.08.19", "2026.07.01"),
            Ok(VersionRelation::Older)
        );
    }
}
