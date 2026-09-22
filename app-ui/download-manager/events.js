import { isPlayableJob, isVisuallySelected, jobsForSection, normalizeJobs, normalizePreferences, playlistJobId, resolveTheme, sectionForLayout } from './core/model.js';
import { bindDownloadManagerActions, changeDownloadPriority } from './actions.js';
import { bindDownloadManagerThumbnailFallbacks } from './thumbnails.js';
import { localUnifiedSuggestions, moveUnifiedSuggestion, paintUnifiedSearch, scheduleUnifiedSuggestions, submitUnifiedInput } from './search.js';
import { runtimeState, syncPreferences } from './state.js';
import { bindVirtualListScroll } from './live.js';
import { dmIcon } from './view/icons.js';
import { mountFloatingMenus } from './floating.js';
function changeUiScale(context, delta) {
  const next = Math.max(50, Math.min(130, Math.round((runtimeState.preferences.uiScale + delta) / 5) * 5));
  if (next === runtimeState.preferences.uiScale) return;
  syncPreferences({ uiScale: next });
  context.onUiScaleChange?.(next, { commit: true });
  const root = document.querySelector('.dm-host');
  const range = root?.querySelector('[data-dm-setting="uiScale"]');
  const number = root?.querySelector('[data-dm-scale-number]');
  if (range) range.value = String(next);
  if (number) number.value = String(next);
}

function patchVisualSelection(root) {
  root.querySelectorAll('[data-dm-select-job]').forEach((row) => {
    const id = Number(row.dataset.dmSelectJob || 0);
    const batchSelected = Boolean(runtimeState.selectionMode && runtimeState.selectedJobIds.has(id));
    const visuallySelected = isVisuallySelected(id, runtimeState.preferences, runtimeState.selectionMode, runtimeState.selectedJobIds);
    row.classList.toggle('is-selected', !runtimeState.selectionMode && visuallySelected);
    row.classList.toggle('is-batch-selected', batchSelected);
    row.classList.toggle('is-visually-selected', visuallySelected);
    row.setAttribute('aria-selected', visuallySelected ? 'true' : 'false');
    const checkbox = row.querySelector(`[data-dm-select-checkbox="${CSS.escape(String(id))}"]`);
    if (checkbox) checkbox.checked = batchSelected;
  });
}

function patchSelectionControls(root, jobs) {
  const selectedCount = runtimeState.selectedJobIds.size;
  const deleteButton = root.querySelector('[data-dm-bulk-delete]');
  if (deleteButton) {
    deleteButton.disabled = selectedCount === 0;
    const label = deleteButton.querySelector('span');
    if (label) label.textContent = selectedCount ? `Eliminar ${selectedCount}` : 'Eliminar';
  }
  const prioritySelect = root.querySelector('[data-dm-bulk-priority]');
  if (prioritySelect) prioritySelect.disabled = selectedCount === 0;
  const selectAllButton = root.querySelector('[data-dm-select-all-visible]');
  if (!selectAllButton) return;
  const activeSection = sectionForLayout(runtimeState.preferences);
  const visibleJobs = jobsForSection(runtimeState.liveJobs?.length ? runtimeState.liveJobs : jobs, runtimeState.preferences, activeSection);
  const allSelected = Boolean(visibleJobs.length) && visibleJobs.every((job) => runtimeState.selectedJobIds.has(Number(job.id)));
  selectAllButton.title = allSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles';
  const label = selectAllButton.querySelector('span');
  if (label) label.textContent = allSelected ? 'Ninguna' : 'Todas';
  const icon = selectAllButton.querySelector('svg');
  if (icon) icon.outerHTML = dmIcon(allSelected ? 'x' : 'check', 18);
}

function bindModalKeyboard(root) {
  const modal = root.querySelector('.dm-modal');
  if (!modal) return;
  const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
  const focusables = () => [...modal.querySelectorAll(focusableSelector)].filter((element) => !element.hidden && element.getClientRects().length > 0);
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  window.requestAnimationFrame(() => {
    if (modal.contains(document.activeElement)) return;
    const preferred = modal.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
      || modal.querySelector('button:not([disabled])');
    preferred?.focus({ preventScroll: true });
  });
}

async function copyClipboard() {
  try { return (await navigator.clipboard.readText()).trim(); } catch { return ''; }
}

async function writeClipboard(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    field.remove();
    return copied;
  }
}

export function settleFloatingRowMenu(_root, anchor) {
  window.requestAnimationFrame(() => {
    // Rerender replaces .dm-host, so the closure's root may be detached by
    // the time this frame runs. Query the mounted overlay instead.
    const menu = document.querySelector('.dm-row-menu-floating');
    if (!menu) return;
    const margin = 8;
    const viewport = window.visualViewport;
    const viewportWidth = Math.max(1, Number(viewport?.width || window.innerWidth));
    const viewportHeight = Math.max(1, Number(viewport?.height || window.innerHeight));
    const viewportLeft = Number(viewport?.offsetLeft || 0);
    const viewportTop = Number(viewport?.offsetTop || 0);
    // A very tall action menu must remain usable inside the viewport. Set the
    // actual available height before clamping so the browser creates an
    // internal scroll area instead of leaving actions below the window edge.
    menu.style.setProperty('max-height', `${Math.max(1, viewportHeight - margin * 2)}px`, 'important');
    const bounds = menu.getBoundingClientRect();
    const left = anchor.alignRight
      ? anchor.x - bounds.width
      : anchor.x;
    const below = anchor.y;
    const above = Number(anchor.above ?? anchor.y) - bounds.height;
    const top = below + bounds.height <= viewportTop + viewportHeight - margin
      ? below
      : Math.max(margin, above);
    const position = {
      left: Math.round(Math.max(viewportLeft + margin, Math.min(viewportLeft + viewportWidth - bounds.width - margin, left))),
      top: Math.round(Math.max(viewportTop + margin, Math.min(viewportTop + viewportHeight - bounds.height - margin, top)))
    };
    runtimeState.rowMenuPosition = position;
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
  });
}

function firstSupportedDroppedLine(value = '') {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && /^(?:https?:|magnet:)/i.test(line)) || '';
}

async function droppedSource(dataTransfer) {
  if (!dataTransfer) return '';
  const uri = firstSupportedDroppedLine(dataTransfer.getData?.('text/uri-list'));
  if (uri) return uri;
  const text = firstSupportedDroppedLine(dataTransfer.getData?.('text/plain'));
  if (text) return text;
  const files = Array.from(dataTransfer.files || []);
  const torrent = files.find((file) => file.name?.toLowerCase().endsWith('.torrent'));
  if (torrent) return String(torrent.path || torrent.webkitRelativePath || '');
  const list = files.find((file) => /\.(?:txt|url)$/i.test(file.name || ''));
  if (list?.text) return firstSupportedDroppedLine(await list.text());
  return '';
}

function readCustomSpeedLimit(menu) {
  const input = menu?.querySelector('[data-dm-speed-custom-value]');
  const raw = String(input?.value ?? '').trim();
  if (!raw || raw === '0') return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const bytesPerSecond = value * 1_000;
  return bytesPerSecond >= 64_000 ? bytesPerSecond : null;
}


