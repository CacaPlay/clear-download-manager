use super::model::{
    fraction, EtaKind, JobPhase, PlaylistItemProgress, PlaylistPhase, PlaylistProgress,
    ProgressKind, SpeedKind, StreamPhase, StreamProgress, TotalKind, TransferProgress,
};

pub(crate) fn aggregate_streams(streams: &[StreamProgress]) -> TransferProgress {
    let transfers: Vec<TransferProgress> = streams
        .iter()
        .map(|stream| stream.transfer.clone())
        .collect();
    aggregate_transfers(&transfers)
}

/// Aggregates an adaptive transfer without treating a missing stream as an
/// instruction to discard the progress already reported by other streams.
///
/// `expected_streams` comes from the selected yt-dlp format expression.  When
/// all expected streams have exact totals, the result is exact.  If any
/// legitimate estimate participates, the result is estimated.  When a stream
/// has no denominator, the fallback is deliberately stage-based: completed
/// streams contribute 1, active streams contribute their own progress, and
/// pending streams contribute 0.  This is explicitly estimated and avoids a
/// misleading byte-weighted or 50/50 average without a valid weight.
pub(crate) fn aggregate_streams_with_expected(
    streams: &[StreamProgress],
    expected_streams: usize,
) -> TransferProgress {
    if streams.is_empty() {
        return TransferProgress::default();
    }

    let downloaded_bytes = streams
        .iter()
        .map(|stream| stream.transfer.downloaded_bytes)
        .sum();
    let expected_streams = expected_streams.max(streams.len()).max(1);
    let total_state = aggregate_total_with_expected(streams, expected_streams);
    let reported_percent = streams
        .iter()
        .filter_map(|stream| stream.transfer.reported_percent)
        .rfind(|value| value.is_finite() && (0.0..=1.0).contains(value));

    let (progress, progress_kind) = match total_state {
        (Some(total), TotalKind::Exact) => {
            (Some(fraction(downloaded_bytes, total)), ProgressKind::Exact)
        }
        (Some(total), TotalKind::Estimated) => (
            Some(fraction(downloaded_bytes, total)),
            ProgressKind::Estimated,
        ),
        (None, TotalKind::Unknown) => {
            let stage_sum = streams.iter().map(stream_stage_progress).sum::<f64>();
            if stage_sum > 0.0
                || streams
                    .iter()
                    .any(|stream| stream.transfer.progress.is_some())
            {
                (
                    Some((stage_sum / expected_streams as f64).clamp(0.0, 1.0)),
                    ProgressKind::Estimated,
                )
            } else {
                (None, ProgressKind::Unavailable)
            }
        }
        _ => (None, ProgressKind::Unavailable),
    };

    let (speed_bps, speed_kind) = aggregate_active_speed(streams);
    let (eta_seconds, eta_kind) = aggregate_adaptive_eta(
        streams,
        expected_streams,
        total_state,
        speed_bps,
        downloaded_bytes,
    );

    TransferProgress {
        downloaded_bytes,
        total_bytes: total_state.0,
        total_kind: total_state.1,
        reported_percent,
        progress,
        progress_kind,
        speed_bps,
        speed_kind,
        eta_seconds,
        eta_kind,
    }
}

fn aggregate_total_with_expected(
    streams: &[StreamProgress],
    expected_streams: usize,
) -> (Option<u64>, TotalKind) {
    if streams.len() < expected_streams {
        return (None, TotalKind::Unknown);
    }
    if streams
        .iter()
        .all(|stream| stream.transfer.total_kind == TotalKind::Exact)
        && streams
            .iter()
            .all(|stream| stream.transfer.total_bytes.is_some())
    {
        return (
            Some(
                streams
                    .iter()
                    .filter_map(|stream| stream.transfer.total_bytes)
                    .sum(),
            ),
            TotalKind::Exact,
        );
    }
    if streams.iter().all(|stream| {
        matches!(
            stream.transfer.total_kind,
            TotalKind::Exact | TotalKind::Estimated
        ) && stream.transfer.total_bytes.is_some()
    }) {
        return (
            Some(
                streams
                    .iter()
                    .filter_map(|stream| stream.transfer.total_bytes)
                    .sum(),
            ),
            TotalKind::Estimated,
        );
    }
    (None, TotalKind::Unknown)
}

