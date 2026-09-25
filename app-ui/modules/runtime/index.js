let runtimeConfig = {};
let appState = null;
let previewMode = false;
let snapshotRefreshTimer = 0;
let lastFullSnapshotAt = 0;
let forceFullSnapshotRefresh = false;
let downloadLifecycleListenersStarted = false;
const VISIBLE_ACTIVE_REFRESH_MS = 350;
const VISIBLE_IDLE_REFRESH_MS = 1200;
const BACKGROUND_ACTIVE_REFRESH_MS = 1800;
const BACKGROUND_IDLE_REFRESH_MS = 2400;
const HIDDEN_REFRESH_MS = 2500;
const FULL_SNAPSHOT_REFRESH_MS = 15_000;
// Activity snapshots intentionally omit cold fields such as thumbnails. Keep
// the manager responsive with the fast activity cadence, but refresh the
// complete row data often enough for a thumbnail arriving after queueing to
// appear without requiring a user interaction.
const VISIBLE_FULL_SNAPSHOT_REFRESH_MS = 5_000;
const VISIBLE_THUMBNAIL_SNAPSHOT_REFRESH_MS = 900;
let releaseProgressV2Listener = null;
const pendingProgressByIdentity = new Map();
const MAX_PENDING_PROGRESS = 256;

export function snapshotPollingDelay({ managerVisible = false, documentHidden = false, activeJobs = 0 } = {}) {
  if (documentHidden) return HIDDEN_REFRESH_MS;
  if (managerVisible) return activeJobs > 0 ? VISIBLE_ACTIVE_REFRESH_MS : VISIBLE_IDLE_REFRESH_MS;
  return activeJobs > 0 ? BACKGROUND_ACTIVE_REFRESH_MS : BACKGROUND_IDLE_REFRESH_MS;
}

export function configureRuntime(config = {}) {
  runtimeConfig = config;
  appState = config.getAppState();
  previewMode = Boolean(config.previewMode);
}

function dependency(name, ...args) {
  const value = runtimeConfig[name];
  if (typeof value !== 'function') throw new Error(`Runtime dependency not configured: ${name}`);
  return value(...args);
}
function icon(...args) { return dependency('icon', ...args); }
function escapeHtml(...args) { return dependency('escapeHtml', ...args); }
function formatBytes(...args) { return dependency('formatBytes', ...args); }
function patchDownloadManagerLive(...args) { return dependency('patchDownloadManagerLive', ...args); }
function showToast(...args) { return dependency('showToast', ...args); }
function invoke(...args) { return dependency('invoke', ...args); }
function normalizeAppearance(...args) { return dependency('normalizeAppearance', ...args); }
function scheduleAppearancePersist(...args) { return dependency('scheduleAppearancePersist', ...args); }
function applyAppearance(...args) { return dependency('applyAppearance', ...args); }
function scheduleExtensionStatePublish(...args) { return dependency('scheduleExtensionStatePublish', ...args); }
function hydratePlaylistRuntimeItem(...args) { return dependency('hydratePlaylistRuntimeItem', ...args); }
function stablePlaylistThumbnail(...args) { return dependency('stablePlaylistThumbnail', ...args); }
function playlistPreviewUrl(...args) { return dependency('playlistPreviewUrl', ...args); }
function playlistPlayableThumb(...args) { return dependency('playlistPlayableThumb', ...args); }
function bindPlaylistPreviewButtons(...args) { return dependency('bindPlaylistPreviewButtons', ...args); }
function bindThumbnailFallbacks(...args) { return dependency('bindThumbnailFallbacks', ...args); }
function playlistMetadata(...args) { return dependency('playlistMetadata', ...args); }
function clamp(...args) { return dependency('clamp', ...args); }

function mixSnapshotSignature(hash, value) {
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function snapshotSignature(snapshot = appState.snapshot) {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const playlists = Array.isArray(snapshot?.playlist_batches) ? snapshot.playlist_batches : [];
  let hash = 2166136261;
  for (const job of jobs) {
    for (const value of [job.id, job.status, job.progress, job.detail, job.downloaded_bytes, job.total_bytes, job.total_bytes_estimated, job.speed_bps, job.eta_seconds, job.updated_at, job.title, job.thumbnail, job.destination]) {
      hash = mixSnapshotSignature(hash, value);
    }
  }
  for (const batch of playlists) {
    for (const value of [batch.batch_id, batch.status, batch.progress, batch.downloaded_bytes, batch.total_bytes, batch.total_bytes_estimated, batch.speed_bps, batch.eta_seconds, batch.completed_items, batch.failed_items, batch.active_items, batch.updated_at, batch.title, batch.thumbnail_stack]) {
      hash = mixSnapshotSignature(hash, value);
    }
  }
  const queue = snapshot?.queue || {};
  for (const value of [queue.active, queue.queued, queue.paused, queue.completed_today, queue.failed, queue.total_speed_bps]) {
    hash = mixSnapshotSignature(hash, value);
  }
  return `${jobs.length}:${playlists.length}:${hash >>> 0}`;
}

const HOT_JOB_FIELDS = [
  'id', 'status', 'progress', 'detail', 'downloaded_bytes', 'total_bytes',
  'total_bytes_estimated', 'final_size', 'speed_bps', 'eta_seconds',
  'indeterminate', 'stage', 'updated_at'
];
const COLD_JOB_FIELDS = ['title', 'thumbnail', 'source_url', 'destination', 'kind', 'engine'];
const HOT_PLAYLIST_FIELDS = [
  'batch_id', 'status', 'progress', 'downloaded_bytes', 'total_bytes',
  'total_bytes_estimated', 'final_size', 'speed_bps', 'eta_seconds',
  'completed_items', 'failed_items', 'active_items', 'updated_at', 'stage', 'indeterminate'
];
const COLD_PLAYLIST_FIELDS = ['title', 'format', 'thumbnail_stack', 'destination'];

function snapshotRowSignature(row, fields) {
  return fields.map((field) => String(row?.[field] ?? '')).join('\u0001');
}

export function snapshotChangedJobIds(before, after, activityOnly = true) {
  if (!before || !after) return null;
  const changed = new Set();
  const compare = (beforeRows, afterRows, fields, keyOf) => {
    const previous = new Map((Array.isArray(beforeRows) ? beforeRows : []).map((row) => [keyOf(row), row]));
    const current = new Map((Array.isArray(afterRows) ? afterRows : []).map((row) => [keyOf(row), row]));
    current.forEach((row, key) => {
      const old = previous.get(key);
      if (!old || snapshotRowSignature(old, fields) !== snapshotRowSignature(row, fields)) changed.add(String(key));
    });
    if (!activityOnly) previous.forEach((_row, key) => { if (!current.has(key)) changed.add(String(key)); });
  };
  const jobFields = activityOnly ? HOT_JOB_FIELDS : [...HOT_JOB_FIELDS, ...COLD_JOB_FIELDS];
  const playlistFields = activityOnly ? HOT_PLAYLIST_FIELDS : [...HOT_PLAYLIST_FIELDS, ...COLD_PLAYLIST_FIELDS];
  compare(before.jobs, after.jobs, jobFields, (row) => row?.id);
  compare(before.playlist_batches, after.playlist_batches, playlistFields, (row) => `batch:${row?.batch_id}`);
  for (const row of (Array.isArray(after.playlist_batches) ? after.playlist_batches : [])) {
    if (changed.has(`batch:${row?.batch_id}`)) changed.add(String(-1_000_000_000 - Number(row?.batch_id || 0)));
  }
  return changed;
}

function patchDynamicSnapshot() {
  rememberQueueSpeed();
  const jobs = currentJobs();
  const queueCount = document.querySelector('.downloads-queue-panel .count-badge');
  if (queueCount && queueCount.textContent !== `${jobs.length} activas`) queueCount.textContent = `${jobs.length} activas`;
  const metrics = queueMetrics();
  const queueFooter = document.querySelector('.queue-footer');
  if (queueFooter) queueFooter.innerHTML = `<span>${jobs.length} tareas visibles · ${metrics.completed} completadas hoy</span><span>${icon('trend', 17)} Velocidad total: <strong>${downloadQueueSpeed()}</strong></span>`;
  const values = [metrics.active, metrics.queued, metrics.paused, metrics.completed, metrics.failed, downloadQueueSpeed()];
  document.querySelectorAll('.queue-summary-card dd').forEach((node, index) => {
    if (values[index] !== undefined) node.textContent = String(values[index]);
  });
  const wave = document.querySelector('.queue-summary-card .mini-wave');
  if (wave) wave.innerHTML = queueHistoryMarkup();
  const storage = appState.snapshot.storage || {};
  const total = Number(storage.total_bytes) || 0;
  const free = Number(storage.free_bytes) || 0;
  const usedPercent = total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : 0;
  const storageBar = document.querySelector('.storage span i');
  if (storageBar) storageBar.style.width = `${usedPercent}%`;
  const storageLabel = document.querySelector('.storage b');
  if (storageLabel) storageLabel.textContent = free > 0 && total > 0 ? `${formatBytes(free)} libres de ${formatBytes(total)}` : 'Calculando almacenamiento⬦';
  bindDynamicListEvents();
  animateDownloadProgressBars();
}

function bindDynamicListEvents() {
  document.querySelectorAll('.pause-btn').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const item = button.closest('.download-item');
      const id = Number(item?.dataset.job || 0);
      if (!id) return;
      try {
        await invoke('set_job_status', { id, status: item.classList.contains('paused') ? 'running' : 'paused' });
        await loadSnapshot();
        patchDynamicSnapshot();
      } catch (error) { showToast(error, 'error'); }
    });
  });
  document.querySelectorAll('.remove-btn').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const id = Number(button.closest('.download-item')?.dataset.job || 0);
      if (!id) return;
      try { await invoke('set_job_status', { id, status: 'cancelled' }); await loadSnapshot(); patchDynamicSnapshot(); }
      catch (error) { showToast(error, 'error'); }
    });
  });
  document.querySelectorAll('.recent-item[data-path]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const path = button.dataset.path;
      if (!path) return;
      try { await invoke('open_local_file', { path }); }
      catch (error) { showToast(error, 'error'); }
    });
  });
}

