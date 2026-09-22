import { formatSpeed, isVisuallySelected, jobsForSection, normalizeJobs, sectionForLayout, statusCounts, totalSpeed } from './core/model.js';
import { applyOptimisticJobStatuses, createVirtualizationDescriptor, runtimeState, VIRTUAL_DEFAULT_VIEWPORT_HEIGHT, virtualListRange } from './state.js';
import { bindDownloadManagerThumbnailFallbacks } from './thumbnails.js';
import { downloadAreaMarkup, downloadRowMarkup, downloadRowState, downloadVisualState } from './view/unified.js?v=0.45.1-runtime-20260903';
import { loadLocale, resolveLocale } from '../modules/i18n/index.js';
import { localizeDom } from '../modules/i18n/runtime.js';

const STATUS_TRANSITION_CLEANUP_MS = 330;
const PROGRESS_CADENCE_MIN_MS = 180;
const PROGRESS_CADENCE_MAX_MS = 1000;
const PROGRESS_CADENCE_FACTOR = 0.95;
const PROGRESS_CADENCE_EMA_ALPHA = 0.35;
const PROGRESS_COMPLETION_DURATION_MS = 220;

function rowVisualState(row) {
  return String(row?.dataset?.dmVisualState || '').trim().toLowerCase()
    || downloadVisualState({ status: row?.dataset?.dmState, stage: row?.dataset?.dmStage }, row?.dataset?.dmProcessing === 'true');
}

function statusTransitionLabel(previous, next) {
  if (!previous || !next || previous === next) return '';
  if (previous === 'paused' && next === 'downloading') return 'resumed';
  if (previous === 'error' && ['queued', 'downloading'].includes(next)) return 'retry';
  return next;
}

