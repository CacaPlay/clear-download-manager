use super::model::{
    JobPhase, PlaylistItemProgress, ProgressSnapshotV2, StreamKind, StreamPhase, StreamProgress,
    TotalKind, TransferProgress,
};

pub(crate) fn single_exact_fixture() -> Vec<ProgressSnapshotV2> {
    [0, 20, 50, 100]
        .into_iter()
        .map(|percent| {
            let bytes = percent;
            let phase = if percent == 100 {
                JobPhase::Finalizing
            } else {
                JobPhase::Downloading
            };
            let mut snapshot = ProgressSnapshotV2::new(
                1,
                phase,
                TransferProgress::with_total(bytes, Some(100), TotalKind::Exact),
            );
            if percent == 100 {
                snapshot.phase = JobPhase::Completed;
                snapshot.final_size = Some(100);
            }
            snapshot
        })
        .collect()
}

pub(crate) fn estimated_fixture() -> Vec<TransferProgress> {
    [(10, 100), (40, 110), (80, 130), (120, 140)]
        .into_iter()
        .map(|(downloaded, total)| {
            TransferProgress::with_total(downloaded, Some(total), TotalKind::Estimated)
        })
        .collect()
}

pub(crate) fn percent_only_fixture() -> Vec<TransferProgress> {
    [5.0, 38.0, 82.0, 100.0]
        .into_iter()
        .map(|percent| TransferProgress::with_reported_percent(55, percent))
        .collect()
}

pub(crate) fn dash_fixture() -> Vec<Vec<StreamProgress>> {
    vec![
        vec![
            StreamProgress::new(
                "video",
                StreamKind::Video,
                Some("299".to_string()),
                StreamPhase::Downloading,
                TransferProgress::with_total(80, Some(100), TotalKind::Exact),
            ),
            StreamProgress::new(
                "audio",
                StreamKind::Audio,
                Some("140".to_string()),
                StreamPhase::Pending,
                TransferProgress::default(),
            ),
        ],
        vec![
            StreamProgress::new(
                "video",
                StreamKind::Video,
                Some("299".to_string()),
                StreamPhase::Completed,
                TransferProgress::with_total(100, Some(100), TotalKind::Exact),
            ),
            StreamProgress::new(
                "audio",
                StreamKind::Audio,
                Some("140".to_string()),
                StreamPhase::Downloading,
                TransferProgress::with_total(12, Some(15), TotalKind::Estimated),
            ),
        ],
        vec![
            StreamProgress::new(
                "video",
                StreamKind::Video,
                Some("299".to_string()),
                StreamPhase::Completed,
                TransferProgress::with_total(100, Some(100), TotalKind::Exact),
            ),
            StreamProgress::new(
                "audio",
                StreamKind::Audio,
                Some("140".to_string()),
                StreamPhase::Completed,
                TransferProgress::with_total(15, Some(15), TotalKind::Exact),
            ),
        ],
    ]
}

fn playlist_item(
    position: usize,
    state: JobPhase,
    progress: TransferProgress,
) -> PlaylistItemProgress {
    PlaylistItemProgress {
        id: format!("item-{position}"),
        job_id: position as u64,
        source_id: format!("source-{position}"),
        position,
        title: format!("Track {position}"),
        final_size: (state == JobPhase::Completed).then_some(100),
        child_snapshot: None,
        state,
        transfer: progress,
    }
}

