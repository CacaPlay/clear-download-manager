const LOCALE_KEY = 'clear-download-manager/extension-locale-v1';
const ORIGINAL_TEXT = new WeakMap();
const ORIGINAL_ATTRIBUTES = new WeakMap();
const PREFIXES = Object.freeze({
  en: Object.freeze({
    'Versión ': 'Version ', 'Descarga disponible: ': 'Download available: ', 'Captura recibida: ': 'Capture received: ',
    'Solicitud recibida por el puente (': 'Request received by the bridge (', 'Añadido a «': 'Added to “', 'Descarga transferida a ': 'Download sent to ',
    'Clear Download Manager no la aceptó; Chrome continúa la descarga.': 'Clear Download Manager did not accept it; Chrome continues the download.',
    'La aplicación está cerrada; se abrirá al enviar.': 'The app is closed; it will open when you send.',
    'La app está cerrada; se abrirá al enviar.': 'The app is closed; it will open when you send.',
    'No disponible con este puente o estado. Utiliza Clear Download Manager.': 'Unavailable with this bridge or state. Use Clear Download Manager.',
    'Este puente solo ofrece apertura en la app.': 'This bridge only supports opening the app.',
    'Pega al menos un enlace HTTP o HTTPS válido.': 'Paste at least one valid HTTP or HTTPS link.',
    'Puedes seguir agregando vídeos con +.': 'You can keep adding videos with +.'
  }),
  es: Object.freeze({})
});