function statusMotionEnabled() {
  const root = document.documentElement;
  const mode = root.dataset.motionMode || root.dataset.motion || 'on';
  if (mode === 'off' || mode === 'reduced') return false;
  if (mode === 'system' && root.dataset.reducedMotion === 'true') return false;
  if (mode === 'system' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function clearStatusTransition(row) {
  if (!row) return;
  row.removeAttribute('data-status-transition');
  row.classList.remove('dm-status-transition-active');
}

function triggerStatusTransition(row, previous, next) {
  const key = String(row?.dataset?.dmSelectJob || '');
  const timer = runtimeState.statusTransitionTimers.get(key);
  if (timer) window.clearTimeout(timer);
  runtimeState.statusTransitionTimers.delete(key);
  const label = statusTransitionLabel(previous, next);
  if (!row || !label || !statusMotionEnabled()) {
    clearStatusTransition(row);
    return;
  }
  row.dataset.statusTransition = label;
  row.classList.remove('dm-status-transition-active');
  void row.offsetWidth;
  row.classList.add('dm-status-transition-active');
  const cleanup = window.setTimeout(() => {
    if (row.isConnected && row.dataset.statusTransition === label) {
      resetStatusLane(row);
      clearStatusTransition(row);
    }
    runtimeState.statusTransitionTimers.delete(key);
  }, STATUS_TRANSITION_CLEANUP_MS);
  runtimeState.statusTransitionTimers.set(key, cleanup);
}

function syncVisualStateAttributes(row, next) {
  if (!row || !next) return;
  row.dataset.dmState = next.dataset.dmState || '';
  row.dataset.dmVisualState = next.dataset.dmVisualState || '';
  row.dataset.dmStage = next.dataset.dmStage || '';
  row.dataset.dmProcessing = next.dataset.dmProcessing || 'false';
}

function rememberVisualState(row) {
  const key = String(row?.dataset?.dmSelectJob || '');
  if (key) runtimeState.previousVisualStateByJobId.set(key, rowVisualState(row));
}
function replaceNodeContents(current, next) {
  if (!current || !next || current.innerHTML === next.innerHTML) return;
  current.innerHTML = next.innerHTML;
}

function progressNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function progressVisualDuration(jobKey, currentFill, nextFill) {
  const currentRatio = Number.parseFloat(currentFill?.style?.getPropertyValue('--dm-progress-ratio') || '');
  const nextRatio = Number.parseFloat(nextFill?.style?.getPropertyValue('--dm-progress-ratio') || '');
  if (!Number.isFinite(nextRatio) || !Number.isFinite(currentRatio) || nextRatio === currentRatio) return null;
  const now = progressNow();
  const previous = runtimeState.progressCadenceByJobId.get(jobKey);
  const delta = previous ? now - previous.timestamp : 0;
  let ema = previous?.ema || 0;
  if (delta >= 40 && delta <= 5000) {
    ema = ema > 0 ? (ema * (1 - PROGRESS_CADENCE_EMA_ALPHA)) + (delta * PROGRESS_CADENCE_EMA_ALPHA) : delta;
    if (globalThis.__CACATOOLS_MOTION_DIAGNOSTICS__) {
      const samples = globalThis.__cdmProgressCadenceSamples || (globalThis.__cdmProgressCadenceSamples = []);
      samples.push(Number(delta.toFixed(1)));
      if (samples.length > 64) samples.splice(0, samples.length - 64);
    }
  }
  runtimeState.progressCadenceByJobId.set(jobKey, { timestamp: now, ema, previousRatio: nextRatio });
  if (nextRatio >= 0.999) return PROGRESS_COMPLETION_DURATION_MS;
  if (!ema) return PROGRESS_CADENCE_MIN_MS;
  return Math.max(PROGRESS_CADENCE_MIN_MS, Math.min(PROGRESS_CADENCE_MAX_MS, ema * PROGRESS_CADENCE_FACTOR));
}

function resetStatusLane(row) {
  const stage = row?.querySelector?.('.status-lane-text-stage');
  if (!stage) return;
  const current = stage.querySelector('.status-lane-current');
  const enter = stage.querySelector('.status-lane-enter');
  if (!current && !enter) return;
  const stable = current || document.createElement('span');
  stable.className = 'status-lane-current';
  if (enter) stable.textContent = enter.textContent;
  stage.replaceChildren(stable);
}

function patchStatusLane(current, next, animate) {
  if (!current || !next) return;
  current.title = next.title;
  current.setAttribute('aria-label', next.getAttribute('aria-label') || '');
  const stage = current.querySelector('.status-lane-text-stage');
  if (stage?.querySelector('.status-lane-enter')) resetStatusLane(current);
  const currentText = current.querySelector('.status-lane-current');
  const nextText = next.querySelector('.status-lane-current') || next.querySelector('.status-lane-text-stage > span');
  if (!currentText || !nextText || !stage) {
    replaceNodeContents(current, next);
    return;
  }
  if (currentText.textContent === nextText.textContent) return;
  if (!animate || !statusMotionEnabled()) {
    currentText.textContent = nextText.textContent;
    return;
  }
  const exit = document.createElement('span');
  exit.className = 'status-lane-exit';
  exit.setAttribute('aria-hidden', 'true');
  exit.textContent = currentText.textContent;
  const enter = document.createElement('span');
  enter.className = 'status-lane-enter';
  enter.textContent = nextText.textContent;
  stage.replaceChildren(exit, enter);
}

function patchProgressContent(current, next) {
  if (!current || !next) return;
  if (current.className !== next.className) current.className = next.className;
  if (current.dataset.dmAnalyzing !== next.dataset.dmAnalyzing) current.dataset.dmAnalyzing = next.dataset.dmAnalyzing || 'false';
  const currentWrap = current.querySelector('.dm-progress-wrap');
  const nextWrap = next.querySelector('.dm-progress-wrap');
  const currentBar = current.querySelector('.dm-progress');
  const nextBar = next.querySelector('.dm-progress');
  const currentFill = current.querySelector('.dm-progress > i');
  const nextFill = next.querySelector('.dm-progress > i');
  if (!currentWrap || !nextWrap || !currentBar || !nextBar || !currentFill || !nextFill) {
    replaceNodeContents(current, next);
    return;
  }
  if (currentBar.className !== nextBar.className) currentBar.className = nextBar.className;
  ['aria-valuenow', 'aria-label'].forEach((name) => {
    const value = nextBar.getAttribute(name);
    if (value === null) currentBar.removeAttribute(name);
    else currentBar.setAttribute(name, value);
  });
  const width = nextFill.style.width;
  const jobKey = current.closest?.('.dm-download-item')?.dataset?.dmSelectJob || '';
  const duration = progressVisualDuration(jobKey, currentFill, nextFill);
  if (duration) currentFill.style.setProperty('--dm-progress-duration', `${Math.round(duration)}ms`);
  if (currentFill.style.width !== width) currentFill.style.width = width;
  const ratio = nextFill.style.getPropertyValue('--dm-progress-ratio');
  if (currentFill.style.getPropertyValue('--dm-progress-ratio') !== ratio) {
    if (ratio) currentFill.style.setProperty('--dm-progress-ratio', ratio);
    else currentFill.style.removeProperty('--dm-progress-ratio');
  }
  const currentValue = current.querySelector('.dm-progress-wrap > strong');
  const nextValue = next.querySelector('.dm-progress-wrap > strong');
  if (currentValue && nextValue && currentValue.textContent !== nextValue.textContent) currentValue.textContent = nextValue.textContent;
}

function patchTransferContent(current, next) {
  if (!current || !next) return;
  if (current.className !== next.className) current.className = next.className;
  if (current.getAttribute('aria-label') !== next.getAttribute('aria-label')) {
    current.setAttribute('aria-label', next.getAttribute('aria-label') || '');
  }
  const currentSize = current.querySelector(':scope > strong');
  const nextSize = next.querySelector(':scope > strong');
  const currentDetail = current.querySelector(':scope > small');
  const nextDetail = next.querySelector(':scope > small');
  if (Boolean(currentDetail) !== Boolean(nextDetail)) {
    replaceNodeContents(current, next);
    return;
  }
  if (currentSize && nextSize && currentSize.textContent !== nextSize.textContent) currentSize.textContent = nextSize.textContent;
  if (currentDetail && nextDetail && currentDetail.textContent !== nextDetail.textContent) currentDetail.textContent = nextDetail.textContent;
}

function rowVisualNode(row) {
  return [...(row?.children || [])].find((node) => node.matches?.('.dm-player-trigger,.dm-job-thumb,.dm-job-file,.dm-playlist-stack')) || null;
}

function patchRowVisual(current, next) {
  const currentVisual = rowVisualNode(current);
  const nextVisual = rowVisualNode(next);
  if (!currentVisual || !nextVisual) return false;
  currentVisual.replaceWith(nextVisual.cloneNode(true));
  return true;
}

function patchLiveDownloadRow(current, next) {
  const key = String(current?.dataset?.dmSelectJob || next?.dataset?.dmSelectJob || '');
  const previous = runtimeState.previousVisualStateByJobId.get(key) || rowVisualState(current);
  const nextVisualState = rowVisualState(next);
  if (current.dataset.dmRowStructure !== next.dataset.dmRowStructure) {
    if (current.dataset.dmRowContent === next.dataset.dmRowContent && patchRowVisual(current, next)) {
      current.className = next.className;
      syncVisualStateAttributes(current, next);
      current.dataset.dmRowStructure = next.dataset.dmRowStructure || '';
      current.dataset.dmRowContent = next.dataset.dmRowContent || '';
      runtimeState.previousVisualStateByJobId.set(key, nextVisualState);
      if (previous !== nextVisualState) triggerStatusTransition(current, previous, nextVisualState);
      return current;
    }
    current.replaceWith(next);
    syncVisualStateAttributes(next, next);
    runtimeState.previousVisualStateByJobId.set(key, nextVisualState);
    if (previous !== nextVisualState) triggerStatusTransition(next, previous, nextVisualState);
    return next;
  }
  const liveChanged = current.dataset.dmRowLive !== next.dataset.dmRowLive;
  const hadActiveTransition = current.classList.contains('dm-status-transition-active');
  current.className = next.className;
  if (hadActiveTransition) current.classList.add('dm-status-transition-active');
  syncVisualStateAttributes(current, next);
  current.tabIndex = next.tabIndex;
  const currentIndex = current.querySelector('.dm-item-index');
  const nextIndex = next.querySelector('.dm-item-index');
  if (currentIndex && nextIndex && currentIndex.textContent !== nextIndex.textContent) currentIndex.textContent = nextIndex.textContent;
  if (!liveChanged) {
    runtimeState.previousVisualStateByJobId.set(key, nextVisualState);
    return current;
  }
  const currentDetail = current.querySelector('.dm-item-subline > small');
  const nextDetail = next.querySelector('.dm-item-subline > small');
  if (currentDetail && nextDetail) {
    if (currentDetail.textContent !== nextDetail.textContent) currentDetail.textContent = nextDetail.textContent;
    if (currentDetail.title !== nextDetail.title) currentDetail.title = nextDetail.title;
  }
  const currentStatus = current.querySelector('.dm-item-status');
  const nextStatus = next.querySelector('.dm-item-status');
  if (currentStatus && nextStatus) {
    patchStatusLane(currentStatus, nextStatus, previous !== nextVisualState);
  }
  patchProgressContent(current.querySelector('.dm-item-progress'), next.querySelector('.dm-item-progress'));
  const currentPercentage = current.querySelector('.dm-item-percentage');
  const nextPercentage = next.querySelector('.dm-item-percentage');
  if (currentPercentage && nextPercentage && currentPercentage.textContent !== nextPercentage.textContent) currentPercentage.textContent = nextPercentage.textContent;
  patchTransferContent(current.querySelector('.dm-item-transfer'), next.querySelector('.dm-item-transfer'));
  replaceNodeContents(current.querySelector('.dm-item-actions'), next.querySelector('.dm-item-actions'));
  current.dataset.dmRowLive = next.dataset.dmRowLive || '';
  runtimeState.previousVisualStateByJobId.set(key, nextVisualState);
  if (previous !== nextVisualState) triggerStatusTransition(current, previous, nextVisualState);
  return current;
}

function parseLiveRow(job, index, selectedId, recovery) {
  const template = document.createElement('template');
  template.innerHTML = downloadRowMarkup(job, index, selectedId, null, null, recovery, runtimeState.selectionMode, runtimeState.selectedJobIds).trim();
  const row = template.content.firstElementChild;
  const recoveryNode = row?.nextElementSibling?.matches('.dm-inline-recovery[data-job-id]')
    ? row.nextElementSibling
    : null;
  return { row, recoveryNode };
}

function keyedDownloadRowsPatch(area, visible, selectedId, recoveryByJobId, changedJobIds = null) {
  const currentScroll = area.querySelector('.dm-download-scroll');
  if (!currentScroll) return false;
  const currentRows = new Map([...currentScroll.querySelectorAll(':scope > .dm-download-item')]
    .map((row) => [String(row.dataset.dmSelectJob || ''), row]));
  const currentRecoveries = new Map([...currentScroll.querySelectorAll(':scope > .dm-inline-recovery[data-job-id]')]
    .map((node) => [String(node.dataset.jobId || ''), node]));
  const orderedNodes = [];
  const retained = new Set();
  visible.forEach((job, index) => {
    const key = String(job.id);
    const currentRow = currentRows.get(key);
    const currentRecovery = currentRecoveries.get(key);
    const selected = isVisuallySelected(job.id, { selectedJobId: selectedId }, false);
    const needsActivityPatch = !changedJobIds || changedJobIds.has(key);
    const state = currentRow && !needsActivityPatch ? null : downloadRowState(job);
    const needsLivePatch = !currentRow
      || (needsActivityPatch && (currentRow.dataset.dmRowStructure !== state.structureSignature
        || currentRow.dataset.dmRowLive !== state.liveSignature));
    const needsRecoveryPatch = job.status === 'failed' || Boolean(currentRecovery);
    let parsed = null;
    if (needsLivePatch || needsRecoveryPatch) parsed = parseLiveRow(job, index, selectedId, recoveryByJobId[job.id]);
    let row = currentRow;
    if (!row) row = parsed?.row;
    else if (needsLivePatch && parsed?.row) row = patchLiveDownloadRow(row, parsed.row);
    if (!row) return;
    if (!currentRow) rememberVisualState(row);
    const batchSelected = Boolean(runtimeState.selectionMode && runtimeState.selectedJobIds.has(Number(job.id)));
    const visuallySelected = isVisuallySelected(job.id, { selectedJobId: selectedId }, runtimeState.selectionMode, runtimeState.selectedJobIds);
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-batch-selected', batchSelected);
    row.classList.toggle('is-visually-selected', visuallySelected);
    row.setAttribute('aria-selected', visuallySelected ? 'true' : 'false');
    const indexNode = row.querySelector('.dm-item-index');
    if (indexNode && indexNode.textContent !== String(index + 1)) indexNode.textContent = String(index + 1);
    orderedNodes.push(row);
    retained.add(row);
    const nextRecovery = parsed?.recoveryNode || null;
    if (!nextRecovery) {
      currentRecovery?.remove();
      return;
    }
    let recovery = currentRecovery;
    if (!recovery) recovery = nextRecovery;
    else if (recovery.outerHTML !== nextRecovery.outerHTML) {
      recovery.replaceWith(nextRecovery);
      recovery = nextRecovery;
    }
    orderedNodes.push(recovery);
    retained.add(recovery);
  });
  let anchor = currentScroll.firstChild;
  for (const node of orderedNodes) {
    if (node === anchor) anchor = anchor.nextSibling;
    else currentScroll.insertBefore(node, anchor);
  }
  [...currentScroll.children].forEach((node) => {
    if (!retained.has(node)) node.remove();
  });
  const visibleKeys = new Set(visible.map((job) => String(job.id)));
  runtimeState.previousVisualStateByJobId.forEach((_state, key) => {
    if (!visibleKeys.has(key)) runtimeState.previousVisualStateByJobId.delete(key);
  });
  area.dataset.dmLiveReplaced = '1';
  return true;
}

export function scheduleVirtualListUpdate(scroll) {
  const key = scroll?.dataset?.dmVirtualKey;
  const state = key ? runtimeState.virtualLists.get(key) : null;
  if (!state || runtimeState.rowMenuJobId) return;
  state.scrollTop = scroll.scrollTop;
  state.viewportHeight = scroll.clientHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT;
  if (runtimeState.virtualRenderFrame) return;
  runtimeState.virtualRenderFrame = requestAnimationFrame(() => {
    runtimeState.virtualRenderFrame = 0;
    const currentScroll = document.querySelector(`.dm-download-scroll[data-dm-virtual-key="${CSS.escape(key)}"]`);
    const currentState = runtimeState.virtualLists.get(key);
    if (!currentScroll || !currentState) return;
    patchVirtualListWindow(currentScroll, currentState);
  });
}

function scheduleVirtualListMeasure(scroll, state) {
  if (runtimeState.virtualMeasureFrame) return;
  runtimeState.virtualMeasureFrame = requestAnimationFrame(() => {
    runtimeState.virtualMeasureFrame = 0;
    const windowNode = scroll.querySelector('[data-dm-virtual-window]');
    if (!windowNode) return;
    let changed = false;
    const rowGap = Number.parseFloat(getComputedStyle(windowNode).rowGap || getComputedStyle(windowNode).gap || '');
    if (Number.isFinite(rowGap) && rowGap >= 0 && state.rowGap !== rowGap) {
      state.rowGap = rowGap;
      state.metricsSignature = '';
      changed = true;
    }
    windowNode.querySelectorAll(':scope > .dm-download-item').forEach((row) => {
      const height = Math.round(row.getBoundingClientRect().height);
      const key = String(row.dataset.dmSelectJob || '');
      if (!key || !height || state.heights.get(key) === height) return;
      state.heights.set(key, height);
      changed = true;
    });
    if (changed) {
      state.metricsSignature = '';
      patchVirtualListWindow(scroll, state);
    }
  });
}

function patchVirtualListWindow(scroll, state) {
  const windowNode = scroll.querySelector('[data-dm-virtual-window]');
  const topSpacer = scroll.querySelector('[data-dm-virtual-spacer="top"]');
  const bottomSpacer = scroll.querySelector('[data-dm-virtual-spacer="bottom"]');
  if (!windowNode || !topSpacer || !bottomSpacer) return false;
  const visible = state.visible || [];
  const range = virtualListRange(visible, state);
  const currentRows = new Map([...windowNode.querySelectorAll(':scope > .dm-download-item')]
    .map((row) => [String(row.dataset.dmSelectJob || ''), row]));
  const currentRecoveries = new Map([...windowNode.querySelectorAll(':scope > .dm-inline-recovery[data-job-id]')]
    .map((node) => [String(node.dataset.jobId || ''), node]));
  const activeRow = document.activeElement?.closest?.('[data-dm-select-job]');
  const focusedId = activeRow?.dataset?.dmSelectJob || '';
  const orderedNodes = [];
  const retained = new Set();
  const changedJobIds = state.changedJobIds;
  for (let index = range.start; index < range.end; index += 1) {
    const job = visible[index];
    const key = String(job.id);
    const currentRow = currentRows.get(key);
    const currentRecovery = currentRecoveries.get(key);
    const needsActivityPatch = !changedJobIds || changedJobIds.has(key);
    const rowState = currentRow && !needsActivityPatch ? null : downloadRowState(job);
    const needsLivePatch = !currentRow
      || (needsActivityPatch && (currentRow.dataset.dmRowStructure !== rowState.structureSignature
        || currentRow.dataset.dmRowLive !== rowState.liveSignature));
    const needsRecoveryPatch = job.status === 'failed' || Boolean(currentRecovery);
    let parsed = null;
    if (needsLivePatch || needsRecoveryPatch) {
      parsed = parseLiveRow(job, index, state.selectedId, state.recoveryByJobId[job.id]);
    }
    let row = currentRow || parsed?.row;
    if (currentRow && needsLivePatch && parsed?.row) row = patchLiveDownloadRow(currentRow, parsed.row);
    if (!row) continue;
    if (!currentRow) rememberVisualState(row);
    const selected = Number(job.id) === Number(state.selectedId);
    const batchSelected = Boolean(runtimeState.selectionMode && runtimeState.selectedJobIds.has(Number(job.id)));
    const visuallySelected = selected || batchSelected;
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-batch-selected', batchSelected);
    row.classList.toggle('is-visually-selected', visuallySelected);
    row.setAttribute('aria-selected', visuallySelected ? 'true' : 'false');
    const indexNode = row.querySelector('.dm-item-index');
    if (indexNode && indexNode.textContent !== String(index + 1)) indexNode.textContent = String(index + 1);
    orderedNodes.push(row);
    retained.add(row);
    const nextRecovery = parsed?.recoveryNode || null;
    if (!nextRecovery) {
      currentRecovery?.remove();
      continue;
    }
    let recovery = currentRecovery || nextRecovery;
    if (currentRecovery && currentRecovery.outerHTML !== nextRecovery.outerHTML) {
      currentRecovery.replaceWith(nextRecovery);
      recovery = nextRecovery;
    }
    orderedNodes.push(recovery);
    retained.add(recovery);
  }
  let anchor = windowNode.firstChild;
  for (const node of orderedNodes) {
    if (node === anchor) anchor = anchor.nextSibling;
    else windowNode.insertBefore(node, anchor);
  }
  [...windowNode.children].forEach((node) => {
    if (!retained.has(node)) node.remove();
  });
  const visibleKeys = new Set(visible.map((job) => String(job.id)));
  runtimeState.previousVisualStateByJobId.forEach((_state, key) => {
    if (!visibleKeys.has(key)) runtimeState.previousVisualStateByJobId.delete(key);
  });
  topSpacer.style.height = `${range.topHeight}px`;
  bottomSpacer.style.height = `${range.bottomHeight}px`;
  scroll.dataset.dmVirtualStart = String(range.start);
  scroll.dataset.dmVirtualEnd = String(range.end);
  scroll.dataset.dmVirtualTotal = String(visible.length);
  state.start = range.start;
  state.end = range.end;
  if (focusedId && !windowNode.querySelector(`[data-dm-select-job="${CSS.escape(focusedId)}"]`) && document.activeElement !== scroll) {
    scroll.focus({ preventScroll: true });
  }
  bindDownloadManagerThumbnailFallbacks(scroll);
  scheduleVirtualListMeasure(scroll, state);
  return true;
}

export function bindVirtualListScroll(root) {
  const scroll = root?.querySelector?.('.dm-download-scroll[data-dm-virtual-list="1"]');
  if (!scroll || scroll.dataset.dmVirtualScrollBound === '1') return;
  scroll.dataset.dmVirtualScrollBound = '1';
  scroll.tabIndex = 0;
  scroll.addEventListener('scroll', () => scheduleVirtualListUpdate(scroll), { passive: true });
  scroll.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const row = event.target.closest?.('[data-dm-select-job]');
    if (!row || event.target.closest('button,input,select,a,.dm-row-select')) return;
    event.preventDefault();
    row.click();
  });
}

