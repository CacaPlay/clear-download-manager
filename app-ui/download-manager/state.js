import { loadDownloadManagerPreferences, longListVirtualizationPolicy, saveDownloadManagerPreferences } from './core/model.js';

export const runtimeState = {
  preferences: loadDownloadManagerPreferences(),
  modal: '',
  modalJobId: null,
  modalNewsId: '',
  modalNewsImage: '',
  newsFilter: 'all',
  videoSearchQuery: '',
  videoSearchBusy: false,
  videoSearchResults: [],
  videoSearchRequestId: 0,
  recoveryBusy: false,
  recoveryResult: null,
  deletePreviewBusy: false,
  deletePreview: null,
  deleteBusy: false,
  torrentSource: '',
  torrentBusy: false,
  addMenuOpen: false,
  rowMenuJobId: null,
  rowMenuPosition: null,
  rowMenuOpenedAt: 0,
  rowMenuAnchor: null,
  selectionMode: false,
  selectedJobIds: new Set(),
  bulkDeleteBusy: false,
  mobileSidebarOpen: false,
  mobileInspectorOpen: false,
  settingsOpen: false,
  categoryMenuOpen: false,
  settingsSection: 'general',
  unifiedQuery: '',
  unifiedFocused: false,
  unifiedBusy: false,
  unifiedSuggestionBusy: false,
  unifiedSuggestions: [],
  unifiedActiveIndex: -1,
  unifiedSuggestionQuery: '',
  unifiedRequestId: 0,
  liveJobs: [],
  previousVisualStateByJobId: new Map(),
  progressCadenceByJobId: new Map(),
  statusTransitionTimers: new Map(),
  optimisticJobStatuses: new Map(),
  optimisticJobPriorities: new Map(),
  recoveryByJobId: Object.create(null),
  recoveryPending: new Set(),
  settingsScrollTop: 0,
  downloadScrollTop: 0,
  pendingDownloadScrollTop: null,
  virtualLists: new Map(),
  virtualRenderFrame: 0,
  virtualMeasureFrame: 0,
  releaseGlobalShortcuts: () => {},
  releaseSystemThemeListener: () => {}
};

export const searchState = {
  timer: 0,
  inFlight: false,
  queued: null,
  cache: new Map(),
  remoteQuery: '',
  remoteResults: [],
  remoteExpiresAt: 0
};

export const thumbnailState = {
  cache: new Map(),
  loadQueue: [],
  activeLoads: 0,
  observer: null
};

export function isTransientUiOpen() {
  return Boolean(
    runtimeState.modal
    || runtimeState.addMenuOpen
    || runtimeState.rowMenuJobId
    || runtimeState.settingsOpen
    || runtimeState.categoryMenuOpen
    || runtimeState.mobileSidebarOpen
    || runtimeState.mobileInspectorOpen
    || runtimeState.unifiedFocused
  );
}

export const VIRTUAL_OVERSCAN_ROWS = 8;
export const VIRTUAL_DEFAULT_VIEWPORT_HEIGHT = 640;
export const UNIFIED_SUGGESTION_DEBOUNCE_MS = 120;
export const UNIFIED_SUGGESTION_TIMEOUT_MS = 7200;
export const UNIFIED_SUGGESTION_CACHE_LIMIT = 32;
export const UNIFIED_SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_CONCURRENT_THUMBNAILS = 6;
export const MAX_THUMBNAIL_CACHE_ENTRIES = 128;
export const THUMBNAIL_FAILURE_TTL_MS = 30 * 1000;

function virtualListKey(preferences, section) {
  return [section, preferences.filter, preferences.category, preferences.query].join('|');
}

function virtualListState(preferences, section, policy) {
  const key = virtualListKey(preferences, section);
  let state = runtimeState.virtualLists.get(key);
  if (!state) {
    while (runtimeState.virtualLists.size >= 12) {
      const oldestKey = runtimeState.virtualLists.keys().next().value;
      if (oldestKey === undefined) break;
      runtimeState.virtualLists.delete(oldestKey);
    }
    state = {
      key,
      section,
      estimatedRowHeight: policy.estimatedRowHeight,
      overscanRows: VIRTUAL_OVERSCAN_ROWS,
      rowGap: 8.32,
      heights: new Map(),
      scrollTop: 0,
      viewportHeight: VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
      metricsSignature: '',
      metrics: null,
      visible: [],
      selectedId: null,
      recoveryByJobId: {},
      changedJobIds: null
    };
    runtimeState.virtualLists.set(key, state);
  }
  state.estimatedRowHeight = policy.estimatedRowHeight;
  return state;
}

function virtualListMetrics(visible, state) {
  const signature = `${state.rowGap}:${visible.map((job) => `${job.id}:${state.heights.get(String(job.id)) || state.estimatedRowHeight}`).join('|')}`;
  if (state.metricsSignature === signature && state.metrics) return state.metrics;
  const offsets = new Array(visible.length + 1);
  offsets[0] = 0;
  visible.forEach((job, index) => {
    const height = state.heights.get(String(job.id)) || state.estimatedRowHeight;
    offsets[index + 1] = offsets[index] + height + (index < visible.length - 1 ? state.rowGap : 0);
  });
  state.metricsSignature = signature;
  state.metrics = { offsets, totalHeight: offsets[offsets.length - 1] || 0 };
  return state.metrics;
}

