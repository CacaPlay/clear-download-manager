let extensionContext = {};
let appState = {};
let previewMode = false;
let extensionStatePublishTimer = 0;
const contextValue = (name, fallback) => extensionContext[name] || fallback;
const invoke = (...args) => contextValue('invoke', async () => {})(...args);
const loadSnapshot = (...args) => contextValue('loadSnapshot', async () => {})(...args);
const render = (...args) => contextValue('render', () => {})(...args);
const showToast = (...args) => contextValue('showToast', () => {})(...args);
const routeDownloadAnalysis = (...args) => contextValue('routeDownloadAnalysis', async () => {})(...args);
const downloadManagerVisualPreferences = (...args) => contextValue('downloadManagerVisualPreferences', () => ({ theme: 'dark', accent: '' }))(...args);
const forceDownloadManagerAllView = (...args) => contextValue('forceDownloadManagerAllView', () => {})(...args);

export function configureExtension(context = {}) {
  extensionContext = context;
  appState = context.getAppState?.() || {};
  previewMode = Boolean(context.previewMode);
}

const BrowserCaptureService = Object.freeze({
  normalizeSource(value) {
    const source = String(value || '').trim();
    if (source.length > 4096) return '';
    try {
      const parsed = new URL(source);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch { return ''; }
  },
  async drain() {
    return invoke('drain_extension_bridge_requests', { limit: 1 });
  }
});

function extensionPayloadUrls(payload = {}) {
  const candidates = Array.isArray(payload.items) ? payload.items : [];
  const values = [payload.url, payload.source, payload.text, ...candidates.flatMap((item) => [item?.mediaUrl, item?.canonicalUrl, item?.pageUrl, item?.url, item?.sourceUrl])];
  return [...new Set(values.map((value) => BrowserCaptureService.normalizeSource(value)).filter(Boolean))].slice(0, 500);
}

function extensionPlaylistItem(item = {}, index = 0) {
  const sourceUrl = BrowserCaptureService.normalizeSource(item.selectedSourceUrl || item.selected_source_url || item.mediaUrl || item.canonicalUrl || item.pageUrl || item.url || item.sourceUrl);
  return {
    sourceId: String(item.id || item.sourceId || `manual-${index + 1}`),
    sourceUrl,
    selectedSourceUrl: sourceUrl,
    metadataUrl: String(item.metadataUrl || item.metadata_url || '').trim(),
    resolutionState: String(item.resolutionState || item.resolution_state || '').trim(),
    providerId: String(item.platform || item.provider || 'manual-links'),
    title: String(item.title || `Vídeo ${index + 1}`),
    creator: String(item.author || item.creator || ''),
    thumbnail: String(item.thumbnail || ''),
    durationLabel: String(item.duration || item.durationLabel || '—'),
    expectedDurationSeconds: item.durationSeconds == null ? null : Number(item.durationSeconds)
  };
}

function preferredExtensionMediaFormat(payload = {}) {
  const preferredFormat = String(payload.preferredFormat || 'auto').toLowerCase();
  const preferredQuality = String(payload.preferredQuality || 'auto').toLowerCase();
  if (preferredFormat === 'mp3') return { formatSelector: 'bestaudio/best', outputMode: 'audio_mp3' };
  if (preferredFormat === 'm4a') return { formatSelector: 'bestaudio[ext=m4a]/bestaudio/best', outputMode: 'audio_m4a' };
  const quality = preferredQuality.match(/^(2160|1440|1080|720|480|360|240|144)p?$/)?.[1];
  if (quality) return { formatSelector: `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best[height<=${quality}]`, outputMode: 'video_mp4' };
  return { formatSelector: 'bestvideo*+bestaudio/best', outputMode: 'video_mp4' };
}

function extensionPlaylistFormatLabel(payload = {}) {
  const preferredFormat = String(payload.preferredFormat || 'auto').toLowerCase();
  const preferredQuality = String(payload.preferredQuality || 'auto').toLowerCase();
  if (preferredFormat === 'mp3') return 'MP3 320 kbps';
  if (preferredFormat === 'm4a') return 'M4A';
  const quality = preferredQuality.match(/^(2160|1440|1080|720|480|360|240|144)p?$/)?.[1];
  if (quality) return `Video ${quality}p MP4`;
  return 'Video mejor calidad disponible';
}

async function queueExtensionSourceInBackground(source, payload = {}) {
  const inspected = await invoke('inspect_download_url', { url: source });
  const normalized = inspected?.normalized_url || source;
  if (inspected?.kind === 'html_page') throw new Error('html_direct_unsupported');
  if (!inspected?.requires_media_resolver && inspected?.kind !== 'generic_url') {
    return invoke('queue_http_download', {
      url: normalized,
      filename: inspected?.suggested_filename || null,
      extensionFilename: payload.filename || null,
      extensionMime: payload.mime || null,
      extensionExpectedExtension: payload.expectedExtension || null
    });
  }
  const sessionArgs = {
    useBraveCookies: Boolean(payload.sessionConsent),
    cookiesPath: payload.cookiesPath || null
  };
  const media = await invoke('analyze_media_url_with_session', { url: normalized, ...sessionArgs });
  if (Array.isArray(media?.items) && media.items.length) {
    const items = media.items.map((item, index) => extensionPlaylistItem({
      ...item,
      mediaUrl: item.selected_source_url || item.source_url,
      id: item.source_id,
      duration: item.duration_label,
      durationSeconds: item.duration_seconds,
      provider: item.provider
    }, index)).filter((item) => item.sourceUrl);
    return invoke('queue_playlist_selection', {
      playlistTitle: String(payload.playlistTitle || media.title || 'Playlist desde la extensión'),
      items,
      format: extensionPlaylistFormatLabel(payload)
    });
  }
  const format = preferredExtensionMediaFormat(payload);
  return invoke('queue_media_download_secure', {
    url: normalized,
    title: media?.title || payload.title || 'Descarga multimedia',
    thumbnail: media?.thumbnail || payload.thumbnail || '',
    formatSelector: format.formatSelector,
    outputMode: format.outputMode,
    expectedDurationSeconds: media?.duration_seconds || null,
    useBraveCookies: sessionArgs.useBraveCookies,
    cookiesPath: sessionArgs.cookiesPath
  });
}

async function forceExtensionForeground() {
  appState.backgroundLaunch = false;
  render();
  await invoke('wake_main_window').catch(() => {});
  await new Promise((resolve) => window.setTimeout(resolve, 90));
  await invoke('wake_main_window').catch(() => {});
}

function extensionJob(jobId) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('La descarga seleccionada no es válida.');
  const jobs = Array.isArray(appState.snapshot?.jobs) ? appState.snapshot.jobs : [];
  const job = jobs.find((entry) => Number(entry?.id) === id);
  if (!job) throw new Error('La descarga ya no está disponible en CacaTools. Actualiza el panel.');
  return { id, job };
}