export function patchDownloadManagerLiveCore(context = {}, rerenderFn = null) {
  const rerender = rerenderFn || ((nextContext) => nextContext.onRerender?.());
  const root = document.querySelector('.dm-host');
  if (!root) return false;
  const existingMarker = root.querySelector('[data-progress-engine-diagnostic]');
  if (context.progressEngineStatus?.diagnostic && !existingMarker) {
    const marker = document.createElement('span');
    marker.dataset.progressEngineDiagnostic = '1';
    marker.style.cssText = 'position:fixed;right:12px;bottom:10px;z-index:1000;padding:4px 8px;border:1px solid #e5a900;border-radius:999px;background:#241d08;color:#ffd66b;font:11px/1.2 ui-monospace,Consolas,monospace;pointer-events:none;';
    marker.textContent = `DEV · UI: ${String(context.progressEngineStatus.ui_source || context.progressEngineStatus.mode || 'unknown')}`;
    root.append(marker);
  } else if (!context.progressEngineStatus?.diagnostic && existingMarker) {
    existingMarker.remove();
  }
  const jobs = applyOptimisticJobStatuses(normalizeJobs(context.snapshot || {}, context.pendingJobs || []));
  runtimeState.liveJobs = jobs;
  const visibleJobKeys = new Set(jobs.map((job) => String(job.id)));
  runtimeState.progressCadenceByJobId.forEach((_value, key) => {
    if (!visibleJobKeys.has(key)) runtimeState.progressCadenceByJobId.delete(key);
  });
  const counts = statusCounts(jobs);
  const statValues = { running: counts.running, completed: counts.completed, speed: formatSpeed(totalSpeed(jobs)) };
  Object.entries(statValues).forEach(([key, value]) => {
    const node = root.querySelector(`[data-dm-stat="${key}"] strong`);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  });
  Object.entries(counts).forEach(([key, value]) => {
    root.querySelectorAll(`[data-dm-filter-count="${key}"]`).forEach((node) => {
      if (node.textContent !== String(value)) node.textContent = String(value);
    });
  });
  const footerSpeed = root.querySelector('.dm-minimal-footer > strong');
  const runningCount = jobs.filter((job) => job.status === 'running' && Number(job.speedBps || 0) > 0).length;
  const aggregateSpeed = formatSpeed(totalSpeed(jobs));
  const totalSpeedLabel = runningCount > 1 ? `Total · ${aggregateSpeed}` : aggregateSpeed;
  if (footerSpeed && footerSpeed.textContent !== totalSpeedLabel) footerSpeed.textContent = totalSpeedLabel;
  const area = root.querySelector('.dm-download-area');
  if (!area || runtimeState.rowMenuJobId) return true;
  const activeSection = sectionForLayout(runtimeState.preferences);
  const visible = jobsForSection(jobs, runtimeState.preferences, activeSection);
  const selectedId = jobs.some((job) => job.id === runtimeState.preferences.selectedJobId)
    ? runtimeState.preferences.selectedJobId
    : null;
  const oldScroll = area.querySelector('.dm-download-scroll')?.scrollTop || 0;
  const currentVirtual = area.querySelector('.dm-download-scroll[data-dm-virtual-list="1"]');
  const virtualization = createVirtualizationDescriptor(
    visible,
    runtimeState.preferences,
    activeSection,
    currentVirtual
  );
  let patchedArea = area;
  const currentHasRows = Boolean(area.querySelector('.dm-download-scroll'));
  if (!visible.length || !currentHasRows || Boolean(currentVirtual) !== Boolean(virtualization)) {
    const fresh = document.createElement('template');
    fresh.innerHTML = downloadAreaMarkup({
      ...context,
      jobs,
      preferences: runtimeState.preferences,
      virtualization,
      rowMenuJobId: null,
      rowMenuPosition: null,
      recoveryByJobId: runtimeState.recoveryByJobId
    }, visible, selectedId).trim();
    const nextArea = fresh.content.firstElementChild;
    if (!nextArea) return false;
    nextArea.dataset.dmLiveReplaced = '1';
    area.replaceWith(nextArea);
    patchedArea = nextArea;
  } else if (virtualization) {
    const state = virtualization.state;
    state.visible = visible;
    state.selectedId = selectedId;
    state.recoveryByJobId = runtimeState.recoveryByJobId;
    state.changedJobIds = context.changedJobIds || null;
    patchVirtualListWindow(currentVirtual, state);
    bindVirtualListScroll(patchedArea);
  } else if (!keyedDownloadRowsPatch(area, visible, selectedId, runtimeState.recoveryByJobId, context.changedJobIds)) {
    return false;
  }
  const nextScroll = patchedArea.querySelector('.dm-download-scroll');
  if (nextScroll) nextScroll.scrollTop = oldScroll;
  bindVirtualListScroll(patchedArea);
  bindDownloadManagerThumbnailFallbacks(patchedArea);
  // Live patches update only the changing text nodes and therefore bypass the
  // full-render localization pass. Re-run the small, exact-term translator on
  // the patched area so status/stage labels follow the active locale instantly.
  const configuredLocale = typeof context.locale === 'function' ? context.locale() : context.locale;
  localizeDom(patchedArea, resolveLocale(configuredLocale || loadLocale()));
  if (nextScroll && nextScroll.dataset.dmLiveScrollBound !== '1') {
    nextScroll.dataset.dmLiveScrollBound = '1';
    // Do not dismiss on DOM `scroll`: restoring scrollTop after a live patch
    // emits it programmatically and made the context menu flash/disappear while
    // an active download was updating. A real wheel gesture may dismiss it.
    nextScroll.addEventListener('wheel', () => {
      if (!runtimeState.rowMenuJobId) return;
      runtimeState.rowMenuJobId = null;
      runtimeState.rowMenuPosition = null;
      runtimeState.rowMenuOpenedAt = 0;
      runtimeState.rowMenuAnchor = null;
      rerender(context);
    }, { passive: true });
  }
  return true;
}
