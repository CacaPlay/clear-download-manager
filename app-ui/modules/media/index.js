let mediaContext = {};
let appState = {};
const contextValue = (name, fallback) => mediaContext[name] || fallback;
const icon = (...args) => contextValue('icon', () => '')(...args);
const escapeHtml = (...args) => contextValue('escapeHtml', (value) => String(value ?? ''))(...args);
const formatBytes = (...args) => contextValue('formatBytes', () => '')(...args);
const downloadDirectoryLabel = (...args) => contextValue('downloadDirectoryLabel', () => '')(...args);
const normalizeVideoQuality = (...args) => contextValue('normalizeVideoQuality', (value) => value)(...args);
const persistMediaDownloadPreferences = (...args) => contextValue('persistMediaDownloadPreferences', () => {})(...args);
const startPlaylistSizeAnalysis = (...args) => contextValue('startPlaylistSizeAnalysis', () => {})(...args);
let PLAYLIST_SIZE_INITIAL_DELAY_MS = 900;

export function configureMedia(context = {}) {
  mediaContext = context;
  appState = context.getAppState?.() || {};
  PLAYLIST_SIZE_INITIAL_DELAY_MS = context.PLAYLIST_SIZE_INITIAL_DELAY_MS || PLAYLIST_SIZE_INITIAL_DELAY_MS;
}

