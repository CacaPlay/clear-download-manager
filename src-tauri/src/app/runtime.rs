use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::background_command;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum ToolId {
    YtDlp,
    Ffmpeg,
    Ffprobe,
    Deno,
    Aria2c,
}

impl ToolId {
    pub(crate) fn base_name(self) -> &'static str {
        match self {
            Self::YtDlp => "yt-dlp",
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::Deno => "deno",
            Self::Aria2c => "aria2c",
        }
    }

    pub(crate) fn env_name(self) -> &'static str {
        match self {
            Self::YtDlp => "CACATOOLS_YTDLP",
            Self::Ffmpeg => "CACATOOLS_FFMPEG",
            Self::Ffprobe => "CACATOOLS_FFPROBE",
            Self::Deno => "CACATOOLS_DENO",
            Self::Aria2c => "CACATOOLS_ARIA2C",
        }
    }

    pub(crate) fn component_group(self) -> Option<&'static str> {
        match self {
            Self::Ffmpeg | Self::Ffprobe => Some("FFMPEG_SET"),
            _ => None,
        }
    }

    fn version_arguments(self) -> &'static [&'static str] {
        match self {
            Self::Deno => &["--version"],
            Self::YtDlp | Self::Ffmpeg | Self::Ffprobe | Self::Aria2c => &["--version", "-version"],
        }
    }

    pub(crate) fn executable_name(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.base_name())
        } else {
            self.base_name().to_string()
        }
    }

    /// Filename declared by the current Windows runtime catalog.
    pub(crate) const fn artifact_filename(self) -> &'static str {
        match self {
            Self::YtDlp => "yt-dlp.exe",
            Self::Ffmpeg => "ffmpeg.exe",
            Self::Ffprobe => "ffprobe.exe",
            Self::Deno => "deno.exe",
            Self::Aria2c => "aria2c.exe",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolSource {
    EnvOverride,
    VerifiedOverlay,
    Bundled,
    Path,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeMode {
    Production,
    DevelopmentQa,
}

fn current_runtime_mode() -> RuntimeMode {
    if cfg!(debug_assertions) {
        RuntimeMode::DevelopmentQa
    } else {
        RuntimeMode::Production
    }
}

impl ToolSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::EnvOverride => "ENV_OVERRIDE",
            Self::VerifiedOverlay => "VERIFIED_OVERLAY",
            Self::Bundled => "BUNDLED",
            Self::Path => "PATH",
            Self::Unavailable => "UNAVAILABLE",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolResolution {
    pub(crate) id: ToolId,
    pub(crate) path: Option<PathBuf>,
    pub(crate) source: ToolSource,
    pub(crate) version: Option<String>,
    pub(crate) sha256: Option<String>,
}

impl ToolResolution {
    fn unavailable(id: ToolId) -> Self {
        Self {
            id,
            path: None,
            source: ToolSource::Unavailable,
            version: None,
            sha256: None,
        }
    }

    pub(crate) fn is_available(&self) -> bool {
        self.path.is_some()
    }
}

#[derive(Clone, Copy)]
struct CandidateCheck {
    require_file: bool,
    probe: bool,
}

#[derive(Clone)]
struct Candidate {
    source: ToolSource,
    path: PathBuf,
    check: CandidateCheck,
}

#[derive(Clone)]
pub(crate) struct MediaRuntimePaths {
    pub(crate) yt_dlp: PathBuf,
    pub(crate) ffmpeg_dir: PathBuf,
}

#[derive(Serialize)]
pub(crate) struct MediaRuntimeSnapshot {
    pub(crate) available: bool,
    pub(crate) yt_dlp: bool,
    pub(crate) yt_dlp_version: String,
    pub(crate) ffmpeg: bool,
    pub(crate) ffmpeg_version: String,
    pub(crate) ffprobe: bool,
    pub(crate) ffprobe_version: String,
    pub(crate) detail: String,
}

pub(crate) fn runtime_candidates(app: &AppHandle, binary_name: &str) -> Vec<PathBuf> {
    runtime_candidates_for(Some(app), binary_name)
}

fn runtime_candidates_for(app: Option<&AppHandle>, binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("resources").join("bin").join(binary_name));
            candidates.push(resource_dir.join("bin").join(binary_name));
            candidates.push(resource_dir.join(binary_name));
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("resources").join("bin").join(binary_name));
            candidates.push(parent.join("bin").join(binary_name));
            candidates.push(parent.join(binary_name));
        }
    }
    candidates
}