fn stream_stage_progress(stream: &StreamProgress) -> f64 {
    match stream.state {
        StreamPhase::Completed => 1.0,
        StreamPhase::Pending => 0.0,
        StreamPhase::Failed | StreamPhase::Cancelled => stream.transfer.progress.unwrap_or(0.0),
        StreamPhase::Preparing | StreamPhase::Downloading | StreamPhase::Paused => {
            stream.transfer.progress.unwrap_or(0.0)
        }
    }
}

fn aggregate_active_speed(streams: &[StreamProgress]) -> (Option<f64>, SpeedKind) {
    let values: Vec<(f64, SpeedKind)> = streams
        .iter()
        .filter(|stream| {
            matches!(
                stream.state,
                StreamPhase::Preparing | StreamPhase::Downloading | StreamPhase::Paused
            )
        })
        .filter_map(|stream| {
            stream
                .transfer
                .speed_bps
                .map(|speed| (speed.max(0.0), stream.transfer.speed_kind))
        })
        .collect();
    if values.is_empty() {
        return (None, SpeedKind::Unavailable);
    }
    let speed = values.iter().map(|(value, _)| value).sum();
    let kind = if values.iter().all(|(_, kind)| *kind == SpeedKind::Reported) {
        SpeedKind::Reported
    } else {
        SpeedKind::Derived
    };
    (Some(speed), kind)
}

fn aggregate_adaptive_eta(
    streams: &[StreamProgress],
    expected_streams: usize,
    total_state: (Option<u64>, TotalKind),
    speed_bps: Option<f64>,
    downloaded_bytes: u64,
) -> (Option<u64>, EtaKind) {
    if streams.len() < expected_streams {
        return (None, EtaKind::Unavailable);
    }
    if streams.iter().any(|stream| {
        matches!(stream.state, StreamPhase::Pending | StreamPhase::Preparing)
            && stream.transfer.eta_seconds.is_none()
    }) {
        return (None, EtaKind::Unavailable);
    }
    let active: Vec<&StreamProgress> = streams
        .iter()
        .filter(|stream| matches!(stream.state, StreamPhase::Downloading | StreamPhase::Paused))
        .collect();
    if active.is_empty() {
        return (Some(0), EtaKind::Estimated);
    }
    if active
        .iter()
        .all(|stream| stream.transfer.eta_kind == EtaKind::Reported)
    {
        if let Some(value) = active
            .iter()
            .filter_map(|stream| stream.transfer.eta_seconds)
            .max()
        {
            return (Some(value), EtaKind::Reported);
        }
    }
    let Some(total) = total_state.0 else {
        return (None, EtaKind::Unavailable);
    };
    if active
        .iter()
        .all(|stream| stream.transfer.eta_kind == EtaKind::Unavailable)
    {
        return (None, EtaKind::Unavailable);
    }
    let Some(speed) = speed_bps.filter(|value| value.is_finite() && *value > 0.0) else {
        return (None, EtaKind::Unavailable);
    };
    let remaining = total.saturating_sub(downloaded_bytes);
    (
        Some((remaining as f64 / speed).ceil() as u64),
        EtaKind::Estimated,
    )
}