const CATALOG = Object.freeze({
  es: Object.freeze({
    'Captura segura del navegador': 'Captura segura del navegador', 'Comprobando…': 'Comprobando…', Idioma: 'Idioma', Sistema: 'Sistema',
    'Preferencias rápidas': 'Preferencias rápidas', Calidad: 'Calidad', 'Calidad o formato predeterminado': 'Calidad o formato predeterminado',
    'Mejor calidad': 'Mejor calidad', 'Siempre 1080p': 'Siempre 1080p', 'Siempre 720p': 'Siempre 720p', 'Siempre MP3': 'Siempre MP3', 'Siempre M4A': 'Siempre M4A',
    'Sin límite fijo: 4K o más, si está disponible.': 'Sin límite fijo: 4K o más, si está disponible.', 'Al enviar': 'Al enviar',
    'Mantener app en segundo plano': 'Mantener app en segundo plano', 'Abrir app en primer plano': 'Abrir app en primer plano',
    'Abrir Clear Download Manager': 'Abrir Clear Download Manager', 'Captura de descargas': 'Captura de descargas', 'Capturar descargas del navegador': 'Capturar descargas del navegador',
    'La app ejecuta y conserva todas las tareas.': 'La app ejecuta y conserva todas las tareas.', Automático: 'Automático', Avisar: 'Avisar', Desactivado: 'Desactivado',
    'Actualización de la extensión lista': 'Actualización de la extensión lista', Aplicar: 'Aplicar', 'PESTAÑA ACTUAL': 'PESTAÑA ACTUAL', 'Contenido detectado': 'Contenido detectado',
    'Reintentar': 'Reintentar', 'Acciones de envío': 'Acciones de envío', 'Seleccionar todo': 'Seleccionar todo', 'Enviar vídeo actual': 'Enviar vídeo actual',
    'SINCRONIZADO CON LA APP': 'SINCRONIZADO CON LA APP', Descargas: 'Descargas', Descarga: 'Descarga', descarga: 'descarga', 'Sin actividad': 'Sin actividad', Ocultar: 'Ocultar', Mostrar: 'Mostrar',
    'Ver más': 'Ver más', 'Ver menos': 'Ver menos', Enlaces: 'Enlaces', 'Pega uno o varios enlaces': 'Pega uno o varios enlaces', 'Nueva playlist': 'Nueva playlist', Salir: 'Salir',
    'Pega aquí un enlace o varios enlaces': 'Pega aquí un enlace o varios enlaces', 'Vaciar': 'Vaciar', 'Enviar playlist': 'Enviar playlist', 'Enviar enlace': 'Enviar enlace',
    'COLECCIONES MANUALES': 'COLECCIONES MANUALES', 'Apariencia de la extensión': 'Apariencia de la extensión', Colores: 'Colores',
    'Seguir Clear Download Manager': 'Seguir Clear Download Manager', Personalizada: 'Personalizada', Tema: 'Tema', Oscuro: 'Oscuro', Claro: 'Claro',
    'Para ensanchar el panel, arrastra su borde hacia el centro del navegador.': 'Para ensanchar el panel, arrastra su borde hacia el centro del navegador.',
    'Sincronizando…': 'Sincronizando…', 'No disponible': 'No disponible', 'App cerrada': 'App cerrada', Disponible: 'Disponible',
    Sincronizado: 'Sincronizado', 'Conectado · gestión desde la app': 'Conectado · gestión desde la app', 'Puente listo': 'Puente listo', 'Datos guardados': 'Datos guardados', 'Sin conexión': 'Sin conexión',
    'No hay descargas registradas todavía.': 'No hay descargas registradas todavía.', 'Contenido multimedia': 'Contenido multimedia', 'Canal no disponible': 'Canal no disponible',
    Descargando: 'Descargando', 'En cola': 'En cola', Pausada: 'Pausada', Completada: 'Completada', Error: 'Error', Cancelada: 'Cancelada', Pendiente: 'Pendiente',
    'No se detectó contenido multimedia compatible.': 'No se detectó contenido multimedia compatible.', 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.': 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.',
    'No se confirmó el envío. Revisa Clear Download Manager antes de volver a enviarlo.': 'No se confirmó el envío. Revisa Clear Download Manager antes de volver a enviarlo.',
    'No se pudo abrir la descarga en Clear Download Manager.': 'No se pudo abrir la descarga en Clear Download Manager.', 'Nombre de la playlist': 'Nombre de la playlist', 'Mi playlist': 'Mi playlist',
    '¿Crear playlist? Los siguientes enlaces se añadirán automáticamente a esa carpeta.': '¿Crear playlist? Los siguientes enlaces se añadirán automáticamente a esa carpeta.',
    '¿Vaciar esta carpeta de enlaces?': '¿Vaciar esta carpeta de enlaces?', 'Acciones disponibles únicamente desde el panel de la extensión.': 'Acciones disponibles únicamente desde el panel de la extensión.',
    '¿Eliminar el archivo descargado y su registro? Esta acción no se puede deshacer.': '¿Eliminar el archivo descargado y su registro? Esta acción no se puede deshacer.',
    '¿Eliminar esta descarga del historial?': '¿Eliminar esta descarga del historial?'
  }),
  en: Object.freeze({
    'Captura segura del navegador': 'Secure browser capture', 'Comprobando…': 'Checking…', Idioma: 'Language', Sistema: 'System',
    'Preferencias rápidas': 'Quick preferences', Calidad: 'Quality', 'Calidad o formato predeterminado': 'Default quality or format',
    'Mejor calidad': 'Best quality', 'Siempre 1080p': 'Always 1080p', 'Siempre 720p': 'Always 720p', 'Siempre MP3': 'Always MP3', 'Siempre M4A': 'Always M4A',
    'Sin límite fijo: 4K o más, si está disponible.': 'No fixed limit: 4K or higher when available.', 'Al enviar': 'When sending',
    'Mantener app en segundo plano': 'Keep the app in the background', 'Abrir app en primer plano': 'Open the app in the foreground',
    'Abrir Clear Download Manager': 'Open Clear Download Manager', 'Abrir en Clear Download Manager': 'Open in Clear Download Manager', 'Abrir archivo': 'Open file', 'Eliminar del historial': 'Remove from history',
    'Abre Clear Download Manager o inicia una descarga.': 'Open Clear Download Manager or start a download.', 'Comprobando conexión con Clear Download Manager': 'Checking connection to Clear Download Manager',
    'Carpeta activa': 'Active folder', 'Carpeta o playlist activa': 'Active folder or playlist', 'Modo de captura': 'Capture mode',
    'Captura de descargas': 'Download capture', 'Capturar descargas del navegador': 'Capture browser downloads',
    'La app ejecuta y conserva todas las tareas.': 'The app runs and keeps all tasks.', Automático: 'Automatic', Avisar: 'Ask', Desactivado: 'Disabled',
    'Actualización de la extensión lista': 'Extension update ready', Aplicar: 'Apply', 'PESTAÑA ACTUAL': 'CURRENT TAB', 'Contenido detectado': 'Detected content',
    'Reintentar': 'Retry', 'Acciones de envío': 'Send actions', 'Seleccionar todo': 'Select all', 'Enviar vídeo actual': 'Send current video',
    'SINCRONIZADO CON LA APP': 'SYNCED WITH THE APP', Descargas: 'Downloads', Descarga: 'Download', descarga: 'download', 'Sin actividad': 'No activity', Ocultar: 'Hide', Mostrar: 'Show',
    'Ver más': 'Show more', 'Ver menos': 'Show less', Enlaces: 'Links', 'Pega uno o varios enlaces': 'Paste one or more links', 'Nueva playlist': 'New playlist', Salir: 'Leave',
    'Pega aquí un enlace o varios enlaces': 'Paste one or more links here', Vaciar: 'Clear', 'Enviar playlist': 'Send playlist', 'Enviar enlace': 'Send link',
    'COLECCIONES MANUALES': 'MANUAL COLLECTIONS', 'Apariencia de la extensión': 'Extension appearance', Colores: 'Colors',
    'Seguir Clear Download Manager': 'Follow Clear Download Manager', Personalizada: 'Custom', Tema: 'Theme', Oscuro: 'Dark', Claro: 'Light',
    'Para ensanchar el panel, arrastra su borde hacia el centro del navegador.': 'To widen the panel, drag its edge toward the center of the browser.',
    'Sincronizando…': 'Syncing…', 'No disponible': 'Unavailable', 'App cerrada': 'App closed', Disponible: 'Available',
    Sincronizado: 'Synced', 'Conectado · gestión desde la app': 'Connected · manage from the app', 'Puente listo': 'Bridge ready', 'Datos guardados': 'Saved data', 'Sin conexión': 'Offline',
    'No hay descargas registradas todavía.': 'No downloads recorded yet.', 'Contenido multimedia': 'Media content', 'Canal no disponible': 'Channel unavailable',
    Descargando: 'Downloading', 'En cola': 'Queued', Pausada: 'Paused', Completada: 'Completed', Error: 'Error', Cancelada: 'Cancelled', Pendiente: 'Pending',
    'No se detectó contenido multimedia compatible.': 'No compatible media was detected.', 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.': 'The analysis could not be completed. Click Refresh to retry.',
    'No se confirmó el envío. Revisa Clear Download Manager antes de volver a enviarlo.': 'The send was not confirmed. Check Clear Download Manager before trying again.',
    'No se pudo abrir la descarga en Clear Download Manager.': 'The download could not be opened in Clear Download Manager.', 'Nombre de la playlist': 'Playlist name', 'Mi playlist': 'My playlist',
    '¿Crear playlist? Los siguientes enlaces se añadirán automáticamente a esa carpeta.': 'Create a playlist? The following links will be added to that folder automatically.',
    '¿Vaciar esta carpeta de enlaces?': 'Clear this links folder?', 'Acciones disponibles únicamente desde el panel de la extensión.': 'This action is available only from the extension panel.',
    '¿Eliminar el archivo descargado y su registro? Esta acción no se puede deshacer.': 'Delete the downloaded file and its record? This cannot be undone.',
    '¿Eliminar esta descarga del historial?': 'Delete this download from history?',
    'Captura segura del navegador': 'Secure browser capture', 'Analizando la pestaña activa…': 'Analyzing the active tab…',
    'Selecciona qué quieres enviar a Clear Download Manager.': 'Select what you want to send to Clear Download Manager.',
    'Chrome no permite analizar esta página.': 'Chrome does not allow analysis of this page.',
    'La página requiere permiso para analizarse.': 'This page requires permission to analyze it.',
    'Clear Download Manager no está disponible en este momento.': 'Clear Download Manager is not available right now.',
    'Spotify está desactivado temporalmente.': 'Spotify is temporarily disabled.',
    'Automático en YouTube, Spotify, Pinterest y TikTok; en otros sitios se inicia al abrir el panel o pulsar ↻.': 'Automatic on YouTube, Spotify, Pinterest and TikTok; on other sites it starts when you open the panel or press ↻.',
    'Actualizar detección': 'Refresh detection', 'Añadir a playlist manual': 'Add to manual playlist', 'Añadir enlaces automáticamente a la playlist': 'Automatically add links to the playlist',
    'La app instalada todavía no envía sus colores de progreso. Se muestran los valores predeterminados, no una sincronización personalizada.': 'The installed app does not send its progress colors yet. Default values are shown instead of a custom sync.',
    'Colores de progreso sincronizados con Clear Download Manager.': 'Progress colors synced with Clear Download Manager.',
    'Este puente solo ofrece apertura en la app. Para reproducir, gestionar o eliminar desde aquí hace falta actualizar el puente nativo; no la extensión únicamente.': 'This bridge only supports opening the app. Update the native bridge to play, manage or delete from here; updating the extension alone is not enough.',
    'Pega al menos un enlace HTTP o HTTPS válido.': 'Paste at least one valid HTTP or HTTPS link.',
    'La app está cerrada; se abrirá al enviar.': 'The app is closed; it will open when you send.',
    'No hay enlaces en esta carpeta.': 'There are no links in this folder.', 'Enlaces sueltos': 'Loose links', 'enlaces sueltos': 'loose links',
    'Enviar como playlist': 'Send as playlist', 'Enlaces manuales': 'Manual links', 'Nombre de la playlist manual': 'Manual playlist name',
    'Nombre de la nueva playlist': 'New playlist name', 'Añadido a «': 'Added to “', 'Ese vídeo ya está en esta playlist.': 'That video is already in this playlist.',
    'El envío anterior no se confirmó. Comprueba primero las descargas y ventanas de Clear Download Manager. ¿Ya verificaste que no se recibió y deseas reenviar?': 'The previous send was not confirmed. Check Clear Download Manager downloads and windows first. Did you verify it was not received and want to resend?',
    'Enviando a Clear Download Manager…': 'Sending to Clear Download Manager…', 'No se confirmó el envío. Revisa Clear Download Manager antes de volver a enviarlo.': 'The send was not confirmed. Check Clear Download Manager before trying again.',
    'No se pudo abrir la descarga en Clear Download Manager.': 'The download could not be opened in Clear Download Manager.', 'Pestaña actual': 'Current tab',
    'Menú contextual disponible': 'Context menu available', 'Acciones de ': 'Actions for ', 'Seleccionar enlace': 'Select link', 'Eliminar enlace': 'Remove link',
    'La captura no se confirmó. Revisa Clear Download Manager y la descarga pausada del navegador antes de reanudar.': 'The capture was not confirmed. Check Clear Download Manager and the paused browser download before resuming.',
    'Clear Download Manager aceptó la descarga, pero no se pudo cancelar la copia del navegador. Revisa ambas descargas.': 'Clear Download Manager accepted the download, but the browser copy could not be cancelled. Check both downloads.',
    'Hay una captura pendiente de revisión. Comprueba Clear Download Manager y las descargas del navegador antes de reanudar o reenviar.': 'A capture is waiting for review. Check Clear Download Manager and browser downloads before resuming or resending.',
    'Acción disponible únicamente desde el panel de la extensión.': 'This action is available only from the extension panel.',
    'La descarga seleccionada no es válida': 'The selected download is not valid', 'La acción de descarga no es válida': 'The download action is not valid',
    'Las opciones de descarga no son válidas': 'The download options are not valid', 'Acción no compatible': 'Unsupported action',
    'El puente no respondió. Comprueba Clear Download Manager antes de reenviar.': 'The bridge did not respond. Check Clear Download Manager before resending.',
    'Esta función requiere un puente más reciente. Puedes realizarla desde Clear Download Manager.': 'This feature requires a newer bridge. You can perform it from Clear Download Manager.',
    'Añade vídeos o audio individuales a tu playlist.': 'Add individual videos or audio items to your playlist.',
    'Selecciona como máximo 100 elementos por envío.': 'Select at most 100 items per send.',
    'Este Mix necesita abrirse desde un vídeo de YouTube. Abre el Mix y vuelve a enviarlo.': 'This Mix must be opened from a YouTube video. Open the Mix and send it again.',
    'Abre un vídeo individual de YouTube para enviarlo a Clear Download Manager.': 'Open an individual YouTube video to send it to Clear Download Manager.',
    'El enlace no es válido.': 'The link is not valid.', 'Transferencia sin confirmar. La descarga del navegador queda pausada. Revisa Clear Download Manager antes de reanudarla manualmente en el navegador.': 'Transfer was not confirmed. The browser download is paused. Check Clear Download Manager before resuming it manually in the browser.',
    'Esta página no permite análisis desde extensiones.': 'This page does not allow extension analysis.', 'La captura no se confirmó. Revisa Clear Download Manager y la descarga pausada del navegador antes de reanudar.': 'The capture was not confirmed. Check Clear Download Manager and the paused browser download before resuming.',
    'La acción no está disponible con este puente o estado. Abre Clear Download Manager para realizarla.': 'This action is not available with this bridge or state. Open Clear Download Manager to perform it.',
    'No hay elementos válidos seleccionados.': 'No valid items selected.', 'Spotify está desactivado en esta app.': 'Spotify is disabled in this app.'
  })
});