fn probe_with_arguments(path: &Path, arguments: &[&str]) -> bool {
    arguments.iter().any(|argument| {
        background_command(path)
            .arg(argument)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    })
}

fn resolve_candidates(
    id: ToolId,
    candidates: impl IntoIterator<Item = Candidate>,
    version_arguments: &[&str],
) -> ToolResolution {
    resolve_candidates_with_probe(id, candidates, version_arguments, probe_with_arguments)
}

fn resolve_candidates_with_probe(
    id: ToolId,
    candidates: impl IntoIterator<Item = Candidate>,
    version_arguments: &[&str],
    probe: impl Fn(&Path, &[&str]) -> bool,
) -> ToolResolution {
    for candidate in candidates {
        if candidate.check.require_file && !candidate.path.is_file() {
            continue;
        }
        if candidate.check.probe && !probe(&candidate.path, version_arguments) {
            continue;
        }
        return ToolResolution {
            id,
            path: Some(candidate.path),
            source: candidate.source,
            version: None,
            sha256: None,
        };
    }
    ToolResolution::unavailable(id)
}

fn absolute_environment_override(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name)?);
    path.is_absolute().then_some(path)
}

fn valid_development_override(id: ToolId) -> Option<PathBuf> {
    let path = absolute_environment_override(id.env_name())?;
    validate_development_override_path(id, &path)
}

fn validate_development_override_path(id: ToolId, path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || runtime_has_reparse_point(&metadata)
    {
        return None;
    }
    let expected = id.executable_name();
    let actual = path.file_name()?.to_str()?;
    actual
        .eq_ignore_ascii_case(&expected)
        .then_some(path.to_path_buf())
}

#[cfg(windows)]
fn runtime_has_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn runtime_has_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn development_path_candidate(id: ToolId) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    development_path_candidate_from_paths(id, std::env::split_paths(&path))
}

fn development_path_candidate_from_paths(
    id: ToolId,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    paths
        .into_iter()
        .map(|directory| directory.join(id.executable_name()))
        .find_map(|path| validate_development_override_path(id, &path))
}

fn standard_candidates(app: Option<&AppHandle>, id: ToolId, mode: RuntimeMode) -> Vec<Candidate> {
    let binary_name = id.executable_name();
    let mut candidates = Vec::new();
    candidates.extend(
        runtime_candidates_for(app, &binary_name)
            .into_iter()
            .map(|path| Candidate {
                source: ToolSource::Bundled,
                path,
                check: CandidateCheck {
                    require_file: true,
                    probe: false,
                },
            }),
    );
    if mode == RuntimeMode::DevelopmentQa {
        if let Some(path) = development_path_candidate(id) {
            candidates.push(Candidate {
                source: ToolSource::Path,
                path,
                check: CandidateCheck {
                    require_file: true,
                    probe: true,
                },
            });
        }
    }
    candidates
}