async function applyExtensionJobAction(payload = {}) {
  const { id, job } = extensionJob(payload.jobId || payload.id);
  const action = String(payload.action || '').toLowerCase();
  if (action === 'open_player' || action === 'play') return invoke('open_media_player', { jobId: id });
  if (action === 'pause') return invoke('set_job_status', { id, status: 'paused' });
  if (action === 'resume' || action === 'retry') return invoke('set_job_status', { id, status: 'running' });
  if (action === 'cancel') return invoke('emergency_stop_job', { id, deletePartial: false });
  if (action === 'reveal_file' || action === 'open_file') {
    const path = String(job.destination || job.outputPath || job.output_path || '').trim();
    if (!path) throw new Error('CacaTools todavía no tiene un archivo local disponible para esta descarga.');
    return invoke(action === 'reveal_file' ? 'reveal_local_file' : 'open_local_file', { path });
  }
  if (action === 'delete_history') {
    if (payload.confirmed !== true) throw new Error('La eliminación del historial requiere confirmación.');
    return invoke('delete_download_job', { id, deleteStorage: false });
  }
  if (action === 'delete_file') {
    if (payload.confirmed !== true) throw new Error('La eliminación del archivo requiere confirmación.');
    return invoke('delete_download_job', { id, deleteStorage: true });
  }
  throw new Error('Esta acción no está disponible para la descarga seleccionada.');
}