export function virtualListRange(visible, state) {
  const metrics = virtualListMetrics(visible, state);
  const targetTop = Math.max(0, Number(state.scrollTop) || 0);
  const targetBottom = targetTop + Math.max(1, Number(state.viewportHeight) || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT);
  let low = 0;
  let high = visible.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (metrics.offsets[middle + 1] <= targetTop) low = middle + 1;
    else high = middle;
  }
  const firstVisible = Math.min(visible.length, low);
  low = firstVisible;
  high = visible.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (metrics.offsets[middle] < targetBottom) low = middle + 1;
    else high = middle;
  }
  const lastVisible = Math.min(visible.length, low);
  const start = Math.max(0, firstVisible - state.overscanRows);
  const end = Math.min(visible.length, lastVisible + state.overscanRows);
  return {
    start,
    end: Math.max(start, end),
    topHeight: metrics.offsets[start] || 0,
    bottomHeight: Math.max(0, metrics.totalHeight - (metrics.offsets[end] || 0)),
    totalHeight: metrics.totalHeight
  };
}

export function createVirtualizationDescriptor(visible, preferences, section, scroll = null) {
  const policy = longListVirtualizationPolicy(section, visible.length);
  if (!policy) return null;
  const state = virtualListState(preferences, section, policy);
  if (scroll) {
    state.scrollTop = scroll.scrollTop;
    state.viewportHeight = scroll.clientHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT;
  }
  state.visible = visible;
  const range = virtualListRange(visible, state);
  return { enabled: true, key: state.key, ...range, state };
}

export function virtualizedListPolicy(section, count) {
  return longListVirtualizationPolicy(section, count);
}

export function syncPreferences(patch = {}) {
  runtimeState.preferences = saveDownloadManagerPreferences({ ...runtimeState.preferences, ...patch });
  return runtimeState.preferences;
}

export function forceDownloadManagerAllView({ clearQuery = true } = {}) {
  runtimeState.preferences = saveDownloadManagerPreferences({
    ...runtimeState.preferences,
    section: 'downloads',
    filter: 'all',
    category: 'all',
    ...(clearQuery ? { query: '' } : {})
  });
  runtimeState.rowMenuJobId = null;
  runtimeState.rowMenuPosition = null;
  runtimeState.mobileSidebarOpen = false;
  runtimeState.mobileInspectorOpen = false;
  runtimeState.settingsOpen = false;
  if (clearQuery) {
    runtimeState.unifiedQuery = '';
    runtimeState.unifiedSuggestions = [];
    runtimeState.unifiedActiveIndex = -1;
    runtimeState.unifiedSuggestionBusy = false;
  }
  return runtimeState.preferences;
}

export function clearDownloadManagerSearchState() {
  runtimeState.modal = '';
  runtimeState.videoSearchQuery = '';
  runtimeState.videoSearchBusy = false;
  runtimeState.videoSearchResults = [];
  runtimeState.videoSearchRequestId += 1;
  runtimeState.unifiedQuery = '';
  runtimeState.unifiedFocused = false;
  runtimeState.unifiedBusy = false;
  runtimeState.unifiedSuggestionBusy = false;
  runtimeState.unifiedSuggestions = [];
  runtimeState.unifiedActiveIndex = -1;
  runtimeState.unifiedSuggestionQuery = '';
  runtimeState.unifiedRequestId += 1;
}

export function getDownloadManagerPreferences() {
  return { ...runtimeState.preferences };
}

export function setOptimisticJobStatus(id, status, options = {}) {
  const key = String(Number(id) || id || '');
  if (!key) return;
  if (!status) runtimeState.optimisticJobStatuses.delete(key);
  else runtimeState.optimisticJobStatuses.set(key, {
    status: String(status),
    resetProgress: options.resetProgress === true,
    expiresAt: Date.now() + 8000
  });
}

export function setOptimisticJobPriority(id, priority) {
  const key = String(Number(id) || id || '');
  if (!key) return;
  if (!priority) runtimeState.optimisticJobPriorities.delete(key);
  else runtimeState.optimisticJobPriorities.set(key, {
    priority: String(priority),
    expiresAt: Date.now() + 8000
  });
}

export function applyOptimisticJobStatuses(jobs = []) {
  const now = Date.now();
  return (Array.isArray(jobs) ? jobs : []).map((job) => {
    const key = String(job?.id ?? '');
    const pending = runtimeState.optimisticJobStatuses.get(key);
    const pendingPriority = runtimeState.optimisticJobPriorities.get(key);
    let nextJob = job;
    if (pendingPriority) {
      if (pendingPriority.expiresAt <= now || job.priority === pendingPriority.priority) {
        runtimeState.optimisticJobPriorities.delete(key);
      } else {
        nextJob = { ...job, priority: pendingPriority.priority };
      }
    }
    if (!pending) return nextJob;
    const statusSettled = job.status === pending.status;
    const resetSettled = !pending.resetProgress || Number(job.progress || 0) <= 0;
    if (pending.expiresAt <= now || (statusSettled && resetSettled)) {
      runtimeState.optimisticJobStatuses.delete(key);
      return nextJob;
    }
    return {
      ...nextJob,
      status: pending.status,
      progress: pending.resetProgress ? 0 : job.progress,
      speedBps: 0,
      speed_bps: 0,
      etaSeconds: null,
      eta_seconds: null,
      indeterminate: false,
      detail: pending.status === 'paused'
        ? 'En pausa'
        : pending.status === 'queued'
          ? 'Reintentando…'
          : pending.status === 'running'
            ? 'Reanudando…'
            : job.detail
    };
  });
}