fn aggregate_transfers(transfers: &[TransferProgress]) -> TransferProgress {
    if transfers.is_empty() {
        return TransferProgress::default();
    }

    let downloaded_bytes = transfers
        .iter()
        .map(|transfer| transfer.downloaded_bytes)
        .sum();
    let total_state = aggregate_total(transfers);
    let reported_percent = average_reported_percent(transfers);

    let (progress, progress_kind) = match total_state {
        (Some(total), TotalKind::Exact) => {
            (Some(fraction(downloaded_bytes, total)), ProgressKind::Exact)
        }
        (Some(total), TotalKind::Estimated) => (
            Some(fraction(downloaded_bytes, total)),
            ProgressKind::Estimated,
        ),
        (None, TotalKind::Unknown) => match reported_percent {
            Some(value) => (Some(value), ProgressKind::Estimated),
            None => (None, ProgressKind::Unavailable),
        },
        _ => (None, ProgressKind::Unavailable),
    };

    let (speed_bps, speed_kind) = aggregate_speed(transfers);
    let (eta_seconds, eta_kind) =
        aggregate_eta(transfers, total_state, speed_bps, downloaded_bytes);

    TransferProgress {
        downloaded_bytes,
        total_bytes: total_state.0,
        total_kind: total_state.1,
        reported_percent,
        progress,
        progress_kind,
        speed_bps,
        speed_kind,
        eta_seconds,
        eta_kind,
    }
}

fn aggregate_total(transfers: &[TransferProgress]) -> (Option<u64>, TotalKind) {
    if transfers
        .iter()
        .all(|transfer| transfer.total_kind == TotalKind::Exact && transfer.total_bytes.is_some())
    {
        return (
            Some(
                transfers
                    .iter()
                    .filter_map(|transfer| transfer.total_bytes)
                    .sum(),
            ),
            TotalKind::Exact,
        );
    }
    if transfers.iter().all(|transfer| {
        matches!(transfer.total_kind, TotalKind::Exact | TotalKind::Estimated)
            && transfer.total_bytes.is_some()
    }) {
        return (
            Some(
                transfers
                    .iter()
                    .filter_map(|transfer| transfer.total_bytes)
                    .sum(),
            ),
            TotalKind::Estimated,
        );
    }
    (None, TotalKind::Unknown)
}