async function processExtensionBridgeRequests() {
  if (previewMode || appState.extensionBridgeBusy) return;
  appState.extensionBridgeBusy = true;
  try {
    const pending = appState.extensionBridgePendingRequest;
    const requests = pending ? [pending] : await BrowserCaptureService.drain();
    const request = Array.isArray(requests) ? requests[0] : null;
    if (!request) return;
    const payload = request.payload || {};
    const playerRequest = request.action === 'open_player'
      || (request.action === 'open_job' && String(payload.mode || '').toLowerCase() === 'play');
    const jobActionRequest = request.action === 'job_action' || request.action === 'set_job_options';
    const foreground = !playerRequest && !jobActionRequest && (
      ['activate_app', 'open_app', 'open_job'].includes(request.action)
      || String(payload.windowMode || payload.windowBehavior || '').toLowerCase() === 'foreground'
    );

    if (!playerRequest) {
      appState.activeSection = 'Descargas';
      forceDownloadManagerAllView();
    }
    appState.backgroundLaunch = !foreground;
    if (foreground) await forceExtensionForeground();

    if (request.action === 'activate_app' || request.action === 'open_app') {
      appState.extensionBridgePendingRequest = null;
      appState.backgroundLaunch = false;
      render();
      return;
    }
    if (request.action === 'open_job') {
      appState.extensionBridgePendingRequest = null;
      const { id } = extensionJob(payload.jobId || payload.id);
      if (String(payload.mode || '').toLowerCase() === 'play') {
        await invoke('open_media_player', { jobId: id });
      } else {
        await invoke('wake_main_window');
      }
      if (foreground) render();
      return;
    }
    if (request.action === 'open_player') {
      appState.extensionBridgePendingRequest = null;
      const { id } = extensionJob(payload.jobId || payload.id);
      await invoke('open_media_player', { jobId: id });
      return;
    }
    if (request.action === 'job_action') {
      appState.extensionBridgePendingRequest = null;
      await applyExtensionJobAction(payload);
      await loadSnapshot();
      scheduleExtensionStatePublish(0);
      if (foreground) render();
      return;
    }
    if (request.action === 'set_job_options') {
      appState.extensionBridgePendingRequest = null;
      throw new Error('Las opciones solo pueden cambiarse antes de iniciar una nueva descarga.');
    }
    if (request.action === 'list_jobs') {
      appState.extensionBridgePendingRequest = null;
      await loadSnapshot();
      scheduleExtensionStatePublish(0);
      return;
    }
    if (request.action === 'browser_download_capture') {
      appState.extensionBridgePendingRequest = null;
      const response = await invoke('accept_browser_download_capture', {
        requestId: request.id,
        capture: payload
      });
      if (response?.status === 'accepted') {
        await loadSnapshot();
        if (foreground) showToast('Descarga capturada desde el navegador.', 'success');
      } else if (response?.status === 'review_opened') {
        if (foreground) showToast('Elige la carpeta y confirma la descarga en la ventana HTTP.', 'success');
      } else if (response?.error && foreground) showToast(friendlyError(response.error), 'error');
      if (foreground) render();
      return;
    }

    if (appState.analysisBusy) {
      appState.extensionBridgePendingRequest = request;
      if (foreground) render();
      return;
    }
    appState.extensionBridgePendingRequest = null;
    const urls = extensionPayloadUrls(payload);
    if (!urls.length) return;
    const sourceItems = Array.isArray(payload.items) ? payload.items : urls.map((url, index) => ({ url, title: `Vídeo ${index + 1}` }));
    const detectedPlaylist = String(payload.sourceType || '').toLowerCase() === 'playlist'
      || sourceItems.some((item) => String(item?.type || '').toLowerCase() === 'playlist');
    const manualPlaylist = Boolean(payload.manualPlaylist || payload.playlistTitle || payload.collectionId)
      && urls.length >= 1
      && !detectedPlaylist;
    if (manualPlaylist || urls.length > 1) {
      const items = sourceItems.map(extensionPlaylistItem).filter((item) => item.sourceUrl);
      await invoke('queue_playlist_selection', {
        playlistTitle: String(payload.playlistTitle || payload.collectionName || 'Playlist desde la extensión'),
        items,
        format: extensionPlaylistFormatLabel(payload)
      });
      await loadSnapshot();
      if (foreground) {
        showToast(`${items.length} enlaces añadidos como playlist.`, 'success');
        render();
      }
      return;
    }

    const source = urls[0];
    if (!foreground) {
      await queueExtensionSourceInBackground(source, payload);
      await loadSnapshot();
      return;
    }
    showToast('Solicitud recibida desde la extensión del navegador.', 'success');
    await routeDownloadAnalysis(source, {
      query: String(payload.title || payload.pageTitle || source),
      alternatives: [],
      windowMode: payload.windowMode || payload.windowBehavior || 'foreground',
      preferredQuality: payload.preferredQuality || '',
      preferredFormat: payload.preferredFormat || '',
      filename: payload.filename || '',
      mime: payload.mime || '',
      expectedExtension: payload.expectedExtension || '',
      title: payload.title || '',
      pageTitle: payload.pageTitle || '',
      sourceType: payload.sourceType || sourceItems[0]?.type || 'generic_url',
      provider: payload.provider || sourceItems[0]?.provider || sourceItems[0]?.platform || 'generic'
    });
  } catch (error) {
    appState.analysisBusy = false;
    appState.analysisPhase = '';
    console.warn('El puente de extensión no pudo procesar una solicitud.', error);
    scheduleExtensionStatePublish(0);
    if (!appState.backgroundLaunch) render();
  } finally {
    appState.extensionBridgeBusy = false;
  }
}


