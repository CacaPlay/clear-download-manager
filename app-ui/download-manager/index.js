import { jobsForSection, normalizeJobs, normalizePreferences, resolveTheme, sectionForLayout, selectedJob } from './core/model.js';
import { APPEARANCE_REVISION, DEFAULT_PROGRESS_ACTIVE_COLOR, DEFAULT_PROGRESS_COMPLETED_COLOR } from './core/constants.js';
import { renderZenSidebar } from './view/zen-sidebar.js?v=0.95.0-verify-20260911-r5';
import { bulkDeleteDialog, cancelDialog, clipboardPreviewDialog, deleteDialog, extensionDialog, feedbackDialog, newsDetailsDialog, newsImageDialog, recoveryDialog, renameDialog, scheduleDialog, torrentDialog, updateDialog, videoSearchDialog } from './view/dialogs.js';
import { applyOptimisticJobStatuses, createVirtualizationDescriptor, runtimeState } from './state.js';
import { patchDownloadManagerLiveCore, scheduleVirtualListUpdate } from './live.js';
import { bindDownloadManagerEvents } from './events.js?v=0.95.0-verify-20260911-r5';
import { iconVariantForColor } from '../modules/appearance/index.js?v=0.95.0-verify-20260911-r4';
import { setSectionLocale } from './view/sections.js';

export { clearDownloadManagerSearchState, getDownloadManagerPreferences, setOptimisticJobPriority, setOptimisticJobStatus } from './state.js';
export { isTransientUiOpen } from './state.js';
export { forceDownloadManagerAllView, virtualizedListPolicy } from './state.js';