fn average_reported_percent(transfers: &[TransferProgress]) -> Option<f64> {
    let values: Vec<f64> = transfers
        .iter()
        .filter_map(|transfer| transfer.reported_percent)
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn aggregate_speed(transfers: &[TransferProgress]) -> (Option<f64>, SpeedKind) {
    let values: Vec<(f64, SpeedKind)> = transfers
        .iter()
        .filter_map(|transfer| {
            transfer
                .speed_bps
                .map(|speed| (speed.max(0.0), transfer.speed_kind))
        })
        .collect();
    if values.is_empty() {
        return (None, SpeedKind::Unavailable);
    }
    let speed = values.iter().map(|(value, _)| value).sum();
    let kind = if values.iter().all(|(_, kind)| *kind == SpeedKind::Reported) {
        SpeedKind::Reported
    } else {
        SpeedKind::Derived
    };
    (Some(speed), kind)
}

fn aggregate_eta(
    transfers: &[TransferProgress],
    total_state: (Option<u64>, TotalKind),
    speed_bps: Option<f64>,
    downloaded_bytes: u64,
) -> (Option<u64>, EtaKind) {
    let reported: Vec<u64> = transfers
        .iter()
        .filter(|transfer| transfer.eta_kind == EtaKind::Reported)
        .filter_map(|transfer| transfer.eta_seconds)
        .collect();
    if let Some(value) = reported.into_iter().max() {
        return (Some(value), EtaKind::Reported);
    }
    let Some(total) = total_state.0 else {
        return (None, EtaKind::Unavailable);
    };
    let Some(speed) = speed_bps.filter(|value| value.is_finite() && *value > 0.0) else {
        return (None, EtaKind::Unavailable);
    };
    let remaining = total.saturating_sub(downloaded_bytes);
    (
        Some((remaining as f64 / speed).ceil() as u64),
        EtaKind::Estimated,
    )
}

pub(crate) fn aggregate_playlist(items: &[PlaylistItemProgress]) -> PlaylistProgress {
    aggregate_playlist_with_id(0, items)
}

pub(crate) fn aggregate_playlist_with_id(
    batch_id: u64,
    items: &[PlaylistItemProgress],
) -> PlaylistProgress {
    let total_items = items.len();
    let counts = PlaylistCounts {
        queued: count(items, |state| state == JobPhase::Queued),
        preparing: count(items, |state| state == JobPhase::Preparing),
        downloading: count(items, |state| state == JobPhase::Downloading),
        processing: count(items, |state| {
            matches!(state, JobPhase::PostProcessing | JobPhase::Finalizing)
        }),
        paused: count(items, |state| state == JobPhase::Paused),
        completed: count(items, |state| state == JobPhase::Completed),
        failed: count(items, |state| state == JobPhase::Failed),
        cancelling: count(items, |state| state == JobPhase::Cancelling),
        cancelled: count(items, |state| state == JobPhase::Cancelled),
    };

    let transfers: Vec<TransferProgress> = items.iter().map(playlist_transfer).collect();
    let mut transfer = aggregate_transfers(&transfers);
    if transfer.total_kind == TotalKind::Unknown {
        let useful_progress = items.iter().any(|item| {
            item.state != JobPhase::Queued
                || item.transfer.progress.is_some()
                || item.final_size.is_some()
        });
        let completed_progress = items
            .iter()
            .map(|item| match item.state {
                JobPhase::Completed => 1.0,
                JobPhase::Preparing
                | JobPhase::Downloading
                | JobPhase::PostProcessing
                | JobPhase::Finalizing
                | JobPhase::Paused
                | JobPhase::Cancelling => item.transfer.progress.unwrap_or(0.0),
                JobPhase::Queued | JobPhase::Failed | JobPhase::Cancelled => 0.0,
            })
            .sum::<f64>();
        transfer.progress = useful_progress
            .then(|| (completed_progress / total_items.max(1) as f64).clamp(0.0, 1.0));
        transfer.progress_kind = if transfer.progress.is_some() {
            ProgressKind::Estimated
        } else {
            ProgressKind::Unavailable
        };
        transfer.reported_percent = None;
    }

    let current_items = items
        .iter()
        .filter(|item| {
            matches!(
                item.state,
                JobPhase::Preparing
                    | JobPhase::Downloading
                    | JobPhase::PostProcessing
                    | JobPhase::Finalizing
                    | JobPhase::Paused
                    | JobPhase::Cancelling
            )
        })
        .collect::<Vec<_>>();
    let current = current_items.first().copied();
    let state = playlist_state(total_items, counts);
    let final_size = if total_items > 0
        && counts.completed == total_items
        && items.iter().all(|item| item.final_size.is_some())
    {
        Some(items.iter().filter_map(|item| item.final_size).sum())
    } else {
        None
    };

    PlaylistProgress {
        batch_id,
        total_items,
        queued: counts.queued,
        preparing: counts.preparing,
        downloading: counts.downloading,
        processing: counts.processing,
        paused: counts.paused,
        completed: counts.completed,
        failed: counts.failed,
        cancelling: counts.cancelling,
        cancelled: counts.cancelled,
        state,
        current_item: current.map(|item| item.id.clone()),
        current_position: current.map(|item| item.position),
        current_items: current_items.iter().map(|item| item.id.clone()).collect(),
        current_positions: current_items.iter().map(|item| item.position).collect(),
        transfer,
        final_size,
        items: items.to_vec(),
    }
}

fn playlist_transfer(item: &PlaylistItemProgress) -> TransferProgress {
    if item.state == JobPhase::Completed {
        if let Some(final_size) = item.final_size {
            return TransferProgress::with_total(final_size, Some(final_size), TotalKind::Exact);
        }
    }
    let mut transfer = item.transfer.clone();
    if !matches!(item.state, JobPhase::Preparing | JobPhase::Downloading) {
        transfer.speed_bps = None;
        transfer.speed_kind = SpeedKind::Unavailable;
        transfer.eta_seconds = None;
        transfer.eta_kind = EtaKind::Unavailable;
    }
    transfer
}

fn count(items: &[PlaylistItemProgress], predicate: impl Fn(JobPhase) -> bool) -> usize {
    items.iter().filter(|item| predicate(item.state)).count()
}

#[derive(Clone, Copy)]
struct PlaylistCounts {
    queued: usize,
    preparing: usize,
    downloading: usize,
    processing: usize,
    paused: usize,
    completed: usize,
    failed: usize,
    cancelling: usize,
    cancelled: usize,
}

fn playlist_state(total_items: usize, counts: PlaylistCounts) -> PlaylistPhase {
    if counts.cancelling > 0 {
        return PlaylistPhase::Cancelling;
    }
    if counts.downloading > 0 {
        return PlaylistPhase::Downloading;
    }
    if counts.preparing > 0 {
        return PlaylistPhase::Preparing;
    }
    if counts.processing > 0 {
        return PlaylistPhase::PostProcessing;
    }
    if counts.paused > 0 {
        return PlaylistPhase::Paused;
    }
    if total_items == 0 || counts.queued == total_items {
        return PlaylistPhase::Queued;
    }
    if counts.completed == total_items {
        return PlaylistPhase::Completed;
    }
    if counts.failed == total_items {
        return PlaylistPhase::Failed;
    }
    if counts.cancelled == total_items {
        return PlaylistPhase::Cancelled;
    }
    if counts.failed > 0 && counts.completed + counts.failed + counts.cancelled == total_items {
        return PlaylistPhase::PartialFailure;
    }
    if counts.failed > 0 || counts.cancelled > 0 {
        return PlaylistPhase::PartialFailure;
    }
    if counts.queued > 0 {
        return PlaylistPhase::Preparing;
    }
    PlaylistPhase::Queued
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::model::{StreamKind, StreamPhase, StreamProgress};

    fn stream(id: &str, bytes: u64, total: Option<u64>, kind: TotalKind) -> StreamProgress {
        StreamProgress::new(
            id,
            StreamKind::File,
            None,
            StreamPhase::Downloading,
            TransferProgress::with_total(bytes, total, kind),
        )
    }

    #[test]
    fn exact_streams_aggregate_exactly() {
        let result = aggregate_streams(&[
            stream("video", 80, Some(100), TotalKind::Exact),
            stream("audio", 12, Some(15), TotalKind::Exact),
        ]);
        assert_eq!(result.downloaded_bytes, 92);
        assert_eq!(result.total_bytes, Some(115));
        assert_eq!(result.total_kind, TotalKind::Exact);
        assert_eq!(result.progress_kind, ProgressKind::Exact);
        assert!((result.progress.unwrap() - 92.0 / 115.0).abs() < f64::EPSILON);
    }

    #[test]
    fn estimated_stream_keeps_aggregate_estimated() {
        let result = aggregate_streams(&[
            stream("video", 80, Some(100), TotalKind::Exact),
            stream("audio", 12, Some(15), TotalKind::Estimated),
        ]);
        assert_eq!(result.total_kind, TotalKind::Estimated);
        assert_eq!(result.progress_kind, ProgressKind::Estimated);
    }

    #[test]
    fn unknown_stream_can_keep_reported_percent() {
        let mut unknown = stream("audio", 12, None, TotalKind::Unknown);
        unknown.transfer = TransferProgress::with_reported_percent(12, 38.0);
        let result = aggregate_streams(&[unknown]);
        assert_eq!(result.total_kind, TotalKind::Unknown);
        assert_eq!(result.progress_kind, ProgressKind::Estimated);
        assert!((result.progress.unwrap() - 0.38).abs() < f64::EPSILON);
    }

    #[test]
    fn aggregate_never_clamps_downloaded_to_estimate() {
        let result = aggregate_streams(&[stream("file", 110, Some(100), TotalKind::Estimated)]);
        assert_eq!(result.downloaded_bytes, 110);
        assert_eq!(result.total_bytes, Some(100));
        assert_eq!(result.progress, Some(1.0));
    }

    #[test]
    fn unknown_without_percent_is_unavailable() {
        let result = aggregate_streams(&[stream("file", 55, None, TotalKind::Unknown)]);
        assert_eq!(result.progress, None);
        assert_eq!(result.progress_kind, ProgressKind::Unavailable);
    }
}