fn resolve_standard_tool(
    app: Option<&AppHandle>,
    id: ToolId,
    version_arguments: &[&str],
    mode: RuntimeMode,
) -> ToolResolution {
    if mode == RuntimeMode::DevelopmentQa {
        if let Some(path) = valid_development_override(id) {
            let resolution = resolve_candidates(
                id,
                [Candidate {
                    source: ToolSource::EnvOverride,
                    path,
                    check: CandidateCheck {
                        require_file: true,
                        probe: true,
                    },
                }],
                version_arguments,
            );
            if resolution.is_available() {
                return resolution;
            }
        }
    }
    // yt-dlp is the only component with a verified, versioned per-user
    // overlay. Other tools use the same bundled/dev-PATH policy without it.
    if id == ToolId::YtDlp {
        if let Some(app) = app {
            if let Some(overlay) = crate::tools::overlay::resolve_verified_overlay(app) {
                return ToolResolution {
                    id,
                    path: Some(overlay.path),
                    source: ToolSource::VerifiedOverlay,
                    version: Some(overlay.version),
                    sha256: Some(overlay.sha256),
                };
            }
        }
    }
    resolve_candidates(id, standard_candidates(app, id, mode), version_arguments)
}

pub(crate) fn resolve_bundled_tool(app: &AppHandle, id: ToolId) -> ToolResolution {
    resolve_candidates(
        id,
        runtime_candidates_for(Some(app), &id.executable_name())
            .into_iter()
            .map(|path| Candidate {
                source: ToolSource::Bundled,
                path,
                check: CandidateCheck {
                    require_file: true,
                    probe: false,
                },
            }),
        id.version_arguments(),
    )
}

fn resolve_deno_tool(version_arguments: &[&str], mode: RuntimeMode) -> ToolResolution {
    let binary_name = ToolId::Deno.executable_name();
    let mut candidates = Vec::new();
    if mode == RuntimeMode::DevelopmentQa {
        if let Some(path) = valid_development_override(ToolId::Deno) {
            candidates.push(Candidate {
                source: ToolSource::EnvOverride,
                path,
                check: CandidateCheck {
                    require_file: true,
                    probe: true,
                },
            });
        }
    }
    if mode == RuntimeMode::Production {
        candidates.extend(
            runtime_candidates_for(None, &binary_name)
                .into_iter()
                .map(|path| Candidate {
                    source: ToolSource::Bundled,
                    path,
                    check: CandidateCheck {
                        require_file: true,
                        probe: true,
                    },
                }),
        );
        return resolve_candidates(ToolId::Deno, candidates, version_arguments);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            for path in [
                parent.join("resources").join("bin").join(&binary_name),
                parent.join("bin").join(&binary_name),
                parent.join(&binary_name),
            ] {
                candidates.push(Candidate {
                    source: ToolSource::Bundled,
                    path,
                    check: CandidateCheck {
                        require_file: false,
                        probe: true,
                    },
                });
            }
            if let Some(grandparent) = parent.parent() {
                candidates.push(Candidate {
                    source: ToolSource::Bundled,
                    path: grandparent.join("resources").join("bin").join(&binary_name),
                    check: CandidateCheck {
                        require_file: false,
                        probe: true,
                    },
                });
                if let Some(source_root) = grandparent.parent() {
                    candidates.push(Candidate {
                        source: ToolSource::Bundled,
                        path: source_root.join("resources").join("bin").join(&binary_name),
                        check: CandidateCheck {
                            require_file: false,
                            probe: true,
                        },
                    });
                }
            }
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(Candidate {
            source: ToolSource::Bundled,
            path: current_dir.join("resources").join("bin").join(&binary_name),
            check: CandidateCheck {
                require_file: false,
                probe: true,
            },
        });
        candidates.push(Candidate {
            source: ToolSource::Bundled,
            path: current_dir
                .join("src-tauri")
                .join("resources")
                .join("bin")
                .join(&binary_name),
            check: CandidateCheck {
                require_file: false,
                probe: true,
            },
        });
    }
    if let Some(path) = development_path_candidate(ToolId::Deno) {
        candidates.push(Candidate {
            source: ToolSource::Path,
            path,
            check: CandidateCheck {
                require_file: true,
                probe: true,
            },
        });
    }
    resolve_candidates(ToolId::Deno, candidates, version_arguments)
}