function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  return value > 0 ? `${formatBytes(value)}/s` : 'Sin actividad';
}

function mergeSnapshotRows(previousRows, partialRows, keyOf) {
  const merged = new Map((Array.isArray(previousRows) ? previousRows : []).map((row) => [keyOf(row), row]));
  (Array.isArray(partialRows) ? partialRows : []).forEach((row) => {
    const key = keyOf(row);
    if (key !== null && key !== undefined) merged.set(key, row);
  });
  return [...merged.values()];
}

export function mergeActivitySnapshot(previous = {}, activity = {}) {
  return {
    ...previous,
    ...activity,
    queue: activity.queue || previous.queue || {},
    jobs: mergeSnapshotRows(previous.jobs, activity.jobs, (row) => String(row?.id ?? '')),
    playlist_batches: mergeSnapshotRows(
      previous.playlist_batches,
      activity.playlist_batches,
      (row) => String(row?.batch_id ?? row?.id ?? '')
    )
  };
}

const LEGACY_PROCESSING_STAGES = new Set([
  'Combinando video y audio',
  'Convirtiendo',
  'Validando',
  'Preparando',
  'Procesando',
  'Finalizando'
]);

export function retainLegacyDeterminateProgress(previous = {}, next = {}) {
  const preserve = (before, current) => {
    if (!before || !current || String(current.status || '') !== 'running') return current;
    const previousProgress = Number(before.progress);
    const currentProgress = Number(current.progress);
    if (!Number.isFinite(previousProgress) || previousProgress <= 0) return current;
    if (!Number.isFinite(currentProgress) || currentProgress >= previousProgress) return current;
    const processing = LEGACY_PROCESSING_STAGES.has(String(current.stage || '')) || Boolean(current.indeterminate);
    if (!processing) return current;
    return {
      ...current,
      progress: previousProgress,
      indeterminate: false,
      progress_estimated: Boolean(current.progress_estimated || before.progress_estimated),
      progressEstimated: Boolean(current.progressEstimated || before.progressEstimated)
    };
  };
  const previousJobs = new Map((Array.isArray(previous.jobs) ? previous.jobs : []).map((job) => [String(job?.id), job]));
  const previousPlaylists = new Map((Array.isArray(previous.playlist_batches) ? previous.playlist_batches : []).map((batch) => [String(batch?.batch_id ?? batch?.id), batch]));
  return {
    ...next,
    jobs: (Array.isArray(next.jobs) ? next.jobs : []).map((job) => preserve(previousJobs.get(String(job?.id)), job)),
    playlist_batches: (Array.isArray(next.playlist_batches) ? next.playlist_batches : []).map((batch) => preserve(previousPlaylists.get(String(batch?.batch_id ?? batch?.id)), batch))
  };
}

function phaseToLegacyStatus(phase, fallback = 'running') {
  const map = {
    queued: 'queued', preparing: 'running', downloading: 'running', post_processing: 'running',
    finalizing: 'running', paused: 'paused', completed: 'completed', failed: 'failed',
    cancelling: 'running', cancelled: 'cancelled'
  };
  return map[String(phase || '')] || fallback;
}

function stageToLegacyLabel(stage, fallback = '') {
  const map = {
    merging: 'Combinando video y audio',
    remuxing: 'Combinando video y audio',
    converting: 'Convirtiendo',
    extracting_audio: 'Extrayendo audio',
    tagging: 'Añadiendo metadatos',
    embedding_metadata: 'Añadiendo metadatos',
    embedding_artwork: 'Añadiendo portada',
    probing: 'Analizando archivo',
    verifying: 'Validando'
  };
  return map[String(stage || '')] || fallback;
}

function isProgressV2UiMode() {
  const mode = appState?.progressEngineStatus?.mode;
  return mode === 'v2';
}

function shouldObserveProgressV2() {
  const mode = appState?.progressEngineStatus?.mode;
  return mode === 'stable' || mode === 'compare' || mode === 'v2';
}

function stableIdentity(row, kind = 'job') {
  const id = row?.[kind === 'playlist' ? 'batch_id' : 'id'];
  const title = String(row?.title || '').trim();
  if (id === undefined || id === null || id === '') return '';
  if (!title || /^(?:Descarga en curso|Playlist en curso|Descarga sin nombre|Playlist sin nombre)$/i.test(title)) return '';
  return `${kind}:${String(id)}`;
}

function bufferProgressSnapshot(snapshot, kind) {
  const id = Number(snapshot?.job_id ?? snapshot?.jobId ?? 0);
  if (!id) return;
  const key = `${kind}:${id}`;
  pendingProgressByIdentity.delete(key);
  pendingProgressByIdentity.set(key, { kind, snapshot });
  while (pendingProgressByIdentity.size > MAX_PENDING_PROGRESS) {
    pendingProgressByIdentity.delete(pendingProgressByIdentity.keys().next().value);
  }
  recordProgressUiDiagnostic('progress_buffered_without_identity', key);
}