function extensionStatePayload() {
  const jobs = Array.isArray(appState.snapshot?.jobs) ? appState.snapshot.jobs : [];
  const managerAppearance = downloadManagerVisualPreferences();
  return {
    appearance: {
      theme: managerAppearance.theme,
      accent: managerAppearance.accent,
      intensity: appState.appearance.intensity,
      contrast: appState.appearance.contrast,
      motion: appState.appearance.motion,
      motionMode: appState.appearance.motionMode,
      textScale: appState.appearance.textScale,
      iconColorMode: appState.appearance.iconColorMode,
      iconColor: appState.appearance.iconColor,
      progressActive: appState.appearance.progressActive,
      progressCompleted: appState.appearance.progressCompleted,
      progressPaused: appState.appearance.progressPaused,
      progressError: appState.appearance.progressError,
      progressActiveCustomized: appState.appearance.progressActiveCustomized === true,
      progressCompletedCustomized: appState.appearance.progressCompletedCustomized === true,
      appearanceRevision: appState.appearance.appearanceRevision
    },
    jobs: jobs.slice(0, 80).map((job) => ({
      id: job.id,
      title: job.title,
      detail: job.detail,
      progress: Number(job.progress || 0),
      status: job.status,
      kind: job.kind,
      stage: job.stage,
      downloadedBytes: Number(job.downloaded_bytes || 0),
      totalBytes: job.total_bytes == null ? null : Number(job.total_bytes),
      speedBps: Number(job.speed_bps || 0),
      etaSeconds: job.eta_seconds == null ? null : Number(job.eta_seconds),
      thumbnail: job.thumbnail || '',
      destination: job.destination || '',
      sourceUrl: job.source_url || job.sourceUrl || '',
      updatedAt: job.updated_at || ''
    })),
    queue: appState.snapshot?.queue || {},
    updatedAt: Date.now()
  };
}

function scheduleExtensionStatePublish(delay = 120) {
  if (previewMode) return;
  window.clearTimeout(extensionStatePublishTimer);
  extensionStatePublishTimer = window.setTimeout(() => {
    void invoke('publish_extension_state', { state: extensionStatePayload() }).catch((error) => console.info('No se pudo sincronizar el panel de la extensión.', error));
  }, delay);
}


export {
  BrowserCaptureService,
  extensionPayloadUrls,
  extensionPlaylistItem,
  preferredExtensionMediaFormat,
  queueExtensionSourceInBackground,
  forceExtensionForeground,
  processExtensionBridgeRequests,
  extensionStatePayload,
  scheduleExtensionStatePublish
};
