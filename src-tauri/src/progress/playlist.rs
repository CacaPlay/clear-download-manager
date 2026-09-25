use super::adapter::V1ProgressObservation;
use super::aggregate::aggregate_playlist_with_id;
use super::model::{
    EtaKind, JobPhase, PlaylistPhase, PlaylistProgress, ProgressSnapshotV2, SpeedKind, TotalKind,
    TransferProgress,
};
use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PLAYLIST_COMPARISONS: usize = 64;
const MAX_SHADOW_PLAYLISTS: usize = 16;
const MAX_SHADOW_ITEMS: usize = 500;

#[derive(Debug, Clone)]
pub(crate) struct PlaylistItemSeed {
    pub(crate) item_id: i64,
    pub(crate) job_id: i64,
    pub(crate) source_id: String,
    pub(crate) position: usize,
    pub(crate) title: String,
    pub(crate) state: JobPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaylistDivergence {
    None,
    LegacyQueuedWhileActive,
    ProgressKindMismatch,
    CounterMismatch,
    DangerousByteRegression,
    TotalMismatch,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlaylistComparison {
    pub(crate) timestamp_ms: u64,
    pub(crate) batch_id: i64,
    pub(crate) v1: PlaylistProgress,
    pub(crate) v2: PlaylistProgress,
    pub(crate) divergence: PlaylistDivergence,
}

#[derive(Debug, Default)]
struct ShadowPlaylist {
    items: Vec<super::model::PlaylistItemProgress>,
    v1_items: Vec<super::model::PlaylistItemProgress>,
    comparisons: VecDeque<PlaylistComparison>,
}

#[derive(Debug, Default)]
pub(crate) struct PlaylistShadowStore {
    playlists: HashMap<i64, ShadowPlaylist>,
    job_to_batch: HashMap<i64, i64>,
}

impl PlaylistShadowStore {
    pub(crate) fn ensure_playlist(&mut self, batch_id: i64, seeds: Vec<PlaylistItemSeed>) {
        if seeds.is_empty() {
            return;
        }
        if let Some(playlist) = self.playlists.get_mut(&batch_id) {
            for seed in seeds {
                self.job_to_batch.insert(seed.job_id, batch_id);
                if playlist
                    .items
                    .iter()
                    .any(|item| item.id == seed.item_id.to_string())
                {
                    continue;
                }
                if playlist.items.len() >= MAX_SHADOW_ITEMS {
                    break;
                }
                let item = item_from_seed(&seed);
                playlist.items.push(item.clone());
                playlist.v1_items.push(item);
            }
            sort_items(&mut playlist.items);
            sort_items(&mut playlist.v1_items);
            return;
        }

        let mut items = seeds
            .into_iter()
            .take(MAX_SHADOW_ITEMS)
            .map(|seed| {
                self.job_to_batch.insert(seed.job_id, batch_id);
                item_from_seed(&seed)
            })
            .collect::<Vec<_>>();
        sort_items(&mut items);
        self.playlists.insert(
            batch_id,
            ShadowPlaylist {
                v1_items: items.clone(),
                items,
                comparisons: VecDeque::new(),
            },
        );
        self.evict_oldest_if_needed(batch_id);
    }

    pub(crate) fn update_item(
        &mut self,
        job_id: i64,
        child: &ProgressSnapshotV2,
        v1: Option<&V1ProgressObservation>,
    ) {
        let Some(batch_id) = self.job_to_batch.get(&job_id).copied() else {
            return;
        };
        let Some(playlist) = self.playlists.get_mut(&batch_id) else {
            return;
        };
        let Some(index) = playlist
            .items
            .iter()
            .position(|item| item.job_id == job_id as u64)
        else {
            return;
        };
        let item = &mut playlist.items[index];
        item.state = child.phase;
        item.transfer = child.transfer.clone();
        item.final_size = child.final_size;
        item.child_snapshot = Some(Box::new(child.clone()));

        let v1_item = &mut playlist.v1_items[index];
        v1_item.state = child.phase;
        if let Some(v1) = v1 {
            v1_item.transfer = transfer_from_v1(v1);
        } else {
            v1_item.transfer = child.transfer.clone();
        }
        v1_item.final_size = child.final_size;

        let v2 = aggregate_playlist_with_id(batch_id as u64, &playlist.items);
        let v1_snapshot = aggregate_playlist_with_id(batch_id as u64, &playlist.v1_items);
        let divergence = compare_playlist(&v1_snapshot, &v2);
        playlist.comparisons.push_back(PlaylistComparison {
            timestamp_ms: now_ms(),
            batch_id,
            v1: v1_snapshot,
            v2,
            divergence,
        });
        while playlist.comparisons.len() > MAX_PLAYLIST_COMPARISONS {
            playlist.comparisons.pop_front();
        }
    }

    pub(crate) fn pause_batch(&mut self, batch_id: i64) {
        let Some(playlist) = self.playlists.get_mut(&batch_id) else {
            return;
        };
        for item in &mut playlist.items {
            if !matches!(
                item.state,
                JobPhase::Completed | JobPhase::Failed | JobPhase::Cancelled
            ) {
                item.state = JobPhase::Paused;
            }
        }
        for item in &mut playlist.v1_items {
            if !matches!(
                item.state,
                JobPhase::Completed | JobPhase::Failed | JobPhase::Cancelled
            ) {
                item.state = JobPhase::Paused;
            }
        }
    }

    pub(crate) fn resume_batch(&mut self, batch_id: i64) {
        let Some(playlist) = self.playlists.get_mut(&batch_id) else {
            return;
        };
        for item in &mut playlist.items {
            if item.state == JobPhase::Paused {
                item.state = JobPhase::Queued;
            }
        }
        for item in &mut playlist.v1_items {
            if item.state == JobPhase::Paused {
                item.state = JobPhase::Queued;
            }
        }
    }

    pub(crate) fn cancel_batch(&mut self, batch_id: i64) {
        let Some(playlist) = self.playlists.get_mut(&batch_id) else {
            return;
        };
        for item in &mut playlist.items {
            if item.state != JobPhase::Completed {
                item.state = JobPhase::Cancelled;
            }
        }
        for item in &mut playlist.v1_items {
            if item.state != JobPhase::Completed {
                item.state = JobPhase::Cancelled;
            }
        }
    }

    pub(crate) fn retry_failed_items(&mut self, batch_id: i64) {
        let Some(playlist) = self.playlists.get_mut(&batch_id) else {
            return;
        };
        for item in &mut playlist.items {
            if item.state == JobPhase::Failed {
                item.state = JobPhase::Queued;
                item.transfer = TransferProgress::default();
                item.final_size = None;
                item.child_snapshot = None;
            }
        }
        for item in &mut playlist.v1_items {
            if item.state == JobPhase::Failed {
                item.state = JobPhase::Queued;
                item.transfer = TransferProgress::default();
                item.final_size = None;
            }
        }
    }

    pub(crate) fn snapshot(&self, batch_id: i64) -> Option<ProgressSnapshotV2> {
        let playlist = self.playlists.get(&batch_id)?;
        let aggregate = aggregate_playlist_with_id(batch_id as u64, &playlist.items);
        let phase = job_phase_from_playlist(aggregate.state);
        let final_size = (phase == JobPhase::Completed)
            .then_some(aggregate.final_size)
            .flatten();
        let mut snapshot =
            ProgressSnapshotV2::new(batch_id as u64, phase, aggregate.transfer.clone());
        snapshot.final_size = final_size;
        snapshot.playlist = Some(aggregate);
        snapshot.validate().ok()?;
        Some(snapshot)
    }

    pub(crate) fn batch_for_job(&self, job_id: i64) -> Option<i64> {
        self.job_to_batch.get(&job_id).copied()
    }

    pub(crate) fn comparisons(&self, batch_id: i64) -> Vec<PlaylistComparison> {
        self.playlists
            .get(&batch_id)
            .map(|playlist| playlist.comparisons.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn evict_oldest_if_needed(&mut self, newest_batch_id: i64) {
        while self.playlists.len() > MAX_SHADOW_PLAYLISTS {
            let Some(batch_id) = self
                .playlists
                .keys()
                .copied()
                .find(|batch_id| *batch_id != newest_batch_id)
            else {
                break;
            };
            self.playlists.remove(&batch_id);
            self.job_to_batch.retain(|_, value| *value != batch_id);
        }
    }
}

fn item_from_seed(seed: &PlaylistItemSeed) -> super::model::PlaylistItemProgress {
    super::model::PlaylistItemProgress {
        id: seed.item_id.to_string(),
        job_id: seed.job_id as u64,
        source_id: seed.source_id.clone(),
        position: seed.position,
        title: seed.title.clone(),
        state: seed.state,
        transfer: TransferProgress::default(),
        final_size: None,
        child_snapshot: None,
    }
}

fn sort_items(items: &mut [super::model::PlaylistItemProgress]) {
    items.sort_by_key(|item| item.position);
}

fn transfer_from_v1(v1: &V1ProgressObservation) -> TransferProgress {
    let mut transfer = match (v1.total_bytes, v1.total_estimated) {
        (Some(total), true) => {
            TransferProgress::with_total(v1.downloaded_bytes, Some(total), TotalKind::Estimated)
        }
        (Some(total), false) => {
            TransferProgress::with_total(v1.downloaded_bytes, Some(total), TotalKind::Exact)
        }
        (None, _) => v1
            .progress_percent
            .map(|percent| TransferProgress::with_reported_percent(v1.downloaded_bytes, percent))
            .unwrap_or_else(|| TransferProgress::unknown(v1.downloaded_bytes)),
    };
    if let Some(speed) = v1.speed_bps {
        transfer = transfer.with_speed(speed, SpeedKind::Reported);
    }
    if let Some(eta) = v1.eta_seconds {
        transfer = transfer.with_eta(eta, EtaKind::Reported);
    }
    transfer
}

fn compare_playlist(v1: &PlaylistProgress, v2: &PlaylistProgress) -> PlaylistDivergence {
    if v2.transfer.downloaded_bytes < v1.transfer.downloaded_bytes {
        PlaylistDivergence::DangerousByteRegression
    } else if v1.state == PlaylistPhase::Queued && v2.state != PlaylistPhase::Queued {
        PlaylistDivergence::LegacyQueuedWhileActive
    } else if v1.completed != v2.completed
        || v1.downloading != v2.downloading
        || v1.processing != v2.processing
    {
        PlaylistDivergence::CounterMismatch
    } else if v1.transfer.total_kind != v2.transfer.total_kind {
        PlaylistDivergence::TotalMismatch
    } else if v1.transfer.progress_kind != v2.transfer.progress_kind {
        PlaylistDivergence::ProgressKindMismatch
    } else {
        PlaylistDivergence::None
    }
}

fn job_phase_from_playlist(phase: PlaylistPhase) -> JobPhase {
    match phase {
        PlaylistPhase::Queued => JobPhase::Queued,
        PlaylistPhase::Preparing => JobPhase::Preparing,
        PlaylistPhase::Downloading => JobPhase::Downloading,
        PlaylistPhase::PostProcessing => JobPhase::PostProcessing,
        PlaylistPhase::Paused => JobPhase::Paused,
        PlaylistPhase::Completed => JobPhase::Completed,
        PlaylistPhase::PartialFailure | PlaylistPhase::Failed => JobPhase::Failed,
        PlaylistPhase::Cancelling => JobPhase::Cancelling,
        PlaylistPhase::Cancelled => JobPhase::Cancelled,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::model::{PlaylistItemProgress, ProgressKind};

    fn seeds(count: usize) -> Vec<PlaylistItemSeed> {
        (1..=count)
            .map(|position| PlaylistItemSeed {
                item_id: position as i64,
                job_id: (100 + position) as i64,
                source_id: format!("source-{position}"),
                position,
                title: format!("Track {position}"),
                state: JobPhase::Queued,
            })
            .collect()
    }

    fn child(
        job_id: u64,
        phase: JobPhase,
        downloaded: u64,
        total: Option<u64>,
    ) -> ProgressSnapshotV2 {
        let transfer = total
            .map(|total| TransferProgress::with_total(downloaded, Some(total), TotalKind::Exact))
            .unwrap_or_else(|| TransferProgress::with_reported_percent(downloaded, 50.0));
        ProgressSnapshotV2::new(job_id, phase, transfer)
    }

    #[test]
    fn playlist_is_not_queued_when_a_child_is_active() {
        let mut store = PlaylistShadowStore::default();
        store.ensure_playlist(7, seeds(7));
        store.update_item(101, &child(101, JobPhase::Downloading, 25, Some(100)), None);
        let snapshot = store.snapshot(7).unwrap();
        let playlist = snapshot.playlist.unwrap();
        assert_eq!(playlist.state, PlaylistPhase::Downloading);
        assert_eq!(playlist.downloading, 1);
        assert_eq!(playlist.total_items, 7);
    }

    #[test]
    fn playlist_items_keep_order_and_child_snapshots() {
        let mut store = PlaylistShadowStore::default();
        store.ensure_playlist(8, seeds(3));
        store.update_item(103, &child(103, JobPhase::Downloading, 10, Some(20)), None);
        let playlist = store.snapshot(8).unwrap().playlist.unwrap();
        assert_eq!(playlist.items[0].position, 1);
        assert_eq!(playlist.items[2].position, 3);
        assert!(playlist.items[2].child_snapshot.is_some());
    }

    #[test]
    fn playlist_store_bounds_comparisons_and_playlists() {
        let mut store = PlaylistShadowStore::default();
        store.ensure_playlist(1, seeds(1));
        for value in 0..(MAX_PLAYLIST_COMPARISONS + 10) {
            store.update_item(
                101,
                &child(101, JobPhase::Downloading, value as u64, Some(100)),
                None,
            );
        }
        assert_eq!(store.comparisons(1).len(), MAX_PLAYLIST_COMPARISONS);
        for batch_id in 2..=(MAX_SHADOW_PLAYLISTS as i64 + 3) {
            store.ensure_playlist(batch_id, seeds(1));
        }
        assert!(store.playlists.len() <= MAX_SHADOW_PLAYLISTS);
    }

    fn item(
        job_id: u64,
        position: usize,
        state: JobPhase,
        transfer: TransferProgress,
        final_size: Option<u64>,
    ) -> PlaylistItemProgress {
        PlaylistItemProgress {
            id: job_id.to_string(),
            job_id,
            source_id: format!("source-{job_id}"),
            position,
            title: format!("Track {job_id}"),
            state,
            transfer,
            final_size,
            child_snapshot: None,
        }
    }

    #[test]
    fn playlist_uses_weighted_bytes_for_unequal_items() {
        let playlist = aggregate_playlist_with_id(
            20,
            &[
                item(
                    1,
                    1,
                    JobPhase::Completed,
                    TransferProgress::with_total(5, Some(5), TotalKind::Exact),
                    Some(5),
                ),
                item(
                    2,
                    2,
                    JobPhase::Downloading,
                    TransferProgress::with_total(75, Some(150), TotalKind::Exact),
                    None,
                ),
                item(
                    3,
                    3,
                    JobPhase::Queued,
                    TransferProgress::with_total(0, Some(10), TotalKind::Exact),
                    None,
                ),
            ],
        );
        assert_eq!(playlist.transfer.downloaded_bytes, 80);
        assert_eq!(playlist.transfer.total_bytes, Some(165));
        assert_eq!(playlist.transfer.total_kind, TotalKind::Exact);
        assert_eq!(playlist.transfer.progress_kind, ProgressKind::Exact);
        assert_eq!(playlist.transfer.progress, Some(80.0 / 165.0));
    }

    #[test]
    fn playlist_aggregates_concurrent_item_speed_and_current_items() {
        let playlist = aggregate_playlist_with_id(
            21,
            &[
                item(
                    1,
                    1,
                    JobPhase::Downloading,
                    TransferProgress::with_total(20, Some(100), TotalKind::Exact)
                        .with_speed(10.0, SpeedKind::Reported),
                    None,
                ),
                item(
                    2,
                    2,
                    JobPhase::Downloading,
                    TransferProgress::with_total(40, Some(200), TotalKind::Exact)
                        .with_speed(20.0, SpeedKind::Reported),
                    None,
                ),
                item(
                    3,
                    3,
                    JobPhase::Paused,
                    TransferProgress::with_total(30, Some(300), TotalKind::Exact)
                        .with_speed(99.0, SpeedKind::Reported),
                    None,
                ),
            ],
        );
        assert_eq!(playlist.downloading, 2);
        assert_eq!(playlist.current_items, vec!["1", "2", "3"]);
        assert_eq!(playlist.current_positions, vec![1, 2, 3]);
        assert_eq!(playlist.transfer.speed_bps, Some(30.0));
    }

    #[test]
    fn playlist_uses_estimated_item_stage_when_totals_are_unknown() {
        let playlist = aggregate_playlist_with_id(
            22,
            &[
                item(1, 1, JobPhase::Completed, TransferProgress::default(), None),
                item(2, 2, JobPhase::Completed, TransferProgress::default(), None),
                item(3, 3, JobPhase::Completed, TransferProgress::default(), None),
                item(
                    4,
                    4,
                    JobPhase::Downloading,
                    TransferProgress::with_reported_percent(50, 50.0),
                    None,
                ),
                item(5, 5, JobPhase::Queued, TransferProgress::default(), None),
            ],
        );
        assert_eq!(playlist.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(playlist.transfer.progress_kind, ProgressKind::Estimated);
        assert_eq!(playlist.transfer.progress, Some(0.7));
    }

    #[test]
    fn playlist_postprocessing_and_partial_failure_are_not_reported_as_completed() {
        let processing = aggregate_playlist_with_id(
            23,
            &[
                item(
                    1,
                    1,
                    JobPhase::PostProcessing,
                    TransferProgress::default(),
                    None,
                ),
                item(2, 2, JobPhase::Queued, TransferProgress::default(), None),
            ],
        );
        assert_eq!(processing.state, PlaylistPhase::PostProcessing);
        assert_eq!(processing.processing, 1);
        assert_eq!(processing.completed, 0);

        let partial = aggregate_playlist_with_id(
            24,
            &[
                item(
                    1,
                    1,
                    JobPhase::Completed,
                    TransferProgress::default(),
                    Some(10),
                ),
                item(2, 2, JobPhase::Failed, TransferProgress::default(), None),
            ],
        );
        assert_eq!(partial.state, PlaylistPhase::PartialFailure);
    }

    #[test]
    fn playlist_completion_counter_waits_until_finalizing_is_completed() {
        let processing = aggregate_playlist_with_id(
            26,
            &[item(
                1,
                1,
                JobPhase::Finalizing,
                TransferProgress::with_total(110, Some(110), TotalKind::Exact),
                None,
            )],
        );
        assert_eq!(processing.processing, 1);
        assert_eq!(processing.completed, 0);

        let completed = aggregate_playlist_with_id(
            26,
            &[item(
                1,
                1,
                JobPhase::Completed,
                TransferProgress::with_total(110, Some(110), TotalKind::Exact),
                Some(106),
            )],
        );
        assert_eq!(completed.completed, 1);
        assert_eq!(completed.final_size, Some(106));
    }

    #[test]
    fn playlist_cancel_and_retry_failed_items_are_explicit_transitions() {
        let mut store = PlaylistShadowStore::default();
        store.ensure_playlist(25, seeds(2));
        store.update_item(101, &child(101, JobPhase::Failed, 10, Some(100)), None);
        store.retry_failed_items(25);
        let retry = store.snapshot(25).unwrap().playlist.unwrap();
        assert_eq!(retry.failed, 0);
        assert_eq!(retry.state, PlaylistPhase::Queued);

        store.update_item(101, &child(101, JobPhase::Downloading, 20, Some(100)), None);
        store.cancel_batch(25);
        assert_eq!(
            store.snapshot(25).unwrap().playlist.unwrap().state,
            PlaylistPhase::Cancelled
        );
    }
}