function recordProgressUiDiagnostic(stage, detail = '') {
  if (!appState?.progressEngineStatus?.diagnostic) return;
  const trace = Array.isArray(appState.progressUiTrace) ? appState.progressUiTrace : [];
  trace.push({ stage, atMs: Date.now(), detail: String(detail || '') });
  if (trace.length > 128) trace.splice(0, trace.length - 128);
  appState.progressUiTrace = trace;
  console.debug(`[progress-engine] ${stage}`, detail);
}

function markProgressEngineFailure(stage, error) {
  const detail = String(error || stage);
  recordProgressUiDiagnostic(stage, detail);
  if (isProgressV2UiMode()) {
    appState.progressEngineStatus = {
      ...appState.progressEngineStatus,
      v2_ready: false,
      ui_source: 'stable_v2_unavailable',
      runtime_error: stage
    };
  }
}

async function progressV2FullSnapshot() {
  try {
    return await invoke('progress_v2_full_snapshot');
  } catch (error) {
    markProgressEngineFailure('v2_full_snapshot_failed', error);
    return null;
  }
}

function applyProgressV2Snapshot(base, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return base;
  const transfer = snapshot.transfer || {};
  const next = { ...base };
  const phase = String(snapshot.phase || '');
  const downloadedBytes = Number(transfer.downloadedBytes ?? transfer.downloaded_bytes ?? next.downloaded_bytes ?? next.downloadedBytes ?? 0);
  const totalBytes = transfer.transferTotal ?? transfer.totalBytes ?? transfer.total_bytes ?? null;
  const totalKind = transfer.totalKind ?? transfer.total_kind;
  const transferProgress = transfer.progress;
  const transferProgressKind = transfer.progressKind ?? transfer.progress_kind;
  const phaseProgress = snapshot.phaseProgress ?? snapshot.phase_progress;
  const phaseProgressKind = snapshot.phaseProgressKind ?? snapshot.phase_progress_kind;
  const processingPhase = phase === 'post_processing' || phase === 'finalizing';
  const visibleProgress = processingPhase && phaseProgress != null ? phaseProgress : transferProgress;
  const visibleProgressKind = processingPhase && phaseProgress != null ? phaseProgressKind : transferProgressKind;
  next.status = phaseToLegacyStatus(snapshot.phase, next.status);
  next.downloaded_bytes = downloadedBytes;
  next.downloadedBytes = downloadedBytes;
  next.total_bytes = totalBytes;
  next.totalBytes = totalBytes;
  next.total_bytes_estimated = totalKind === 'estimated';
  next.totalBytesEstimated = totalKind === 'estimated';
  next.progress_estimated = visibleProgressKind === 'estimated';
  next.progressEstimated = visibleProgressKind === 'estimated';
  next.progress = visibleProgress == null ? Number(next.progress || 0) : Number(visibleProgress) * 100;
  next.speed_bps = phase === 'paused'
    ? 0
    : Number(transfer.speedBps ?? transfer.speed_bps ?? next.speed_bps ?? next.speedBps ?? 0);
  next.speedBps = next.speed_bps;
  next.eta_seconds = phase === 'paused'
    ? null
    : transfer.etaSeconds ?? transfer.eta_seconds ?? next.eta_seconds ?? next.etaSeconds ?? null;
  next.etaSeconds = next.eta_seconds;
  next.final_size = snapshot.finalSize ?? snapshot.final_size ?? next.final_size ?? next.finalSize ?? null;
  next.finalSize = next.final_size;
  next.stage = snapshot.stage
    ? stageToLegacyLabel(snapshot.stage, next.stage || '')
    : phase === 'finalizing'
      ? 'Finalizando'
      : phase === 'post_processing'
        ? 'Procesando'
        : next.stage || '';
  next.indeterminate = visibleProgress == null && visibleProgressKind === 'unavailable' && next.status === 'running';
  if (next.status === 'completed') next.progress = 100;
  return next;
}

// Stable projection boundary: legacy rows provide identity and the
// coordinator snapshot provides every live field.  Components consume the
// resulting snapshot and do not select V1/SQLite/V2 independently.
function buildStableProgressViewModel(snapshot = {}) {
  const jobs = (Array.isArray(snapshot.jobs) ? snapshot.jobs : []).map((job) => {
    const paused = String(job.status || '') === 'paused';
    return {
      ...job,
      speed_bps: paused ? 0 : Math.max(0, Number(job.speed_bps ?? job.speedBps ?? 0) || 0),
      eta_seconds: paused ? null : job.eta_seconds ?? job.etaSeconds ?? null,
      progress_source: 'progress_coordinator_v2'
    };
  });
  const playlist_batches = (Array.isArray(snapshot.playlist_batches) ? snapshot.playlist_batches : []).map((batch) => ({
    ...batch,
    speed_bps: String(batch.status || '') === 'paused' ? 0 : Math.max(0, Number(batch.speed_bps ?? batch.speedBps ?? 0) || 0),
    progress_source: 'progress_coordinator_v2'
  }));
  return { ...snapshot, jobs, playlist_batches };
}

function playlistDomId(snapshot) {
  const batchId = Number(snapshot?.job_id ?? snapshot?.jobId ?? 0);
  return String(-1_000_000_000 - batchId);
}

function applyProgressV2ToSnapshot(base = {}, payload = {}) {
  const next = { ...base, jobs: [...(base.jobs || [])], playlist_batches: [...(base.playlist_batches || [])] };
  const jobsById = new Map(next.jobs.map((job) => [String(job.id), job]));
  for (const snapshot of payload.jobs || []) {
    const key = String(snapshot.job_id ?? snapshot.jobId ?? '');
    const previous = jobsById.get(key);
    if (!stableIdentity(previous, 'job')) {
      bufferProgressSnapshot(snapshot, 'job');
      continue;
    }
    jobsById.set(key, applyProgressV2Snapshot(previous, snapshot));
  }
  next.jobs = [...jobsById.values()];
  const batchesById = new Map(next.playlist_batches.map((batch) => [String(batch.batch_id), batch]));
  for (const snapshot of payload.playlists || []) {
    const key = String(snapshot.job_id ?? snapshot.jobId ?? '');
    const previous = batchesById.get(key);
    if (!stableIdentity(previous, 'playlist')) {
      bufferProgressSnapshot(snapshot, 'playlist');
      continue;
    }
    const updated = applyProgressV2Snapshot(previous, snapshot);
    const playlist = snapshot.playlist || {};
    updated.completed_items = Number(playlist.completed ?? previous.completed_items ?? 0);
    updated.failed_items = Number(playlist.failed ?? previous.failed_items ?? 0);
    updated.active_items = Number((playlist.downloading || 0) + (playlist.processing || 0) + (playlist.preparing || 0));
    updated.total_items = Number(playlist.totalItems ?? playlist.total_items ?? previous.total_items ?? 0);
    updated.playlistCompleted = updated.completed_items;
    updated.playlistFailed = updated.failed_items;
    updated.playlistActive = updated.active_items;
    updated.playlistTotal = updated.total_items;
    batchesById.set(key, updated);
  }
  next.playlist_batches = [...batchesById.values()];
  for (const [key, entry] of pendingProgressByIdentity) {
    const [kind, id] = key.split(':');
    if (kind === 'job') {
      const base = next.jobs.find((job) => String(job.id) === id);
      if (stableIdentity(base, 'job')) {
        const updated = applyProgressV2Snapshot(base, entry.snapshot);
        next.jobs = next.jobs.map((job) => String(job.id) === id ? updated : job);
        pendingProgressByIdentity.delete(key);
      }
    } else if (kind === 'playlist') {
      const base = next.playlist_batches.find((batch) => String(batch.batch_id) === id);
      if (stableIdentity(base, 'playlist')) {
        const playlist = entry.snapshot.playlist || {};
        const updated = applyProgressV2Snapshot(base, entry.snapshot);
        updated.completed_items = Number(playlist.completed ?? base.completed_items ?? 0);
        updated.failed_items = Number(playlist.failed ?? base.failed_items ?? 0);
        updated.active_items = Number((playlist.downloading || 0) + (playlist.processing || 0) + (playlist.preparing || 0));
        updated.total_items = Number(playlist.totalItems ?? playlist.total_items ?? base.total_items ?? 0);
        updated.playlistCompleted = updated.completed_items;
        updated.playlistFailed = updated.failed_items;
        updated.playlistActive = updated.active_items;
        updated.playlistTotal = updated.total_items;
        next.playlist_batches = next.playlist_batches.map((batch) => String(batch.batch_id) === id ? updated : batch);
        pendingProgressByIdentity.delete(key);
      }
    }
  }
  return buildStableProgressViewModel(next);
}

