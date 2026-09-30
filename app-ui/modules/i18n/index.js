const LOCALE_KEY = 'clear-download-manager/locale-v1';
export const SUPPORTED_LOCALES = Object.freeze(['system', 'es', 'en']);

const MESSAGES = Object.freeze({
  es: {
    settings: 'Ajustes', themeToggle: 'Cambiar tema', unreadNews: 'Hay novedades sin leer',
    news: 'Novedades', newsDescription: 'Actualizaciones, información y soporte de Clear Download Manager.', back: 'Volver al gestor',
    all: 'Todas', updates: 'Actualizaciones', extension: 'Extensión', history: 'Historial', dismissNews: 'Quitar de novedades',
    noNews: 'No hay novedades nuevas', noNewsDescription: 'Las actualizaciones y avisos aparecerán aquí.',
    details: 'Más detalles', update: 'Actualizar', later: 'Más tarde', installed: 'Instalada',
    openSourceLicenses: 'Licencias de código abierto', licensesSummary: 'Avisos y licencias de terceros y de componentes opcionales; no describen por sí solos la licencia de Clear Download Manager.', licenseBundleInfo: 'Los textos completos y avisos específicos de las versiones distribuidas se incluyen en resources/licenses/; THIRD_PARTY_NOTICES.txt reúne el conjunto para consulta.', licenseYtdlp: 'yt-dlp: el proyecto fuente usa Unlicense; el yt-dlp.exe oficial empaquetado con PyInstaller incluye código GPLv3+ y la obra combinada se distribuye bajo GPLv3+. Se incluyen los avisos de terceros aplicables.', licenseDeno: 'Deno: MIT; se incluye el texto de la licencia.', licenseFfmpeg: 'FFmpeg / FFprobe: la compilación distribuida declara --enable-gpl y --enable-version3; se distribuye bajo GPLv3+. Se incluyen la licencia y la configuración reportada.', licenseAria2: 'aria2c: GPL-2.0-or-later; se incluyen COPYING y la licencia/aviso de excepción OpenSSL del lanzamiento verificado.',
    support: 'Apoya el proyecto', supportDescription: 'Tu apoyo ayuda a mantener Clear Download Manager en desarrollo.', supportAction: 'Apoyar',
    directLinks: 'Enlaces directos', close: 'Cerrar', open: 'Abrir', feedback: 'Comentarios y sugerencias', checkUpdates: 'Buscar actualizaciones', language: 'Idioma', interfaceLanguage: 'Idioma de la interfaz', system: 'Sistema', spanish: 'Español', english: 'English',
    extensionSummary: 'Envía enlaces, vídeos y playlists del navegador directamente a CDM.', updateSummary: 'CDM incluye mejoras importantes de estabilidad, rendimiento y experiencia de uso.', extensionTitle: 'Extensión de Clear Download Manager', officialSite: 'Sitio oficial', officialSiteDescription: 'Información, descargas y ayuda de Clear Download Manager.', visitOfficialSite: 'Visitar cdm.cacaplay.lat',
    general: 'General', windowStartup: 'Ventana e inicio', windowBehavior: 'Comportamiento de ventana', closeAction: 'Al pulsar cerrar', closeToTray: 'Cerrar a la bandeja', exitCompletely: 'Salir completamente', startWithWindows: 'Iniciar con Windows', automation: 'Preferencias', detectClipboard: 'Detectar enlaces copiados', clipboardDescription: 'Sugerir enlaces al volver a enfocar Clear Download Manager.', automaticUpdates: 'Buscar actualizaciones automáticamente', automaticUpdatesDescription: 'Comprueba versiones nuevas de la aplicación en segundo plano cuando hay conexión.', status: 'Estado', minimize: 'Minimizar', taskbar: 'Barra de tareas', exit: 'Salida completa', tray: 'Bandeja',
    'Restablecer todos los ajustes': 'Restablecer todos los ajustes', 'Restablece las preferencias de la aplicación. Se conservan las descargas, el historial y los archivos.': 'Restablece las preferencias de la aplicación. Se conservan las descargas, el historial y los archivos.', '¿Restablecer los ajustes de Clear Download Manager? Las descargas, el historial y los archivos se conservarán.': '¿Restablecer los ajustes de Clear Download Manager? Las descargas, el historial y los archivos se conservarán.', 'Se restablecieron los ajustes.': 'Se restablecieron los ajustes.',
    updateAvailable: (version) => `Clear Download Manager ${version} disponible`,
    updateCategory: 'ACTUALIZACIÓN', extensionCategory: 'EXTENSIÓN', historyTitle: 'Actualizaciones anteriores',
    'Actualizaciones y diagnóstico': 'Actualizaciones y diagnóstico', 'Consulta versiones, estado de herramientas y diagnóstico visual.': 'Consulta versiones, estado de herramientas y diagnóstico visual.',
    'Aplicación y herramientas': 'Aplicación y herramientas', 'Nombre': 'Nombre', 'Versión': 'Versión', 'Estado': 'Estado',
    'Instalado': 'Instalado', 'No detectado': 'No detectado', 'Comprobando…': 'Comprobando…', 'Actualización disponible': 'Actualización disponible',
    'Microsoft Store': 'Microsoft Store', 'Actualizado': 'Actualizado', 'No disponible': 'No disponible', 'Aún no comprobado': 'Aún no comprobado',
    'Repositorios oficiales': 'Repositorios oficiales', 'Abrir repositorio': 'Abrir repositorio', 'Diagnóstico visual': 'Diagnóstico visual',
    'Escala efectiva': 'Escala efectiva', 'Afecta el tamaño de la interfaz y sus elementos.': 'Afecta el tamaño de la interfaz y sus elementos.',
    'Reducir escala': 'Reducir escala', 'Aumentar escala': 'Aumentar escala', 'Porcentaje de escala': 'Porcentaje de escala',
    'Escala de interfaz': 'Escala de interfaz', 'Escala automática': 'Escala automática', 'Tipografía': 'Tipografía', 'Copiar diagnóstico': 'Copiar diagnóstico',
    'Más recientes': 'Más recientes', 'Recientes': 'Recientes', 'Visibles': 'Visibles', 'Más antiguos': 'Más antiguos', 'Nombre (A-Z)': 'Nombre (A-Z)', 'Mayor a menor': 'Mayor a menor', 'Tamaño ↓': 'Tamaño ↓',
    'Ninguna': 'Ninguna', 'Todas': 'Todas', 'Prioridad…': 'Prioridad…', 'Cambiar prioridad de la selección': 'Cambiar prioridad de la selección',
    'Alta': 'Alta', 'Normal': 'Normal', 'Baja': 'Baja', 'Eliminar': 'Eliminar', 'Quitar selección visible': 'Quitar selección visible',
    'Seleccionar todas las descargas visibles': 'Seleccionar todas las descargas visibles', 'Salir de selección': 'Salir de selección',
    'Seleccionar descargas': 'Seleccionar descargas', 'Seleccionar': 'Seleccionar'
  },
  en: {
    settings: 'Settings', themeToggle: 'Change theme', unreadNews: 'Unread updates',
    news: "What's new", newsDescription: 'Updates, information and support for Clear Download Manager.', back: 'Back to manager',
    all: 'All', updates: 'Updates', extension: 'Extension', history: 'History', dismissNews: 'Dismiss',
    noNews: 'No new updates', noNewsDescription: 'Updates and notices will appear here.',
    details: 'More details', update: 'Update', later: 'Later', installed: 'Installed',
    openSourceLicenses: 'Open-source licenses', licensesSummary: 'Notices and licenses for third-party and optional components; they do not by themselves define Clear Download Manager’s license.', licenseBundleInfo: 'Full texts and version-specific notices are included in resources/licenses/; THIRD_PARTY_NOTICES.txt gathers them for review.', licenseYtdlp: 'yt-dlp: the source project uses the Unlicense; the official PyInstaller yt-dlp.exe includes GPLv3+ code, and the combined executable is distributed under GPLv3+. Applicable third-party notices are included.', licenseDeno: 'Deno: MIT; the license text is included.', licenseFfmpeg: 'FFmpeg / FFprobe: the distributed build reports --enable-gpl and --enable-version3 and is GPLv3+. Its license and reported build configuration are included.', licenseAria2: 'aria2c: GPL-2.0-or-later; the verified COPYING text and upstream OpenSSL linking-exception notice are included.',
    support: 'Support the project', supportDescription: 'Your support helps keep Clear Download Manager in development.', supportAction: 'Support',
    directLinks: 'Direct links', close: 'Close', open: 'Open', feedback: 'Comments and suggestions', checkUpdates: 'Check for updates', language: 'Language', interfaceLanguage: 'Interface language', system: 'System', spanish: 'Español', english: 'English',
    extensionSummary: 'Send links, videos and playlists from your browser directly to CDM.', updateSummary: 'CDM includes important stability, performance and experience improvements.', extensionTitle: 'Clear Download Manager extension', officialSite: 'Official website', officialSiteDescription: 'Clear Download Manager information, downloads, and help.', visitOfficialSite: 'Visit cdm.cacaplay.lat',
    general: 'General', windowStartup: 'Window and startup', windowBehavior: 'Window behavior', closeAction: 'When closing', closeToTray: 'Close to tray', exitCompletely: 'Exit completely', startWithWindows: 'Start with Windows', automation: 'Preferences', detectClipboard: 'Detect copied links', clipboardDescription: 'Suggest links when Clear Download Manager regains focus.', automaticUpdates: 'Check for updates automatically', automaticUpdatesDescription: 'Checks for new application releases in the background when connected.', status: 'Status', minimize: 'Minimize', taskbar: 'Taskbar', exit: 'Complete exit', tray: 'Tray',
    'Restablecer todos los ajustes': 'Reset all settings', 'Restablece las preferencias de la aplicación. Se conservan las descargas, el historial y los archivos.': 'Resets app preferences. Downloads, history, and files are kept.', '¿Restablecer los ajustes de Clear Download Manager? Las descargas, el historial y los archivos se conservarán.': 'Reset Clear Download Manager settings? Downloads, history, and files will be kept.', 'Se restablecieron los ajustes.': 'Settings were reset.',
    updateAvailable: (version) => `Clear Download Manager ${version} available`,
    updateCategory: 'UPDATE', extensionCategory: 'EXTENSION', historyTitle: 'Previous updates',
    'Actualizaciones y diagnóstico': 'Updates and diagnostics', 'Consulta versiones, estado de herramientas y diagnóstico visual.': 'View versions, tool status, and visual diagnostics.',
    'Aplicación y herramientas': 'Application and tools', 'Nombre': 'Name', 'Versión': 'Version', 'Estado': 'Status',
    'Instalado': 'Installed', 'No detectado': 'Not detected', 'Comprobando…': 'Checking…', 'Actualización disponible': 'Update available',
    'Microsoft Store': 'Microsoft Store', 'Actualizado': 'Up to date', 'No disponible': 'Unavailable', 'Aún no comprobado': 'Not checked yet',
    'Repositorios oficiales': 'Official repositories', 'Abrir repositorio': 'Open repository', 'Diagnóstico visual': 'Visual diagnostics',
    'Escala efectiva': 'Effective scale', 'Afecta el tamaño de la interfaz y sus elementos.': 'Changes the size of the interface and its elements.',
    'Reducir escala': 'Decrease scale', 'Aumentar escala': 'Increase scale', 'Porcentaje de escala': 'Scale percentage',
    'Escala de interfaz': 'Interface scale', 'Escala automática': 'Automatic scale', 'Tipografía': 'Typography', 'Copiar diagnóstico': 'Copy diagnostics',
    'Más recientes': 'Most recent', 'Recientes': 'Recent', 'Visibles': 'Visible', 'Más antiguos': 'Oldest', 'Nombre (A-Z)': 'Name (A-Z)', 'Mayor a menor': 'Largest first',
    'Ninguna': 'None', 'Todas': 'All', 'Tamaño ↓': 'Size ↓', 'Prioridad…': 'Priority…', 'Cambiar prioridad de la selección': 'Change selected priority',
    'Alta': 'High', 'Normal': 'Normal', 'Baja': 'Low', 'Eliminar': 'Delete',
    'Quitar selección visible': 'Clear visible selection', 'Seleccionar todas las descargas visibles': 'Select all visible downloads',
    'Salir de selección': 'Exit selection', 'Seleccionar descargas': 'Select downloads', 'Seleccionar': 'Select'
  }
});