export function bindDownloadManagerEvents(context = {}, options = {}) {
  const rerender = options.rerender || ((nextContext) => nextContext.onRerender?.());
  const applyAccent = options.applyAccent || (() => {});
  const root = document.querySelector('.dm-host');
  if (!root) return;
  if (root.dataset.dmEventsBound === '1') return;
  root.dataset.dmEventsBound = '1';
  // Row menus are moved to the fixed floating layer after rendering. Remove
  // the previous document delegate before installing the one for this render;
  // otherwise every refresh would invoke the IPC command multiple times.
  runtimeState.releaseFloatingMenuClick?.();
  bindDownloadManagerThumbnailFallbacks(root);
  bindVirtualListScroll(root);
  bindModalKeyboard(root);
  const jobs = normalizeJobs(context.snapshot || {}, context.pendingJobs || []);
  runtimeState.liveJobs = jobs;
  const rerenderNow = () => rerender(context);
  const openAdvancedDetails = (id) => {
    syncPreferences({ selectedJobId: id, inspectorTab: 'connections', inspectorCollapsed: false });
    runtimeState.modal = '';
    runtimeState.modalJobId = id;
    runtimeState.mobileInspectorOpen = window.innerWidth <= 820;
    runtimeState.rowMenuJobId = null;
    runtimeState.rowMenuPosition = null;
    rerenderNow();
  };

  root.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    changeUiScale(context, event.deltaY > 0 ? -4 : 4);
  }, { passive: false });

  root.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    root.classList.add('is-dragging');
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget)) root.classList.remove('is-dragging');
  });
  root.addEventListener('drop', async (event) => {
    event.preventDefault();
    root.classList.remove('is-dragging');
    const source = await droppedSource(event.dataTransfer);
    if (!source) {
      context.onToast?.('Suelta un enlace HTTP, magnet, archivo .torrent o lista TXT/URL.', 'error');
      return;
    }
    if (/^magnet:/i.test(source) || /\.torrent$/i.test(source)) {
      runtimeState.modal = 'torrent';
      runtimeState.torrentSource = source;
      runtimeState.torrentBusy = false;
      rerenderNow();
      return;
    }
    await context.onAnalyzeSource?.(source, { query: source, alternatives: [] });
  });
  root.addEventListener('contextmenu', (event) => {
    // The native/WebView menu is never useful in CDM. A download row still
    // gets its own application menu below; blank areas intentionally do none.
    event.preventDefault();
    const row = event.target.closest('[data-dm-select-job]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const id = Number(row.dataset.dmSelectJob);
    runtimeState.rowMenuJobId = id;
    runtimeState.rowMenuOpenedAt = performance.now();
    runtimeState.rowMenuAnchor = { x: Number(event.clientX || 0), y: Number(event.clientY || 0) };
    runtimeState.rowMenuPosition = {
      left: Math.round(Math.max(8, event.clientX)),
      top: Math.round(Math.max(8, event.clientY))
    };
    syncPreferences({ selectedJobId: id });
    rerenderNow();
    settleFloatingRowMenu(root, { x: event.clientX, y: event.clientY, above: event.clientY });
  });
  root.addEventListener('dblclick', async (event) => {
    const row = event.target.closest?.('[data-dm-select-job]');
    if (!row || event.target.closest('button,input,select,a,.dm-row-select')) return;
    const rawId = String(row.dataset.dmSelectJob || '');
    const id = Number(rawId);
    const job = (runtimeState.liveJobs || jobs).find((entry) => String(entry.id) === rawId || (Number.isFinite(id) && Number(entry.id) === id));
    if (!job) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      if (job.kind === 'playlist' && job.playlistBatchId) {
        await context.onOpenPlaylistPlayer?.(Number(job.playlistBatchId));
      } else if (job.status === 'completed' && job.destination) {
        if (isPlayableJob(job)) await context.onOpenPlayer?.(id);
        else await context.invoke?.('open_local_file', { path: job.destination });
      } else {
        context.onToast?.('El archivo todavía no está disponible para abrirlo.', 'info');
      }
    } catch (error) {
      context.onToast?.(String(error), 'error');
    }
  });
  runtimeState.releaseGlobalShortcuts();
  runtimeState.releaseSystemThemeListener();
  // Appearance/system theme changes are owned by modules/appearance/sync.js.
  // The Download Manager only rerenders when the shared owner notifies it.
  runtimeState.releaseSystemThemeListener = () => {};
  const handleGlobalKeydown = (event) => {
    const target = event.target;
    const isEditing = target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const usesCommandKey = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (usesCommandKey && key === 'k') {
      event.preventDefault();
      root.querySelector('[data-dm-unified-input]')?.focus();
      return;
    }
    if (usesCommandKey && ['+', '=', '-'].includes(key)) {
      event.preventDefault();
      changeUiScale(context, key === '-' ? -5 : 5);
      return;
    }
    if (usesCommandKey && key === '0') {
      event.preventDefault();
      syncPreferences({ uiScale: 100 });
      context.onUiScaleChange?.(100, { commit: true });
      return;
    }
    if (usesCommandKey && key === 'n' && !isEditing) {
      event.preventDefault();
      runtimeState.addMenuOpen = false;
      root.querySelector('[data-dm-unified-input]')?.focus();
      return;
    }
    if (usesCommandKey && event.shiftKey && key === 'b' && !isEditing) {
      event.preventDefault();
      if (window.innerWidth <= 820) runtimeState.mobileSidebarOpen = !runtimeState.mobileSidebarOpen;
      else syncPreferences({ sidebarCollapsed: !runtimeState.preferences.sidebarCollapsed });
      rerenderNow();
      return;
    }
    if (event.key === 'F5' && !isEditing) {
      event.preventDefault();
      void context.onRefresh?.();
      return;
    }
    if (event.key === 'Escape' && (runtimeState.modal || context.clipboardPrompt || runtimeState.addMenuOpen || runtimeState.categoryMenuOpen || runtimeState.mobileSidebarOpen || runtimeState.mobileInspectorOpen || runtimeState.rowMenuJobId)) {
      event.preventDefault();
      const clipboardPrompt = context.getClipboardPrompt?.() || context.clipboardPrompt;
      if (clipboardPrompt && !runtimeState.modal) {
        void context.onClipboardPreviewAction?.(clipboardPrompt, 'cancel', false);
        return;
      }
      runtimeState.modal = '';
      runtimeState.modalJobId = null;
      runtimeState.deletePreview = null;
      runtimeState.deletePreviewBusy = false;
      runtimeState.deleteBusy = false;
      runtimeState.addMenuOpen = false;
      runtimeState.categoryMenuOpen = false;
      runtimeState.mobileSidebarOpen = false;
      runtimeState.mobileInspectorOpen = false;
      runtimeState.rowMenuJobId = null;
      runtimeState.rowMenuPosition = null;
      rerenderNow();
    }
  };
  const handleGlobalPointerDown = (event) => {
    if (!runtimeState.rowMenuJobId || event.button !== 0) return;
    // Keep the contextual menu and the `.dm-inspector,.dm-speed-menu` editor
    // alive through pointerdown -> click; otherwise capture would detach the button before the delegated click handler can persist the selected limit.
    if (event.target instanceof Element && event.target.closest('.dm-row-menu,.dm-row-menu-floating,.dm-speed-menu,.dm-inspector-speed-menu,[data-dm-row-menu]')) return;
    const elapsed = performance.now() - Number(runtimeState.rowMenuOpenedAt || 0);
    const anchor = runtimeState.rowMenuAnchor;
    const nearContextAnchor = anchor
      && Math.hypot(Number(event.clientX || 0) - anchor.x, Number(event.clientY || 0) - anchor.y) <= 18;
    // WebView2 can emit a primary pointer gesture immediately after contextmenu.
    // Ignore only that near-origin echo; a genuine click elsewhere still closes it.
    if (elapsed >= 0 && elapsed < 450 && nearContextAnchor) return;
    runtimeState.rowMenuJobId = null;
    runtimeState.rowMenuPosition = null;
    runtimeState.rowMenuOpenedAt = 0;
    runtimeState.rowMenuAnchor = null;
    rerenderNow();
  };
  const handleRowMenuClickDismiss = (event) => {
    if (!runtimeState.rowMenuJobId) return;
    const target = event.target instanceof Element ? event.target : null;
    const menu = target?.closest('.dm-row-menu,.dm-row-menu-floating');
    if (!menu) return;
    // Let the action's own click handler finish first. Keep the speed input
    // open while the user is entering a value; clicking its Apply button still
    // closes the menu through this deferred path.
    if (target.closest('.dm-speed-menu') && !target.closest('button')) return;
    window.setTimeout(() => {
      if (!runtimeState.rowMenuJobId) return;
      runtimeState.rowMenuJobId = null;
      runtimeState.rowMenuPosition = null;
      runtimeState.rowMenuOpenedAt = 0;
      runtimeState.rowMenuAnchor = null;
      rerenderNow();
    }, 0);
  };
  document.addEventListener('keydown', handleGlobalKeydown);
  // Close row menus only on a genuine primary-button pointer gesture. WebView2
  // may emit a retargeted/synthetic click after contextmenu while progress is
  // repainting; listening to click was the reason active-download menus flashed.
  document.addEventListener('pointerdown', handleGlobalPointerDown, true);
  document.addEventListener('click', handleRowMenuClickDismiss, true);
  runtimeState.releaseGlobalShortcuts = () => {
    document.removeEventListener('keydown', handleGlobalKeydown);
    document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
    document.removeEventListener('click', handleRowMenuClickDismiss, true);
  };
  root.addEventListener('click', (event) => {
    const previewSuggestion = event.target.closest('[data-dm-preview-suggestion]');
    const previewResult = event.target.closest('[data-dm-preview-result]');
    const suggestionVisual = event.target.closest('.dm-suggestion-visual');
    const suggestionOwner = suggestionVisual?.closest('[data-dm-suggestion-index]');
    const suggestionFromThumbnail = suggestionOwner
      ? runtimeState.unifiedSuggestions[Number(suggestionOwner.dataset.dmSuggestionIndex)]
      : null;
    const previewSource = previewSuggestion?.dataset.dmPreviewSuggestion || previewResult?.dataset.dmPreviewResult || suggestionFromThumbnail?.sourceUrl || '';
    if (previewSource) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void context.invoke?.('open_online_media_player', { url: previewSource }).catch((error) => context.onToast?.(String(error), 'error'));
      return;
    }
    const suggestionButton = event.target.closest('[data-dm-suggestion-index]');
    if (suggestionButton) {
      const suggestion = runtimeState.unifiedSuggestions[Number(suggestionButton.dataset.dmSuggestionIndex)];
      if (!suggestion) return;
      runtimeState.unifiedQuery = suggestion.title;
      runtimeState.unifiedActiveIndex = Number(suggestionButton.dataset.dmSuggestionIndex);
      void submitUnifiedInput(context, suggestion.title, rerender);
      return;
    }
    let changed = false;
    if (runtimeState.addMenuOpen && !event.target.closest('.dm-add-split')) {
      runtimeState.addMenuOpen = false;
      changed = true;
    }
    if (runtimeState.settingsOpen && !event.target.closest('.dm-settings-popover,[data-dm-open-settings]')) {
      runtimeState.settingsOpen = false;
      changed = true;
    }
    if (runtimeState.categoryMenuOpen && !event.target.closest('.dm-category-control')) {
      runtimeState.categoryMenuOpen = false;
      changed = true;
    }
    if (runtimeState.unifiedFocused && !event.target.closest('.dm-unified-search')) {
      runtimeState.unifiedFocused = false;
      changed = true;
    }
    if (changed) rerenderNow();
  });

  const handleDownloadAreaClick = async (event) => {
    const target = event.target;
    const area = target.closest?.('.dm-download-area');
    const floatingMenu = target.closest?.('.dm-row-menu-floating');
    const inspector = target.closest?.('.dm-inspector');
    if (!area && !floatingMenu && !inspector) return;
    const clickedRow = target.closest?.('[data-dm-select-job]');
    const interactive = target.closest?.('button,input,select,textarea,a,[data-dm-row-menu],.dm-row-select');
    // A click on the empty download surface is an explicit deselect gesture.
    // Keep controls, inspector content, and row actions out of this branch so
    // their delegated handlers retain their existing behavior.
    if (area && !clickedRow && !interactive && !floatingMenu && !inspector) {
      const hadSelection = runtimeState.preferences.selectedJobId !== null || runtimeState.selectedJobIds.size > 0;
      if (hadSelection) {
        syncPreferences({ selectedJobId: null });
        runtimeState.selectedJobIds.clear();
        runtimeState.selectionMode = false;
        runtimeState.rowMenuJobId = null;
        runtimeState.rowMenuPosition = null;
        rerenderNow();
      }
      return;
    }
    const currentJobs = runtimeState.liveJobs || [];
    const renameButton = target.closest('[data-dm-rename-job]');
    if (renameButton) {
      event.preventDefault();
      event.stopPropagation();
      runtimeState.rowMenuJobId = null;
      runtimeState.rowMenuPosition = null;
      runtimeState.modal = 'rename';
      runtimeState.modalJobId = Number(renameButton.dataset.dmRenameJob || 0);
      rerenderNow();
      const input = root.querySelector('#dm-rename-name');
      input?.focus();
      input?.select();
      input?.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          root.querySelector('[data-dm-rename-save]')?.click();
        }
      });
      return;
    }
    const priorityButton = target.closest('[data-dm-set-priority]');
    if (priorityButton) {
      event.stopPropagation();
      const jobId = Number(priorityButton.dataset.jobId || playlistJobId(priorityButton.dataset.playlistBatchId));
      await changeDownloadPriority(context, currentJobs, [jobId], priorityButton.dataset.dmSetPriority, rerenderNow);
      return;
    }
    const speedButton = target.closest('[data-dm-set-speed-limit],[data-dm-apply-speed-limit]');
    if (speedButton) {
      event.stopPropagation();
      const jobId = Number(speedButton.dataset.jobId || 0);
      const bytesPerSecond = speedButton.matches('[data-dm-apply-speed-limit]')
        ? readCustomSpeedLimit(speedButton.closest('.dm-speed-menu'))
        : Math.max(0, Number(speedButton.dataset.dmSetSpeedLimit || 0));
      if (!jobId) return;
      if (bytesPerSecond === null) {
        context.onToast?.('Introduce una velocidad de al menos 64 KB/s.', 'error');
        return;
      }
      try {
        await context.invoke?.('set_download_speed_limit', {
          id: jobId,
          settings: bytesPerSecond > 0
            ? { mode: 'limited', bytesPerSecond }
            : { mode: 'unlimited' }
        });
        const job = currentJobs.find((entry) => Number(entry.id) === jobId);
        // External engines receive their rate when they start. Restart only
        // those active workers so the new per-job limit takes effect now;
        // native HTTP refreshes its limiter in-place and do not flicker.
        if (job?.status === 'running' && ['yt-dlp', 'aria2c'].includes(String(job.engine || '').toLowerCase())) {
          await context.invoke?.('set_job_status', { id: jobId, status: 'paused' });
          await context.invoke?.('set_job_status', { id: jobId, status: 'running' });
        }
        runtimeState.rowMenuJobId = null;
        runtimeState.rowMenuPosition = null;
        context.onToast?.(bytesPerSecond > 0 ? `Límite de esta descarga: ${speedButton.querySelector('span')?.textContent || 'personalizado'}.` : 'Esta descarga quedó sin límite de velocidad.', 'success');
        await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(jobId)]) });
      } catch (error) {
        context.onToast?.(String(error), 'error');
      }
      return;
    }
    const playlistSpeedButton = target.closest('[data-dm-set-playlist-speed-limit],[data-dm-apply-playlist-speed-limit]');
    if (playlistSpeedButton) {
      event.stopPropagation();
      const batchId = Number(playlistSpeedButton.dataset.playlistBatchId || 0);
      const bytesPerSecond = playlistSpeedButton.matches('[data-dm-apply-playlist-speed-limit]')
        ? readCustomSpeedLimit(playlistSpeedButton.closest('.dm-speed-menu'))
        : Math.max(0, Number(playlistSpeedButton.dataset.dmSetPlaylistSpeedLimit || 0));
      if (!batchId) return;
      if (bytesPerSecond === null) {
        context.onToast?.('Introduce una velocidad de al menos 64 KB/s.', 'error');
        return;
      }
      try {
        await context.invoke?.('set_playlist_speed_limit', {
          batchId,
          settings: bytesPerSecond > 0
            ? { mode: 'limited', bytesPerSecond }
            : { mode: 'unlimited' }
        });
        runtimeState.rowMenuJobId = null;
        runtimeState.rowMenuPosition = null;
        context.onToast?.(bytesPerSecond > 0 ? `Límite de la playlist: ${playlistSpeedButton.querySelector('span')?.textContent || 'personalizado'}.` : 'La playlist quedó sin límite de velocidad.', 'success');
        await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(playlistJobId(batchId))]) });
      } catch (error) {
        context.onToast?.(String(error), 'error');
      }
      return;
    }
    const playlistPlayerButton = target.closest('[data-dm-open-playlist-player]');
    if (playlistPlayerButton) {
      event.stopPropagation();
      try { await context.onOpenPlaylistPlayer?.(Number(playlistPlayerButton.dataset.dmOpenPlaylistPlayer || 0)); }
      catch (error) { context.onToast?.(String(error), 'error'); }
      return;
    }
    const playerButton = target.closest('[data-dm-open-player]');
    if (playerButton) {
      event.stopPropagation();
      await context.onOpenPlayer?.(Number(playerButton.dataset.dmOpenPlayer || 0));
      return;
    }
    const row = target.closest('[data-dm-select-job]');
    const menuButton = target.closest('[data-dm-row-menu]');
    if (menuButton) {
      event.stopPropagation();
      const id = Number(menuButton.dataset.dmRowMenu);
      const rect = menuButton.getBoundingClientRect();
      runtimeState.rowMenuJobId = id;
      runtimeState.rowMenuPosition = {
        left: Math.round(Math.max(8, Math.min(window.innerWidth - 240, rect.right - 232))),
        top: Math.round(Math.max(8, rect.bottom + 7))
      };
      syncPreferences({ selectedJobId: id });
      rerender(context);
      settleFloatingRowMenu(root, { x: rect.right, y: rect.bottom + 7, above: rect.top - 7, alignRight: true });
      return;
    }
    const actionButton = target.closest('[data-dm-job-action]');
    if (actionButton) {
      event.stopPropagation();
      const id = Number(actionButton.dataset.jobId);
      const action = actionButton.dataset.dmJobAction;
      const job = currentJobs.find((entry) => entry.id === id);
      try {
        if (action === 'reveal') {
          if (!job?.destination) throw new Error('Esta tarea no tiene un archivo local disponible.');
          await context.invoke?.('reveal_local_file', { path: job.destination });
        } else {
          const nextStatus = action === 'pause' ? 'paused' : 'running';
          runtimeState.rowMenuJobId = null;
          runtimeState.rowMenuPosition = null;
          context.onOptimisticJobStatus?.(id, nextStatus);
          await context.invoke?.('set_job_status', { id, status: nextStatus });
          await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(id)]) });
        }
      } catch (error) {
        if (action !== 'reveal') context.onOptimisticJobStatus?.(id, null);
        context.onToast?.(String(error), 'error');
      }
      return;
    }
    const playlistButton = target.closest('[data-dm-playlist-action]');
    if (playlistButton) {
      event.stopPropagation();
      const batchId = Number(playlistButton.dataset.playlistBatchId || 0);
      const action = playlistButton.dataset.dmPlaylistAction;
      const jobId = playlistJobId(batchId);
      const nextStatus = action === 'pause' ? 'paused' : action === 'retry' ? 'queued' : 'running';
      try {
        runtimeState.rowMenuJobId = null;
        runtimeState.rowMenuPosition = null;
        context.onOptimisticJobStatus?.(jobId, nextStatus, { resetProgress: action === 'retry' });
        if (action === 'retry') await context.invoke?.('retry_failed_playlist_items', { batchId });
        else await context.invoke?.('set_playlist_batch_paused', { batchId, paused: action === 'pause' });
        await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(jobId)]) });
      } catch (error) {
        context.onOptimisticJobStatus?.(jobId, null);
        context.onToast?.(String(error), 'error');
      }
      return;
    }
    const revealButton = target.closest('[data-dm-reveal-path]');
    if (revealButton) {
      event.stopPropagation();
      try { await context.invoke?.('reveal_local_file', { path: revealButton.dataset.dmRevealPath || '' }); }
      catch (error) { context.onToast?.(String(error), 'error'); }
      return;
    }
    const openDownloadsButton = target.closest('[data-dm-open-download-directory]');
    if (openDownloadsButton) {
      event.stopPropagation();
      try { await context.invoke?.('open_download_directory'); }
      catch (error) { context.onToast?.(String(error), 'error'); }
      return;
    }
    const openButton = target.closest('[data-dm-open-path]');
    if (openButton) {
      event.stopPropagation();
      try { await context.invoke?.('open_local_file', { path: openButton.dataset.dmOpenPath || '' }); }
      catch (error) { context.onToast?.(String(error), 'error'); }
      return;
    }
    const cancelButton = target.closest('[data-dm-cancel-job]');
    if (cancelButton) { runtimeState.modal = 'cancel'; runtimeState.modalJobId = Number(cancelButton.dataset.dmCancelJob); rerender(context); return; }
    const deleteButton = target.closest('[data-dm-delete-job]');
    if (deleteButton) {
      runtimeState.modal = 'delete';
      runtimeState.modalJobId = Number(deleteButton.dataset.dmDeleteJob);
      runtimeState.deletePreview = null;
      runtimeState.deletePreviewBusy = true;
      rerender(context);
      Promise.resolve(context.invoke?.('job_storage_preview', { id: runtimeState.modalJobId }))
        .then((preview) => { runtimeState.deletePreview = preview; })
        .catch((error) => { runtimeState.deletePreview = { safetyWarning: String(error), safeForStorageDeletion: false, storageExists: false }; context.onToast?.(String(error), 'error'); })
        .finally(() => { runtimeState.deletePreviewBusy = false; rerender(context); });
      return;
    }
    const recoverButton = target.closest('[data-dm-recover-job]');
    if (recoverButton) { runtimeState.modal = 'recovery'; runtimeState.modalJobId = Number(recoverButton.dataset.dmRecoverJob); runtimeState.recoveryResult = null; rerender(context); return; }
    const alternativeButton = target.closest('[data-dm-analyze-result]');
    if (alternativeButton) { void context.onAnalyzeSource?.(alternativeButton.dataset.dmAnalyzeResult, { query: alternativeButton.textContent.trim(), alternatives: [] }); return; }
    const advancedButton = target.closest('[data-dm-advanced-details]');
    if (advancedButton) {
      event.stopPropagation();
      const id = Number(advancedButton.dataset.dmAdvancedDetails || 0);
      if (!id) return;
      openAdvancedDetails(id);
      return;
    }
    if (row && !target.closest('button,input,select,a,.dm-row-select')) {
      const id = Number(row.dataset.dmSelectJob);
      if (runtimeState.selectionMode) {
        if (runtimeState.selectedJobIds.has(id)) runtimeState.selectedJobIds.delete(id);
        else runtimeState.selectedJobIds.add(id);
        patchVisualSelection(root);
        patchSelectionControls(root, jobs);
        return;
      }
      syncPreferences({ selectedJobId: id });
      patchVisualSelection(root);
      if (window.innerWidth <= 820) runtimeState.mobileInspectorOpen = true;
      if (window.innerWidth <= 820 || root.querySelector('.dm-inspector:not(.dm-empty-inspector)')) rerenderNow();
    }
  };
  root.addEventListener('click', handleDownloadAreaClick);
  // A genuine click on empty Main content clears the focused row.  Controls,
  // rows, sidebars and overlays are intentionally excluded.
  root.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-dm-select-job],button,input,select,textarea,a,.dm-row-menu,.dm-inspector,.dm-settings-popover,.dm-category-menu')) return;
    const blankMain = event.target === root || Boolean(event.target.closest?.('.dm-zen-main,.dm-zen-content,.dm-download-area'));
    const hasSelection = runtimeState.preferences.selectedJobId !== null || runtimeState.selectedJobIds.size > 0;
    if (!blankMain || !hasSelection) return;
    syncPreferences({ selectedJobId: null });
    runtimeState.selectedJobIds.clear();
    runtimeState.selectionMode = false;
    runtimeState.rowMenuJobId = null;
    runtimeState.rowMenuPosition = null;
    patchVisualSelection(root);
    patchSelectionControls(root, runtimeState.liveJobs || []);
    rerenderNow();
  });
  // Floating row menus live outside .dm-host to avoid clipped panels, so
  // their actions must be handled at document level as well.
  // Keep the document listener scoped to detached floating UI.  Events from
  // the manager itself already bubble through the root listener; forwarding
  // them here would run the row-selection branch twice and immediately undo
  // the user's click.
  const handleFloatingMenuClick = (event) => {
    if (root.contains(event.target)) return;
    handleDownloadAreaClick(event);
  };
  document.addEventListener('click', handleFloatingMenuClick);
  runtimeState.releaseFloatingMenuClick = () => {
    document.removeEventListener('click', handleFloatingMenuClick);
    runtimeState.releaseFloatingMenuClick = null;
  };

  root.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const row = event.target.closest?.('[data-dm-select-job]');
    if (!row || event.target.closest('button,input,select,textarea,a,.dm-row-select')) return;
    event.preventDefault();
    row.click();
  });

  root.addEventListener('change', (event) => {
    const area = event.target.closest?.('.dm-download-area');
    const input = event.target.closest?.('[data-dm-select-checkbox]');
    if (!area || !input) return;
    event.stopPropagation();
    const id = Number(input.dataset.dmSelectCheckbox || 0);
    if (!id) return;
    if (input.checked) runtimeState.selectedJobIds.add(id);
    else runtimeState.selectedJobIds.delete(id);
    patchVisualSelection(root);
    patchSelectionControls(root, jobs);
  });

  root.querySelectorAll('[data-dm-open-playlist-player]').forEach((button) => button.addEventListener('click', async (event) => {
    if (button.closest('.dm-download-scroll[data-dm-virtual-list="1"]')) return;
    event.stopPropagation();
    try { await context.onOpenPlaylistPlayer?.(Number(button.dataset.dmOpenPlaylistPlayer || 0)); }
    catch (error) { context.onToast?.(String(error), 'error'); }
  }));
  root.querySelectorAll('[data-dm-open-player]').forEach((button) => button.addEventListener('click', async (event) => {
    if (button.closest('.dm-download-scroll[data-dm-virtual-list="1"]')) return;
    event.stopPropagation();
    try { await context.onOpenPlayer?.(Number(button.dataset.dmOpenPlayer || 0)); }
    catch (error) { context.onToast?.(String(error), 'error'); }
  }));
  root.querySelectorAll('[data-dm-selection-toggle]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    runtimeState.selectionMode = !runtimeState.selectionMode;
    if (!runtimeState.selectionMode) runtimeState.selectedJobIds.clear();
    runtimeState.rowMenuJobId = null;
    runtimeState.rowMenuPosition = null;
    runtimeState.rowMenuOpenedAt = 0;
    runtimeState.rowMenuAnchor = null;
    rerenderNow();
  }));
  root.querySelector('[data-dm-select-all-visible]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const activeSection = sectionForLayout(runtimeState.preferences);
    const visibleJobs = jobsForSection(runtimeState.liveJobs || jobs, runtimeState.preferences, activeSection);
    const allSelected = visibleJobs.length && visibleJobs.every((job) => runtimeState.selectedJobIds.has(Number(job.id)));
    visibleJobs.forEach((job) => { if (allSelected) runtimeState.selectedJobIds.delete(Number(job.id)); else runtimeState.selectedJobIds.add(Number(job.id)); });
    rerenderNow();
  });
  root.querySelector('[data-dm-bulk-delete]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!runtimeState.selectedJobIds.size) return;
    runtimeState.modal = 'bulk-delete';
    rerenderNow();
  });
  root.querySelector('[data-dm-category-toggle]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    runtimeState.categoryMenuOpen = !runtimeState.categoryMenuOpen;
    rerenderNow();
  });
  root.querySelectorAll('[data-dm-category-option]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    runtimeState.categoryMenuOpen = false;
    syncPreferences({ category: button.dataset.dmCategoryOption || 'all', filter: 'all', section: 'downloads' });
    rerenderNow();
  }));
  const unifiedInput = root.querySelector('[data-dm-unified-input]');
  unifiedInput?.addEventListener('focus', () => {
    runtimeState.unifiedFocused = true;
    runtimeState.unifiedQuery = unifiedInput.value;
    if (!runtimeState.unifiedSuggestions.length) runtimeState.unifiedSuggestions = localUnifiedSuggestions(unifiedInput.value);
    paintUnifiedSearch(context, unifiedInput);
  });
  unifiedInput?.addEventListener('input', (event) => scheduleUnifiedSuggestions(context, event.currentTarget));
  unifiedInput?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveUnifiedSuggestion(context, event.currentTarget, 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveUnifiedSuggestion(context, event.currentTarget, -1); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitUnifiedInput(context, event.currentTarget.value, rerender);
      return;
    }
    if (event.key === 'Escape') { runtimeState.unifiedFocused = false; runtimeState.unifiedActiveIndex = -1; paintUnifiedSearch(context, event.currentTarget); }
  });
  root.querySelector('[data-dm-unified-submit]')?.addEventListener('click', () => { void submitUnifiedInput(context, undefined, rerender); });
  root.querySelector('[data-dm-unified-clear]')?.addEventListener('click', () => {
    runtimeState.unifiedQuery = '';
    runtimeState.unifiedSuggestions = [];
    runtimeState.unifiedActiveIndex = -1;
    runtimeState.unifiedSuggestionBusy = false;
    runtimeState.unifiedActiveIndex = -1;
    runtimeState.unifiedFocused = true;
    unifiedInput.value = '';
    paintUnifiedSearch(context, unifiedInput);
    unifiedInput.focus({ preventScroll: true });
  });
  root.querySelectorAll('[data-dm-focus-unified]').forEach((button) => button.addEventListener('click', () => {
    runtimeState.unifiedFocused = true;
    context.onNewDownload?.();
    window.requestAnimationFrame(() => {
      document.querySelector('#download-url')?.focus();
      document.querySelector('[data-dm-unified-input]')?.focus();
    });
  }));
  root.querySelectorAll('[data-dm-inspector-tab]').forEach((button) => button.addEventListener('click', () => { syncPreferences({ inspectorTab: button.dataset.dmInspectorTab }); rerenderNow(); }));
  root.querySelectorAll('[data-dm-copy-value]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const copied = await writeClipboard(button.dataset.dmCopyValue || '');
    context.onToast?.(copied ? 'Copiado al portapapeles.' : 'No se pudo copiar el valor.', copied ? 'success' : 'error');
  }));
  root.querySelector('[data-dm-rename-save]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    const id = Number(runtimeState.modalJobId || 0);
    const filename = String(root.querySelector('#dm-rename-name')?.value || '').trim();
    if (!id || !filename) return;
    button.disabled = true;
    try {
      await context.invoke?.('rename_completed_download', { id, newName: filename });
      runtimeState.modal = '';
      runtimeState.modalJobId = null;
      await context.onRefresh?.();
      context.onToast?.('Archivo renombrado correctamente.', 'success');
      rerenderNow();
    } catch (error) {
      button.disabled = false;
      context.onToast?.(String(error), 'error');
    }
  });
  root.querySelectorAll('[data-dm-toggle]').forEach((button) => button.addEventListener('click', () => {
    const target = button.dataset.dmToggle;
    if (target === 'sidebar') {
      if (window.innerWidth <= 820) runtimeState.mobileSidebarOpen = !runtimeState.mobileSidebarOpen;
      else syncPreferences({ sidebarCollapsed: !runtimeState.preferences.sidebarCollapsed });
    }
    if (target === 'inspector') {
      if (window.innerWidth <= 820) runtimeState.mobileInspectorOpen = !runtimeState.mobileInspectorOpen;
      else syncPreferences({ inspectorCollapsed: !runtimeState.preferences.inspectorCollapsed });
    }
    if (target === 'lower') syncPreferences({ lowerPanelCollapsed: !runtimeState.preferences.lowerPanelCollapsed });
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-open-settings]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (context.onSection?.('settings') === true) return;
    runtimeState.settingsOpen = !runtimeState.settingsOpen;
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-settings-section]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    runtimeState.settingsSection = button.dataset.dmSettingsSection || 'general';
    runtimeState.settingsScrollTop = 0;
    rerenderNow();
  }));
  root.querySelector('[data-dm-settings-close]')?.addEventListener('click', () => { runtimeState.settingsOpen = false; rerenderNow(); });
  root.querySelector('.dm-settings-popover')?.addEventListener('scroll', (event) => { runtimeState.settingsScrollTop = event.currentTarget.scrollTop; }, { passive: true });
  root.querySelector('[data-dm-choose-download-directory]')?.addEventListener('click', () => context.onChooseDownloadDirectory?.());
  root.querySelector('[data-dm-open-download-directory]')?.addEventListener('click', () => context.onOpenDownloadDirectory?.());
  root.querySelector('[data-dm-repair-integration]')?.addEventListener('click', () => context.onRepairIntegration?.());
  root.querySelector('[data-dm-spotify-connect]')?.addEventListener('click', () => context.onSpotifyConnect?.());
  root.querySelector('[data-dm-spotify-disconnect]')?.addEventListener('click', () => context.onSpotifyDisconnect?.());
  root.querySelector('[data-dm-refresh-runtime]')?.addEventListener('click', () => context.onRefreshRuntime?.());
  root.querySelector('[data-dm-copy-diagnostics]')?.addEventListener('click', () => context.onCopyDiagnostics?.());
  root.querySelector('[data-dm-media-output]')?.addEventListener('change', (event) => context.onMediaPreferencesChange?.({ outputMode: event.currentTarget.value }));
  root.querySelector('[data-dm-media-quality]')?.addEventListener('change', (event) => context.onMediaPreferencesChange?.({ quality: event.currentTarget.value }));
  root.querySelector('[data-dm-playlist-format]')?.addEventListener('change', (event) => context.onMediaPreferencesChange?.({ playlistFormat: event.currentTarget.value }));
  root.querySelector('[data-dm-media-session-consent]')?.addEventListener('change', (event) => context.onMediaSessionChange?.({ useBraveCookies: event.currentTarget.checked, cookiesPath: event.currentTarget.checked ? null : context.mediaSessionSettings?.cookiesPath || null }));
  root.querySelector('[data-dm-choose-media-cookies]')?.addEventListener('click', () => context.onChooseMediaCookies?.());
  root.querySelector('[data-dm-clear-media-cookies]')?.addEventListener('click', () => context.onMediaSessionChange?.({ useBraveCookies: false, cookiesPath: null }));
  root.querySelector('[data-dm-check-update]')?.addEventListener('click', () => context.onCheckUpdate?.());
  root.querySelector('[data-dm-dismiss-update]')?.addEventListener('click', () => context.onDismissUpdate?.());
  root.querySelectorAll('[data-dm-install-update]').forEach((button) => button.addEventListener('click', () => context.onInstallUpdate?.()));
  root.querySelectorAll('[data-dm-news-action]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const action = button.dataset.dmNewsAction;
    if (action === 'check-update') context.onCheckUpdate?.();
    if (action === 'open-update-modal') { runtimeState.modal = 'update'; rerenderNow(); }
    if (action === 'open-news-details') { runtimeState.modalNewsId = button.dataset.newsId || ''; runtimeState.modal = 'news-details'; rerenderNow(); }
    if (action === 'open-news-image') { runtimeState.modalNewsImage = button.dataset.newsImage || ''; runtimeState.modal = 'news-image'; rerenderNow(); }
    if (action === 'support') context.onSupport?.();
    if (action === 'dismiss-news') context.onDismissNews?.(button.dataset.newsId || '');
    if (action === 'dismiss-history') context.onDismissHistory?.(button.dataset.historyId || '');
    if (action === 'install-update') context.onInstallUpdate?.();
    if (action === 'dismiss-update') context.onDismissUpdate?.();
    if (action === 'open-extension-modal') { runtimeState.modal = 'extension'; rerenderNow(); }
    if (action === 'open-extension') context.onOpenExtension?.();
    if (action === 'decline-extension') context.onExtensionPromptDecision?.('declined');
    if (action === 'feedback') { runtimeState.modal = 'feedback'; rerenderNow(); }
    if (action === 'open-news-url') {
      const url = button.dataset.newsUrl || '';
      if (url) context.onOpenNewsUrl?.(url);
    }
  }));
  root.querySelectorAll('[data-dm-news-filter]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    runtimeState.newsFilter = button.dataset.dmNewsFilter || 'all';
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-clipboard-action]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.dmClipboardAction || 'cancel';
    const suppress = Boolean(root.querySelector('[data-dm-clipboard-suppress]')?.checked);
    const clipboardPrompt = context.getClipboardPrompt?.() || context.clipboardPrompt;
    if (!clipboardPrompt) return;
    button.disabled = true;
    await context.onClipboardPreviewAction?.(clipboardPrompt, action, suppress);
  }));
  root.querySelector('[data-dm-auto-update]')?.addEventListener('change', (event) => context.onAutoUpdateChange?.(event.currentTarget.checked));
  root.querySelector('[data-dm-close-action]')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try { await context.onWindowBehaviorChange?.(input.value); }
    finally { input.disabled = false; }
  });
  root.querySelector('[data-dm-startup]')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try { await context.onStartupChange?.(input.checked); }
    finally { input.disabled = false; }
  });
  root.querySelectorAll('[data-dm-setting][type="color"]').forEach((input) => input.addEventListener('input', () => {
    const key = input.dataset.dmSetting;
    runtimeState.preferences = normalizePreferences({ ...runtimeState.preferences, [key]: input.value, ...(key === 'success' ? { successCustomized: true, progressCompleted: input.value, progressCompletedCustomized: true } : {}) });
    if (key === 'accent') {
      applyAccent(root, runtimeState.preferences);
      context.onAppearanceChange?.({ accent: input.value }, { commit: false });
    } else {
      const variable = ({ success: '--dm-success', warning: '--dm-warning', progressPaused: '--dm-progress-paused', danger: '--dm-danger' })[key];
      if (variable) root.style.setProperty(variable, input.value);
    }
  }));
  const accentIntensityRange = root.querySelector('[data-dm-setting="accentIntensity"]');
  accentIntensityRange?.addEventListener('input', (event) => {
    const accentIntensity = Math.max(40, Math.min(100, Math.round(Number(event.currentTarget.value || 88))));
    runtimeState.preferences = normalizePreferences({ ...runtimeState.preferences, accentIntensity });
    const output = event.currentTarget.parentElement?.querySelector('output');
    if (output) output.textContent = `${accentIntensity}%`;
    applyAccent(root, runtimeState.preferences);
    context.onAppearanceChange?.({ intensity: accentIntensity }, { commit: false });
  });
  const scaleRange = root.querySelector('[data-dm-setting="uiScale"]');
  const scaleNumber = root.querySelector('[data-dm-scale-number]');
  const applyUiScaleControl = (rawValue) => {
    const uiScale = Math.max(50, Math.min(130, Math.round(Number(rawValue ?? 100) / 5) * 5));
    runtimeState.preferences = normalizePreferences({ ...runtimeState.preferences, uiScale });
    root.style.setProperty('--dm-ui-scale', String(runtimeState.preferences.uiScale / 100));
    root.style.setProperty('--dm-text-scale', String(Math.max(.92, Math.min(1.16, 1.08 + (runtimeState.preferences.textScale - 100) * 0.004))));
    root.style.setProperty('--dm-ui-inverse', String(100 / runtimeState.preferences.uiScale));
    if (scaleRange) scaleRange.value = String(uiScale);
    if (scaleNumber) scaleNumber.value = String(uiScale);
    context.onUiScaleChange?.(runtimeState.preferences.uiScale, { commit: false });
    const output = root.querySelector('.dm-scale-setting output');
    if (output) output.textContent = `${runtimeState.preferences.uiScale}%`;
  };
  scaleRange?.addEventListener('input', (event) => applyUiScaleControl(event.currentTarget.value));
  scaleNumber?.addEventListener('change', (event) => applyUiScaleControl(event.currentTarget.value));
  scaleNumber?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyUiScaleControl(event.currentTarget.value); } });
  const textScaleRange = root.querySelector('[data-dm-setting="textScale"]');
  textScaleRange?.addEventListener('input', (event) => {
    const textScale = Math.max(80, Math.min(120, Math.round(Number(event.currentTarget.value ?? 100) / 5) * 5));
    runtimeState.preferences = normalizePreferences({ ...runtimeState.preferences, textScale });
    root.style.setProperty('--dm-text-scale', String(Math.max(.92, Math.min(1.16, 1.08 + (textScale - 100) * 0.004))));
    const output = event.currentTarget.parentElement?.querySelector('output');
    if (output) output.textContent = `${textScale}%`;
    context.onAppearanceChange?.({ textScale }, { commit: false });
  });
  root.querySelector('[data-dm-scale-decrease]')?.addEventListener('click', () => changeUiScale(context, -5));
  root.querySelector('[data-dm-scale-increase]')?.addEventListener('click', () => changeUiScale(context, 5));
  root.querySelectorAll('[data-dm-setting]').forEach((input) => input.addEventListener('change', () => {
    const key = input.dataset.dmSetting;
    const value = input.type === 'checkbox' ? input.checked : input.value;
    const patch = { [key]: value };
    if (key === 'success') {
      patch.successCustomized = true;
      patch.progressCompleted = value;
      patch.progressCompletedCustomized = true;
    }
    if (key === 'layout') patch.section = 'downloads';
    syncPreferences(patch);
    if (key === 'accent') context.onAppearanceChange?.({ accent: value }, { commit: true });
    if (key === 'accentIntensity') context.onAppearanceChange?.({ intensity: Number(value) }, { commit: true });
    if (key === 'uiScale') context.onUiScaleChange?.(Number(value), { commit: true });
    if (key === 'textScale') context.onAppearanceChange?.({ textScale: Number(value) }, { commit: true });
    if (key === 'theme') context.onAppearanceChange?.({ theme: value }, { commit: true });
    if (!['accent', 'accentIntensity', 'uiScale', 'textScale', 'theme', 'success', 'warning', 'progressPaused', 'danger'].includes(key)) rerenderNow();
  }));
  root.querySelectorAll('[data-dm-theme-toggle]').forEach((button) => button.addEventListener('click', () => {
    const theme = resolveTheme(runtimeState.preferences) === 'dark' ? 'light' : 'dark';
    syncPreferences({ theme });
    context.onAppearanceChange?.({ theme }, { commit: true });
    applyAccent(root, runtimeState.preferences);
  }));
  root.querySelectorAll('[data-dm-new-download]').forEach((button) => button.addEventListener('click', () => { runtimeState.addMenuOpen = false; context.onNewDownload?.(); }));
  root.querySelectorAll('[data-dm-paste-link]').forEach((button) => button.addEventListener('click', async () => {
    runtimeState.addMenuOpen = false;
    const value = await copyClipboard();
    if (!value) { context.onToast?.('El portapapeles no contiene un enlace compatible.', 'error'); return; }
    runtimeState.unifiedQuery = value;
    await submitUnifiedInput(context, value, rerender);
  }));
  root.querySelectorAll('[data-dm-add-torrent]').forEach((button) => button.addEventListener('click', () => { runtimeState.addMenuOpen = false; runtimeState.modal = 'torrent'; runtimeState.torrentSource = ''; runtimeState.torrentBusy = false; rerenderNow(); }));
  root.querySelectorAll('[data-dm-video-search]').forEach((button) => button.addEventListener('click', () => { runtimeState.addMenuOpen = false; runtimeState.modal = 'video-search'; runtimeState.videoSearchResults = []; rerenderNow(); }));
  root.querySelectorAll('[data-dm-modal-close]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const clipboardPrompt = context.getClipboardPrompt?.() || context.clipboardPrompt;
    if (clipboardPrompt && !runtimeState.modal) {
      void context.onClipboardPreviewAction?.(clipboardPrompt, 'cancel', false);
      return;
    }
    runtimeState.modal = '';
    runtimeState.modalJobId = null;
    runtimeState.modalNewsId = '';
    runtimeState.modalNewsImage = '';
    runtimeState.deletePreview = null;
    runtimeState.deletePreviewBusy = false;
    runtimeState.deleteBusy = false;
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-modal-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.dmModalAction;
    if (action === 'install-update') {
      runtimeState.modal = '';
      rerenderNow();
      await context.onInstallUpdate?.();
      return;
    }
    if (action === 'open-extension') {
      runtimeState.modal = '';
      rerenderNow();
      await context.onOpenExtension?.();
      return;
    }
    if (action === 'decline-extension') {
      runtimeState.modal = '';
      rerenderNow();
      context.onExtensionPromptDecision?.('declined');
      return;
    }
    if (action === 'open-feedback') {
      const value = (field) => root.querySelector(`[data-dm-feedback-field="${field}"]`)?.value?.trim() || '';
      runtimeState.modal = '';
      rerenderNow();
      await context.onOpenFeedback?.({ type: value('type'), title: value('title'), description: value('description'), steps: value('steps') });
    }
  }));
  const feedbackType = root.querySelector('[data-dm-feedback-field="type"]');
  const feedbackSteps = root.querySelector('[data-dm-feedback-steps]');
  const syncFeedbackSteps = () => {
    if (!feedbackType || !feedbackSteps) return;
    const visible = feedbackType.value === 'problem';
    feedbackSteps.hidden = !visible;
    const input = feedbackSteps.querySelector('textarea');
    if (input) input.required = visible;
  };
  feedbackType?.addEventListener('change', syncFeedbackSteps);
  syncFeedbackSteps();
  root.querySelector('.dm-modal-backdrop')?.addEventListener('click', (event) => {
    if (!event.target.classList.contains('dm-modal-backdrop')) return;
    const clipboardPrompt = context.getClipboardPrompt?.() || context.clipboardPrompt;
    if (clipboardPrompt && !runtimeState.modal) {
      void context.onClipboardPreviewAction?.(clipboardPrompt, 'cancel', false);
      return;
    }
    runtimeState.modal = '';
    runtimeState.modalJobId = null;
    runtimeState.deletePreview = null;
    runtimeState.deletePreviewBusy = false;
    runtimeState.deleteBusy = false;
    rerenderNow();
  });
  root.querySelectorAll('[data-dm-row-menu]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const id = Number(button.dataset.dmRowMenu);
    const closing = runtimeState.rowMenuJobId === id;
    let anchor = null;
    if (closing) {
      runtimeState.rowMenuJobId = null;
      runtimeState.rowMenuPosition = null;
    } else {
      const rect = button.getBoundingClientRect();
      anchor = { x: rect.right, y: rect.bottom + 7, above: rect.top - 7, alignRight: true };
      runtimeState.rowMenuJobId = id;
      runtimeState.rowMenuOpenedAt = performance.now();
      runtimeState.rowMenuAnchor = { x: rect.right - 8, y: rect.bottom };
      runtimeState.rowMenuPosition = { left: Math.round(Math.max(8, rect.right - 232)), top: Math.round(Math.max(8, rect.bottom + 7)) };
    }
    syncPreferences({ selectedJobId: id });
    rerenderNow();
    if (anchor) settleFloatingRowMenu(root, anchor);
  }));
  const nativeWindowsDrag = /Windows/i.test(navigator.userAgent || '') && typeof context.invoke === 'function';
  const nativeDrag = { row: null, path: '', pointerId: null, startX: 0, startY: 0, started: false, invoked: false };
  const resetNativeDrag = () => {
    nativeDrag.row?.classList.remove('is-native-dragging', 'is-drag-candidate');
    nativeDrag.row = null;
    nativeDrag.path = '';
    nativeDrag.pointerId = null;
    nativeDrag.startX = 0;
    nativeDrag.startY = 0;
    nativeDrag.started = false;
    nativeDrag.invoked = false;
  };
  if (nativeWindowsDrag) {
    // The browser's drag session cannot carry a real Windows file object from
    // a webview. Disable it for completed rows and start the OLE session after
    // a small pointer threshold. Windows supplies the moving drag image.
    // Disable the browser's HTML5 drag session for every native row.  Live
    // refreshes replace row markup, so selecting only the rows that happened
    // to be `draggable="true"` at bind time left newly completed files on the
    // unreliable WebView drag path.
    const disableNativeBrowserDrag = () => {
      root.querySelectorAll('[data-dm-drag-path]').forEach((row) => { row.draggable = false; });
    };
    disableNativeBrowserDrag();
    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const row = event.target.closest?.('[data-dm-drag-path]');
      if (!row?.dataset.dmDragPath || event.target.closest?.('button,input,select,textarea,a,[data-dm-row-menu]')) return;
      // A row can have been inserted by the live renderer since the initial
      // bind. Turn off HTML5 drag before the pointer crosses its threshold so
      // this gesture always enters the native OLE path below.
      row.draggable = false;
      nativeDrag.row = row;
      nativeDrag.path = row.dataset.dmDragPath;
      nativeDrag.pointerId = event.pointerId;
      nativeDrag.startX = event.clientX;
      nativeDrag.startY = event.clientY;
      nativeDrag.started = false;
      nativeDrag.invoked = false;
      row.classList.add('is-drag-candidate');
      // Do not capture the pointer: WebView2 pointer capture can keep the
      // gesture inside the webview and prevent the native OLE target from
      // receiving the drag outside the window.
    });
    root.addEventListener('pointermove', (event) => {
      if (!nativeDrag.row || nativeDrag.pointerId !== event.pointerId) return;
      if (!nativeDrag.started) {
        const distance = Math.hypot(event.clientX - nativeDrag.startX, event.clientY - nativeDrag.startY);
        if (distance < 8) return;
        nativeDrag.started = true;
        event.preventDefault();
        nativeDrag.row.classList.add('is-native-dragging');
      }
      if (nativeDrag.started) {
        event.preventDefault();
        if (!nativeDrag.invoked) {
          nativeDrag.invoked = true;
          void context.invoke('start_file_drag', { path: nativeDrag.path })
            .catch((error) => context.onToast?.(`No se pudo iniciar el arrastre: ${String(error)}`, 'error'))
            .finally(resetNativeDrag);
        }
      }
    }, { passive: false });
    root.addEventListener('pointerup', resetNativeDrag);
    root.addEventListener('pointercancel', resetNativeDrag);
  }
  root.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('[data-dm-drag-path][draggable="true"]');
    const path = row?.dataset.dmDragPath || '';
    if (!path || !event.dataTransfer) return;
    const filename = path.replace(/\\/g, '/').split('/').pop() || 'download';
    const mime = 'application/octet-stream';
    // A normal drag from a completed download is a copy. Cutting remains an
    // explicit context-menu action, matching Explorer's default behavior.
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.dropEffect = 'copy';
    const fileUrl = `file:///${path.replace(/\\/g, '/')}`;
    // WebView2's DownloadURL payload remains a compatibility fallback, but on
    // Windows the native OLE command is the primary path so Explorer and
    // external apps receive a real CF_HDROP file object.
    const isWindows = /Windows/i.test(navigator.userAgent || '');
    if (isWindows && typeof context.invoke === 'function') {
      event.preventDefault();
      void context.invoke('start_file_drag', { path }).catch(() => {
        // A failed native call must not make the row unusable on older hosts;
        // put the standard browser formats back for the current gesture.
        try {
          event.dataTransfer?.setData('DownloadURL', `${mime}:${filename}:${fileUrl}`);
          event.dataTransfer?.setData('text/uri-list', fileUrl);
          event.dataTransfer?.setData('text/plain', path);
        } catch {}
      });
      return;
    }
    event.dataTransfer.setData('DownloadURL', `${mime}:${filename}:${fileUrl}`);
    event.dataTransfer.setData('text/uri-list', fileUrl);
    event.dataTransfer.setData('text/plain', path);
  });
  root.querySelector('.dm-download-scroll')?.addEventListener('wheel', () => {
    if (!runtimeState.rowMenuJobId) return;
    runtimeState.rowMenuJobId = null;
    runtimeState.rowMenuPosition = null;
    runtimeState.rowMenuOpenedAt = 0;
    runtimeState.rowMenuAnchor = null;
    rerenderNow();
  }, { passive: true });
  bindDownloadManagerActions(root, context, jobs, rerenderNow, copyClipboard);
  // Moving a node preserves direct action listeners while removing it from
  // clipped workspace ancestors.
  mountFloatingMenus(root);
  root.querySelector('#dm-video-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !runtimeState.videoSearchBusy) { event.preventDefault(); root.querySelector('[data-dm-run-video-search]')?.click(); }
  });
  root.querySelector('[data-dm-run-video-search]')?.addEventListener('click', async () => {
    const query = root.querySelector('#dm-video-query')?.value.trim() || '';
    if (!query) return;
    const requestId = ++runtimeState.videoSearchRequestId;
    const isCurrent = () => runtimeState.videoSearchRequestId === requestId
      && runtimeState.modal === 'video-search'
      && runtimeState.videoSearchQuery === query;
    runtimeState.videoSearchQuery = query; runtimeState.videoSearchBusy = true; rerenderNow();
    try {
      const first = await context.invoke?.('search_media_by_title_page', { query, limit: 15, offset: 0 }) || [];
      if (isCurrent()) {
        runtimeState.videoSearchResults = Array.isArray(first) ? first : [];
        rerenderNow();
      }
      const second = await context.invoke?.('search_media_by_title_page', { query, limit: 15, offset: 15 }) || [];
      if (isCurrent()) {
        const merged = [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])];
        const seen = new Set();
        runtimeState.videoSearchResults = merged.filter((item) => {
          const key = String(item?.source_url || item?.url || item?.title || '').toLocaleLowerCase('es');
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 30);
      }
    }
    catch (error) {
      if (isCurrent()) {
        runtimeState.videoSearchResults = [];
        context.onToast?.(String(error), 'error');
      }
    }
    if (isCurrent()) {
      runtimeState.videoSearchBusy = false;
      rerenderNow();
    }
  });
  root.querySelectorAll('[data-dm-analyze-result]').forEach((button) => button.addEventListener('click', () => { const url = button.dataset.dmAnalyzeResult; runtimeState.modal = ''; void context.onAnalyzeSource?.(url, { query: url, alternatives: [] }); }));
  root.querySelectorAll('.dm-search-thumb').forEach((thumb) => {
    const sourceButton = thumb.closest('.dm-search-card')?.querySelector('[data-dm-analyze-result]');
    const sourceUrl = sourceButton?.dataset.dmAnalyzeResult || '';
    if (!sourceUrl || thumb.querySelector('[data-dm-preview-result]')) return;
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'dm-search-play';
    previewButton.dataset.dmPreviewResult = sourceUrl;
    previewButton.setAttribute('aria-label', 'Reproducir resultado');
    previewButton.title = 'Reproducir';
    previewButton.innerHTML = dmIcon('play', 22);
    thumb.append(previewButton);
  });
  root.querySelectorAll('[data-dm-section]').forEach((button) => button.addEventListener('click', () => {
    const section = button.dataset.dmSection;
    const patch = { section, query: '' };
    if (section === 'running') patch.filter = 'running';
    else if (section === 'completed') patch.filter = 'completed';
    else if (['downloads', 'queue', 'history', 'categories', 'scheduler', 'settings', 'news'].includes(section)) patch.filter = 'all';
    syncPreferences(patch);
    runtimeState.mobileSidebarOpen = false;
    runtimeState.rowMenuJobId = null;
    if (section === 'news') context.onNewsOpened?.();
    if (context.onSection?.(section) === true) return;
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-category-jump]').forEach((button) => button.addEventListener('click', () => {
    syncPreferences({ category: button.dataset.dmCategoryJump, filter: 'all', section: 'downloads' });
    rerenderNow();
  }));
  root.querySelectorAll('[data-dm-delete-schedule]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await context.invoke?.('delete_download_schedule', { scheduleId: Number(button.dataset.dmDeleteSchedule) });
      await context.onRefresh?.();
      context.onToast?.('Tarea programada eliminada.', 'success');
    } catch (error) { context.onToast?.(String(error), 'error'); }
  }));
  jobs.filter((job) => job.status === 'failed' && ['video', 'audio', 'media'].includes(job.kind)).forEach((job) => {
    if (runtimeState.recoveryByJobId[job.id] || runtimeState.recoveryPending.has(job.id)) return;
    runtimeState.recoveryPending.add(job.id);
    Promise.resolve(context.invoke?.('recover_media_source', { request: { jobId: job.id, title: job.title, sourceUrl: job.sourceUrl || null, creator: '', durationSeconds: null, limit: 6 } }))
      .then((result) => { runtimeState.recoveryByJobId[job.id] = result || { alternatives: [], message: 'No se encontraron alternativas.' }; })
      .catch((error) => { runtimeState.recoveryByJobId[job.id] = { alternatives: [], message: String(error), diagnosis: { title: 'No se pudo completar el diagnóstico' } }; })
      .finally(() => { runtimeState.recoveryPending.delete(job.id); rerender(context); });
  });
}