function applyProgressV2Delta(envelope) {
  if (!envelope?.deltas?.length || !shouldObserveProgressV2()) return false;
  recordProgressUiDiagnostic('js_listener_received', `deltas=${envelope.deltas.length}`);
  if (!isProgressV2UiMode()) {
    recordProgressUiDiagnostic('v2_delta_shadow_only', 'Classic+ conserva las filas legacy');
    return false;
  }
  const payload = { jobs: [], playlists: [] };
  const removedJobs = new Set();
  for (const delta of envelope.deltas) {
    if (delta.removed) {
      removedJobs.add(String(delta.job_id ?? delta.jobId ?? ''));
      continue;
    }
    if (!delta.snapshot) continue;
    if (delta.snapshot.playlist) payload.playlists.push(delta.snapshot);
    else payload.jobs.push(delta.snapshot);
  }
  if (!payload.jobs.length && !payload.playlists.length && !removedJobs.size) return false;
  const before = appState.snapshot;
  if (payload.jobs.length || payload.playlists.length) appState.snapshot = applyProgressV2ToSnapshot(appState.snapshot, payload);
  if (removedJobs.size) {
    appState.snapshot = {
      ...appState.snapshot,
      jobs: appState.snapshot.jobs.filter((job) => !removedJobs.has(String(job.id))),
      playlist_batches: appState.snapshot.playlist_batches.filter((batch) => !removedJobs.has(String(batch.batch_id ?? batch.id)))
    };
  }
  const visibleJobIds = new Set((appState.snapshot.jobs || []).map((job) => String(job.id)));
  const visiblePlaylistIds = new Set((appState.snapshot.playlist_batches || []).map((batch) => String(batch.batch_id)));
  const visible = payload.jobs.some((snapshot) => visibleJobIds.has(String(snapshot.job_id ?? snapshot.jobId)))
    || payload.playlists.some((snapshot) => visiblePlaylistIds.has(String(snapshot.job_id ?? snapshot.jobId)))
    || removedJobs.size > 0;
  recordProgressUiDiagnostic(visible ? 'frontend_state_updated' : 'progress_buffered', `jobs=${payload.jobs.length};playlists=${payload.playlists.length}`);
  return visible || before !== appState.snapshot && removedJobs.size > 0;
}

export async function startProgressV2Listener() {
  if (previewMode || releaseProgressV2Listener || !shouldObserveProgressV2()) return;
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') {
    markProgressEngineFailure('js_listener_unavailable', 'Tauri event.listen no disponible');
    return;
  }
  try {
    releaseProgressV2Listener = await listen('progress-v2-delta', (event) => {
    if (!applyProgressV2Delta(event.payload) || !isProgressV2UiMode()) return;
    const changedJobIds = new Set();
    for (const delta of event.payload?.deltas || []) {
      changedJobIds.add(String(delta.job_id ?? delta.jobId ?? ''));
      if (delta.snapshot?.playlist) changedJobIds.add(playlistDomId(delta.snapshot));
    }
    recordProgressUiDiagnostic('row_patch_requested', `jobs=${changedJobIds.size}`);
    const patched = patchDownloadManagerLive({
      snapshot: appState.snapshot,
      pendingJobs: appState.pendingJobs,
      runtimeStatus: appState.runtimeStatus,
      mediaRuntimeStatus: appState.mediaRuntimeStatus,
      downloadDirectory: appState.downloadDirectory,
      schedules: appState.downloadSchedules,
      changedJobIds,
      progressEngineStatus: appState.progressEngineStatus
    });
    recordProgressUiDiagnostic('dom_patch_applied', `result=${patched === true ? 'true' : 'false'}`);
    });
    recordProgressUiDiagnostic('js_listener_registered', 'progress-v2-delta');
  } catch (error) {
    markProgressEngineFailure('js_listener_failed', error);
  }
}