// Exposed read-only for the repository i18n gate; application code should use
// translate()/messagesFor() so locale resolution remains centralized.
export const LOCALE_CATALOGS = MESSAGES;

export function normalizeLocale(value) {
  const locale = String(value || '').toLowerCase();
  return SUPPORTED_LOCALES.includes(locale) ? locale : 'system';
}

export function detectSystemLocale() {
  try {
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    const preferred = candidates
      .map((value) => String(value || '').toLowerCase())
      .find((value) => /^(?:es|en)(?:[-_]|$)/.test(value));
    return preferred?.startsWith('es') ? 'es' : 'en';
  } catch { return 'en'; }
}

export function resolveLocale(value = 'system') {
  const normalized = normalizeLocale(value);
  return normalized === 'system' ? detectSystemLocale() : normalized;
}

export function loadLocale() {
  try { return normalizeLocale(localStorage.getItem(LOCALE_KEY)); } catch { return 'system'; }
}

export function saveLocale(value) {
  const normalized = normalizeLocale(value);
  try { localStorage.setItem(LOCALE_KEY, normalized); } catch {}
  return normalized;
}

export function messagesFor(value = 'system') { return MESSAGES[resolveLocale(value)] || MESSAGES.es; }

export function translate(value, key, ...args) {
  const message = messagesFor(value)[key];
  return typeof message === 'function' ? message(...args) : message || MESSAGES.es[key] || key;
}

export function formatLocaleDate(value, locale = 'system') {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).trim();
  const numeric = typeof value === 'number' ? value : Number(raw);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(raw || String(value)) && numeric < 1000000000) return '';
  const timestamp = Number.isFinite(numeric) && numeric > 1000000000
    ? (numeric < 10000000000 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try { return new Intl.DateTimeFormat(resolveLocale(locale), { dateStyle: 'medium' }).format(new Date(timestamp)); } catch { return new Date(timestamp).toLocaleDateString(); }
}

export const LOCALE_STORAGE_KEY = LOCALE_KEY;
