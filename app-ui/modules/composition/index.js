import { runDocumentTransition, runSettingsCategoryTransition } from '../motion/coordinator.js';
import { runtimeState as downloadManagerState } from '../../download-manager/state.js';

let compositionContext = {};
let appState = {};
let previewMode = false;
let lastRenderedSection = '';
let lastRenderedSettingsCategory = '';

const contextValue = (name, fallback) => compositionContext[name] || fallback;
const icon = (...args) => contextValue('icon', () => '')(...args);
const escapeHtml = (...args) => contextValue('escapeHtml', (value) => String(value ?? ''))(...args);
const downloadsPageMarkup = (...args) => contextValue('downloadsPageMarkup', () => '')(...args);
const documentsPageMarkup = (...args) => contextValue('documentsPageMarkup', () => '')(...args);
const imageEditorMarkup = (...args) => contextValue('imageEditorMarkup', () => '')(...args);
const utilityDetailMarkup = (...args) => contextValue('utilityDetailMarkup', () => '')(...args);
const utilitiesPageMarkup = (...args) => contextValue('utilitiesPageMarkup', () => '')(...args);
const settingsMarkup = (...args) => contextValue('settingsMarkup', () => '')(...args);
const libraryPageMarkup = (...args) => contextValue('libraryPageMarkup', () => '')(...args);
const dashboardMarkup = (...args) => contextValue('dashboardMarkup', () => '')(...args);
const applyAppearance = (...args) => contextValue('applyAppearance', () => {})(...args);
const bindEvents = (...args) => contextValue('bindEvents', () => {})(...args);
const bindVisualDiagnostics = (...args) => contextValue('bindVisualDiagnostics', () => {})(...args);
const rememberQueueSpeed = (...args) => contextValue('rememberQueueSpeed', () => {})(...args);
const animateDownloadProgressBars = (...args) => contextValue('animateDownloadProgressBars', () => {})(...args);
const renderFatalError = (...args) => contextValue('renderFatalError', () => {})(...args);
const selectedPlaylistItems = (...args) => contextValue('selectedPlaylistItems', () => [])(...args);
const selectedPlaylistSizeSummary = (...args) => contextValue('selectedPlaylistSizeSummary', () => '')(...args);
const invoke = (...args) => contextValue('invoke', async () => {})(...args);
const displayedScalePercent = (...args) => contextValue('displayedScalePercent', (value) => value)(...args);
const automaticScalePercent = (...args) => contextValue('automaticScalePercent', () => 100)(...args);
const loadSnapshot = (...args) => contextValue('loadSnapshot', async () => {})(...args);
const snapshotSignature = (...args) => contextValue('snapshotSignature', () => '')(...args);
const processExtensionBridgeRequests = (...args) => contextValue('processExtensionBridgeRequests', async () => {})(...args);
const flushDeferredDownloadManagerRefresh = (...args) => contextValue('flushDeferredDownloadManagerRefresh', () => {})(...args);
const shouldCheckForAppUpdate = (...args) => contextValue('shouldCheckForAppUpdate', () => false)(...args);
const checkForAppUpdate = (...args) => contextValue('checkForAppUpdate', async () => null)(...args);
const refreshNewsFeed = (...args) => contextValue('refreshNewsFeed', async () => [])(...args);
const startSnapshotRefreshLoop = (...args) => contextValue('startSnapshotRefreshLoop', () => {})(...args);
const runProgressAcceptanceAutopilot = (...args) => contextValue('runProgressAcceptanceAutopilot', async () => null)(...args);
const clearFloatingLayer = (...args) => contextValue('clearFloatingLayer', () => {})(...args);
const localizeDom = (...args) => contextValue('localizeDom', () => {})(...args);

export function configureComposition(context = {}) {
  compositionContext = context;
  appState = context.getAppState?.() || {};
  previewMode = Boolean(context.previewMode);
}

function pageHeading(title, description, action = '', iconName = '') {
  return `<header class="page-heading"><div class="page-title-wrap">${iconName ? `<span class="page-title-icon">${icon(iconName, 25)}</span>` : ''}<div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div></div>${action}</header>`;
}