async function loadSnapshot({ includeSettings = false, includeSchedules = true, activityOnly = false } = {}) {
  if (previewMode) return;
  try {
    const useV2LiveState = Boolean(isProgressV2UiMode() && activityOnly && !includeSettings);
    let usedActivitySnapshot = Boolean(activityOnly && !includeSettings && !useV2LiveState);
    const snapshotRequest = useV2LiveState
      ? Promise.resolve(appState.snapshot)
      : usedActivitySnapshot
      ? invoke('download_activity_snapshot').catch((error) => {
        console.warn('Snapshot ligero no disponible; usando snapshot completo.', error);
        usedActivitySnapshot = false;
        return invoke('desktop_snapshot');
      })
      : invoke('desktop_snapshot');
    const [snapshot, schedules] = await Promise.all([
      snapshotRequest,
      includeSchedules
        ? invoke('list_download_schedules').catch((error) => {
          console.warn('No se pudieron cargar las tareas programadas.', error);
          return appState.downloadSchedules;
        })
        : Promise.resolve(appState.downloadSchedules)
    ]);
    const previousSnapshot = appState.snapshot;
    const legacySnapshot = usedActivitySnapshot
      ? mergeActivitySnapshot(appState.snapshot, snapshot)
      : snapshot;
    appState.snapshot = isProgressV2UiMode()
      ? legacySnapshot
      : retainLegacyDeterminateProgress(previousSnapshot, legacySnapshot);
    if (isProgressV2UiMode() && !useV2LiveState) {
      const v2 = await progressV2FullSnapshot();
      if (v2) appState.snapshot = applyProgressV2ToSnapshot(appState.snapshot, v2);
    }
    if (!usedActivitySnapshot) lastFullSnapshotAt = Date.now();
    appState.downloadSchedules = Array.isArray(schedules) ? schedules : [];
    appState.snapshotFailures = 0;
    syncPendingJobs();
    if (includeSettings) {
      const [desktopSettings, remoteAppearance, runtimeStatus, mediaRuntimeStatus, updaterStatus, extensionBridgeStatus, startupStatus, windowBehavior, backgroundLaunch, progressEngineStatus, mediaSessionSettings, experienceSettings, toolUpdateStatus, bandwidthSettings] = await Promise.all([
        invoke('desktop_settings'),
        invoke('get_appearance_settings'),
        invoke('runtime_status'),
        invoke('media_runtime_status').catch(() => null),
        invoke('updater_configuration_status').catch(() => null),
        invoke('extension_bridge_status').catch(() => null),
        invoke('startup_status').catch(() => null),
        invoke('window_behavior_settings').catch(() => ({ closeAction: 'tray', minimizeAction: 'taskbar' })),
        invoke('is_background_launch').catch(() => false),
        invoke('progress_engine_status').catch((error) => ({ mode: 'unavailable', v2_ready: false, status_error: String(error || 'status_unavailable') })),
        invoke('media_session_settings').catch(() => ({ useBraveCookies: false, cookiesPath: null, cookiesFileAvailable: false })),
        invoke('get_experience_settings').catch(() => ({ clipboardAutoSuggest: true, extensionPromptDecision: '', newsReadIds: [], updateSeenVersions: [] })),
        invoke('get_tool_update_status').catch(() => null),
        invoke('get_bandwidth_settings').catch(() => ({ mode: 'unlimited' }))
      ]);
      if (desktopSettings?.downloads_dir) appState.downloadDirectory = desktopSettings.downloads_dir;
      const httpConcurrency = Number(desktopSettings?.downloadConcurrency?.http);
      const multimediaConcurrency = Number(desktopSettings?.downloadConcurrency?.multimedia);
      appState.downloadConcurrency = {
        http: Number.isSafeInteger(httpConcurrency) && httpConcurrency >= 1 && httpConcurrency <= 8 ? httpConcurrency : 2,
        multimedia: Number.isSafeInteger(multimediaConcurrency) && multimediaConcurrency >= 1 && multimediaConcurrency <= 4 ? multimediaConcurrency : 1
      };
      if (remoteAppearance) {
        const remoteRevision = Number(remoteAppearance.appearanceRevision || 0);
        const remoteLegacyScale = remoteRevision < 6 && Number(remoteAppearance.scale || 120) === 120 ? 125 : Number(remoteAppearance.scale ?? 125);
        const migratedRemoteScale = remoteRevision < 7 ? Math.max(50, remoteLegacyScale - 25) : remoteAppearance.scale;
        const migratedRemoteTextScale = remoteRevision < 7 ? Math.max(80, Number(remoteAppearance.textScale ?? 120) - 20) : remoteAppearance.textScale;
        appState.appearance = normalizeAppearance({
          ...appState.appearance,
          ...remoteAppearance,
          theme: ['dark', 'light', 'system'].includes(remoteAppearance.theme) ? remoteAppearance.theme : appState.appearance.theme,
          scale: migratedRemoteScale,
          textScale: migratedRemoteTextScale,
          autoScale: appState.appearance.autoScale,
          appearanceRevision: 8
        });
        if (remoteRevision < 8) scheduleAppearancePersist();
      }
      appState.runtimeStatus = runtimeStatus;
      appState.mediaRuntimeStatus = mediaRuntimeStatus;
      appState.updaterStatus = updaterStatus;
      appState.extensionBridgeStatus = extensionBridgeStatus;
      appState.mediaSessionSettings = mediaSessionSettings || { useBraveCookies: false, cookiesPath: null, cookiesFileAvailable: false };
      appState.experienceSettings = experienceSettings || { clipboardAutoSuggest: true, extensionPromptDecision: '', newsReadIds: [], updateSeenVersions: [] };
      appState.toolUpdateStatus = toolUpdateStatus || appState.toolUpdateStatus;
      appState.bandwidthSettings = bandwidthSettings?.mode === 'limited'
        ? { mode: 'limited', bytesPerSecond: Number(bandwidthSettings.bytesPerSecond || 0) }
        : { mode: 'unlimited' };
      appState.startupStatus = startupStatus;
      appState.windowBehavior = windowBehavior || appState.windowBehavior;
      appState.backgroundLaunch = Boolean(backgroundLaunch);
      appState.progressEngineStatus = progressEngineStatus || { mode: 'unavailable', v2_ready: false, status_error: 'status_empty' };
      if (appState.progressEngineStatus.diagnostic) {
        appState.progressEngineDiagnostics = await invoke('progress_engine_diagnostics').catch((error) => ({
          enabled: true,
          error: String(error || 'diagnostics_unavailable'),
          events: []
        }));
      }
      if (shouldObserveProgressV2()) {
        await startProgressV2Listener();
      }
      if (isProgressV2UiMode()) {
        const v2 = await progressV2FullSnapshot();
        if (v2) appState.snapshot = applyProgressV2ToSnapshot(appState.snapshot, v2);
      }
    }
  } catch (error) {
    appState.snapshotFailures += 1;
    console.warn('No se pudo actualizar el estado local.', error);
    if (appState.snapshotFailures >= 3) showToast('El motor local no respondió. La interfaz seguirá disponible.', 'error');
  }
  applyAppearance(appState.appearance);
  scheduleExtensionStatePublish();
}

async function loadPlaylistRuntime() {
  if (previewMode || !appState.playlistBatchId) return false;
  let recoveryChanged = false;
  try {
    const nextRuntime = await invoke('playlist_runtime_snapshot', { batchId: appState.playlistBatchId });
    const nextCurrentId = nextRuntime?.current?.job_id ?? nextRuntime?.next?.job_id ?? null;
    // Actualiza la tarjeta existente sin animar ni reconstruir toda la ventana.
    appState.playlistAnimateCurrent = false;
    appState.playlistLastCurrentId = nextCurrentId;
    appState.playlistRuntime = nextRuntime;
    const failedItem = nextRuntime?.failed_item || null;
    if (failedItem?.job_id && appState.playlistRecoveryJobId !== failedItem.job_id && !appState.playlistRecoveryBusy) {
      appState.playlistRecoveryBusy = true;
      appState.playlistRecoveryJobId = failedItem.job_id;
      try {
        const recovery = await invoke('recover_media_source', {
          request: {
            jobId: failedItem.job_id,
            title: failedItem.title || '',
            sourceUrl: null,
            creator: failedItem.creator || null,
            durationSeconds: null,
            limit: 8
          }
        });
        appState.unifiedSearchAlternatives = Array.isArray(recovery?.alternatives) ? recovery.alternatives.slice(0, 8) : [];
        recoveryChanged = true;
      } catch (error) {
        console.info('No se pudieron buscar alternativas para la playlist.', error);
        appState.unifiedSearchAlternatives = [];
        recoveryChanged = true;
      } finally {
        appState.playlistRecoveryBusy = false;
      }
    }
  } catch (error) {
    console.info('No se pudo actualizar la playlist.', error);
  }
  return recoveryChanged;
}

function playlistRuntimeIsTerminal(runtime = appState.playlistRuntime) {
  return Boolean(runtime && ['completed', 'completed_with_errors', 'cancelled'].includes(runtime.status));
}

