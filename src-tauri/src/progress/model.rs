use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TotalKind {
    Exact,
    Estimated,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProgressKind {
    Exact,
    Estimated,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpeedKind {
    Reported,
    Derived,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EtaKind {
    Reported,
    Estimated,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobPhase {
    Queued,
    Preparing,
    Downloading,
    PostProcessing,
    Finalizing,
    Paused,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

impl JobPhase {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub(crate) fn is_active(self) -> bool {
        !matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProcessingStage {
    Merging,
    Remuxing,
    Converting,
    ExtractingAudio,
    Tagging,
    EmbeddingMetadata,
    EmbeddingArtwork,
    Probing,
    Verifying,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamKind {
    Video,
    Audio,
    Combined,
    File,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamPhase {
    Pending,
    Preparing,
    Downloading,
    Completed,
    Paused,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaylistPhase {
    Queued,
    Preparing,
    Downloading,
    PostProcessing,
    Paused,
    Completed,
    PartialFailure,
    Failed,
    Cancelling,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContractError {
    TotalKindRequiresMatchingTotal,
    ProgressKindRequiresProgress,
    ProgressOutOfRange,
    SpeedInvalid,
    CompletedSnapshotRequiresFinalSize,
    NonCompletedSnapshotCannotHaveFinalSize,
    PhaseProgressKindRequiresProgress,
    PhaseProgressOutOfRange,
    ProcessingSpeedInvalid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferProgress {
    pub(crate) downloaded_bytes: u64,
    #[serde(rename = "transferTotal")]
    pub(crate) total_bytes: Option<u64>,
    pub(crate) total_kind: TotalKind,
    pub(crate) reported_percent: Option<f64>,
    pub(crate) progress: Option<f64>,
    pub(crate) progress_kind: ProgressKind,
    pub(crate) speed_bps: Option<f64>,
    pub(crate) speed_kind: SpeedKind,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) eta_kind: EtaKind,
}

impl Default for TransferProgress {
    fn default() -> Self {
        Self {
            downloaded_bytes: 0,
            total_bytes: None,
            total_kind: TotalKind::Unknown,
            reported_percent: None,
            progress: None,
            progress_kind: ProgressKind::Unavailable,
            speed_bps: None,
            speed_kind: SpeedKind::Unavailable,
            eta_seconds: None,
            eta_kind: EtaKind::Unavailable,
        }
    }
}

impl TransferProgress {
    pub(crate) fn unknown(downloaded_bytes: u64) -> Self {
        Self {
            downloaded_bytes,
            ..Self::default()
        }
    }

    pub(crate) fn with_total(
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        total_kind: TotalKind,
    ) -> Self {
        let progress = total_bytes.map(|total| fraction(downloaded_bytes, total));
        let progress_kind = match total_kind {
            TotalKind::Exact => ProgressKind::Exact,
            TotalKind::Estimated => ProgressKind::Estimated,
            TotalKind::Unknown => ProgressKind::Unavailable,
        };
        Self {
            downloaded_bytes,
            total_bytes,
            total_kind,
            progress,
            progress_kind,
            ..Self::default()
        }
    }

    pub(crate) fn with_reported_percent(downloaded_bytes: u64, percent: f64) -> Self {
        let progress = Some(normalize_fraction(percent / 100.0));
        Self {
            downloaded_bytes,
            reported_percent: Some(normalize_fraction(percent / 100.0)),
            progress,
            progress_kind: ProgressKind::Estimated,
            ..Self::default()
        }
    }

    pub(crate) fn with_speed(mut self, speed_bps: f64, speed_kind: SpeedKind) -> Self {
        self.speed_bps = Some(speed_bps.max(0.0));
        self.speed_kind = speed_kind;
        self
    }

    pub(crate) fn with_eta(mut self, eta_seconds: u64, eta_kind: EtaKind) -> Self {
        self.eta_seconds = Some(eta_seconds);
        self.eta_kind = eta_kind;
        self
    }

    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        match self.total_kind {
            TotalKind::Unknown if self.total_bytes.is_some() => {
                return Err(ContractError::TotalKindRequiresMatchingTotal)
            }
            TotalKind::Exact | TotalKind::Estimated if self.total_bytes.is_none() => {
                return Err(ContractError::TotalKindRequiresMatchingTotal)
            }
            _ => {}
        }
        if let Some(value) = self.progress {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(ContractError::ProgressOutOfRange);
            }
        }
        if let Some(value) = self.reported_percent {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(ContractError::ProgressOutOfRange);
            }
        }
        if matches!(self.progress_kind, ProgressKind::Unavailable) && self.progress.is_some() {
            return Err(ContractError::ProgressKindRequiresProgress);
        }
        if !matches!(self.progress_kind, ProgressKind::Unavailable) && self.progress.is_none() {
            return Err(ContractError::ProgressKindRequiresProgress);
        }
        if let Some(value) = self.speed_bps {
            if !value.is_finite() || value < 0.0 {
                return Err(ContractError::SpeedInvalid);
            }
        }
        Ok(())
    }
}

fn normalize_fraction(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

pub(crate) fn fraction(downloaded: u64, total: u64) -> f64 {
    if total == 0 {
        return if downloaded == 0 { 0.0 } else { 1.0 };
    }
    normalize_fraction(downloaded as f64 / total as f64)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamProgress {
    pub(crate) id: String,
    pub(crate) kind: StreamKind,
    pub(crate) format_id: Option<String>,
    pub(crate) state: StreamPhase,
    #[serde(flatten)]
    pub(crate) transfer: TransferProgress,
}

impl StreamProgress {
    pub(crate) fn new(
        id: impl Into<String>,
        kind: StreamKind,
        format_id: Option<String>,
        state: StreamPhase,
        transfer: TransferProgress,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            format_id,
            state,
            transfer,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistItemProgress {
    pub(crate) id: String,
    pub(crate) job_id: u64,
    pub(crate) source_id: String,
    pub(crate) position: usize,
    pub(crate) title: String,
    pub(crate) state: JobPhase,
    pub(crate) transfer: TransferProgress,
    pub(crate) final_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) child_snapshot: Option<Box<ProgressSnapshotV2>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistProgress {
    pub(crate) batch_id: u64,
    pub(crate) total_items: usize,
    pub(crate) queued: usize,
    pub(crate) preparing: usize,
    pub(crate) downloading: usize,
    pub(crate) processing: usize,
    pub(crate) paused: usize,
    pub(crate) completed: usize,
    pub(crate) failed: usize,
    pub(crate) cancelling: usize,
    pub(crate) cancelled: usize,
    pub(crate) state: PlaylistPhase,
    pub(crate) current_item: Option<String>,
    pub(crate) current_position: Option<usize>,
    pub(crate) current_items: Vec<String>,
    pub(crate) current_positions: Vec<usize>,
    #[serde(flatten)]
    pub(crate) transfer: TransferProgress,
    pub(crate) final_size: Option<u64>,
    pub(crate) items: Vec<PlaylistItemProgress>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressSnapshotV2 {
    pub(crate) schema_version: u16,
    pub(crate) job_id: u64,
    pub(crate) attempt: u32,
    pub(crate) phase: JobPhase,
    pub(crate) stage: Option<ProcessingStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase_progress: Option<f64>,
    pub(crate) phase_progress_kind: ProgressKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase_eta_seconds: Option<u64>,
    pub(crate) phase_eta_kind: EtaKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) processing_speed_ratio: Option<f64>,
    #[serde(flatten)]
    pub(crate) transfer: TransferProgress,
    pub(crate) final_size: Option<u64>,
    pub(crate) streams: Vec<StreamProgress>,
    pub(crate) playlist: Option<PlaylistProgress>,
}

impl ProgressSnapshotV2 {
    pub(crate) fn new(job_id: u64, phase: JobPhase, transfer: TransferProgress) -> Self {
        Self {
            schema_version: 2,
            job_id,
            attempt: 0,
            phase,
            stage: None,
            phase_progress: None,
            phase_progress_kind: ProgressKind::Unavailable,
            phase_eta_seconds: None,
            phase_eta_kind: EtaKind::Unavailable,
            processing_speed_ratio: None,
            transfer,
            final_size: None,
            streams: Vec::new(),
            playlist: None,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        self.transfer.validate()?;
        if let Some(value) = self.phase_progress {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(ContractError::PhaseProgressOutOfRange);
            }
        }
        if matches!(self.phase_progress_kind, ProgressKind::Unavailable)
            && self.phase_progress.is_some()
        {
            return Err(ContractError::PhaseProgressKindRequiresProgress);
        }
        if !matches!(self.phase_progress_kind, ProgressKind::Unavailable)
            && self.phase_progress.is_none()
        {
            return Err(ContractError::PhaseProgressKindRequiresProgress);
        }
        if let Some(value) = self.processing_speed_ratio {
            if !value.is_finite() || value < 0.0 {
                return Err(ContractError::ProcessingSpeedInvalid);
            }
        }
        if self.phase == JobPhase::Completed && self.final_size.is_none() {
            return Err(ContractError::CompletedSnapshotRequiresFinalSize);
        }
        if self.phase != JobPhase::Completed && self.final_size.is_some() {
            return Err(ContractError::NonCompletedSnapshotCannotHaveFinalSize);
        }
        Ok(())
    }
}