pub(crate) fn playlist_seven_item_fixture() -> Vec<Vec<PlaylistItemProgress>> {
    let mut items = Vec::new();
    let mut sequence = Vec::new();
    for position in 1..=7 {
        items.push(playlist_item(
            position,
            JobPhase::Queued,
            TransferProgress::unknown(0),
        ));
    }
    sequence.push(items.clone());
    for position in 1..=3 {
        items[position - 1] = playlist_item(
            position,
            JobPhase::Downloading,
            TransferProgress::with_total(50, Some(100), TotalKind::Exact),
        );
        sequence.push(items.clone());
        items[position - 1] = playlist_item(
            position,
            JobPhase::PostProcessing,
            TransferProgress::with_total(100, Some(100), TotalKind::Exact),
        );
        sequence.push(items.clone());
        items[position - 1] = playlist_item(
            position,
            JobPhase::Completed,
            TransferProgress::with_total(100, Some(100), TotalKind::Exact),
        );
        sequence.push(items.clone());
    }
    items[3] = playlist_item(
        4,
        JobPhase::Downloading,
        TransferProgress::with_reported_percent(50, 50.0),
    );
    sequence.push(items.clone());
    for position in 4..=7 {
        items[position - 1] = playlist_item(
            position,
            JobPhase::Completed,
            TransferProgress::with_total(100, Some(100), TotalKind::Exact),
        );
        sequence.push(items.clone());
    }
    sequence
}

#[cfg(test)]
mod tests {
    use super::super::aggregate::{aggregate_playlist, aggregate_streams};
    use super::super::model::{
        JobPhase, PlaylistPhase, ProcessingStage, ProgressKind, ProgressSnapshotV2, SpeedKind,
        StreamKind, StreamPhase, StreamProgress, TotalKind, TransferProgress,
    };
    use super::super::state_machine::JobStateMachine;
    use super::*;
    use serde_json::Value;