pub(crate) fn resolve_tool(app: Option<&AppHandle>, id: ToolId) -> ToolResolution {
    resolve_tool_with_mode(app, id, id.version_arguments(), current_runtime_mode())
}

pub(crate) fn resolve_tool_with_arguments(
    app: Option<&AppHandle>,
    id: ToolId,
    version_arguments: &[&str],
) -> ToolResolution {
    resolve_tool_with_mode(app, id, version_arguments, current_runtime_mode())
}

pub(crate) fn resolve_tool_with_mode(
    app: Option<&AppHandle>,
    id: ToolId,
    version_arguments: &[&str],
    mode: RuntimeMode,
) -> ToolResolution {
    if id == ToolId::Deno {
        return resolve_deno_tool(version_arguments, mode);
    }
    resolve_standard_tool(app, id, version_arguments, mode)
}

pub(crate) fn find_runtime_binary(
    app: &AppHandle,
    base_name: &str,
    env_name: &str,
) -> Option<PathBuf> {
    let known = match (base_name, env_name) {
        ("yt-dlp", "CACATOOLS_YTDLP") => Some(ToolId::YtDlp),
        ("ffmpeg", "CACATOOLS_FFMPEG") => Some(ToolId::Ffmpeg),
        ("ffprobe", "CACATOOLS_FFPROBE") => Some(ToolId::Ffprobe),
        ("deno", "CACATOOLS_DENO") => Some(ToolId::Deno),
        ("aria2c", "CACATOOLS_ARIA2C") => Some(ToolId::Aria2c),
        _ => None,
    };
    known.and_then(|id| resolve_tool(Some(app), id).path)
}

pub(crate) fn discover_media_runtime(app: &AppHandle) -> Option<MediaRuntimePaths> {
    let yt_dlp = find_runtime_binary(app, "yt-dlp", "CACATOOLS_YTDLP")?;
    let ffmpeg = find_runtime_binary(app, "ffmpeg", "CACATOOLS_FFMPEG")?;
    let ffprobe = find_runtime_binary(app, "ffprobe", "CACATOOLS_FFPROBE")?;
    let ffmpeg_dir = ffmpeg.parent()?.to_path_buf();
    if ffprobe.parent()? != ffmpeg_dir {
        return None;
    }
    Some(MediaRuntimePaths { yt_dlp, ffmpeg_dir })
}