function dmHexRgb(value) { const source = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#24b8e8'; const clean = source.slice(1); return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16)); }
function dmLuminance(value) { return dmHexRgb(value).map((channel) => { const normalized = channel / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0); }
function dmBlend(first, second, amount) { const a = dmHexRgb(first); const b = dmHexRgb(second); const ratio = Math.max(0, Math.min(1, Number(amount) || 0)); return `#${a.map((channel, index) => Math.round(channel * (1 - ratio) + b[index] * ratio).toString(16).padStart(2, '0')).join('')}`; }
function dmContrast(first, second) { const a = dmLuminance(first); const b = dmLuminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
function dmReadableAccent(accent, theme) {
  const surface = theme === 'light' ? '#f7f9fb' : '#0f151d';
  const dark = theme === 'light' ? '#0d1b2a' : '#07111d';
  const candidates = [
    accent,
    dmBlend(accent, dark, .22),
    dmBlend(accent, dark, .42),
    dmBlend(accent, dark, .62),
    dmBlend(accent, '#ffffff', .18),
    dmBlend(accent, '#ffffff', .36),
    dmBlend(accent, '#ffffff', .56)
  ];
  const ranked = candidates
    .map((value) => ({ value, contrast: dmContrast(value, surface) }))
    .sort((first, second) => second.contrast - first.contrast);
  return ranked.find((entry) => entry.contrast >= 4.5)?.value || ranked[0].value;
}
function dmAccentPresentation(accent, theme) {
  return {
    ink: dmContrast(accent, '#07111d') >= dmContrast(accent, '#ffffff') ? '#07111d' : '#ffffff',
    detail: dmReadableAccent(accent, theme)
  };
}
function dmEffectiveAccent(preferences, theme = resolveTheme(preferences)) { const intensity = Math.max(40, Math.min(100, Number(preferences.accentIntensity || 82))) / 100; return dmBlend(theme === 'light' ? '#ffffff' : '#07111d', preferences.accent, intensity); }
function applyDmAccentVariables(root, preferences, appearance = null) {
  const source = appearance ? { ...preferences, ...appearance, accentIntensity: appearance.intensity ?? preferences.accentIntensity } : preferences;
  const theme = source.resolvedTheme || resolveTheme(source);
  const effective = dmEffectiveAccent(source, theme);
  const visual = dmAccentPresentation(effective, theme);
  root.dataset.dmTheme = theme;
  if (source.density) root.dataset.dmDensity = source.density;
  root.style.setProperty('--dm-accent', effective);
  root.style.setProperty('--dm-accent-source', source.accent);
  root.style.setProperty('--dm-accent-intensity', String(source.accentIntensity || 82));
  const iconAccent = source.iconColorMode === 'custom' && /^#[0-9a-f]{6}$/i.test(String(source.iconColor || '')) ? source.iconColor : effective;
  root.style.setProperty('--dm-icon-accent', iconAccent);
  root.style.setProperty('--dm-progress-active', source.progressActive || DEFAULT_PROGRESS_ACTIVE_COLOR);
  root.style.setProperty('--dm-progress-completed', source.progressCompleted || DEFAULT_PROGRESS_COMPLETED_COLOR);
  root.style.setProperty('--dm-progress-paused', source.progressPaused || source.warning || '#e2a93f');
  root.style.setProperty('--dm-progress-error', source.progressError || 'var(--dm-danger)');
  root.style.setProperty('--dm-success', source.progressCompleted || source.success || DEFAULT_PROGRESS_COMPLETED_COLOR);
  root.style.setProperty('--dm-accent-ink', visual.ink);
  root.style.setProperty('--dm-accent-detail', visual.detail);
}

export function patchDownloadManagerAppearance(appearance = {}) {
  const root = document.querySelector('.dm-host');
  if (!root) return false;
  applyDmAccentVariables(root, runtimeState.preferences, appearance);
  return true;
}

function renderModal(jobs, context = {}) {
  const job = jobs.find((entry) => entry.id === runtimeState.modalJobId) || null;
  if (runtimeState.modal === 'video-search') return videoSearchDialog(runtimeState);
  if (runtimeState.modal === 'torrent') return torrentDialog(runtimeState);
  if (runtimeState.modal === 'cancel') return cancelDialog(job);
  if (runtimeState.modal === 'delete') return deleteDialog(runtimeState, job);
  if (runtimeState.modal === 'bulk-delete') return bulkDeleteDialog(runtimeState, jobs);
  if (runtimeState.modal === 'schedule') return scheduleDialog(job);
  if (runtimeState.modal === 'recovery') return recoveryDialog(runtimeState, job);
  if (runtimeState.modal === 'update') return updateDialog(context);
  if (runtimeState.modal === 'rename') return renameDialog(job);
  if (runtimeState.modal === 'news-details') return newsDetailsDialog({ ...context, newsId: runtimeState.modalNewsId, t: context.translate });
  if (runtimeState.modal === 'news-image') return newsImageDialog({ ...context, newsImage: runtimeState.modalNewsImage });
  if (runtimeState.modal === 'extension') return extensionDialog();
  if (runtimeState.modal === 'feedback') return feedbackDialog();
  if (context.clipboardPrompt) return clipboardPreviewDialog(context.clipboardPrompt);
  return '';
}

export function renderDownloadManager(context = {}) {
  setSectionLocale(context.locale?.() || context.locale || context.experienceSettings?.locale || 'es');
  const inheritedAppearance = context.appearance || {};
  runtimeState.preferences = normalizePreferences({
    ...runtimeState.preferences,
    ...(inheritedAppearance.accent ? { accent: inheritedAppearance.accent } : {}),
    ...(inheritedAppearance.theme ? { theme: inheritedAppearance.theme } : {}),
    ...(Number.isFinite(Number(inheritedAppearance.intensity)) ? { accentIntensity: Number(inheritedAppearance.intensity) } : {}),
    ...(inheritedAppearance.scale ? { uiScale: inheritedAppearance.scale } : {}),
    ...(inheritedAppearance.textScale ? { textScale: inheritedAppearance.textScale } : {}),
    ...(inheritedAppearance.progressActive ? { progressActive: inheritedAppearance.progressActive } : {}),
    ...(inheritedAppearance.progressCompleted ? { progressCompleted: inheritedAppearance.progressCompleted } : {}),
    ...(inheritedAppearance.progressPaused ? { progressPaused: inheritedAppearance.progressPaused } : {}),
    ...(inheritedAppearance.progressError ? { progressError: inheritedAppearance.progressError } : {}),
    ...(inheritedAppearance.iconColorMode ? { iconColorMode: inheritedAppearance.iconColorMode } : {}),
    ...(inheritedAppearance.iconColor ? { iconColor: inheritedAppearance.iconColor } : {}),
    ...(inheritedAppearance.progressActiveCustomized != null ? { progressActiveCustomized: inheritedAppearance.progressActiveCustomized } : {}),
    ...(inheritedAppearance.progressCompletedCustomized != null ? { progressCompletedCustomized: inheritedAppearance.progressCompletedCustomized } : {}),
    appearanceRevision: APPEARANCE_REVISION
  });
  const density = ['compact', 'balanced', 'spacious'].includes(context.appearanceDensity) ? context.appearanceDensity : 'balanced';
  const jobs = applyOptimisticJobStatuses(normalizeJobs(context.snapshot || {}, context.pendingJobs || []));
  const activeSection = sectionForLayout(runtimeState.preferences);
  const activeVisibleJobs = jobsForSection(jobs, runtimeState.preferences, activeSection);
  const virtualization = createVirtualizationDescriptor(activeVisibleJobs, runtimeState.preferences, activeSection);
  if (virtualization) {
    virtualization.state.selectedId = jobs.some((job) => job.id === runtimeState.preferences.selectedJobId)
      ? runtimeState.preferences.selectedJobId
      : null;
    virtualization.state.recoveryByJobId = runtimeState.recoveryByJobId;
    virtualization.state.changedJobIds = null;
  }
  const selectedExists = jobs.some((job) => job.id === runtimeState.preferences.selectedJobId);
  const visualSelectedId = selectedExists ? runtimeState.preferences.selectedJobId : null;
  const inspectorJob = selectedJob(activeVisibleJobs.length ? activeVisibleJobs : jobs, runtimeState.preferences);
  const theme = resolveTheme(runtimeState.preferences);
  const effectiveAccent = dmEffectiveAccent(runtimeState.preferences, theme);
  const accentVisual = dmAccentPresentation(effectiveAccent, theme);
  const effectiveSuccess = runtimeState.preferences.progressCompleted || runtimeState.preferences.success;
  const effectiveIconAccent = runtimeState.preferences.iconColorMode === 'custom' && /^#[0-9a-f]{6}$/i.test(String(runtimeState.preferences.iconColor || '')) ? runtimeState.preferences.iconColor : effectiveAccent;
  // The sidebar logo follows the committed application accent supplied by
  // main.js.  Prefer that authoritative value over the download manager's
  // older local preference snapshot so a rerender cannot restore cyan while
  // the rest of the interface is green/red.
  const brandIconVariant = iconVariantForColor(inheritedAppearance.accent || runtimeState.preferences.accent);
  const css = `--dm-accent:${effectiveAccent};--dm-accent-source:${runtimeState.preferences.accent};--dm-accent-intensity:${runtimeState.preferences.accentIntensity};--dm-icon-accent:${effectiveIconAccent};--dm-accent-ink:${accentVisual.ink};--dm-accent-detail:${accentVisual.detail};--dm-success:${effectiveSuccess};--dm-progress-active:${runtimeState.preferences.progressActive || DEFAULT_PROGRESS_ACTIVE_COLOR};--dm-progress-completed:${runtimeState.preferences.progressCompleted || DEFAULT_PROGRESS_COMPLETED_COLOR};--dm-progress-paused:${runtimeState.preferences.progressPaused || runtimeState.preferences.warning || '#e2a93f'};--dm-progress-error:${runtimeState.preferences.progressError || runtimeState.preferences.danger};--dm-warning:${runtimeState.preferences.warning};--dm-danger:${runtimeState.preferences.danger};--dm-info:#3f8fc7;--dm-ui-scale:${runtimeState.preferences.uiScale / 100};--dm-ui-inverse:${100 / runtimeState.preferences.uiScale};--dm-text-scale:${Math.max(.92, Math.min(1.16, 1.08 + (runtimeState.preferences.textScale - 100) * 0.004))};`;
  const sharedContext = {
    ...context,
    jobs,
    preferences: runtimeState.preferences,
    brandIconVariant,
    rowMenuJobId: runtimeState.rowMenuJobId,
    rowMenuPosition: runtimeState.rowMenuPosition,
    mobileSidebarOpen: runtimeState.mobileSidebarOpen,
    mobileInspectorOpen: runtimeState.mobileInspectorOpen,
    settingsOpen: runtimeState.settingsOpen,
    categoryMenuOpen: runtimeState.categoryMenuOpen,
    settingsSection: runtimeState.settingsSection,
    unifiedQuery: runtimeState.unifiedQuery,
    unifiedFocused: runtimeState.unifiedFocused,
    unifiedBusy: runtimeState.unifiedBusy,
    unifiedSuggestionBusy: runtimeState.unifiedSuggestionBusy,
    unifiedSuggestions: runtimeState.unifiedSuggestions,
    unifiedActiveIndex: runtimeState.unifiedActiveIndex,
    recoveryByJobId: runtimeState.recoveryByJobId,
    selectionMode: runtimeState.selectionMode,
    selectedJobIds: runtimeState.selectedJobIds,
    visualSelectedId,
    inspectorJob,
    virtualization
  };
  const body = renderZenSidebar(sharedContext);
  const diagnosticLabel = String(context.progressEngineStatus?.ui_source || context.progressEngineStatus?.mode || 'unknown')
    .replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const diagnosticMarker = context.progressEngineStatus?.diagnostic
    ? `<span data-progress-engine-diagnostic="1" style="position:fixed;right:12px;bottom:10px;z-index:1000;padding:4px 8px;border:1px solid #e5a900;border-radius:999px;background:#241d08;color:#ffd66b;font:11px/1.2 ui-monospace,Consolas,monospace;pointer-events:none;">DEV · UI: ${diagnosticLabel}</span>`
    : '';
  return `<div class="dm-host" data-dm-theme="${theme}" data-dm-layout="zen-sidebar" data-dm-density="${density}" style="${css}">${body}${runtimeState.modal ? renderModal(jobs, sharedContext) : sharedContext.clipboardPrompt ? clipboardPreviewDialog(sharedContext.clipboardPrompt) : ''}${diagnosticMarker}</div>`;
}

function captureScrollableState() {
  const settings = document.querySelector('.dm-settings-popover');
  const downloads = document.querySelector('.dm-download-scroll');
  if (settings) runtimeState.settingsScrollTop = settings.scrollTop;
  if (downloads) {
    const preservedTop = runtimeState.pendingDownloadScrollTop ?? downloads.scrollTop;
    runtimeState.pendingDownloadScrollTop = preservedTop;
    runtimeState.downloadScrollTop = preservedTop;
    const key = downloads.dataset.dmVirtualKey;
    if (key) {
      const state = runtimeState.virtualLists.get(key);
      if (state) state.scrollTop = preservedTop;
    }
  }
}

function restoreScrollableState() {
  const preservedDownloadTop = runtimeState.pendingDownloadScrollTop ?? runtimeState.downloadScrollTop;
  window.requestAnimationFrame(() => {
    const settings = document.querySelector('.dm-settings-popover');
    const downloads = document.querySelector('.dm-download-scroll');
    if (settings && runtimeState.settingsOpen) settings.scrollTop = runtimeState.settingsScrollTop;
    if (downloads) {
      const key = downloads.dataset.dmVirtualKey;
      const state = key ? runtimeState.virtualLists.get(key) : null;
      downloads.scrollTop = preservedDownloadTop;
      runtimeState.downloadScrollTop = preservedDownloadTop;
      if (state) state.scrollTop = preservedDownloadTop;
      if (state) scheduleVirtualListUpdate(downloads);
    }
    if (runtimeState.pendingDownloadScrollTop === preservedDownloadTop) runtimeState.pendingDownloadScrollTop = null;
  });
}

function rerender(context) {
  captureScrollableState();
  context.onRerender?.();
  restoreScrollableState();
}

function rerenderPreservingInput(context, selector, selectionStart = null, selectionEnd = null) {
  rerender(context);
  window.requestAnimationFrame(() => {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
    input.focus({ preventScroll: true });
    if (selectionStart !== null && selectionEnd !== null) {
      try { input.setSelectionRange(selectionStart, selectionEnd); } catch {}
    }
  });
}


export function patchDownloadManagerLive(context = {}) {
  return patchDownloadManagerLiveCore(context, (nextContext) => rerender(nextContext));
}
export function bindDownloadManager(context = {}) {
  return bindDownloadManagerEvents(context, {
    rerender: (nextContext) => rerender(nextContext),
    applyAccent: (root, preferences) => applyDmAccentVariables(root, preferences)
  });
}
export function openDownloadManagerModal(kind, jobId = null) {
  runtimeState.modal = kind;
  runtimeState.modalJobId = jobId;
}