function updatePlaylistQueueDom() {
  const runtime = appState.playlistRuntime;
  if (!runtime) return;
  const current = hydratePlaylistRuntimeItem(runtime.current, Number(runtime.current?.position || 0));
  const total = Number(runtime.total || 0);
  const completed = Number(runtime.completed || 0);
  const failed = Number(runtime.failed || 0);
  const batchFinished = playlistRuntimeIsTerminal(runtime);
  const active = current && ['running', 'paused', 'queued'].includes(current.status) ? 1 : 0;
  const runtimeUpcoming = Array.isArray(runtime.upcoming) ? [...runtime.upcoming] : [];
  const runtimeNext = hydratePlaylistRuntimeItem(runtime.next, completed + active + 1);
  if (runtimeNext && !runtimeUpcoming.some((item) => Number(item?.job_id || item?.id || 0) === Number(runtimeNext.id || 0))) runtimeUpcoming.unshift(runtimeNext);
  const upcoming = runtimeUpcoming.slice(0, 8).map((item, index) => hydratePlaylistRuntimeItem(item, Number(item?.position ?? completed + active + index + 1))).filter(Boolean);
  const calculatedPending = Math.max(0, total - completed - failed - active);
  const pending = batchFinished ? 0 : Math.max(calculatedPending, upcoming.length);
  const progress = Math.max(0, Math.min(100, Math.round(Number(current?.progress || 0))));
  const paused = runtime.status === 'paused' || current?.status === 'paused';
  const setText = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  const setWidth = (selector, value) => { const node = document.querySelector(selector); if (node) node.style.width = `${value}%`; };
  const status = paused ? 'EN PAUSA' : current?.status === 'queued' ? 'PREPARANDO ELEMENTO' : current?.status === 'running' ? 'DESCARGANDO AHORA' : 'PREPARANDO PLAYLIST';
  const card = document.querySelector('#playlist-current-card');
  if (card && current) {
    card.dataset.jobId = String(current.id || '');
    card.classList.toggle('paused', paused);
    setText('[data-playlist-current-status]', status);
    setText('[data-playlist-current-title]', current.title || 'Preparando el siguiente elemento');
    setText('[data-playlist-current-meta]', playlistMetadata(current));
    const detail = current.error || current.detail || (current.status === 'queued' ? 'Esperando que el motor local inicie el elemento…' : 'Procesamiento secuencial local');
    setText('[data-playlist-current-detail]', detail);
    setText('[data-playlist-current-percent]', `${progress}%`);
    setWidth('[data-playlist-current-bar]', progress);
    setText('[data-playlist-pending-count]', `${pending} pendientes`);
    document.querySelector('[data-playlist-current-progress]')?.classList.toggle('indeterminate', current.status === 'running' && progress <= 0);
    const formatNode = document.querySelector('[data-playlist-current-format]');
    if (formatNode) formatNode.innerHTML = `${icon('audio', 16)} ${escapeHtml(runtime.format || appState.selectedPlaylistFormat || 'MP3 320 kbps')}`;
    const currentThumbAction = card.querySelector('.playlist-thumb-action');
    const currentThumb = currentThumbAction?.querySelector('.playlist-thumb.large');
    const thumbnail = stablePlaylistThumbnail(current, Number(current.position || 0));
    const currentOriginal = currentThumb?.querySelector('img')?.dataset.originalThumbnail || '';
    const currentPreviewUrl = playlistPreviewUrl(current);
    const renderedPreviewUrl = currentThumbAction?.querySelector('[data-playlist-preview-url]')?.dataset.playlistPreviewUrl || '';
    if (currentThumbAction && (thumbnail !== currentOriginal || currentPreviewUrl !== renderedPreviewUrl)) {
      const template = document.createElement('template');
      template.innerHTML = playlistPlayableThumb(current, 'large').trim();
      currentThumbAction.replaceWith(template.content.firstElementChild);
      bindPlaylistPreviewButtons(card);
    }
  }
  const pauseButton = document.querySelector('.playlist-pause');
  if (pauseButton) {
    pauseButton.dataset.paused = paused ? '1' : '0';
    pauseButton.innerHTML = `${icon(paused ? 'play' : 'pause', 19)}<span>${paused ? 'Continuar' : 'Pausar'}</span>`;
  }
  const list = document.querySelector('[data-playlist-upcoming-list]');
  if (list) {
    const signature = upcoming.map((item) => `${item.id}:${item.title}:${item.thumbnail}:${item.status}:${playlistPreviewUrl(item)}`).join('|') || `empty:${pending}:${batchFinished}`;
    if (list.dataset.queueSignature !== signature) {
      const scrollTop = list.scrollTop;
      list.innerHTML = upcoming.length
        ? upcoming.map((item, index) => `<article class="playlist-upcoming-row" data-playlist-upcoming-index="${index}" data-playlist-upcoming-id="${escapeHtml(item.id || '')}">${playlistPlayableThumb(item, 'normal', completed + active + index + 1)}<div><strong data-playlist-upcoming-title>${escapeHtml(item.title)}</strong><small data-playlist-upcoming-meta>${escapeHtml(playlistMetadata(item) || 'Metadatos pendientes')}</small></div><span>En espera</span></article>`).join('')
        : `<div class="playlist-upcoming-empty">${icon('clock', 26)}<strong>${batchFinished ? 'La playlist terminó' : pending > 0 ? 'Sincronizando la cola' : 'Esperando la cola local'}</strong><span>${batchFinished ? 'No quedan elementos pendientes.' : pending > 0 ? 'CacaTools está preparando el siguiente elemento.' : 'Los próximos elementos aparecerán aquí automáticamente.'}</span></div>`;
      list.dataset.queueSignature = signature;
      list.scrollTop = Math.min(scrollTop, list.scrollHeight);
      bindThumbnailFallbacks();
      bindPlaylistPreviewButtons(list);
    }
  }
}

function currentJobs() {
  const confirmed = Array.isArray(appState.snapshot.jobs) ? appState.snapshot.jobs : [];
  const pending = Array.isArray(appState.pendingJobs) ? appState.pendingJobs : [];
  const seen = new Set(confirmed.map((job) => String(job.id)));
  const merged = [...confirmed];
  pending.forEach((job) => {
    if (!seen.has(String(job.id))) merged.unshift(job);
  });
  return merged;
}

function hasPendingMediaThumbnail() {
  return currentJobs().some((job) => {
    const kind = String(job?.kind || '').toLowerCase();
    const status = String(job?.status || '').toLowerCase();
    return ['video', 'audio', 'media', 'playlist'].includes(kind)
      && !String(job?.thumbnail || '').trim()
      && !['completed', 'cancelled'].includes(status);
  });
}

function scheduleSnapshotRefresh(delay = VISIBLE_IDLE_REFRESH_MS) {
  window.clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = window.setTimeout(() => { void refreshSnapshotTick(); }, delay);
}

function requestFullSnapshotRefresh() {
  forceFullSnapshotRefresh = true;
  scheduleSnapshotRefresh(0);
}

async function startDownloadLifecycleListeners() {
  if (previewMode || downloadLifecycleListenersStarted) return;
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  downloadLifecycleListenersStarted = true;
  for (const eventName of ['download-queued', 'download-state-changed']) {
    try {
      await listen(eventName, () => { requestFullSnapshotRefresh(); });
    } catch (error) {
      console.warn(`No se pudo registrar ${eventName}.`, error);
    }
  }
}