pub(crate) fn runtime_binary_version(path: &Path, argument: &str) -> String {
    let output = background_command(path).arg(argument).output();
    let Ok(output) = output else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("cacatools-runtime-{label}-{suffix}"));
        fs::create_dir_all(&path).expect("create resolver fixture directory");
        path
    }

    fn fixture_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"fixture").expect("create resolver fixture file");
        path
    }

    #[test]
    fn tool_ids_expose_stable_descriptors_and_ffmpeg_set_relationship() {
        assert_eq!(ToolId::YtDlp.base_name(), "yt-dlp");
        assert_eq!(ToolId::Deno.env_name(), "CACATOOLS_DENO");
        assert_eq!(
            ToolId::Aria2c.executable_name(),
            if cfg!(windows) {
                "aria2c.exe"
            } else {
                "aria2c"
            }
        );
        assert_eq!(ToolId::Aria2c.artifact_filename(), "aria2c.exe");
        assert_eq!(ToolId::Ffmpeg.component_group(), Some("FFMPEG_SET"));
        assert_eq!(ToolId::Ffprobe.component_group(), Some("FFMPEG_SET"));
        assert_eq!(ToolId::YtDlp.component_group(), None);
        assert_eq!(ToolSource::VerifiedOverlay.label(), "VERIFIED_OVERLAY");
    }

    #[test]
    fn artifact_names_are_windows_names_while_runtime_names_follow_host() {
        let cases = [
            (ToolId::YtDlp, "yt-dlp.exe", "yt-dlp"),
            (ToolId::Ffmpeg, "ffmpeg.exe", "ffmpeg"),
            (ToolId::Ffprobe, "ffprobe.exe", "ffprobe"),
            (ToolId::Aria2c, "aria2c.exe", "aria2c"),
            (ToolId::Deno, "deno.exe", "deno"),
        ];

        for (id, artifact_name, runtime_name) in cases {
            assert_eq!(id.artifact_filename(), artifact_name, "{id:?}");
            assert_eq!(
                id.executable_name(),
                if cfg!(windows) {
                    artifact_name
                } else {
                    runtime_name
                },
                "{id:?} runtime name"
            );
        }
    }

    #[test]
    fn production_does_not_add_path_or_environment_candidates() {
        for id in [
            ToolId::YtDlp,
            ToolId::Ffmpeg,
            ToolId::Ffprobe,
            ToolId::Aria2c,
        ] {
            let candidates = standard_candidates(None, id, RuntimeMode::Production);
            assert!(!candidates.iter().any(|candidate| matches!(
                candidate.source,
                ToolSource::EnvOverride | ToolSource::Path
            )));
        }
        let deno =
            resolve_tool_with_mode(None, ToolId::Deno, &["--version"], RuntimeMode::Production);
        assert_ne!(deno.source, ToolSource::Path);
    }

    #[test]
    fn development_candidates_keep_only_absolute_path_fallbacks() {
        let candidates = standard_candidates(None, ToolId::Ffmpeg, RuntimeMode::DevelopmentQa);
        assert!(candidates
            .iter()
            .filter(|candidate| candidate.source == ToolSource::Path)
            .all(|candidate| candidate.path.is_absolute()));
        let relative = PathBuf::from("ffmpeg.exe");
        assert_eq!(
            validate_development_override_path(ToolId::Ffmpeg, &relative),
            None
        );
        let directory = fixture_dir("override-directory");
        assert_eq!(
            validate_development_override_path(ToolId::Ffmpeg, &directory),
            None
        );
        let wrong_name = fixture_file(&directory, "not-ffmpeg.exe");
        assert_eq!(
            validate_development_override_path(ToolId::Ffmpeg, &wrong_name),
            None
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn development_path_lookup_returns_an_absolute_expected_binary() {
        let directory = fixture_dir("path-lookup");
        let expected = fixture_file(&directory, &ToolId::Ffmpeg.executable_name());
        let resolved = development_path_candidate_from_paths(ToolId::Ffmpeg, [directory]);
        assert_eq!(resolved, Some(expected.clone()));
        assert!(resolved.expect("absolute development path").is_absolute());
        let _ = fs::remove_file(expected);
    }

    #[test]
    fn authorized_development_override_resolves_only_for_expected_absolute_file() {
        let directory = fixture_dir("authorized-override");
        let override_path = fixture_file(&directory, &ToolId::Ffmpeg.executable_name());
        let validated = validate_development_override_path(ToolId::Ffmpeg, &override_path)
            .expect("expected executable identity should validate");
        let resolution = resolve_candidates_with_probe(
            ToolId::Ffmpeg,
            [Candidate {
                source: ToolSource::EnvOverride,
                path: validated.clone(),
                check: CandidateCheck {
                    require_file: true,
                    probe: true,
                },
            }],
            &["--version"],
            |path, _| path == validated,
        );
        assert_eq!(resolution.source, ToolSource::EnvOverride);
        assert_eq!(resolution.path, Some(validated));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn production_managed_tools_resolve_bundled_candidates() {
        let directory = fixture_dir("production-bundled");
        for id in [
            ToolId::Ffmpeg,
            ToolId::Ffprobe,
            ToolId::Deno,
            ToolId::Aria2c,
        ] {
            let bundled = fixture_file(&directory, &id.executable_name());
            let resolution = resolve_candidates_with_probe(
                id,
                [Candidate {
                    source: ToolSource::Bundled,
                    path: bundled.clone(),
                    check: CandidateCheck {
                        require_file: true,
                        probe: true,
                    },
                }],
                id.version_arguments(),
                |path, _| path == bundled,
            );
            assert_eq!(resolution.source, ToolSource::Bundled);
            assert_eq!(resolution.path, Some(bundled));
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn valid_environment_override_wins_over_bundled_candidate() {
        let dir = fixture_dir("env-wins");
        let override_path = fixture_file(&dir, "override.exe");
        let bundled_path = fixture_file(&dir, "bundled.exe");
        let resolution = resolve_candidates_with_probe(
            ToolId::YtDlp,
            [
                Candidate {
                    source: ToolSource::EnvOverride,
                    path: override_path.clone(),
                    check: CandidateCheck {
                        require_file: true,
                        probe: false,
                    },
                },
                Candidate {
                    source: ToolSource::Bundled,
                    path: bundled_path,
                    check: CandidateCheck {
                        require_file: true,
                        probe: false,
                    },
                },
            ],
            &["--version"],
            |_, _| true,
        );
        assert_eq!(resolution.id, ToolId::YtDlp);
        assert_eq!(resolution.source, ToolSource::EnvOverride);
        assert_eq!(resolution.path, Some(override_path.clone()));
        assert!(override_path.is_absolute());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn bundled_candidate_resolves_before_path_fallback() {
        let dir = fixture_dir("bundled");
        let bundled_path = fixture_file(&dir, "ffmpeg.exe");
        let resolution = resolve_candidates_with_probe(
            ToolId::Ffmpeg,
            [
                Candidate {
                    source: ToolSource::Bundled,
                    path: bundled_path.clone(),
                    check: CandidateCheck {
                        require_file: true,
                        probe: false,
                    },
                },
                Candidate {
                    source: ToolSource::Path,
                    path: PathBuf::from("ffmpeg.exe"),
                    check: CandidateCheck {
                        require_file: false,
                        probe: true,
                    },
                },
            ],
            &["--version", "-version"],
            |_, _| true,
        );
        assert_eq!(resolution.source, ToolSource::Bundled);
        assert_eq!(resolution.path, Some(bundled_path));
        assert!(resolution.is_available());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn path_fallback_is_probed_and_preserves_relative_command_path() {
        let resolution = resolve_candidates_with_probe(
            ToolId::Aria2c,
            [Candidate {
                source: ToolSource::Path,
                path: PathBuf::from("aria2c.exe"),
                check: CandidateCheck {
                    require_file: false,
                    probe: true,
                },
            }],
            &["--version", "-version"],
            |path, args| path == Path::new("aria2c.exe") && args == ["--version", "-version"],
        );
        assert_eq!(resolution.source, ToolSource::Path);
        assert_eq!(resolution.path, Some(PathBuf::from("aria2c.exe")));
    }

    #[test]
    fn unavailable_tool_has_explicit_source_and_no_path() {
        let dir = fixture_dir("missing");
        let resolution = resolve_candidates_with_probe(
            ToolId::Ffprobe,
            [Candidate {
                source: ToolSource::Bundled,
                path: dir.join("missing.exe"),
                check: CandidateCheck {
                    require_file: true,
                    probe: false,
                },
            }],
            &["--version", "-version"],
            |_, _| true,
        );
        assert_eq!(resolution.source, ToolSource::Unavailable);
        assert_eq!(resolution.path, None);
        assert!(!resolution.is_available());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn deno_candidate_requires_successful_version_probe() {
        let dir = fixture_dir("deno-probe");
        let deno_path = fixture_file(&dir, "deno.exe");
        let resolution = resolve_candidates_with_probe(
            ToolId::Deno,
            [Candidate {
                source: ToolSource::Bundled,
                path: deno_path,
                check: CandidateCheck {
                    require_file: false,
                    probe: true,
                },
            }],
            &["--version"],
            |_, args| args == ["--version"],
        );
        assert_eq!(resolution.source, ToolSource::Bundled);
        assert_eq!(resolution.id, ToolId::Deno);
        let _ = fs::remove_dir_all(dir);
    }
}
