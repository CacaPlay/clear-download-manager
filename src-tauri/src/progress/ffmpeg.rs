use super::model::{EtaKind, ProcessingStage, ProgressKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FfmpegProgressStatus {
    Continue,
    End,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FfmpegProgressInput {
    pub(crate) frame: Option<u64>,
    pub(crate) fps: Option<f64>,
    pub(crate) total_size: Option<u64>,
    pub(crate) out_time_seconds: Option<f64>,
    pub(crate) speed_ratio: Option<f64>,
    pub(crate) status: Option<FfmpegProgressStatus>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FfmpegProgressObservation {
    pub(crate) stage: ProcessingStage,
    pub(crate) progress: Option<f64>,
    pub(crate) progress_kind: ProgressKind,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) eta_kind: EtaKind,
    pub(crate) processing_speed_ratio: Option<f64>,
    pub(crate) status: Option<FfmpegProgressStatus>,
}

#[derive(Debug)]
pub(crate) struct FfmpegProgressAdapterV2 {
    stage: ProcessingStage,
    duration_seconds: Option<f64>,
    current: FfmpegProgressInput,
    smoothed_speed_ratio: Option<f64>,
    last_progress: Option<f64>,
}

impl FfmpegProgressAdapterV2 {
    pub(crate) fn new(stage: ProcessingStage, duration_seconds: Option<f64>) -> Self {
        Self {
            stage,
            duration_seconds: clean_duration(duration_seconds),
            current: FfmpegProgressInput::default(),
            smoothed_speed_ratio: None,
            last_progress: None,
        }
    }

    pub(crate) fn set_stage(&mut self, stage: ProcessingStage) {
        if self.stage != stage {
            self.stage = stage;
            self.current = FfmpegProgressInput::default();
            self.smoothed_speed_ratio = None;
            self.last_progress = None;
        }
    }

    pub(crate) fn accept_line(&mut self, line: &str) -> Option<FfmpegProgressObservation> {
        let (key, value) = line.split_once('=')?;
        self.apply_field(key.trim(), value.trim());
        if key.trim() != "progress" {
            return None;
        }
        Some(self.observation())
    }

    pub(crate) fn observation(&self) -> FfmpegProgressObservation {
        let ended = self.current.status == Some(FfmpegProgressStatus::End);
        let raw_progress = if ended {
            Some(1.0)
        } else {
            self.duration_seconds
                .zip(self.current.out_time_seconds)
                .filter(|(duration, out_time)| *duration > 0.0 && *out_time >= 0.0)
                .map(|(duration, out_time)| (out_time / duration).clamp(0.0, 1.0))
        };
        let progress = raw_progress.map(|value| {
            self.last_progress
                .map_or(value, |previous| previous.max(value))
        });
        let eta_seconds = self
            .duration_seconds
            .zip(self.current.out_time_seconds)
            .zip(self.smoothed_speed_ratio)
            .filter(|((duration, out_time), speed)| {
                *duration > *out_time && *speed > 0.0 && speed.is_finite()
            })
            .map(|((duration, out_time), speed)| {
                ((duration - out_time) / speed).ceil().max(0.0) as u64
            });
        FfmpegProgressObservation {
            stage: self.stage,
            progress,
            progress_kind: progress.map_or(ProgressKind::Unavailable, |_| ProgressKind::Estimated),
            eta_seconds,
            eta_kind: eta_seconds.map_or(EtaKind::Unavailable, |_| EtaKind::Estimated),
            processing_speed_ratio: self
                .smoothed_speed_ratio
                .filter(|value| value.is_finite() && *value >= 0.0),
            status: self.current.status,
        }
    }

    fn apply_field(&mut self, key: &str, value: &str) {
        match key {
            "frame" => self.current.frame = parse_u64(value),
            "fps" => self.current.fps = parse_f64(value),
            "total_size" => self.current.total_size = parse_u64(value),
            "out_time_us" => {
                self.current.out_time_seconds = parse_f64(value).map(|v| v / 1_000_000.0)
            }
            // FFmpeg names this field `out_time_ms`, but the progress protocol
            // reports it in AV_TIME_BASE units on the distributed builds (the
            // same microsecond scale as `out_time_us`).
            "out_time_ms" => {
                self.current.out_time_seconds = parse_f64(value).map(|v| v / 1_000_000.0)
            }
            "out_time" => self.current.out_time_seconds = parse_timestamp(value),
            "speed" => {
                self.current.speed_ratio = parse_speed(value);
                if let Some(speed) = self.current.speed_ratio {
                    self.smoothed_speed_ratio = Some(match self.smoothed_speed_ratio {
                        Some(previous) => previous * 0.65 + speed * 0.35,
                        None => speed,
                    });
                }
            }
            "progress" => {
                self.current.status = match value.to_ascii_lowercase().as_str() {
                    "continue" => Some(FfmpegProgressStatus::Continue),
                    "end" => Some(FfmpegProgressStatus::End),
                    _ => None,
                };
                if let Some(value) = self.observation().progress {
                    self.last_progress = Some(value);
                }
            }
            _ => {}
        }
    }
}

fn parse_u64(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok()
}

fn parse_f64(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn parse_speed(value: &str) -> Option<f64> {
    parse_f64(value.trim().trim_end_matches('x'))
}

fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.trim().split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    if parts.next().is_some()
        || !hours.is_finite()
        || !minutes.is_finite()
        || !seconds.is_finite()
        || hours < 0.0
        || !(0.0..60.0).contains(&minutes)
        || !(0.0..60.0).contains(&seconds)
    {
        return None;
    }
    Some(hours * 3_600.0 + minutes * 60.0 + seconds)
}

fn clean_duration(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

pub(crate) fn processing_stage_from_ytdlp_line(line: &str) -> Option<ProcessingStage> {
    if line.contains("[Merger]") {
        Some(ProcessingStage::Merging)
    } else if line.contains("[ExtractAudio]") {
        Some(ProcessingStage::ExtractingAudio)
    } else if line.contains("[VideoConvertor]") {
        Some(ProcessingStage::Converting)
    } else if line.contains("[Metadata]") || line.contains("[EmbedSubtitle]") {
        Some(ProcessingStage::EmbeddingMetadata)
    } else if line.contains("[Fixup") {
        Some(ProcessingStage::Verifying)
    } else {
        None
    }
}

pub(crate) fn processing_stage_from_state(state: &str) -> Option<ProcessingStage> {
    match state.trim().to_ascii_lowercase().as_str() {
        "merging" => Some(ProcessingStage::Merging),
        "remuxing" => Some(ProcessingStage::Remuxing),
        "converting" => Some(ProcessingStage::Converting),
        "extracting_audio" => Some(ProcessingStage::ExtractingAudio),
        "tagging" => Some(ProcessingStage::Tagging),
        "embedding_metadata" => Some(ProcessingStage::EmbeddingMetadata),
        "embedding_artwork" => Some(ProcessingStage::EmbeddingArtwork),
        "probing" => Some(ProcessingStage::Probing),
        "validating" | "processing" => Some(ProcessingStage::Verifying),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_progress_and_estimates_timeline() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Merging, Some(100.0));
        assert!(adapter.accept_line("out_time_us=50000000").is_none());
        adapter.accept_line("speed=2.0x");
        let observation = adapter.accept_line("progress=continue").expect("progress");
        assert_eq!(observation.progress, Some(0.5));
        assert_eq!(observation.progress_kind, ProgressKind::Estimated);
        assert_eq!(observation.eta_seconds, Some(25));
        assert_eq!(observation.eta_kind, EtaKind::Estimated);
        assert_eq!(observation.processing_speed_ratio, Some(2.0));
    }

    #[test]
    fn parses_timestamp_and_end_without_marking_completed() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Converting, Some(10.0));
        adapter.accept_line("out_time=00:00:04.500");
        let observation = adapter.accept_line("progress=end").expect("end");
        assert_eq!(observation.progress, Some(1.0));
        assert_eq!(observation.status, Some(FfmpegProgressStatus::End));
    }

    #[test]
    fn missing_duration_is_unavailable_and_does_not_invent_eta() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Tagging, None);
        adapter.accept_line("out_time_ms=5000");
        adapter.accept_line("speed=3.0x");
        let observation = adapter.accept_line("progress=continue").expect("progress");
        assert_eq!(observation.progress, None);
        assert_eq!(observation.progress_kind, ProgressKind::Unavailable);
        assert_eq!(observation.eta_seconds, None);
    }

    #[test]
    fn progress_is_monotonic_within_one_stage() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Remuxing, Some(100.0));
        adapter.accept_line("out_time=00:00:50.000");
        let first = adapter.accept_line("progress=continue").unwrap();
        adapter.accept_line("out_time=00:00:20.000");
        let second = adapter.accept_line("progress=continue").unwrap();
        assert_eq!(first.progress, Some(0.5));
        assert_eq!(second.progress, Some(0.5));
    }

    #[test]
    fn parses_ffmpeg_out_time_ms_using_the_protocol_timebase() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Merging, Some(1.0));
        adapter.accept_line("out_time_ms=200000");
        let observation = adapter.accept_line("progress=continue").unwrap();
        assert_eq!(observation.progress, Some(0.2));
    }

    #[test]
    fn smooths_processing_speed_without_touching_transfer_speed() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Converting, Some(10.0));
        adapter.accept_line("speed=2.0x");
        let first = adapter.accept_line("progress=continue").unwrap();
        assert_eq!(first.processing_speed_ratio, Some(2.0));
        adapter.accept_line("speed=10.0x");
        let second = adapter.accept_line("progress=continue").unwrap();
        assert_eq!(second.processing_speed_ratio, Some(4.8));
    }

    #[test]
    fn changing_stage_discards_the_previous_timeline() {
        let mut adapter = FfmpegProgressAdapterV2::new(ProcessingStage::Merging, Some(100.0));
        adapter.accept_line("out_time_us=80000000");
        assert_eq!(
            adapter.accept_line("progress=continue").unwrap().progress,
            Some(0.8)
        );
        adapter.set_stage(ProcessingStage::Tagging);
        assert_eq!(
            adapter.accept_line("progress=continue").unwrap().progress,
            None
        );
    }

    #[test]
    fn maps_existing_ytdlp_markers_without_localized_ffmpeg_text() {
        assert_eq!(
            processing_stage_from_ytdlp_line("[Merger] Merging formats into output"),
            Some(ProcessingStage::Merging)
        );
        assert_eq!(
            processing_stage_from_ytdlp_line("[ExtractAudio] Destination"),
            Some(ProcessingStage::ExtractingAudio)
        );
        assert_eq!(
            processing_stage_from_state("validating"),
            Some(ProcessingStage::Verifying)
        );
    }
}