function activeWorkspaceMarkup() {
  switch (appState.activeSection) {
    case 'Descargas': return downloadsPageMarkup();
    case 'Documentos': return documentsPageMarkup();
    case 'Imágenes': return imageEditorMarkup();
    case 'Utilidades': return appState.activeTool ? utilityDetailMarkup() : utilitiesPageMarkup();
    case 'Biblioteca': return libraryPageMarkup();
    case 'Ajustes': return settingsMarkup();
    default: return dashboardMarkup();
  }
}

function renderUnsafe() {
  applyAppearance(appState.appearance);
  clearFloatingLayer();
  const app = document.querySelector('#app');
  const activeSection = appState.activeSection || 'Descargas';
  const navigationChanged = lastRenderedSection !== activeSection;
  // Theme commits are appearance-only updates.  They must never borrow the
  // section-entry channel, even if the render is part of the same synchronous
  // update as a theme change.
  const themeTransitioning = document.documentElement.dataset.themeTransitioning === 'true';
  app.dataset.motionNavigation = (!themeTransitioning && navigationChanged) ? 'true' : 'false';
  app.dataset.motionSection = activeSection;
  app.innerHTML = `${activeWorkspaceMarkup()}<div class="toast-region" aria-live="polite"></div>`;
  // Legacy templates still contain a small set of literal UI phrases. Apply
  // the central locale pass after every render so switching language updates
  // the complete visible surface without touching internal values or user
  // content.
  localizeDom(app, contextValue('locale', () => 'es')());
  document.body.classList.add('app-ready');
  document.body.classList.toggle('download-manager-standalone', activeSection === 'Descargas');
  document.body.classList.remove('download-workspace-window');
  appState.lastSuccessfulRenderAt = Date.now();
  lastRenderedSection = activeSection;
  lastRenderedSettingsCategory = activeSection === 'Ajustes'
    ? (appState.settingsCategory || 'general')
    : '';
  bindEvents();
  bindVisualDiagnostics();
  rememberQueueSpeed();
  animateDownloadProgressBars();
  window.requestAnimationFrame(() => {
    appState.playlistAnimateCurrent = false;
    const currentCard = document.querySelector('#playlist-current-card.item-changed');
    if (currentCard) window.setTimeout(() => currentCard.classList.remove('item-changed'), 360);
  });
}


function captureRenderContinuity() {
  const active = document.activeElement;
  const focus = active instanceof HTMLElement
    ? {
        id: active.id || '',
        dmSetting: active.dataset?.dmSetting || '',
        dmScaleNumber: active.hasAttribute?.('data-dm-scale-number') || false,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
      }
    : null;
  return {
    workspace: document.querySelector('.workspace')?.scrollTop || 0,
    playlist: document.querySelector('.playlist-v2-list > div')?.scrollTop || 0,
    dmSettings: document.querySelector('.dm-settings-popover')?.scrollTop || 0,
    dmDownloads: downloadManagerState.pendingDownloadScrollTop
      ?? document.querySelector('.dm-download-scroll')?.scrollTop
      ?? downloadManagerState.downloadScrollTop
      ?? 0,
    settingsWorkspace: document.querySelector('.settings-workspace-content')?.scrollTop || 0,
    focus
  };
}


function restoreRenderContinuity(state) {
  window.requestAnimationFrame(() => {
    const positions = [
      ['.workspace', state.workspace],
      ['.playlist-v2-list > div', state.playlist],
      ['.dm-settings-popover', state.dmSettings],
      ['.dm-download-scroll', state.dmDownloads],
      ['.settings-workspace-content', state.settingsWorkspace]
    ];
    positions.forEach(([selector, value]) => {
      const node = document.querySelector(selector);
      if (node && Number.isFinite(value)) node.scrollTop = value;
    });
    const focus = state.focus;
    if (!focus) return;
    let target = focus.id ? document.getElementById(focus.id) : null;
    if (!target && focus.dmSetting) target = document.querySelector(`[data-dm-setting="${CSS.escape(focus.dmSetting)}"]`);
    if (!target && focus.dmScaleNumber) target = document.querySelector('[data-dm-scale-number]');
    if (!(target instanceof HTMLElement)) return;
    try {
      target.focus({ preventScroll: true });
      if (typeof target.setSelectionRange === 'function' && focus.selectionStart !== null && focus.selectionEnd !== null) {
        target.setSelectionRange(focus.selectionStart, focus.selectionEnd);
      }
    } catch {}
  });
}