function mediaSizeLabel(bytes, estimated = false) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${estimated ? '~' : ''}${formatBytes(value)}`;
}

function mediaQualityName(format = {}) {
  const raw = String(format.label || format.resolution || format.ext || 'Mejor disponible');
  const cleaned = raw
    .replace(/\s*·?\s*vídeo\s*\+\s*audio/gi, '')
    .replace(/^audio\s*·\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || 'Mejor disponible';
}

function mediaFormatLabel(format = {}) {
  const converted = ['audio_mp3', 'audio_mp3_v0'].includes(appState.selectedOutputMode);
  const size = mediaSizeLabel(format.filesize, Boolean(format.filesize_estimated) || converted);
  return size ? `${mediaQualityName(format)} · ${size}` : mediaQualityName(format);
}

function mediaSummaryBadgeLabel(format = {}) {
  if (appState.selectedOutputMode === 'audio_best') return 'Original / mejor audio disponible';
  return mediaQualityName(format);
}

function mediaFormatIsBest(format = {}) {
  return /mejor disponible|original \/ mejor audio/i.test(String(format.label || ''));
}


function formatAudioTechnicalValue(value, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 'No disponible';
  return `${Math.round(number)}${suffix}`;
}

function mediaConversionInfo(outputMode = appState.selectedOutputMode) {
  if (outputMode === 'audio_best') return { label: 'Sin conversión cuando la fuente lo permite', converted: false };
  if (outputMode === 'audio_mp3') return { label: 'Conversión a MP3 320 kbps', converted: true };
  if (outputMode === 'audio_m4a') return { label: 'Salida M4A compatible', converted: true };
  if (['audio_flac', 'audio_flac_hires', 'audio_flac_max'].includes(outputMode)) return { label: 'Fuente lossless real · salida FLAC', converted: false };
  if (outputMode === 'source') return { label: 'Formato original', converted: false };
  return { label: 'Procesamiento multimedia', converted: null };
}

function mediaTechnicalMarkup(format = {}, outputMode = appState.selectedOutputMode) {
  const conversion = mediaConversionInfo(outputMode);
  const codec = format.audio_codec || 'No disponible';
  const bitrate = formatAudioTechnicalValue(format.bitrate_kbps, ' kbps');
  const sampleRate = formatAudioTechnicalValue(Number(format.sample_rate_hz || 0) / 1000, ' kHz');
  const channels = Number(format.channels || 0) === 1 ? 'Mono' : Number(format.channels || 0) === 2 ? 'Estéreo' : formatAudioTechnicalValue(format.channels, ' canales');
  const container = format.container || format.ext || 'No disponible';
  const summary = [codec, bitrate, container].filter((value) => value && value !== 'No disponible').join(' · ') || 'Codec, bitrate, muestreo y contenedor';
  return `<details class="analysis-technical" data-media-technical>
    <summary><span>${icon('settings', 16)} Más detalles</span><small>${escapeHtml(summary)}</small></summary>
    <div class="analysis-technical-grid">
      <span><small>Codec</small><strong data-media-tech="codec">${escapeHtml(codec)}</strong></span>
      <span><small>Bitrate</small><strong data-media-tech="bitrate">${escapeHtml(bitrate)}</strong></span>
      <span><small>Muestreo</small><strong data-media-tech="sample">${escapeHtml(sampleRate)}</strong></span>
      <span><small>Canales</small><strong data-media-tech="channels">${escapeHtml(channels)}</strong></span>
      <span><small>Contenedor</small><strong data-media-tech="container">${escapeHtml(container)}</strong></span>
      <span><small>Procesamiento</small><strong data-media-tech="conversion">${escapeHtml(conversion.label)}</strong></span>
    </div>
  </details>`;
}

function outputModeIsAudio(mode = appState.selectedOutputMode) { return String(mode || '').startsWith('audio_'); }
function formatsForOutputMode(formats = [], mode = appState.selectedOutputMode) {
  if (mode === 'source') return formats;
  const audio = outputModeIsAudio(mode);
  const matching = formats.filter((format) => Boolean(format.audio_only) === audio);
  return matching.length ? matching : formats;
}
function formatVideoHeight(format = {}) {
  const match = `${format.resolution || ''} ${format.label || ''} ${format.id || ''}`.match(/(?:height<=|\b)(2160|1440|1080|720|480|360|240|144)p?/i);
  return match ? Number(match[1]) : 0;
}
function preferredVideoFormat(formats = [], quality = appState.selectedVideoQuality) {
  const available = formats.filter((format) => !format.audio_only);
  if (!available.length) return null;
  const normalized = normalizeVideoQuality(quality);
  if (normalized === 'best') return available.find((format) => /mejor disponible/i.test(format.label || '') || String(format.id || '').startsWith('bestvideo*')) || available[0];
  const maximum = Number(normalized);
  return available
    .map((format) => ({ format, height: formatVideoHeight(format) }))
    .filter((entry) => entry.height > 0 && entry.height <= maximum)
    .sort((left, right) => right.height - left.height)[0]?.format || null;
}
function preferredFormatForOutput(formats = [], mode = appState.selectedOutputMode) {
  const available = formatsForOutputMode(formats, mode);
  if (mode === 'audio_best') return available.find((format) => String(format.id || '') === 'bestaudio/best' || /original \/ mejor audio|mejor audio disponible/i.test(format.label || '')) || available[0];
  if (mode === 'audio_m4a') return available.find((format) => /m4a/i.test(`${format.ext || ''} ${format.label || ''}`)) || available[0];
  if (mode === 'audio_mp3' || mode === 'audio_mp3_v0') return available.find((format) => /mp3|audio/i.test(`${format.ext || ''} ${format.label || ''}`)) || available[0];
  if (mode === 'video_webm') {
    const webm = available.filter((format) => /webm/i.test(`${format.ext || ''} ${format.label || ''}`));
    return preferredVideoFormat(webm.length ? webm : available, appState.selectedVideoQuality);
  }
  if (mode === 'video_mp4' || mode === 'source') return preferredVideoFormat(available, appState.selectedVideoQuality);
  return available[0];
}


// Integrated preparation markup was removed; the native subwindow owns analysis and queue actions.

export {
  mediaSizeLabel,
  mediaQualityName,
  mediaFormatLabel,
  mediaSummaryBadgeLabel,
  mediaFormatIsBest,
  formatAudioTechnicalValue,
  mediaConversionInfo,
  outputModeIsAudio,
  formatsForOutputMode,
  formatVideoHeight,
  preferredVideoFormat,
  preferredFormatForOutput,
};
