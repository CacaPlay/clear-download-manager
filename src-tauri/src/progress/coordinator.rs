//! Progress Engine V2 Nitro Core.
//!
//! This module is the canonical live state for V2.  The existing adapters remain
//! useful as bounded diagnostic comparators while this coordinator owns the
//! published semantics, coalescing and recovery records.

use super::model::{
    JobPhase, ProcessingStage, ProgressKind, ProgressSnapshotV2, StreamPhase, TotalKind,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[cfg(not(test))]
use tauri::Emitter;

pub(crate) const PROGRESS_V2_EVENT: &str = "progress-v2-delta";
const PUBLISH_INTERVAL: Duration = Duration::from_millis(150);
const PERSIST_INTERVAL: Duration = Duration::from_millis(300);
const PERSIST_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProgressEngineMode {
    Stable,
    V1,
    V2,
    Compare,
}

impl ProgressEngineMode {
    pub(crate) fn from_environment() -> Self {
        match std::env::var("CACATOOLS_PROGRESS_ENGINE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "stable" | "" => Self::Stable,
            "v2" | "nitro" => Self::V2,
            "compare" | "shadow" => Self::Compare,
            "v1" | "legacy" => Self::V1,
            _ => Self::Stable,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::V1 => "v1",
            Self::V2 => "v2",
            Self::Compare => "compare",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressDeltaV2 {
    pub(crate) schema_version: u16,
    pub(crate) sequence: u64,
    pub(crate) job_id: u64,
    pub(crate) inserted: bool,
    pub(crate) removed: bool,
    pub(crate) changed_fields: Vec<String>,
    pub(crate) critical: bool,
    pub(crate) snapshot: Option<ProgressSnapshotV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressDeltaEnvelopeV2 {
    pub(crate) schema_version: u16,
    pub(crate) generated_at_ms: u64,
    pub(crate) deltas: Vec<ProgressDeltaV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressV2FullSnapshot {
    pub(crate) schema_version: u16,
    pub(crate) mode: String,
    pub(crate) sequence: u64,
    pub(crate) jobs: Vec<ProgressSnapshotV2>,
    pub(crate) playlists: Vec<ProgressSnapshotV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProgressV2 {
    schema_version: u16,
    job_id: u64,
    attempt: u32,
    phase: JobPhase,
    stage: Option<ProcessingStage>,
    downloaded_bytes: u64,
    transfer_total: Option<u64>,
    total_kind: TotalKind,
    progress_kind: ProgressKind,
    final_size: Option<u64>,
    updated_at_ms: u64,
    resume_reused_bytes: u64,
    session_transferred_bytes: u64,
    snapshot: ProgressSnapshotV2,
}

#[derive(Debug, Default)]
struct CoordinatorState {
    jobs: HashMap<u64, ProgressSnapshotV2>,
    playlists: HashMap<u64, ProgressSnapshotV2>,
    pending_deltas: BTreeMap<u64, ProgressDeltaV2>,
    pending_persistence: HashMap<u64, PersistedProgressV2>,
    pending_batches: HashMap<u64, ProgressSnapshotV2>,
    playlist_progress: HashMap<u64, (u32, f64, ProgressKind)>,
    resume_reused_bytes: HashMap<u64, u64>,
    sequence: u64,
    last_publish: Option<Instant>,
    last_persist: Option<Instant>,
    force_persist: bool,
    #[cfg(not(test))]
    app: Option<AppHandle>,
    db_path: Option<PathBuf>,
}

static COORDINATOR: OnceLock<Mutex<CoordinatorState>> = OnceLock::new();
static PERSISTENCE_WORKER: OnceLock<()> = OnceLock::new();

fn state() -> &'static Mutex<CoordinatorState> {
    COORDINATOR.get_or_init(|| Mutex::new(CoordinatorState::default()))
}

pub(crate) fn initialize(app: AppHandle, db_path: PathBuf) {
    #[cfg(test)]
    let _ = &app;
    if let Ok(mut guard) = state().lock() {
        #[cfg(not(test))]
        {
            guard.app = Some(app);
        }
        guard.db_path = Some(db_path);
    }
    let _ = PERSISTENCE_WORKER.get_or_init(|| {
        thread::Builder::new()
            .name("cacatools-progress-v2-persistence".into())
            .spawn(|| loop {
                thread::sleep(PERSIST_INTERVAL);
                let _ = flush_persistence(false);
            })
            .expect("progress persistence worker");
    });
    recover_persisted_state();
}

pub(crate) fn mode() -> ProgressEngineMode {
    ProgressEngineMode::from_environment()
}

pub(crate) fn status() -> serde_json::Value {
    let mode = mode();
    let ui_source = match mode {
        ProgressEngineMode::Stable => "stable_metadata_plus_v2_live_projection",
        ProgressEngineMode::V1 => "legacy_sqlite_snapshot",
        ProgressEngineMode::Compare => "legacy_snapshot_plus_v2_live_overlay",
        ProgressEngineMode::V2 => "legacy_snapshot_identity_plus_v2_live_state",
    };
    serde_json::json!({
        "mode": mode.as_str(),
        "v2_ready": true,
        "shadow_comparator": true,
        "coordinator_executed": true,
        "persistence": "legacy_sqlite_plus_v2_coordinator",
        "ui_source": ui_source,
        "diagnostic": cfg!(debug_assertions),
        "event": PROGRESS_V2_EVENT,
        "publish_interval_ms": PUBLISH_INTERVAL.as_millis(),
        "persistence_interval_ms": PERSIST_INTERVAL.as_millis()
    })
}

pub(crate) fn accept(snapshot: ProgressSnapshotV2) {
    super::diagnostics::record(
        "progress_coordinator_v2",
        Some(snapshot.job_id as i64),
        "job_snapshot",
    );
    let Ok(mut guard) = state().lock() else {
        return;
    };
    let snapshot = cohere_live_phase(snapshot);
    let job_id = snapshot.job_id;
    let previous = guard.jobs.insert(job_id, snapshot.clone());
    let changed_fields = changed_fields(previous.as_ref(), &snapshot);
    if changed_fields.is_empty() && previous.is_some() {
        return;
    }
    guard.sequence = guard.sequence.saturating_add(1);
    let critical = previous
        .as_ref()
        .map(|old| old.phase != snapshot.phase || snapshot.phase.is_terminal())
        .unwrap_or(true);
    let delta = ProgressDeltaV2 {
        schema_version: PERSIST_SCHEMA_VERSION,
        sequence: guard.sequence,
        job_id,
        inserted: previous.is_none(),
        removed: false,
        changed_fields,
        critical,
        snapshot: Some(snapshot.clone()),
    };
    merge_delta(&mut guard.pending_deltas, delta);
    super::diagnostics::record("progress_delta_generated", Some(job_id as i64), "job_delta");
    let force = critical || snapshot.phase.is_terminal();
    let reused_bytes = guard
        .resume_reused_bytes
        .get(&job_id)
        .copied()
        .unwrap_or_default();
    guard.pending_persistence.insert(
        job_id,
        PersistedProgressV2 {
            schema_version: PERSIST_SCHEMA_VERSION,
            job_id,
            attempt: snapshot.attempt,
            phase: snapshot.phase,
            stage: snapshot.stage,
            downloaded_bytes: snapshot.transfer.downloaded_bytes,
            transfer_total: snapshot.transfer.total_bytes,
            total_kind: snapshot.transfer.total_kind,
            progress_kind: snapshot.transfer.progress_kind,
            final_size: snapshot.final_size,
            updated_at_ms: now_ms(),
            resume_reused_bytes: reused_bytes,
            session_transferred_bytes: session_transferred_bytes(
                snapshot.transfer.downloaded_bytes,
                reused_bytes,
            ),
            snapshot,
        },
    );
    guard.force_persist |= force;
    let should_publish = force
        || guard
            .last_publish
            .map(|at| at.elapsed() >= PUBLISH_INTERVAL)
            .unwrap_or(true);
    let publish = should_publish.then(|| drain_deltas(&mut guard));
    drop(guard);
    if let Some(envelope) = publish {
        emit(envelope);
    }
}

pub(crate) fn accept_playlist(snapshot: ProgressSnapshotV2) {
    super::diagnostics::record(
        "progress_coordinator_v2",
        Some(snapshot.job_id as i64),
        "playlist_snapshot",
    );
    let Ok(mut guard) = state().lock() else {
        return;
    };
    let snapshot = stabilize_playlist_snapshot(&mut guard, cohere_live_phase(snapshot));
    let batch_id = snapshot.job_id;
    let previous = guard.playlists.insert(batch_id, snapshot.clone());
    let changed = changed_fields(previous.as_ref(), &snapshot);
    if changed.is_empty() && previous.is_some() {
        return;
    }
    guard.sequence = guard.sequence.saturating_add(1);
    let critical = previous
        .as_ref()
        .map(|old| old.phase != snapshot.phase || snapshot.phase.is_terminal())
        .unwrap_or(true);
    let delta = ProgressDeltaV2 {
        schema_version: PERSIST_SCHEMA_VERSION,
        sequence: guard.sequence,
        job_id: batch_id,
        inserted: previous.is_none(),
        removed: false,
        changed_fields: changed,
        critical,
        snapshot: Some(snapshot.clone()),
    };
    merge_delta(&mut guard.pending_deltas, delta);
    super::diagnostics::record(
        "progress_delta_generated",
        Some(batch_id as i64),
        "playlist_delta",
    );
    guard.pending_batches.insert(batch_id, snapshot);
    guard.force_persist |= critical;
    let should_publish = critical
        || guard
            .last_publish
            .map(|at| at.elapsed() >= PUBLISH_INTERVAL)
            .unwrap_or(true);
    let publish = should_publish.then(|| drain_deltas(&mut guard));
    drop(guard);
    if let Some(envelope) = publish {
        emit(envelope);
    }
}

pub(crate) fn set_reused_bytes(job_id: i64, reused_bytes: u64) {
    if let Ok(mut guard) = state().lock() {
        guard
            .resume_reused_bytes
            .insert(job_id.max(0) as u64, reused_bytes);
    }
}

pub(crate) fn remove(job_id: i64) {
    let Ok(mut guard) = state().lock() else {
        return;
    };
    let key = job_id.max(0) as u64;
    guard.jobs.remove(&key);
    guard.playlists.remove(&key);
    guard.playlist_progress.remove(&key);
    guard.pending_persistence.remove(&key);
    guard.sequence = guard.sequence.saturating_add(1);
    let delta = ProgressDeltaV2 {
        schema_version: PERSIST_SCHEMA_VERSION,
        sequence: guard.sequence,
        job_id: key,
        inserted: false,
        removed: true,
        changed_fields: vec!["removed".into()],
        critical: true,
        snapshot: None,
    };
    guard.pending_deltas.insert(key, delta);
    let envelope = drain_deltas(&mut guard);
    drop(guard);
    emit(envelope);
}

pub(crate) fn reset_playlist_progress(batch_id: i64) {
    if let Ok(mut guard) = state().lock() {
        guard.playlist_progress.remove(&(batch_id.max(0) as u64));
    }
}

pub(crate) fn full_snapshot() -> ProgressV2FullSnapshot {
    let Ok(guard) = state().lock() else {
        return ProgressV2FullSnapshot {
            schema_version: PERSIST_SCHEMA_VERSION,
            mode: mode().as_str().into(),
            sequence: 0,
            jobs: Vec::new(),
            playlists: Vec::new(),
        };
    };
    ProgressV2FullSnapshot {
        schema_version: PERSIST_SCHEMA_VERSION,
        mode: mode().as_str().into(),
        sequence: guard.sequence,
        jobs: guard.jobs.values().cloned().collect(),
        playlists: guard.playlists.values().cloned().collect(),
    }
}

pub(crate) fn job_snapshot(job_id: i64) -> Option<ProgressSnapshotV2> {
    state()
        .lock()
        .ok()
        .and_then(|guard| guard.jobs.get(&(job_id.max(0) as u64)).cloned())
}

pub(crate) fn playlist_snapshot(batch_id: i64) -> Option<ProgressSnapshotV2> {
    state()
        .lock()
        .ok()
        .and_then(|guard| guard.playlists.get(&(batch_id.max(0) as u64)).cloned())
}

fn changed_fields(before: Option<&ProgressSnapshotV2>, after: &ProgressSnapshotV2) -> Vec<String> {
    let Some(before) = before else {
        return vec!["snapshot".into()];
    };
    let mut fields = Vec::new();
    if before.phase != after.phase {
        fields.push("phase".into());
    }
    if before.stage != after.stage {
        fields.push("stage".into());
    }
    if before.transfer.downloaded_bytes != after.transfer.downloaded_bytes {
        fields.push("downloadedBytes".into());
    }
    if before.transfer.total_bytes != after.transfer.total_bytes
        || before.transfer.total_kind != after.transfer.total_kind
    {
        fields.push("transferTotal".into());
    }
    if before.transfer.progress != after.transfer.progress
        || before.transfer.progress_kind != after.transfer.progress_kind
    {
        fields.push("progress".into());
    }
    if before.transfer.speed_bps != after.transfer.speed_bps
        || before.transfer.speed_kind != after.transfer.speed_kind
    {
        fields.push("speed".into());
    }
    if before.transfer.eta_seconds != after.transfer.eta_seconds
        || before.transfer.eta_kind != after.transfer.eta_kind
    {
        fields.push("eta".into());
    }
    if before.final_size != after.final_size {
        fields.push("finalSize".into());
    }
    if before.attempt != after.attempt {
        fields.push("attempt".into());
    }
    if before.streams != after.streams {
        fields.push("streams".into());
    }
    if before.playlist != after.playlist {
        fields.push("playlist".into());
    }
    fields
}

fn merge_delta(pending: &mut BTreeMap<u64, ProgressDeltaV2>, delta: ProgressDeltaV2) {
    if let Some(existing) = pending.get_mut(&delta.job_id) {
        existing.sequence = delta.sequence;
        existing.inserted |= delta.inserted;
        existing.removed = delta.removed;
        existing.critical |= delta.critical;
        existing.snapshot = delta.snapshot;
        for field in delta.changed_fields {
            if !existing.changed_fields.contains(&field) {
                existing.changed_fields.push(field);
            }
        }
    } else {
        pending.insert(delta.job_id, delta);
    }
}

fn drain_deltas(guard: &mut CoordinatorState) -> ProgressDeltaEnvelopeV2 {
    let deltas = guard.pending_deltas.values().cloned().collect();
    guard.pending_deltas.clear();
    guard.last_publish = Some(Instant::now());
    ProgressDeltaEnvelopeV2 {
        schema_version: PERSIST_SCHEMA_VERSION,
        generated_at_ms: now_ms(),
        deltas,
    }
}

#[cfg(not(test))]
fn emit(envelope: ProgressDeltaEnvelopeV2) {
    super::diagnostics::record(
        "ipc_emit_progress_v2_delta",
        None,
        format!("deltas={}", envelope.deltas.len()),
    );
    let app = state().lock().ok().and_then(|guard| guard.app.clone());
    if let Some(app) = app {
        let _ = app.emit(PROGRESS_V2_EVENT, envelope);
    }
}

#[cfg(test)]
fn emit(_envelope: ProgressDeltaEnvelopeV2) {}

pub(crate) fn flush_persistence(force: bool) -> Result<usize, String> {
    let (path, records, batches) = {
        let Ok(mut guard) = state().lock() else {
            return Ok(0);
        };
        let due = force
            || guard.force_persist
            || guard
                .last_persist
                .map(|at| at.elapsed() >= PERSIST_INTERVAL)
                .unwrap_or(true);
        if !due || (guard.pending_persistence.is_empty() && guard.pending_batches.is_empty()) {
            return Ok(0);
        }
        let path = guard.db_path.clone();
        let records = guard
            .pending_persistence
            .drain()
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        let batches = guard
            .pending_batches
            .drain()
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        guard.force_persist = false;
        guard.last_persist = Some(Instant::now());
        (path, records, batches)
    };
    let Some(path) = path else {
        requeue_persistence(records, batches);
        return Ok(0);
    };
    let result = (|| {
        let connection = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
        crate::configure_connection(&connection).map_err(|error| error.to_string())?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        for record in &records {
            let json = serde_json::to_string(record).map_err(|error| error.to_string())?;
            transaction.execute(
                "INSERT INTO progress_v2_jobs(job_id,schema_version,attempt,phase,stage,downloaded_bytes,transfer_total,total_kind,progress_kind,final_size,updated_at_ms,resume_reused_bytes,session_transferred_bytes,snapshot_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(job_id) DO UPDATE SET schema_version=excluded.schema_version,attempt=excluded.attempt,phase=excluded.phase,stage=excluded.stage,downloaded_bytes=excluded.downloaded_bytes,transfer_total=excluded.transfer_total,total_kind=excluded.total_kind,progress_kind=excluded.progress_kind,final_size=excluded.final_size,updated_at_ms=excluded.updated_at_ms,resume_reused_bytes=excluded.resume_reused_bytes,session_transferred_bytes=excluded.session_transferred_bytes,snapshot_json=excluded.snapshot_json",
                rusqlite::params![record.job_id, record.schema_version, record.attempt, serde_json::to_string(&record.phase).unwrap_or_default(), record.stage.as_ref().map(|stage| serde_json::to_string(stage).unwrap_or_default()), record.downloaded_bytes as i64, record.transfer_total.map(|value| value as i64), serde_json::to_string(&record.total_kind).unwrap_or_default(), serde_json::to_string(&record.progress_kind).unwrap_or_default(), record.final_size.map(|value| value as i64), record.updated_at_ms as i64, record.resume_reused_bytes as i64, record.session_transferred_bytes as i64, json],
            ).map_err(|error| error.to_string())?;
        }
        for snapshot in &batches {
            let json = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO progress_v2_batches(batch_id,schema_version,updated_at_ms,snapshot_json) VALUES(?1,?2,?3,?4) ON CONFLICT(batch_id) DO UPDATE SET schema_version=excluded.schema_version,updated_at_ms=excluded.updated_at_ms,snapshot_json=excluded.snapshot_json",
                    rusqlite::params![snapshot.job_id as i64, PERSIST_SCHEMA_VERSION, now_ms() as i64, json],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(records.len() + batches.len())
    })();
    if result.is_err() {
        requeue_persistence(records, batches);
    }
    result
}

fn requeue_persistence(records: Vec<PersistedProgressV2>, batches: Vec<ProgressSnapshotV2>) {
    if let Ok(mut guard) = state().lock() {
        for record in records {
            guard.pending_persistence.insert(record.job_id, record);
        }
        for snapshot in batches {
            guard.pending_batches.insert(snapshot.job_id, snapshot);
        }
        guard.force_persist = true;
    }
}

fn recover_persisted_state() {
    let path = state().lock().ok().and_then(|guard| guard.db_path.clone());
    let Some(path) = path else {
        return;
    };
    let Ok(connection) = rusqlite::Connection::open(path) else {
        return;
    };
    let mut statement =
        match connection.prepare("SELECT job_id,snapshot_json FROM progress_v2_jobs") {
            Ok(value) => value,
            Err(_) => return,
        };
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map(|rows| rows.flatten().collect::<Vec<_>>())
        .unwrap_or_default();
    drop(statement);
    let batch_rows = connection
        .prepare("SELECT batch_id,snapshot_json FROM progress_v2_batches")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map(|rows| rows.flatten().collect::<Vec<_>>())
        })
        .unwrap_or_default();
    if let Ok(mut guard) = state().lock() {
        for row in rows {
            if let Ok(snapshot) = serde_json::from_str::<ProgressSnapshotV2>(&row.1) {
                let snapshot = recover_snapshot(snapshot);
                if snapshot.phase == JobPhase::Queued || snapshot.phase.is_terminal() {
                    guard.jobs.insert(row.0.max(0) as u64, snapshot);
                }
            }
        }
        for row in batch_rows {
            if let Ok(snapshot) = serde_json::from_str::<ProgressSnapshotV2>(&row.1) {
                let snapshot = recover_snapshot(snapshot);
                guard.playlists.insert(row.0.max(0) as u64, snapshot);
            }
        }
    }
}

fn recover_snapshot(mut snapshot: ProgressSnapshotV2) -> ProgressSnapshotV2 {
    if snapshot.phase.is_active() && snapshot.phase != JobPhase::Queued {
        snapshot.phase = JobPhase::Queued;
        snapshot.stage = None;
    }
    snapshot
}

fn cohere_live_phase(mut snapshot: ProgressSnapshotV2) -> ProgressSnapshotV2 {
    if snapshot.phase == JobPhase::Queued {
        let stream_is_downloading = snapshot
            .streams
            .iter()
            .any(|stream| stream.state == StreamPhase::Downloading);
        let stream_is_preparing = snapshot.streams.iter().any(|stream| {
            matches!(
                stream.state,
                StreamPhase::Preparing | StreamPhase::Downloading
            )
        });
        let playlist_is_active = snapshot.playlist.as_ref().is_some_and(|playlist| {
            playlist.preparing > 0
                || playlist.downloading > 0
                || playlist.processing > 0
                || playlist.paused > 0
        });
        let has_live_transfer = snapshot.transfer.downloaded_bytes > 0
            || snapshot.transfer.speed_bps.unwrap_or_default() > 0.0;
        if stream_is_downloading || has_live_transfer {
            snapshot.phase = JobPhase::Downloading;
        } else if stream_is_preparing || playlist_is_active {
            snapshot.phase = JobPhase::Preparing;
        }
    }
    snapshot
}

fn stabilize_playlist_snapshot(
    guard: &mut CoordinatorState,
    mut snapshot: ProgressSnapshotV2,
) -> ProgressSnapshotV2 {
    let batch_id = snapshot.job_id;
    let previous = guard.playlists.get(&batch_id);
    let Some(previous_progress) = previous
        .and_then(|previous| previous.transfer.progress)
        .filter(|progress| progress.is_finite())
    else {
        if let Some(progress) = snapshot.transfer.progress {
            guard.playlist_progress.insert(
                batch_id,
                (snapshot.attempt, progress, snapshot.transfer.progress_kind),
            );
        }
        return snapshot;
    };

    if previous.map(|item| item.attempt) != Some(snapshot.attempt) {
        guard.playlist_progress.remove(&batch_id);
        if let Some(progress) = snapshot.transfer.progress {
            guard.playlist_progress.insert(
                batch_id,
                (snapshot.attempt, progress, snapshot.transfer.progress_kind),
            );
        }
        return snapshot;
    }

    let previous_kind = previous
        .map(|item| item.transfer.progress_kind)
        .unwrap_or(ProgressKind::Estimated);
    let current_progress = snapshot.transfer.progress;
    let stable_progress = current_progress
        .filter(|progress| progress.is_finite())
        .map(|progress| progress.max(previous_progress))
        .unwrap_or(previous_progress);
    snapshot.transfer.progress = Some(stable_progress);
    snapshot.transfer.progress_kind = if current_progress.is_some() {
        snapshot.transfer.progress_kind
    } else {
        previous_kind
    };
    if snapshot.transfer.reported_percent.is_none() {
        snapshot.transfer.reported_percent = Some(stable_progress);
    }
    guard.playlist_progress.insert(
        batch_id,
        (
            snapshot.attempt,
            stable_progress,
            snapshot.transfer.progress_kind,
        ),
    );
    snapshot
}

fn session_transferred_bytes(downloaded_bytes: u64, reused_bytes: u64) -> u64 {
    downloaded_bytes.saturating_sub(reused_bytes)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::model::{JobPhase, TotalKind, TransferProgress};

    #[test]
    fn mode_defaults_to_stable_without_environment_override() {
        assert_eq!(ProgressEngineMode::from_environment().as_str(), "stable");
    }

    #[test]
    fn changed_fields_are_field_level_and_terminal_is_critical() {
        let before = ProgressSnapshotV2::new(
            4,
            JobPhase::Downloading,
            TransferProgress::with_total(1, Some(4), TotalKind::Exact),
        );
        let after = ProgressSnapshotV2::new(
            4,
            JobPhase::Completed,
            TransferProgress::with_total(4, Some(4), TotalKind::Exact),
        );
        let fields = changed_fields(Some(&before), &after);
        assert!(fields.iter().any(|field| field == "phase"));
        assert!(after.phase.is_terminal());
    }

    #[test]
    fn coalescing_keeps_latest_snapshot_and_union_of_fields() {
        let mut pending = BTreeMap::new();
        let first = ProgressDeltaV2 {
            schema_version: 1,
            sequence: 1,
            job_id: 1,
            inserted: true,
            removed: false,
            changed_fields: vec!["phase".into()],
            critical: false,
            snapshot: None,
        };
        let second = ProgressDeltaV2 {
            schema_version: 1,
            sequence: 2,
            job_id: 1,
            inserted: false,
            removed: false,
            changed_fields: vec!["downloadedBytes".into()],
            critical: false,
            snapshot: None,
        };
        merge_delta(&mut pending, first);
        merge_delta(&mut pending, second);
        assert_eq!(pending[&1].sequence, 2);
        assert_eq!(pending[&1].changed_fields.len(), 2);
        assert!(pending[&1].inserted);
    }

    #[test]
    fn recovery_never_restores_an_active_phase_as_running() {
        let snapshot = ProgressSnapshotV2::new(
            9,
            JobPhase::PostProcessing,
            TransferProgress::with_total(40, Some(100), TotalKind::Exact),
        );
        let recovered = recover_snapshot(snapshot);
        assert_eq!(recovered.phase, JobPhase::Queued);
        assert_eq!(recovered.stage, None);
        assert_eq!(recovered.transfer.downloaded_bytes, 40);
    }

    #[test]
    fn resume_accounting_separates_reused_bytes_from_session_transfer() {
        assert_eq!(session_transferred_bytes(520, 400), 120);
        assert_eq!(session_transferred_bytes(120, 400), 0);
    }

    #[test]
    fn live_transfer_cannot_remain_queued() {
        let snapshot = ProgressSnapshotV2::new(
            10,
            JobPhase::Queued,
            TransferProgress::with_total(12, Some(100), TotalKind::Exact)
                .with_speed(2048.0, crate::progress::model::SpeedKind::Reported),
        );
        assert_eq!(cohere_live_phase(snapshot).phase, JobPhase::Downloading);
    }

    #[test]
    fn playlist_progress_stays_determinate_during_post_processing() {
        let mut guard = CoordinatorState::default();
        let first = ProgressSnapshotV2::new(
            11,
            JobPhase::Downloading,
            TransferProgress::with_total(42, Some(100), TotalKind::Exact),
        );
        let first = stabilize_playlist_snapshot(&mut guard, first);
        guard.playlists.insert(11, first);
        let stable = stabilize_playlist_snapshot(
            &mut guard,
            ProgressSnapshotV2::new(11, JobPhase::PostProcessing, TransferProgress::unknown(42)),
        );
        assert_eq!(stable.transfer.progress, Some(0.42));
        assert_ne!(stable.transfer.progress_kind, ProgressKind::Unavailable);
    }
}