function render() {
  const continuity = captureRenderContinuity();
  try {
    const activeSection = appState.activeSection || 'Descargas';
    const navigationChanged = lastRenderedSection !== activeSection;
    const settingsCategory = appState.settingsCategory || 'general';
    const settingsCategoryChanged = activeSection === 'Ajustes'
      && lastRenderedSection === 'Ajustes'
      && Boolean(lastRenderedSettingsCategory)
      && lastRenderedSettingsCategory !== settingsCategory;
    const settingsOrder = ['general', 'downloads', 'multimedia', 'appearance', 'integrations', 'updates'];
    const previousIndex = settingsOrder.indexOf(lastRenderedSettingsCategory);
    const nextIndex = settingsOrder.indexOf(settingsCategory);
    const direction = nextIndex >= 0 && previousIndex >= 0 && nextIndex >= previousIndex ? 'down' : 'up';
    if (navigationChanged) {
      void runDocumentTransition(() => renderUnsafe());
    } else if (settingsCategoryChanged) {
      void runSettingsCategoryTransition(() => renderUnsafe(), direction);
    } else {
      renderUnsafe();
    }
    restoreRenderContinuity(continuity);
  } catch (error) { console.error(error); renderFatalError(error); }
}



function updatePlaylistSelectionDom() {
  const selected = selectedPlaylistItems();
  const total = appState.playlistItems.length;
  const count = document.querySelector('.selection-count');
  if (count) count.innerHTML = `<b>${selected.length}</b> de ${total}`;
  const selectAll = document.querySelector('.playlist-select-all input');
  if (selectAll) {
    selectAll.checked = total > 0 && selected.length === total;
    selectAll.indeterminate = selected.length > 0 && selected.length < total;
  }
  const label = document.querySelector('.playlist-select-all span');
  if (label) label.textContent = selected.length === total ? 'Todo seleccionado' : `${selected.length} seleccionados`;
  document.querySelectorAll('[data-playlist-size-summary]').forEach((element) => {
    element.textContent = selectedPlaylistSizeSummary();
  });
}



function bindThumbnailFallbacks() {
  document.querySelectorAll('[data-thumbnail-image]').forEach((image) => {
    if (image.dataset.thumbnailFallbackBound === '1') return;
    image.dataset.thumbnailFallbackBound = '1';
    const source = String(image.getAttribute('src') || '');
    const alternate = source
      .replace(/(i\.ytimg\.com\/vi\/[^/]+\/)(?:default|mqdefault|hqdefault|sddefault)\.jpg/i, '$1maxresdefault.jpg')
      .replace(/(i\.scdn\.co\/image\/ab67616d)00001e02/i, '$10000b273');
    const revealFallback = () => {
      if (!image.dataset.thumbnailRetried && alternate && alternate !== source) {
        image.dataset.thumbnailRetried = '1';
        image.src = alternate;
        return;
      }
      image.hidden = true;
      image.parentElement?.classList.add('thumbnail-load-failed');
    };
    const timeout = window.setTimeout(() => {
      if (!image.complete || image.naturalWidth === 0) revealFallback();
    }, 9000);
    image.addEventListener('load', () => window.clearTimeout(timeout), { once: true });
    image.addEventListener('error', () => {
      window.clearTimeout(timeout);
      revealFallback();
    });
    if (image.complete && image.naturalWidth === 0) revealFallback();
  });
}



let appearanceResizeTimer;
window.addEventListener('resize', () => {
  window.clearTimeout(appearanceResizeTimer);
  appearanceResizeTimer = window.setTimeout(() => applyAppearance(appState.appearance), 120);
});

const STARTUP_COMMAND_TIMEOUT_MS = 10000;