async function refreshSnapshotTick() {
  if (previewMode) return;
  const managerVisible = Boolean(document.querySelector('.dm-host'));
  const nextDelay = snapshotPollingDelay({
    managerVisible,
    documentHidden: document.hidden,
    activeJobs: currentJobs().filter((job) => ['running', 'queued', 'paused'].includes(String(job.status))).length
  });
  if (document.hidden || appState.snapshotRefreshBusy) {
    scheduleSnapshotRefresh(nextDelay);
    return;
  }
  appState.snapshotRefreshBusy = true;
  try {
    const fullSnapshotRefreshMs = managerVisible
      ? (hasPendingMediaThumbnail() ? VISIBLE_THUMBNAIL_SNAPSHOT_REFRESH_MS : VISIBLE_FULL_SNAPSHOT_REFRESH_MS)
      : FULL_SNAPSHOT_REFRESH_MS;
    const needsFullSnapshot = forceFullSnapshotRefresh || Date.now() - lastFullSnapshotAt >= fullSnapshotRefreshMs;
    const activityOnly = managerVisible && !needsFullSnapshot;
    const previousSnapshot = appState.snapshot;
    await loadSnapshot({ includeSchedules: false, activityOnly });
    if (!activityOnly) forceFullSnapshotRefresh = false;
    const nextSignature = snapshotSignature();
    if (nextSignature !== appState.lastSnapshotSignature || (appState.pendingJobs || []).length) {
      appState.lastSnapshotSignature = nextSignature;
      const changedJobIds = snapshotChangedJobIds(previousSnapshot, appState.snapshot, activityOnly);
      if (changedJobIds) {
        (appState.pendingJobs || []).forEach((job) => changedJobIds.add(String(job.id)));
      }
      if (managerVisible) {
        patchDownloadManagerLive({
          snapshot: appState.snapshot,
          pendingJobs: appState.pendingJobs,
          runtimeStatus: appState.runtimeStatus,
          mediaRuntimeStatus: appState.mediaRuntimeStatus,
          downloadDirectory: appState.downloadDirectory,
          schedules: appState.downloadSchedules,
          changedJobIds,
          progressEngineStatus: appState.progressEngineStatus
        });
      } else patchDynamicSnapshot();
    }
  } catch (error) {
    console.warn('Actualización local omitida', error);
  } finally {
    appState.snapshotRefreshBusy = false;
    const activeJobs = currentJobs().filter((job) => ['running', 'queued', 'paused'].includes(String(job.status))).length;
    scheduleSnapshotRefresh(snapshotPollingDelay({
      managerVisible: Boolean(document.querySelector('.dm-host')),
      documentHidden: document.hidden,
      activeJobs
    }));
  }
}

function startSnapshotRefreshLoop() {
  scheduleSnapshotRefresh(0);
  void startProgressV2Listener();
  void startDownloadLifecycleListeners();
  if (window.__cacatoolsSnapshotVisibilityBound) return;
  window.__cacatoolsSnapshotVisibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleSnapshotRefresh(0);
  }, { passive: true });
}

const acceptanceSleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function acceptanceDomSample(jobId) {
  const row = document.querySelector(`[data-dm-select-job="${CSS.escape(String(jobId))}"]`);
  const bar = row?.querySelector('.dm-item-progress .dm-progress i');
  const progress = row?.querySelector('.dm-item-progress .dm-progress');
  return {
    rowCount: document.querySelectorAll('.dm-download-item').length,
    rowText: row?.textContent?.replace(/\s+/g, ' ').trim() || '',
    progressWidth: bar?.style?.width || '',
    indeterminate: Boolean(progress?.classList.contains('is-indeterminate')),
    ghostRows: [...document.querySelectorAll('.dm-download-item')].filter((node) => node.textContent.includes('Descarga en curso')).length,
    untranslatedRunning: [...document.querySelectorAll('.dm-download-item')].filter((node) => /\brunning\b/.test(node.textContent)).length,
    speedLabels: (row?.textContent?.match(/\/s\b/gi) || []).length
  };
}

function acceptanceJobSnapshot(jobId) {
  return (appState.snapshot?.jobs || []).find((job) => Number(job.id) === Number(jobId)) || null;
}

function acceptancePlaylistFallback() {
  const samples = [0.12, 0.42, null, 0.39, 0.67, null, 1];
  let last = 0;
  const values = [];
  for (const sample of samples) {
    if (sample == null) { values.push({ progress: last, indeterminate: false }); continue; }
    last = Math.max(last, sample);
    values.push({ progress: last, indeterminate: false });
  }
  return { monotonic: values.every((value, index) => index === 0 || value.progress >= values[index - 1].progress), values };
}

async function runProgressAcceptanceAutopilot() {
  if (previewMode || appState.progressAcceptanceStarted) return null;
  const config = await invoke('progress_acceptance_config').catch(() => ({ enabled: false }));
  if (!config?.enabled) return null;
  appState.progressAcceptanceStarted = true;
  const startedAt = Date.now();
  const report = { schemaVersion: 1, status: 'FAIL', startedAt: new Date(startedAt).toISOString(), samples: [], assertions: {}, limitations: [] };
  const failures = [];
  const fixtureUrl = String(config.fixtureUrl || '').trim();
  let primaryId = 0;
  try {
    if (!fixtureUrl) throw new Error('CACATOOLS_PROGRESS_ACCEPTANCE_URL no configurada');
    const receipt = await invoke('queue_http_download', { url: fixtureUrl, filename: 'progress-acceptance.bin' });
    primaryId = Number(receipt?.job_id || 0);
    if (!primaryId) throw new Error('La cola no devolvió job_id');
    let pauseRequested = false;
    let resumeRequested = false;
    for (let index = 0; index < 90; index += 1) {
      if (index === 8 && !pauseRequested) {
        await invoke('set_job_status', { id: primaryId, status: 'paused' });
        pauseRequested = true;
        report.assertions.pauseCommandAccepted = true;
      } else if (index === 12 && pauseRequested && !resumeRequested) {
        await invoke('set_job_status', { id: primaryId, status: 'running' });
        resumeRequested = true;
        report.assertions.resumeCommandAccepted = true;
      }
      await loadSnapshot({ includeSchedules: false, activityOnly: false });
      patchDownloadManagerLive({ snapshot: appState.snapshot, pendingJobs: appState.pendingJobs, changedJobIds: new Set([String(primaryId)]), progressEngineStatus: appState.progressEngineStatus });
      const job = acceptanceJobSnapshot(primaryId);
      const dom = acceptanceDomSample(primaryId);
      report.samples.push({ atMs: Date.now() - startedAt, downloadedBytes: Number(job?.downloaded_bytes || job?.downloadedBytes || 0), progress: Number(job?.progress || 0), phase: job?.phase || job?.status || '', speed: Number(job?.speed_bps || job?.speedBps || 0), ...dom });
      if (job?.status === 'completed') break;
      await acceptanceSleep(225);
    }
    const firstSamples = report.samples;
    const byteChanges = new Set(firstSamples.map((sample) => sample.downloadedBytes));
    const widthChanges = new Set(firstSamples.map((sample) => sample.progressWidth));
    const activeSample = firstSamples.find((sample) => sample.downloadedBytes > 0 || sample.speed > 0);
    report.assertions.firstDownloadHasIdentity = Boolean(firstSamples.length && firstSamples.every((sample) => sample.ghostRows === 0) && !firstSamples.some((sample) => sample.rowText.includes('Descarga en curso')));
    report.assertions.noInteractionVisualUpdates = byteChanges.size > 2 && widthChanges.size > 2;
    report.assertions.noPlaceholderRows = firstSamples.every((sample) => sample.ghostRows === 0);
    report.assertions.noUntranslatedRunning = firstSamples.every((sample) => sample.untranslatedRunning === 0);
    report.assertions.oneSpeedPerRow = firstSamples.every((sample) => sample.speedLabels <= 1);
    report.assertions.activeSampleObserved = Boolean(activeSample);
    report.assertions.finalSizeObserved = Boolean(firstSamples.some((sample) => sample.phase === 'completed' || sample.progress >= 100));
    const pausedSpeed = firstSamples.some((sample) => /paused/i.test(sample.phase) && sample.speed > 0);
    report.assertions.pausedHasNoOwnSpeed = !pausedSpeed;
    report.assertions.playlistMonotonic = acceptancePlaylistFallback().monotonic;
    if (!report.assertions.firstDownloadHasIdentity) failures.push('first_download_identity');
    if (!report.assertions.noInteractionVisualUpdates) failures.push('no_interaction_visual_updates');
    if (!report.assertions.noPlaceholderRows) failures.push('ghost_rows');
    if (!report.assertions.noUntranslatedRunning) failures.push('untranslated_running');
    if (!report.assertions.oneSpeedPerRow) failures.push('duplicate_speed');
    if (!report.assertions.pausedHasNoOwnSpeed) failures.push('paused_speed');
    if (!report.assertions.finalSizeObserved) failures.push('final_size');
    const cancelReceipt = await invoke('queue_http_download', { url: fixtureUrl, filename: 'progress-acceptance-cancel.bin' });
    const cancelId = Number(cancelReceipt?.job_id || 0);
    if (cancelId) {
      await acceptanceSleep(450);
      await invoke('cancel_download_job', { id: cancelId, deletePartial: false });
      await acceptanceSleep(700);
      await loadSnapshot({ includeSchedules: false, activityOnly: false });
      const cancelled = acceptanceJobSnapshot(cancelId);
      report.assertions.cancelEndsTerminal = ['cancelled', 'failed'].includes(String(cancelled?.status || ''));
      if (!report.assertions.cancelEndsTerminal) failures.push('cancel_not_terminal');
    }
  } catch (error) {
    failures.push(String(error || 'acceptance_error'));
  }
  report.failures = failures;
  report.status = failures.length ? 'FAIL' : 'PASS';
  report.finishedAt = new Date().toISOString();
  globalThis.__CACATOOLS_PROGRESS_ACCEPTANCE__ = report;
  await invoke('progress_acceptance_report', { report }).catch(() => {});
  console.info('[progress-acceptance]', report);
  return report;
}

