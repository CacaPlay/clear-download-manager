import {
  APPEARANCE_REVISION,
  DEFAULT_ICON_COLOR,
  DEFAULT_ICON_COLOR_MODE,
  PREVIOUS_DEFAULT_ICON_COLOR,
  DEFAULT_PROGRESS_ACTIVE_COLOR,
  DEFAULT_PROGRESS_COMPLETED_COLOR,
  DEFAULT_PROGRESS_ERROR_COLOR,
  DEFAULT_PROGRESS_PAUSED_COLOR,
  ICON_COLOR_MODE_ACCENT,
  ICON_COLOR_MODE_CUSTOM,
  ICON_COLOR_MODES
} from '../../modules/appearance/tokens.js';

export const DOWNLOAD_MANAGER_STORAGE_KEY = 'cacatools.download-manager.v2';
export const LEGACY_DOWNLOAD_MANAGER_STORAGE_KEY = 'cacatools.download-manager.v1';
export { APPEARANCE_REVISION, DEFAULT_ICON_COLOR, DEFAULT_ICON_COLOR_MODE, DEFAULT_PROGRESS_ACTIVE_COLOR, DEFAULT_PROGRESS_COMPLETED_COLOR, DEFAULT_PROGRESS_ERROR_COLOR, DEFAULT_PROGRESS_PAUSED_COLOR, ICON_COLOR_MODE_ACCENT, ICON_COLOR_MODE_CUSTOM, ICON_COLOR_MODES, PREVIOUS_DEFAULT_ICON_COLOR };

export const DEFAULT_DOWNLOAD_MANAGER_PREFERENCES = Object.freeze({
  layout: 'zen-sidebar',
  section: 'downloads',
  theme: 'system',
  accent: '#24b8e8',
  accentIntensity: 82,
  progressActive: DEFAULT_PROGRESS_ACTIVE_COLOR,
  progressCompleted: DEFAULT_PROGRESS_COMPLETED_COLOR,
  progressActiveCustomized: false,
  progressCompletedCustomized: false,
  success: DEFAULT_PROGRESS_COMPLETED_COLOR,
  successCustomized: false,
  warning: '#e8b04c',
  progressPaused: DEFAULT_PROGRESS_PAUSED_COLOR,
  danger: DEFAULT_PROGRESS_ERROR_COLOR,
  iconColorMode: DEFAULT_ICON_COLOR_MODE,
  iconColor: DEFAULT_ICON_COLOR,
  sidebarCollapsed: true,
  inspectorCollapsed: true,
  lowerPanelCollapsed: true,
  compactRows: false,
  filter: 'all',
  category: 'all',
  query: '',
  selectedJobId: null,
  inspectorTab: 'summary',
  commandPanel: 'overview',
  uiScale: 100,
  textScale: 100,
  appearanceRevision: APPEARANCE_REVISION
});

export const FILTERS = Object.freeze([
  ['all', 'Todas'],
  ['running', 'Activas'],
  ['queued', 'En cola'],
  ['paused', 'En pausa'],
  ['completed', 'Completadas'],
  ['failed', 'Error']
]);

export const COMMAND_NAV_ITEMS = Object.freeze([
  ['downloads', 'Descargas', 'download'],
  ['queue', 'Cola', 'queue'],
  ['history', 'Historial', 'history'],
  ['categories', 'Categorías', 'folder'],
  ['scheduler', 'Programación', 'calendar']
]);

export const ZEN_NAV_ITEMS = Object.freeze([
  ['downloads', 'Descargas', 'download'],
  ['queue', 'Cola', 'queue'],
  ['running', 'Activas', 'play'],
  ['completed', 'Completadas', 'check']
]);

export const ENGINE_ITEMS = Object.freeze([
  ['aria2c', 'aria2c', 'HTTP y torrents'],
  ['yt-dlp', 'yt-dlp', 'Vídeo, audio y playlists'],
  ['ffmpeg', 'FFmpeg / FFprobe', 'Conversión y validación'],
  ['sqlite', 'SQLite', 'Cola e historial local']
]);

export function engineRuntimeState(id, runtimeStatus, mediaRuntimeStatus) {
  if (id === 'sqlite') return { state: 'ready', detail: 'Base local disponible' };
  if (!runtimeStatus && !mediaRuntimeStatus) return { state: 'checking', detail: 'Comprobando componente…' };
  if (id === 'aria2c') return runtimeStatus?.aria2_available
    ? { state: 'ready', detail: 'Motor HTTP y torrent disponible' }
    : { state: 'missing', detail: 'aria2c no está instalado' };
  if (id === 'yt-dlp') return mediaRuntimeStatus?.yt_dlp
    ? { state: 'ready', detail: 'Resolvedor multimedia disponible' }
    : { state: 'missing', detail: 'yt-dlp no está instalado' };
  if (id === 'ffmpeg') return mediaRuntimeStatus?.ffmpeg && mediaRuntimeStatus?.ffprobe
    ? { state: 'ready', detail: 'FFmpeg y FFprobe disponibles' }
    : { state: 'missing', detail: 'FFmpeg o FFprobe no está disponible' };
  return { state: 'checking', detail: 'Estado desconocido' };
}