function resolveWithin(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} excedió el tiempo de espera`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function start() {
  try {
    applyAppearance(appState.appearance);

    // Paint the usable shell before asking the native side for persisted data.
    // A stalled DB/process command must never leave the user on the boot screen.
    render();
    if (!previewMode) {
      window.setTimeout(() => { void refreshNewsFeed().catch(() => {}); }, 1200);
    }

    if (!previewMode) {
      // Read the launch mode before the broader startup snapshot. If one of
      // the optional diagnostics is unavailable, a background launch must
      // still remain hidden rather than falling through to show_main_window.
      appState.backgroundLaunch = Boolean(await resolveWithin(
        invoke('is_background_launch'),
        3000,
        'is_background_launch',
      ).catch(() => false));
    }
    if (!window.__cacatoolsAdaptiveScaleBound) {
      window.__cacatoolsAdaptiveScaleBound = true;
      window.addEventListener('resize', () => {
        if (!appState.appearance.autoScale) return;
        applyAppearance(appState.appearance);
        const output = document.querySelector('[data-setting-value="auto-scale"]');
        if (output) output.textContent = `${displayedScalePercent(automaticScalePercent())}%`;
      }, { passive: true });
    }
    await resolveWithin(
      loadSnapshot({ includeSettings: true }),
      STARTUP_COMMAND_TIMEOUT_MS,
      'snapshot inicial',
    ).catch((error) => {
      // The shell is already usable. The regular refresh loop can hydrate it
      // later, so a slow optional native service is not a fatal startup error.
      console.warn('Startup snapshot diferido:', error);
    });
    appState.lastSnapshotSignature = snapshotSignature();
    render();
    if (appState.backgroundLaunch && !previewMode) {
      // Keep startup genuinely silent even if WebView2/Tauri briefly shows the
      // native window while the first frontend render is settling.
      await invoke('hide_main_window').catch(() => {});
      window.setTimeout(() => {
        if (appState.backgroundLaunch) void invoke('hide_main_window').catch(() => {});
      }, 350);
    }
    if (!previewMode) {
      if (!window.__cacatoolsDeferredRefreshBound) {
        window.__cacatoolsDeferredRefreshBound = true;
        document.addEventListener('focusout', flushDeferredDownloadManagerRefresh, true);
        document.addEventListener('pointerup', flushDeferredDownloadManagerRefresh, true);
        document.addEventListener('keyup', (event) => {
          if (event.key === 'Escape' || event.key === 'Enter') flushDeferredDownloadManagerRefresh();
        }, true);
      }
      window.setInterval(() => {
        void processExtensionBridgeRequests();
      }, 500);
      window.setTimeout(() => {
        if (appState.autoUpdateEnabled && appState.updaterStatus?.configured && shouldCheckForAppUpdate()) {
          void checkForAppUpdate({ silent: true });
        }
      }, 7000);
      // Keep the notification fresh while the app is open without polling
      // aggressively; the first-run check above still feels immediate.
      window.setInterval(() => {
        if (appState.autoUpdateEnabled && appState.updaterStatus?.configured && shouldCheckForAppUpdate()) {
          void checkForAppUpdate({ silent: true });
        }
      }, 60 * 1000);
      window.addEventListener('online', () => {
        if (appState.autoUpdateEnabled && appState.updaterStatus?.configured && shouldCheckForAppUpdate()) void checkForAppUpdate({ silent: true });
      }, { passive: true });
      startSnapshotRefreshLoop();
      void runProgressAcceptanceAutopilot();
      window.setInterval(() => {
        if (document.hidden) return;
        const root = document.querySelector('#app');
        if (!root || !root.children.length || (!document.querySelector('.dm-host') && !document.querySelector('.dm-external-download-workspace') && !document.querySelector('.download-workspace-complete') && !document.querySelector('.settings-view') && !document.querySelector('.fatal-screen'))) {
          console.warn('Watchdog: restaurando interfaz local');
          render();
        }
      }, 3500);
    }
  } catch (error) { renderFatalError(error); }
}

export {
  pageHeading,
  activeWorkspaceMarkup,
  renderUnsafe,
  captureRenderContinuity,
  restoreRenderContinuity,
  render,
  updatePlaylistSelectionDom,
  bindThumbnailFallbacks,
  start
};