function syncPendingJobs() {
  const confirmed = new Set((appState.snapshot.jobs || []).map((job) => String(job.id)));
  appState.pendingJobs = (appState.pendingJobs || []).filter((job) => !confirmed.has(String(job.id)) && (Date.now() - Number(job.__addedAt || 0) < 45000));
}

function pushOptimisticJob(title, status = 'queued', detail = 'Preparando descarga local⬦') {
  const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  appState.pendingJobs = [{ id, title, detail, progress: 0, status, __addedAt: Date.now() }, ...(appState.pendingJobs || [])].slice(0, 8);
  patchDynamicSnapshot();
  return id;
}

function promoteOptimisticJob(pendingId, jobId, detail = 'Iniciando descarga⬦') {
  appState.pendingJobs = (appState.pendingJobs || []).map((job) => job.id === pendingId
    // Keep the original insertion timestamp while the native snapshot is
    // catching up; promoting the optimistic row must not make it jump to the
    // front of the list.
    ? { ...job, id: jobId, status: 'running', detail, __addedAt: job.__addedAt || Date.now() }
    : job);
  // Paint the confirmed identity immediately; the caller performs the single
  // real snapshot refresh after the backend receipt.
  patchDynamicSnapshot();
}

function removeOptimisticJob(pendingId) {
  appState.pendingJobs = (appState.pendingJobs || []).filter((job) => job.id !== pendingId);
  patchDynamicSnapshot();
}


function queueMetrics() {
  const jobs = currentJobs();
  const remote = appState.snapshot.queue || {};
  const localActive = jobs.filter((job) => job.status === 'running').length;
  const localQueued = jobs.filter((job) => job.status === 'queued').length;
  const localPaused = jobs.filter((job) => job.status === 'paused').length;
  const localSpeed = jobs
    .filter((job) => job.status === 'running')
    .reduce((sum, job) => sum + Math.max(0, Number(job.speed_bps) || 0), 0);
  // The stable projection is the only source for counters and speed.  The
  // legacy queue aggregate can lag behind a V2 delta and must never populate
  // a header after the rows have already reached zero or paused state.
  const speed = localSpeed;
  return {
    active: Math.max(Number(remote.active) || 0, localActive),
    queued: Math.max(Number(remote.queued) || 0, localQueued),
    paused: Math.max(Number(remote.paused) || 0, localPaused),
    completed: Number(remote.completed_today) || 0,
    failed: Number(remote.failed) || 0,
    speed
  };
}

function rememberQueueSpeed() {
  const metrics = queueMetrics();
  const history = appState.queueSpeedHistory || [];
  history.push(metrics.speed);
  while (history.length > 16) history.shift();
  appState.queueSpeedHistory = history;
}

function queueHistoryMarkup() {
  const history = (appState.queueSpeedHistory || []).slice(-12);
  while (history.length < 12) history.unshift(0);
  const max = Math.max(1, ...history);
  return history.map((value, index) => {
    const height = value > 0 ? Math.max(16, Math.round(value / max * 100)) : 8;
    return `<i style="height:${height}%" data-speed-index="${index}"></i>`;
  }).join('');
}

function animateDownloadProgressBars() {
  document.querySelectorAll('.download-item[data-job]').forEach((item) => {
    const key = String(item.dataset.job || '');
    const target = clamp(Number(item.dataset.targetProgress || 0), 0, 100);
    const bar = item.querySelector('.progress > span');
    const percent = item.querySelector('.download-percent');
    if (!bar || !percent || item.classList.contains('is-indeterminate')) return;
    if (appState.progressAnimations[key]) cancelAnimationFrame(appState.progressAnimations[key]);
    let current = Number(appState.displayedProgress[key]);
    if (!Number.isFinite(current)) current = Math.max(0, Math.min(target, target > 4 ? target - 4 : target));
    const tick = () => {
      if (!item.isConnected) return;
      const distance = target - current;
      if (Math.abs(distance) <= .12) current = target;
      else {
        const step = Math.min(.92, Math.max(.16, Math.abs(distance) * .065));
        current += Math.sign(distance) * step;
      }
      current = clamp(current, 0, 100);
      appState.displayedProgress[key] = current;
      bar.style.width = `${current.toFixed(2)}%`;
      percent.textContent = `${Math.floor(current)}%`;
      if (current !== target) appState.progressAnimations[key] = requestAnimationFrame(tick);
      else delete appState.progressAnimations[key];
    };
    tick();
  });
}

function downloadQueueSpeed() {
  return formatRate(queueMetrics().speed);
}

export {
  mixSnapshotSignature,
  snapshotSignature,
  patchDynamicSnapshot,
  bindDynamicListEvents,
  loadSnapshot,
  loadPlaylistRuntime,
  playlistRuntimeIsTerminal,
  updatePlaylistQueueDom,
  currentJobs,
  scheduleSnapshotRefresh,
  refreshSnapshotTick,
  startSnapshotRefreshLoop,
  syncPendingJobs,
  pushOptimisticJob,
  promoteOptimisticJob,
  removeOptimisticJob,
  formatRate,
  queueMetrics,
  rememberQueueSpeed,
  queueHistoryMarkup,
  animateDownloadProgressBars,
  applyProgressV2ToSnapshot,
  buildStableProgressViewModel,
  downloadQueueSpeed,
  runProgressAcceptanceAutopilot
};