export function detectLocale() {
  const values = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  const preferred = values
    .map((value) => String(value || '').toLowerCase())
    .find((value) => /^(?:es|en)(?:[-_]|$)/.test(value));
  return preferred?.startsWith('es') ? 'es' : 'en';
}

export function normalizeLocale(value) { return value === 'es' || value === 'en' ? value : 'system'; }

export function loadLocale() {
  try { return normalizeLocale(localStorage.getItem(LOCALE_KEY)); } catch { return 'system'; }
}

export function saveLocale(value) {
  const locale = normalizeLocale(value);
  try { localStorage.setItem(LOCALE_KEY, locale); } catch {}
  return locale;
}

export function resolveLocale(value = 'system') { const locale = normalizeLocale(value); return locale === 'system' ? detectLocale() : locale; }

function dictionary(value = 'system') { return CATALOG[resolveLocale(value)] || CATALOG.en; }

function localizeKnown(source, locale, map) {
  if (map[source]) return map[source];
  const prefix = Object.entries(PREFIXES[locale] || {}).find(([from]) => source.startsWith(from));
  if (prefix) return `${prefix[1]}${source.slice(prefix[0].length)}`;
  if (locale === 'en') {
    let match = source.match(/^(\d+) activas? · (\d+) completadas?$/);
    if (match) return `${match[1]} active · ${match[2]} completed`;
    match = source.match(/^Ver más \((\d+)\)$/);
    if (match) return `Show more (${match[1]})`;
    match = source.match(/^Versión (.+) descargada por Chrome$/);
    if (match) return `Version ${match[1]} downloaded by Chrome`;
    match = source.match(/^Solicitud recibida por el puente \((.+)\)\. Comprueba su preparación en Clear Download Manager\.$/);
    if (match) return `Request received by the bridge (${match[1]}). Check its preparation in Clear Download Manager.`;
    match = source.match(/^Añadido a «(.+)»\. Puedes seguir agregando vídeos con \+\.$/);
    if (match) return `Added to “${match[1]}”. You can keep adding videos with +.`;
    match = source.match(/^(\d+) elementos? detectados?$/);
    if (match) return `${match[1]} detected item${match[1] === '1' ? '' : 's'}`;
    match = source.match(/^Enlaces sueltos \((\d+)\)$/);
    if (match) return `Loose links (${match[1]})`;
    match = source.match(/^(.+) · (\d+) enlaces$/);
    if (match) return `${match[1]} · ${match[2]} links`;
    match = source.match(/^(\d+) enlaces sueltos$/);
    if (match) return `${match[1]} loose links`;
  }
  return source;
}