    #[test]
    fn single_exact_fixture_is_exact_until_completion() {
        let snapshots = single_exact_fixture();
        assert_eq!(snapshots.len(), 4);
        for snapshot in &snapshots {
            assert_eq!(snapshot.transfer.total_kind, TotalKind::Exact);
            assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Exact);
            assert!(snapshot.validate().is_ok());
        }
        assert_eq!(snapshots.last().unwrap().final_size, Some(100));
    }

    #[test]
    fn estimate_updates_without_becoming_exact() {
        for transfer in estimated_fixture() {
            assert_eq!(transfer.total_kind, TotalKind::Estimated);
            assert_eq!(transfer.progress_kind, ProgressKind::Estimated);
            assert!(transfer.validate().is_ok());
        }
    }

    #[test]
    fn estimated_overshoot_preserves_measured_bytes() {
        let fixture = estimated_fixture();
        let transfer = fixture.last().unwrap();
        assert_eq!(transfer.downloaded_bytes, 120);
        assert_eq!(transfer.total_bytes, Some(140));
    }

    #[test]
    fn percent_only_fixture_is_determined_but_estimated() {
        for (expected, transfer) in [0.05, 0.38, 0.82, 1.0]
            .into_iter()
            .zip(percent_only_fixture())
        {
            assert_eq!(transfer.total_kind, TotalKind::Unknown);
            assert_eq!(transfer.progress_kind, ProgressKind::Estimated);
            assert!((transfer.progress.unwrap() - expected).abs() < f64::EPSILON);
        }
    }

    #[test]
    fn dash_fixture_preserves_stream_identity_and_accuracy() {
        let sequence = dash_fixture();
        assert_eq!(sequence[0][0].kind, StreamKind::Video);
        assert_eq!(sequence[0][1].state, StreamPhase::Pending);
        assert_eq!(
            aggregate_streams(&sequence[1]).progress_kind,
            ProgressKind::Estimated
        );
        let final_transfer = aggregate_streams(sequence.last().unwrap());
        assert_eq!(final_transfer.total_kind, TotalKind::Exact);
        assert_eq!(final_transfer.downloaded_bytes, 115);
    }

    #[test]
    fn postprocessing_does_not_expose_final_size_early() {
        let mut snapshot = ProgressSnapshotV2::new(
            2,
            JobPhase::Downloading,
            TransferProgress::with_total(100, Some(100), TotalKind::Exact),
        );
        snapshot.phase = JobPhase::PostProcessing;
        snapshot.stage = Some(ProcessingStage::Tagging);
        assert!(snapshot.validate().is_ok());
        assert_eq!(snapshot.final_size, None);
        snapshot.phase = JobPhase::Finalizing;
        assert!(snapshot.validate().is_ok());
        snapshot.phase = JobPhase::Completed;
        snapshot.final_size = Some(96);
        assert!(snapshot.validate().is_ok());
    }

    #[test]
    fn pause_resume_and_cancellation_fixtures_are_terminally_safe() {
        let mut machine = JobStateMachine::from_phase(JobPhase::Downloading, 0);
        assert!(machine.transition(JobPhase::Paused).is_ok());
        assert!(machine.transition(JobPhase::Downloading).is_ok());
        assert!(machine.cancel().is_ok());
        assert!(machine.process_terminated().is_ok());
        assert_eq!(machine.phase(), JobPhase::Cancelled);
    }

    #[test]
    fn playlist_fixture_never_reports_queued_during_real_activity() {
        let sequence = playlist_seven_item_fixture();
        assert_eq!(sequence.len(), 15);
        for items in sequence.iter().skip(1) {
            let playlist = aggregate_playlist(items);
            assert_ne!(playlist.state, PlaylistPhase::Queued);
        }
        let middle_items = sequence
            .iter()
            .find(|items| {
                items[3].state == JobPhase::Downloading && items[3].transfer.progress == Some(0.5)
            })
            .unwrap();
        let middle = aggregate_playlist(middle_items);
        assert_eq!(middle.state, PlaylistPhase::Downloading);
        assert_eq!(middle.completed, 3);
        assert_eq!(middle.current_position, Some(4));
        assert_eq!(middle.transfer.progress_kind, ProgressKind::Estimated);
        let completed = aggregate_playlist(sequence.last().unwrap());
        assert_eq!(completed.state, PlaylistPhase::Completed);
        assert_eq!(completed.completed, 7);
        assert_eq!(completed.final_size, Some(700));
    }

    #[test]
    fn playlist_partial_failure_is_explicit() {
        let items = vec![
            playlist_item(
                1,
                JobPhase::Completed,
                TransferProgress::with_total(100, Some(100), TotalKind::Exact),
            ),
            playlist_item(2, JobPhase::Failed, TransferProgress::unknown(30)),
        ];
        let playlist = aggregate_playlist(&items);
        assert_eq!(playlist.state, PlaylistPhase::PartialFailure);
        assert_eq!(playlist.completed, 1);
        assert_eq!(playlist.failed, 1);
    }

    #[test]
    fn dto_serializes_stable_v2_names_and_nulls() {
        let mut snapshot = ProgressSnapshotV2::new(
            42,
            JobPhase::Downloading,
            TransferProgress::with_total(73, Some(200), TotalKind::Estimated)
                .with_speed(5_242_880.0, SpeedKind::Reported)
                .with_eta(28, super::super::model::EtaKind::Estimated),
        );
        snapshot.attempt = 1;
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["schemaVersion"], Value::from(2));
        assert_eq!(json["jobId"], Value::from(42));
        assert_eq!(json["transferTotal"], Value::from(200));
        assert_eq!(json["totalKind"], Value::from("estimated"));
        assert_eq!(json["progressKind"], Value::from("estimated"));
        assert_eq!(json["finalSize"], Value::Null);
        assert_eq!(json["speedKind"], Value::from("reported"));
    }

    #[test]
    fn invariant_downloaded_bytes_can_exceed_estimate() {
        let transfer = aggregate_streams(&[StreamProgress::new(
            "file",
            StreamKind::File,
            None,
            StreamPhase::Downloading,
            TransferProgress::with_total(106, Some(100), TotalKind::Estimated),
        )]);
        assert!(transfer.downloaded_bytes > transfer.total_bytes.unwrap());
        assert!(transfer.validate().is_ok());
    }

    #[test]
    fn invariant_unknown_does_not_invent_a_total() {
        let transfer = aggregate_streams(&[StreamProgress::new(
            "file",
            StreamKind::File,
            None,
            StreamPhase::Downloading,
            TransferProgress::unknown(55),
        )]);
        assert_eq!(transfer.total_bytes, None);
        assert_eq!(transfer.total_kind, TotalKind::Unknown);
    }
}