export function translate(locale, value, fallback = '') {
  const resolved = resolveLocale(locale);
  const text = String(value ?? '');
  const translated = localizeKnown(text, resolved, dictionary(resolved));
  return translated || fallback || text;
}

export function applyI18n(root = document, value = loadLocale()) {
  const locale = resolveLocale(value);
  document.documentElement.lang = locale;
  const map = dictionary(locale);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const raw = textNode.nodeValue || '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const source = ORIGINAL_TEXT.get(textNode) || trimmed;
    ORIGINAL_TEXT.set(textNode, source);
    const translated = localizeKnown(source, locale, map);
    if (translated !== source) {
      const localized = raw.replace(trimmed, translated);
      if (localized !== raw) textNode.nodeValue = localized;
    }
  }
  root.querySelectorAll?.('[title],[aria-label],[placeholder]').forEach((element) => {
    const originals = ORIGINAL_ATTRIBUTES.get(element) || {};
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const raw = element.getAttribute(attribute);
      if (raw && !originals[attribute]) originals[attribute] = raw;
      const source = originals[attribute] || raw;
      const translated = source ? localizeKnown(source, locale, map) : source;
      if (source && translated !== source && element.getAttribute(attribute) !== translated) element.setAttribute(attribute, translated);
    }
    ORIGINAL_ATTRIBUTES.set(element, originals);
  });
  return locale;
}

export function catalogLabels(value = 'system') {
  const locale = resolveLocale(value);
  return { locale, language: locale === 'es' ? 'Idioma' : 'Language', system: locale === 'es' ? 'Sistema' : 'System', spanish: 'Español', english: 'English' };
}
