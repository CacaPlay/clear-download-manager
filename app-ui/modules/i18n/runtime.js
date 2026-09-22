/*
 * Last-mile localization for legacy renderers.  The download manager has a
 * number of small templates that predate the central catalog and are rebuilt
 * from several modules.  This pass translates only exact, known UI phrases
 * after rendering; user content, paths, code and diagnostic payloads remain
 * untouched.
 */
const ES_TO_EN = Object.freeze({
  'Ajustes': 'Settings', 'Cambiar tema': 'Change theme', 'Novedades': "What's new", 'Navegación principal': 'Main navigation', 'Abrir navegación': 'Open navigation', 'Accesos de entrada': 'Input shortcuts', 'Cola': 'Queue',
  'Descargas': 'Downloads', 'Descargas activas': 'Active downloads', 'Todos los trabajos locales y sus estados.': 'All local jobs and their status.',
  'Gestor local de archivos y multimedia.': 'Local file and media manager.', 'Documentos': 'Documents', 'Biblioteca': 'Library', 'Imágenes': 'Images', 'Utilidades': 'Utilities', 'Inicio': 'Home',
  'Pega un enlace, torrent, archivo, playlist o busca un vídeo…': 'Paste a link, torrent, file, playlist, or search for a video…',
  'Pega un enlace multimedia, playlist o archivo directo': 'Paste a media link, playlist, or direct file', 'Entrada universal de descarga': 'Universal download input',
  'Pegar': 'Paste', 'Torrent': 'Torrent', 'Archivo o enlace': 'File or link', 'Playlist': 'Playlist', 'Seleccionar': 'Select', 'Seleccionar descargas': 'Select downloads', 'Todas las categorías': 'Categories', 'Categorías': 'Categories', 'Filtrar categorías': 'Filter categories', 'Mostrar detalles': 'Show details', 'Pausar': 'Pause',
  'Analizar': 'Analyze', 'Analizando…': 'Analyzing…', 'Limpiar': 'Clear', 'Activas': 'Active', 'Completadas': 'Completed', 'Velocidad': 'Speed',
  'Pendientes': 'Pending', 'En ejecución': 'Running', 'Con errores': 'With errors', 'Archivos': 'Files', 'Vídeo': 'Video', 'Audio': 'Audio', 'Multimedia': 'Media',
  'No hay descargas aquí todavía': 'No downloads here yet', 'Pega un enlace, añade un torrent o busca un vídeo para comenzar.': 'Paste a link, add a torrent, or search for a video to get started.',
  'Nueva descarga': 'New download', 'ÁREA DE DESCARGAS': 'DOWNLOAD AREA', 'Resumen de descargas': 'Download summary', 'Sugerencias de búsqueda': 'Search suggestions',
  'RESULTADOS DE VÍDEO': 'VIDEO RESULTS', 'Cargando más resultados': 'Loading more results', 'Listos': 'Ready', 'Cargando resultados': 'Loading results',
  'Sigue escribiendo para buscar coincidencias.': 'Keep typing to search for matches.', 'Busca un vídeo por su título': 'Search for a video by title', 'También puedes escribir artista, canal o palabras clave.': 'You can also enter an artist, channel, or keywords.',
  'Vídeo encontrado': 'Video found', 'Sugerencia de YouTube': 'YouTube suggestion', 'Reproducir': 'Play', '↑↓ para navegar · Enter para analizar': '↑↓ to navigate · Enter to analyze', 'Ctrl + K enfoca el buscador': 'Ctrl + K focuses search',
  'Resumen': 'Overview', 'Detalles avanzados': 'Advanced details', 'Registro': 'Log', 'Motor': 'Engine', 'Protocolo': 'Protocol', 'Modo': 'Mode', 'Transferencia': 'Transfer', 'Conexiones': 'Connections', 'Recuperación': 'Recovery', 'Enlace original': 'Original link',
  'Cerrar': 'Close', 'Volver': 'Back', 'Volver al gestor': 'Back to manager', 'Abrir': 'Open', 'Mostrar archivo': 'Show in folder', 'Abrir archivo': 'Open file', 'Copiar ruta': 'Copy path', 'Copiar archivo': 'Copy file', 'Copiar': 'Copy', 'Cortar archivo': 'Cut file', 'Cortar': 'Cut', 'Copiar enlace original': 'Copy original link', 'Ir a la extensión': 'Open extension', 'Renombrar': 'Rename', 'Renombrar archivo': 'Rename file', 'Nuevo nombre': 'New name', 'El archivo descargado se renombrará en su carpeta. Su extensión se conservará.': 'The downloaded file will be renamed in its folder. Its extension will be preserved.', 'Archivo renombrado correctamente.': 'File renamed successfully.',
  'Formato y calidad': 'Format and quality', 'Calidad / formato': 'Quality / format', 'Salida predeterminada': 'Default output', 'Se reutiliza al analizar el siguiente enlace compatible.': 'Reused when analyzing the next compatible link.', 'Formato de playlist': 'Playlist format', 'Se conserva entre playlists y se reajusta solo si resulta incompatible.': 'Kept between playlists and adjusted only when incompatible.', 'Guardar en': 'Save to', 'Elementos seleccionados': 'Selected items', 'seleccionados': 'selected', 'Todo seleccionado': 'All selected', 'Seleccionar todo': 'Select all', 'Listo para descargar': 'Ready to download',
  'Eliminar': 'Delete', 'Eliminar selección': 'Delete selection', 'Cancelar': 'Cancel', 'Guardar': 'Save', 'Restablecer': 'Reset', 'Restablecer colores': 'Reset colors', 'Restablecer apariencia': 'Reset appearance',
  'Más detalles': 'More details', 'Actualizar': 'Update', 'Más tarde': 'Later', 'Instalar ahora': 'Install now', 'Preparando…': 'Preparing…', 'Buscar ahora': 'Check now', 'Buscar actualizaciones': 'Check for updates', 'Comentarios y sugerencias': 'Feedback', 'Ver release': 'View release', 'Ver extensión': 'View extension', 'Apoyar': 'Support',
  'Apoya el proyecto': 'Support the project', 'Tu apoyo ayuda a mantener Clear Download Manager en desarrollo.': 'Your support helps keep Clear Download Manager in development.',
  'Actualizaciones': 'Updates', 'Extensión': 'Extension', 'Historial': 'History', 'Todas': 'All', 'ACTUALIZACIÓN': 'UPDATE', 'EXTENSIÓN': 'EXTENSION', 'Actualizaciones anteriores': 'Previous updates',
  'General': 'General', 'Descargas simultáneas': 'Concurrent downloads', 'Carpeta de descargas': 'Download folder', 'Cambiar carpeta': 'Change folder', 'Abrir carpeta': 'Open folder', 'Comportamiento': 'Behavior', 'Reanudación': 'Resume', 'Parciales': 'Partials', 'Conservados': 'Kept', 'En tiempo real': 'Real-time', 'Disponible': 'Available', 'No detectado': 'Not detected',
  'Destino y organización': 'Destination and organization', 'UBICACIÓN ACTUAL': 'CURRENT LOCATION', 'Descargas HTTP simultáneas': 'Concurrent HTTP downloads', 'Descargas multimedia simultáneas': 'Concurrent media downloads', 'Las tareas activas continúan; el límite se aplica al próximo espacio disponible.': 'Active tasks continue; the limit applies to the next available slot.', 'Límite máximo por descarga': 'Maximum limit per download', 'Progreso': 'Progress',
  'Velocidad': 'Speed', 'Limitar velocidad de descarga': 'Limit download speed', 'Máximo por descarga': 'Maximum per download', 'Velocidad personalizada': 'Custom speed', 'Unidad': 'Unit', 'Sin límite': 'Unlimited', 'Personalizado': 'Custom', 'Se aplicará a descargas nuevas y reanudadas. MB/s significa megabytes por segundo.': 'Applies to new and resumed downloads. MB/s means megabytes per second.',
  'Multimedia': 'Media', 'Motores y preferencias': 'Engines and preferences', 'Disponibilidad': 'Availability', 'Sesión': 'Session', 'Cookies de Brave activadas': 'Brave cookies enabled', 'Sin cookies del navegador': 'No browser cookies', 'Mejor disponible': 'Best available', 'Calidad preferida': 'Preferred quality', 'Compatibilidad': 'Compatibility', 'Las políticas multimedia y el reproductor se conservan sin cambios.': 'Media policies and the player remain unchanged.',
  'Apariencia': 'Appearance', 'Personaliza la interfaz': 'Customize the interface', 'Tema y color': 'Theme and color', 'Tema': 'Theme', 'Sistema': 'System', 'Oscuro': 'Dark', 'Claro': 'Light', 'Color de acento': 'Accent color', 'Colores de acento': 'Accent colors', 'Colores de acento para iconos': 'Accent colors for icons', 'Color de iconos': 'Icon color', 'Controla la parte de color de los iconos; la base gris permanece limpia y legible.': 'Controls the colored part of icons; the gray base stays clean and legible.', 'Colores preajustados': 'Preset colors', 'Colores preajustados para iconos': 'Preset icon colors', 'Color personalizado': 'Custom color', 'Color personalizado de iconos': 'Custom icon color', 'Colores de progreso': 'Progress colors', 'Activo': 'Active', 'Completado': 'Completed', 'En pausa': 'Paused', 'Error': 'Error', 'Activo, completado, pausa y error conservan sus colores independientes.': 'Active, completed, paused, and error keep independent colors.', 'Escala y densidad': 'Scale and density', 'Escala automática': 'Automatic scale', 'Activada': 'Enabled', 'Desactivada': 'Disabled', 'Escala de interfaz': 'Interface scale', 'Reducir escala': 'Decrease scale', 'Aumentar escala': 'Increase scale', 'Porcentaje de escala': 'Scale percentage', 'Densidad': 'Density', 'Compacta': 'Compact', 'Equilibrada': 'Balanced', 'Amplia': 'Spacious', 'Avanzado': 'Advanced', 'Tamaño del texto': 'Text size', 'Miniaturas': 'Thumbnails', 'Medianas': 'Medium', 'Grandes': 'Large', 'Muy grandes': 'Extra large', 'Efectos': 'Effects', 'Superficie': 'Surface', 'Sólida': 'Solid', 'Mica': 'Mica', 'Movimiento': 'Motion', 'Reducido': 'Reduced', 'Desactivado': 'Off', 'Esquinas': 'Corners', 'Rectas': 'Sharp', 'Estándar': 'Standard', 'Suaves': 'Soft', 'Tamaño de texto, miniaturas y preferencias visuales': 'Text size, thumbnails, and visual preferences', 'Caca verde': 'Green', 'Caca azul': 'Blue', 'Violeta': 'Violet', 'Cian': 'Cyan', 'Rosa': 'Rose', 'Ámbar': 'Amber', 'Esmeralda': 'Emerald', 'Índigo': 'Indigo', 'Magenta': 'Magenta', 'Carmesí': 'Crimson', 'Turquesa': 'Teal', 'Gris predeterminado': 'Default gray', 'Automático': 'Automatic',
  'Integraciones': 'Integrations', 'Conexiones disponibles': 'Available connections', 'Extensión del navegador': 'Browser extension', 'Puente': 'Bridge', 'Preparado': 'Ready', 'Spotify': 'Spotify', 'Spotify está desactivado temporalmente.': 'Spotify is temporarily disabled.', 'Spotify desactivado': 'Spotify disabled',
  'Actualizaciones y diagnóstico': 'Updates and diagnostics', 'Estado local': 'Local status', 'Versiones': 'Versions', 'Aplicación': 'Application', 'Herramientas internas': 'Internal tools', 'Comprueba de forma segura el motor interno de multimedia.': 'Safely check the internal media engine.', 'yt-dlp · actualización segura': 'yt-dlp · safe update', 'FFmpeg / FFprobe / Deno / aria2c': 'FFmpeg / FFprobe / Deno / aria2c', 'FFmpeg, FFprobe, Deno y aria2c se actualizan junto con una versión firmada de la aplicación para conservar compatibilidad.': 'FFmpeg, FFprobe, Deno and aria2c update together with a signed application release to preserve compatibility.', 'yt-dlp puede actualizarse con catálogo firmado. FFmpeg, FFprobe, Deno y aria2c se actualizan junto con una versión firmada de la aplicación para conservar compatibilidad.': 'yt-dlp can be updated from a signed catalog. FFmpeg, FFprobe, Deno and aria2c update together with a signed application release to preserve compatibility.', 'Incluida en la actualización de la aplicación': 'Included in the application update', 'Disponible': 'Available', 'No detectado': 'Not detected', 'Última comprobación': 'Last check', 'Diagnóstico visual': 'Visual diagnostics', 'Escala efectiva': 'Effective scale', 'Tipografía': 'Typography', 'Copiar diagnóstico': 'Copy diagnostics', 'Actualizado': 'Up to date', 'Comprobando…': 'Checking…', 'Descargando…': 'Downloading…', 'Verificando…': 'Verifying…', 'Instalando…': 'Installing…', 'No se pudo completar': 'Could not complete', 'Sin conexión': 'Offline', 'Actualizaciones no configuradas': 'Updates not configured', 'Estado no disponible': 'Status unavailable', 'Aún no comprobado': 'Not checked yet',
  'Preparar una descarga': 'Prepare a download', 'Pega un enlace multimedia, playlist o archivo directo y pulsa Analizar.': 'Paste a media link, playlist, or direct file and press Analyze.', 'Espera a que termine el análisis para confirmar la descarga.': 'Wait for analysis to finish to confirm the download.', 'Cerrar ahora saldrá completamente': 'Close now to exit completely', 'Cerrar ahora enviará CacaTools a la bandeja': 'Close now to send Clear Download Manager to the tray',
  'CENTRO DE DESCARGAS': 'DOWNLOAD CENTER', 'Enlace de descarga': 'Download link', 'Calidad': 'Quality', 'Formato': 'Format', 'Destino': 'Destination', 'Tamaño': 'Size', 'Selección': 'Selection', 'Descargar': 'Download', 'Descargando…': 'Downloading…', 'Cancelar': 'Cancel', 'Cargando…': 'Loading…', 'Resolviendo metadatos multimedia…': 'Resolving media metadata…', 'Analizando elementos de la playlist…': 'Analyzing playlist items…', 'Descarga lista': 'Download ready', 'Confirmar descarga': 'Confirm download', 'Espera': 'Wait', 'No se pudo analizar el enlace.': 'The link could not be analyzed.', 'Debes seleccionar al menos un elemento.': 'Select at least one item.', 'Elementos seleccionados': 'Selected items',
  'Buscar vídeos': 'Search videos', 'Título, artista, canal o descripción': 'Title, artist, channel, or description', 'Buscar': 'Search', 'La búsqueda se realiza mediante el resolvedor local. Nada se envía a CacaTools.': 'Search uses the local resolver. Nothing is sent anywhere.', 'Buscando coincidencias…': 'Searching for matches…',
  'Añadir torrent de forma local': 'Add a torrent locally', 'Pega un enlace magnet o selecciona un archivo .torrent. aria2c gestionará la descarga, la pausa y la recuperación.': 'Paste a magnet link or select a .torrent file. aria2c handles downloading, pausing, and recovery.', 'Magnet o archivo .torrent': 'Magnet or .torrent file', 'Elegir archivo': 'Choose file', 'Abre el selector nativo de Windows.': 'Opens the native Windows picker.', 'Pegar magnet': 'Paste magnet', 'Lee el portapapeles solo al pulsarlo.': 'Reads the clipboard only when pressed.', 'Motor privado y local': 'Private local engine', 'La fuente se entrega directamente a aria2c. CacaTools no utiliza un servidor intermediario.': 'The source is sent directly to aria2c. No intermediary server is used.', 'Añadir a la cola': 'Add to queue', 'Nueva descarga torrent': 'New torrent download',
  'Cancelar descarga': 'Cancel download', 'Cancelar y conservar': 'Cancel and keep', 'Cancelar y limpiar': 'Cancel and clean', 'Volver': 'Back', 'Eliminar descarga': 'Delete download', 'Eliminar selección': 'Delete selection', 'Solo de CacaTools': 'From Clear Download Manager only', 'CacaTools y almacenamiento': 'Clear Download Manager and storage', 'Confirmo la eliminación del almacenamiento': 'I confirm storage deletion', 'Eliminar archivo y registro': 'Delete file and record', 'Eliminar archivos y registros': 'Delete files and records',
  'Actualización disponible': 'Update available', 'ACTUALIZACIÓN DISPONIBLE': 'UPDATE AVAILABLE', 'La instalación no comienza automáticamente y se mantiene bloqueada mientras haya descargas activas.': 'Installation does not start automatically and remains blocked while downloads are active.',
  'Vista previa': 'Preview', 'No hay un enlace original disponible para esta tarea.': 'No original link is available for this task.', 'No hay novedades nuevas': 'No new updates', 'Las actualizaciones y avisos aparecerán aquí.': 'Updates and notices will appear here.',
  'Contenido administrado localmente por CacaTools.': 'Content managed locally by Clear Download Manager.', 'CacaTools encontró un error de interfaz': 'Clear Download Manager encountered an interface error', 'Recargar la interfaz': 'Reload interface'
});

// Remaining desktop surfaces still contain a few legacy renderers that emit
// complete phrases instead of catalog keys.  Keep their translations in the
// same runtime authority so settings, preparation dialogs, details, player,
// and updater text are localized without changing their functional logic.
const EXTRA_ES_TO_EN = Object.freeze({
  'Límite de descarga': 'Download limit', 'Aplicar': 'Apply', 'Velocidad personalizada en KB/s': 'Custom speed in KB/s', 'Aplicar velocidad personalizada': 'Apply custom speed',
  'Elegir archivo torrent': 'Choose torrent file', 'Pegar enlace magnet': 'Paste magnet link', 'magnet:?xt=urn:btih:… o C:\\ruta\\archivo.torrent': 'magnet:?xt=urn:btih:… or C:\\path\\file.torrent',
  'Comprobación no disponible': 'Check unavailable', 'Instalada': 'Installed', 'Versión disponible': 'Version available', 'Actualización disponible': 'Update available', 'Repositorio': 'Repository', 'Abrir repositorio': 'Open repository', 'Repositorios oficiales': 'Official repositories',
  'Comprobar automáticamente': 'Check automatically', 'Busca al iniciar y cada 6 horas cuando el actualizador firmado está configurado.': 'Checks at startup and every 6 hours when the signed updater is configured.',
  'Descargando la actualización firmada…': 'Downloading the signed update…', 'Verificando e instalando la actualización firmada.': 'Verifying and installing the signed update.',
  'Progreso de descarga': 'Download progress', 'Instalando actualización': 'Installing update', 'Descargando actualización': 'Downloading update',
  'FFmpeg, FFprobe, Deno y aria2c se actualizan junto con la aplicación firmada.': 'FFmpeg, FFprobe, Deno, and aria2c are updated with the signed application.',
  'Con la aplicación firmada': 'With the signed app',
  'PREPARACIÓN': 'PREPARATION',
  'Preparando vista previa…': 'Preparing preview…',
  'Preparando vista previa...': 'Preparing preview...',
  'Preparing vista previa…': 'Preparing preview…',
  'Preparing vista previa...': 'Preparing preview...',
  'Resolviendo primero un flujo nativo. Si el proveedor lo bloquea, podrás abrir el enlace oficial manualmente.': 'Resolving a native stream first. If the provider blocks it, you can open the official link manually.',
  'Resolviendo primero un flujo nativo. Si el proveedor lo bloquea, podrás abrir el enlace oficial manualmente': 'Resolving a native stream first. If the provider blocks it, you can open the official link manually.',
  'Resolviendo la mejor fuente disponible sin descargar el archivo final.': 'Resolving the best available source without downloading the final file.',
  'Consultando descarga…': 'Checking download…',
  'Consultando descarga...': 'Checking download...',
  'Comprobando el archivo local final.': 'Checking the final local file.',
  'Comprobando el archivo local final...': 'Checking the final local file...',
  'VISTA PREVIA': 'PREVIEW',
  'VISTA PREVIA ONLINE': 'ONLINE PREVIEW',
  'ARCHIVO LOCAL': 'LOCAL FILE',
  'Preparando vista previa': 'Preparing preview',
  'Resolviendo primero un flujo nativo': 'Resolving a native stream first',
  'Consultando descarga': 'Checking download',
  'ANALIZANDO': 'ANALYZING',
  'Preparando reproducción…': 'Preparing playback…',
  'Resolviendo la mejor fuente disponible': 'Resolving the best available source',
  'Playlist todavía no reproducible': 'Playlist is not playable yet',
  'Puedes ver todos sus elementos en la lista, pero ninguno tiene todavía un archivo local final reproducible.': 'You can see all its items in the list, but none has a playable final local file yet.',
  'Preparando playlist…': 'Preparing playlist…',
  'Cargando todos los elementos y comprobando cuáles tienen archivo local reproducible.': 'Loading all items and checking which ones have a playable local file.',
  'Categorías de ajustes': 'Settings categories', 'Velocidad': 'Speed',
  'Nombre': 'Name', 'Guardar en': 'Save to', 'Cambiar': 'Change', 'Comprimido': 'Compressed',
  'Analiza': 'Analyze', 'ENLACE DETECTADO': 'LINK DETECTED', 'EXTENSIÓN DE CLEAR DOWNLOAD MANAGER': 'CLEAR DOWNLOAD MANAGER EXTENSION',
  'NO DISPONIBLE': 'UNAVAILABLE', 'PREPARACIÓN HTTP': 'HTTP PREPARATION', 'DESTINO': 'DESTINATION', 'Tipo de archivo': 'File type',
  'Destino y opciones': 'Destination and options', 'Se descargará como archivo original.': 'It will be downloaded as the original file.',
  'Pega un enlace multimedia, playlist o archivo directo': 'Paste a media link, playlist, or direct file', 'Espera a que termine el análisis para confirmar la descarga.': 'Wait for analysis to finish to confirm the download.',
  'Selecciona primero una descarga.': 'Select a download first.', 'Seleccionar todo': 'Select all', 'seleccionados': 'selected',
  'elementos': 'items', 'Origen multimedia': 'Media source', 'Sugerencias de búsqueda': 'Search suggestions', 'Entrada universal de descarga': 'Universal download input',
  'MULTIMEDIA · CONTENIDO': 'MEDIA · CONTENT', 'MULTIMEDIA': 'MEDIA', 'Contenido multimedia': 'Media content',
  'Preparando contenido multimedia': 'Preparing media content', 'Añadir torrent de forma local': 'Add torrent locally',
  'Pega un enlace magnet o selecciona un archivo .torrent. aria2c gestionará la descarga, la pausa y la recuperación.': 'Paste a magnet link or select a .torrent file. aria2c will manage downloading, pausing, and recovery.',
  'Elegir archivo': 'Choose file', 'Abre el selector nativo de Windows.': 'Opens the native Windows picker.',
  'Pegar magnet': 'Paste magnet', 'Lee el portapapeles solo al pulsarlo.': 'Reads the clipboard only when clicked.',
  'Motor privado y local': 'Private local engine', 'La fuente se entrega directamente a aria2c. CacaTools no utiliza un servidor intermediario.': 'The source is sent directly to aria2c. Clear Download Manager does not use an intermediary server.',
  'Elige Analizar para abrir la preparación correspondiente. La descarga no comenzará desde esta sugerencia.': 'Choose Analyze to open the corresponding preparation. The download will not start from this suggestion.',
  'No se pudo preparar este enlace': 'This link could not be prepared', 'El enlace devolvió una página web, no el archivo solicitado. Busca el botón de descarga de la página y copia el enlace directo del archivo.': 'The link returned a web page, not the requested file. Find the page download button and copy the file direct link.',
  'Buscando coincidencias…': 'Searching for matches…', 'Busca un vídeo por su título': 'Search for a video by title',
  'También puedes escribir artista, canal o palabras clave.': 'You can also enter an artist, channel, or keywords.',
  'La búsqueda se realiza mediante el resolvedor local. Nada se envía a CacaTools.': 'Search uses the local resolver. Nothing is sent anywhere.',
  'Nueva descarga torrent': 'New torrent download', 'Pega un magnet o selecciona un archivo .torrent.': 'Paste a magnet or select a .torrent file.',
  'Cancelar y conservar': 'Cancel and keep', 'Mantiene fragmentos y temporales para recuperación manual.': 'Keeps fragments and temporary files for manual recovery.',
  'Cancelar y limpiar': 'Cancel and clean up', 'Elimina únicamente los temporales administrados cuando el proceso termine.': 'Removes only managed temporary files when the process ends.',
  'Validando rutas administradas…': 'Validating managed paths…', 'Archivo o carpeta final': 'Final file or folder', 'Temporales relacionados': 'Related temporary files',
  'No existe una salida final registrada.': 'No final output is registered.', 'No hay temporales registrados.': 'No temporary files are registered.', 'Raíz administrada:': 'Managed root:',
  'El almacenamiento está protegido': 'Storage is protected', 'Solo de CacaTools': 'Clear Download Manager only', 'CacaTools y almacenamiento': 'Clear Download Manager and storage',
  'Borra la tarea de la cola y el historial. Conserva archivos y carpetas.': 'Removes the task from the queue and history. Keeps files and folders.',
  'Elimina las rutas finales y parciales indicadas arriba.': 'Removes the final and partial paths shown above.', 'Confirmo la eliminación del almacenamiento': 'I confirm storage deletion',
  'Eliminar archivo y registro': 'Delete file and record', 'Eliminar archivos y registros': 'Delete files and records',
  'Eliminar selección': 'Delete selection', 'más': 'more', 'Actualización disponible': 'Update available',
  'La instalación no comienza automáticamente y se mantiene bloqueada mientras haya descargas activas.': 'Installation does not start automatically and remains blocked while downloads are active.',
  'Más tarde': 'Later', 'Instalar ahora': 'Install now', 'Vista previa': 'Preview', 'Cerrar': 'Close', 'Volver': 'Back',
  'Envía enlaces desde tu navegador': 'Send links from your browser', 'Envía enlaces al gestor y consulta tus descargas directamente desde el navegador.': 'Send links to the manager and view your downloads directly from the browser.',
  'La extensión no se instala automáticamente. Solo se abrirá la Chrome Web Store si eliges continuar.': 'The extension is not installed automatically. The Chrome Web Store opens only if you choose to continue.',
  'Prepara un reporte local para abrirlo en GitHub. CacaTools no adjunta logs ni rutas privadas automáticamente.': 'Prepare a local report to open in GitHub. Clear Download Manager does not attach logs or private paths automatically.',
  'Programa una acción local para': 'Schedule a local action for', 'Selecciona primero una descarga.': 'Select a download first.', 'La programación se vincula a un trabajo concreto para evitar tareas sin efecto.': 'Scheduling is tied to a specific job to avoid ineffective tasks.',
  'Acción': 'Action', 'Pausar': 'Pause', 'No apareció una alternativa suficientemente fiable': 'No sufficiently reliable alternative was found', 'No es necesario buscar otro vídeo para este tipo de error': 'There is no need to search for another video for this error type',
  'El asistente conserva el archivo parcial y propone reparar la tarea original cuando es seguro.': 'The assistant keeps the partial file and offers to repair the original task when safe.',
  'Diagnóstico local, doble comprobación y reparación según el tipo de tarea.': 'Local diagnosis, double-check, and repair based on the task type.',
  'Se distingue entre fallo temporal, restricción, archivo bloqueado y contenido realmente ausente.': 'Temporary failures, restrictions, blocked files, and genuinely missing content are distinguished.',
  '¿El error es definitivo o todavía se puede corregir?': 'Is the error final or can it still be fixed?', 'Primero se verificará la fuente. Solo los vídeos realmente no disponibles activarán la búsqueda de alternativas.': 'The source will be checked first. Only videos that are truly unavailable will trigger an alternative search.',
  'Descargando': 'Downloading', 'Descargando…': 'Downloading…', 'Descargando...': 'Downloading...', 'En pausa': 'Paused', 'Cancelada': 'Cancelled', 'Error': 'Error', 'Programada': 'Scheduled', 'Procesando…': 'Processing…', 'Procesando': 'Processing', 'Procesando...': 'Processing...', 'Pendiente': 'Pending', 'Verificando': 'Verifying', 'Finalizando': 'Finalizing', 'Preparando': 'Preparing',
  'Original / mejor audio disponible': 'Original / best available audio', 'Mejor disponible': 'Best available', 'Original, sin conversión cuando sea posible': 'Original, without conversion when possible', 'MP4 · vídeo + audio': 'MP4 · video + audio', 'WebM · vídeo + audio': 'WebM · video + audio', 'Vídeo · mejor disponible': 'Video · best available', 'Vídeo · MP4 720p': 'Video · MP4 720p', 'Vídeo · MP4 480p': 'Video · MP4 480p', 'Vídeo · MP4 1080p': 'Video · MP4 1080p',
  'Vídeo': 'Video', 'Documento': 'Document', 'Imagen': 'Image', 'Fuente': 'Font', 'Texto': 'Text', 'Código': 'Code', 'Hoja': 'Spreadsheet', 'Presentación': 'Presentation', 'Aplicación': 'Application', 'Archivo': 'File', 'Completado': 'Completed', 'Completada': 'Completed', 'Datos contabilizados': 'Counted data', 'Directo': 'Direct', 'Origen administrado': 'Managed source', 'Sin conexiones activas': 'No active connections',
  'Programar': 'Schedule', 'Programar tarea': 'Schedule task', 'Iniciar o reanudar': 'Start or resume',
  'Diagnosticar': 'Diagnose', 'Diagnosticar y confirmar': 'Diagnose and confirm', 'Prioridad': 'Priority',
  'Alta': 'High', 'Normal': 'Normal', 'Baja': 'Low', 'Todo seleccionado': 'All selected', 'Estado': 'Status',
  'No volver a mostrar sugerencias del portapapeles': 'Do not show clipboard suggestions again', 'Origen web': 'Web source',
  'Playlist de YouTube': 'YouTube playlist', 'Preparar contenido multimedia': 'Prepare media content',
  'Formato y calidad': 'Format and quality', 'Destino y archivo': 'Destination and file', 'Formato de salida': 'Output format',
  'Calidad / formato': 'Quality / format', 'Listo para confirmar': 'Ready to confirm', 'Opciones comunes': 'Common options',
  'Elementos seleccionados': 'Selected items', 'Descargar seleccionados': 'Download selected', 'Sin elementos seleccionados': 'No items selected',
  'Descarga todavía en curso': 'Download still in progress', 'No reproduce archivos .part, fragmentos incompletos ni vídeo y audio separados.': 'It does not play .part files, incomplete fragments, or separate video and audio streams.',
  'El reproductor se habilitará cuando exista un archivo final seguro.': 'The player will be enabled when a safe final file exists.',
  'Progreso actual:': 'Current progress:', 'Preparando enlace…': 'Preparing link…', 'Preparando playlist…': 'Preparing playlist…',
  'Reproducción temporal sin descargar.': 'Temporary playback without downloading.', 'Archivo multimedia local.': 'Local media file.',
  'Abrir ajustes de sesión': 'Open session settings', 'No gracias': 'No thanks', 'Tipo de reporte': 'Report type',
  'Problema': 'Problem', 'Sugerencia': 'Suggestion', 'Comentario': 'Comment', 'Otro': 'Other', 'Título': 'Title',
  'Descripción': 'Description', 'Resumen breve': 'Brief summary', 'Qué ocurrió y qué esperabas': 'What happened and what you expected',
  'Pasos para reproducir': 'Steps to reproduce', 'Fecha y hora': 'Date and time', 'Repetir diariamente': 'Repeat daily',
  'Guardar tarea': 'Save task', 'Confirmando el error antes de actuar…': 'Confirming the error before acting…',
  'Qué conviene hacer': 'What to do', 'Alternativas encontradas': 'Alternatives found', 'Usar alternativa': 'Use alternative',
  'Fuente disponible': 'Source available', 'Fallo confirmado': 'Failure confirmed', 'Reanudar fuente original': 'Resume original source',
  'Reintentar conservando el parcial': 'Retry while keeping the partial file', 'Actualización disponible': 'Update available',
  'Límite máximo por descarga': 'Maximum limit per download', 'Máximo por descarga': 'Maximum per download',
  'Guardar': 'Save', 'Cambiar carpeta': 'Change folder', 'Abrir carpeta': 'Open folder',
  'Carpeta de descargas': 'Download folder', 'Comportamiento': 'Behavior', 'Reanudación': 'Resume',
  'Parciales': 'Partials', 'Conservados': 'Kept', 'En tiempo real': 'Real-time',
  'Tonalidad': 'Tone', 'Intensidad del acento': 'Accent intensity', 'Contraste': 'Contrast',
  'Ventana / DPR': 'Window / DPR', 'Miniaturas': 'Thumbnails', 'cargadas · caché': 'loaded · cache',
  'Restablecer colores': 'Reset colors', 'Restablecer apariencia': 'Reset appearance',
  'Las tareas activas continúan; el límite se aplica al próximo espacio disponible.': 'Active tasks continue; the limit applies to the next available slot.',
  'Se aplicará a descargas nuevas y reanudadas. MB/s significa megabytes por segundo.': 'Applies to new and resumed downloads. MB/s means megabytes per second.',
  'Motor y diagnóstico': 'Engine and diagnostics', 'Estado reportado por los componentes locales.': 'Status reported by local components.',
  'Sesión para YouTube y plataformas compatibles': 'Session for YouTube and supported platforms',
  'Se configura una sola vez y se aplica a análisis, descargas y playlists.': 'Configured once and applied to analysis, downloads, and playlists.',
  'Diagnóstico y recuperación': 'Diagnostics and recovery', 'Se confirmará el error, se distinguirá si es temporal y se buscarán alternativas solo cuando corresponda.': 'The error will be confirmed, transient failures distinguished, and alternatives searched only when appropriate.',
  'Carpeta predeterminada': 'Default folder', 'Archivos relacionados': 'Related files', 'Rutas reales conocidas por el trabajo seleccionado.': 'Actual paths known for the selected job.',
  'Información técnica reportada por el motor local.': 'Technical information reported by the local engine.', 'Registro del trabajo': 'Job log', 'Resumen persistente del último estado conocido.': 'Persistent summary of the last known state.', 'Trabajo finalizado': 'Job completed', 'Sesión y piezas persistentes': 'Persistent session and pieces', 'Parcial conservable y reanudable': 'Resumable partial file', 'Sin conexiones activas': 'No active connections', 'No hay un enlace original disponible para esta tarea.': 'No original link is available for this job.', 'Enlace original': 'Original link', 'Transferencia': 'Transfer', 'Recuperación': 'Recovery', 'Protocolo': 'Protocol', 'Endpoint': 'Endpoint', 'Modo': 'Mode', 'Conexiones': 'Connections',
  'Selecciona una descarga': 'Select a download', 'Los detalles, archivos, conexiones y acciones aparecerán aquí.': 'Details, files, connections, and actions will appear here.',
  'Abrir carpeta de descargas': 'Open download folder', 'Cancelar descarga': 'Cancel download', 'Eliminar del historial': 'Remove from history',
  'Pausar playlist': 'Pause playlist', 'Reanudar playlist': 'Resume playlist', 'Reproducir': 'Play',
  'El archivo guardado ya no está disponible.': 'The saved file is no longer available.', 'No hay un archivo parcial activo.': 'There is no active partial file.',
  'La playlist no tiene acciones disponibles.': 'The playlist has no available actions.', 'Esta tarea no tiene acciones disponibles.': 'This task has no available actions.',
  'Preferencias persistentes de salida y calidad.': 'Persistent output and quality preferences.',
  'Extractor yt-dlp; unión local con FFmpeg cuando hace falta': 'yt-dlp extractor; local FFmpeg merge when needed',
  'La integración conserva el ID oficial y recibe enlaces, estado y progreso desde la extensión.': 'The integration keeps the official ID and receives links, status, and progress from the extension.',
  'Sesión y piezas persistentes': 'Session and persistent pieces', 'Temporal y reanudación': 'Temporary files and resume',
  'Descarga HTTP con rangos y reintentos': 'HTTP download with ranges and retries', 'Motor privado y local': 'Private local engine',
  'Disponible': 'Available', 'No disponible': 'Unavailable', 'No detectado': 'Not detected', 'En cola': 'Queued',
  'En ejecución': 'Running', 'Pendientes': 'Pending', 'Completada': 'Completed', 'Con errores': 'With errors',
  'Aplicación': 'Application', 'Archivo': 'File', 'Código': 'Code', 'Presentación': 'Presentation', 'Música': 'Music',
  'Archivo final': 'Final file', 'Archivo o carpeta final': 'Final file or folder', 'Categoría': 'Category', 'Categorías disponibles': 'Available categories',
  'Detalles de novedades': 'News details', 'Diagnóstico y recuperación': 'Diagnostics and recovery', 'Actualizador y componentes locales.': 'Updater and local components.',
  'El código está preparado; la publicación requiere endpoint y firma válidos.': 'The code is ready; publication requires a valid endpoint and signature.',
  'El motor no reportó mensajes adicionales.': 'The engine reported no additional messages.', 'El puente nativo no informó una configuración válida.': 'The native bridge did not report a valid configuration.',
  'La búsqueda se realiza mediante el resolvedor local. Nada se envía a CacaTools.': 'Search uses the local resolver. Nothing is sent anywhere.',
  'Torrent detectado': 'Torrent detected', 'Enlace detectado': 'Link detected', 'Vídeo encontrado': 'Video found', 'Búsqueda de vídeo': 'Video search',
  'Comprobando el error y buscando alternativas…': 'Checking the error and looking for alternatives…', 'Se hará automáticamente; no necesitas abrir otra ventana.': 'This happens automatically; you do not need to open another window.',
  'El origen falló; elige una coincidencia para sustituirlo.': 'The source failed; choose a match to replace it.',
  'El parcial se conserva cuando el origen lo permite; puedes reintentar después de corregir el enlace.': 'The partial file is kept when the source allows it; retry after correcting the link.',
  'El servidor exige una sesión o un enlace temporal; vuelve a iniciar la descarga desde la página original.': 'The server requires a session or temporary link; restart the download from the original page.',
  'El servidor usa una ruta intermedia; analiza la página original o copia el enlace final.': 'The server uses an intermediate route; analyze the original page or copy the final link.',
  'Fallo interno de yt-dlp, no de tu conexión. Suele resolverse solo; si se repite mucho, actualiza la app.': 'Internal yt-dlp failure, not your connection. It usually resolves itself; if it repeats, update the app.',
  'La dirección devuelve una página de acceso, no el archivo; usa el botón de descarga directa del sitio.': 'The address returns an access page, not the file; use the site’s direct download button.',
  'Resolviendo metadatos multimedia…': 'Resolving media metadata…', 'Analizando elementos de la playlist…': 'Analyzing playlist items…',
  'Analizando contenido': 'Analyzing content', 'Analizando la fuente…': 'Analyzing source…', 'Comprobando el archivo': 'Checking the file',
  'Esperando el archivo': 'Waiting for the file', 'El análisis comenzará automáticamente.': 'Analysis will start automatically.',
  'Preparar una descarga': 'Prepare a download', 'Preparar descarga HTTP': 'Prepare HTTP download', 'Preparar playlist': 'Prepare playlist',
  'Nombre del archivo': 'File name', 'Origen pendiente': 'Pending source', 'Archivo directo': 'Direct file', 'Archivo comprimido': 'Compressed file',
  'Automático (nombre original)': 'Automatic (original name)', 'Automático (título original)': 'Automatic (original title)', 'Mejor audio disponible': 'Best available audio',
  'MP4 · vídeo + audio': 'MP4 · video + audio', 'WebM · vídeo + audio': 'WebM · video + audio', 'MP4 · vídeo': 'MP4 · video', 'WebM · vídeo': 'WebM · video',
  'Listo para descargar': 'Ready to download', 'Iniciar descarga': 'Start download', 'Reintentar análisis': 'Retry analysis',
  'Selecciona un formato y calidad compatibles.': 'Select a compatible format and quality.', 'Selecciona una calidad disponible.': 'Select an available quality.',
  'La calidad solicitada no está disponible en esta fuente.': 'The requested quality is not available from this source.',
  'No se pudo analizar el enlace.': 'The link could not be analyzed.', 'No se pudo preparar este enlace': 'This link could not be prepared',
  'Pega un magnet o selecciona un archivo .torrent.': 'Paste a magnet or select a .torrent file.', 'Añadir a la cola': 'Add to queue',
  'Nueva descarga torrent': 'New torrent download', 'Magnet o archivo .torrent': 'Magnet or .torrent file',
  'Abrir enlace oficial': 'Open official link', 'Preparando reproductor…': 'Preparing player…', 'Preparando reproducción.': 'Preparing playback.',
  'Esperando información del contenido.': 'Waiting for content information.', 'Reproductor online': 'Online player', 'Información de audio': 'Audio information',
  'Lista de reproducción': 'Playlist', 'Lista de la playlist': 'Playlist list', 'Velocidad de reproducción': 'Playback speed',
  'Calidad de reproducción': 'Playback quality', 'Calidad disponible': 'Available quality', 'Selecciona un flujo expuesto por la fuente original.': 'Select a stream exposed by the original source.',
  'Calidad oficial de YouTube': 'Official YouTube quality', 'Calidad oficial de YouTube:': 'Official YouTube quality:',
  'Este archivo se reproduce en la calidad descargada.': 'This file plays at its downloaded quality.', 'La fuente no expuso más flujos directos seleccionables.': 'The source exposed no more selectable direct streams.',
  'Video y audio en un solo flujo': 'Video and audio in one stream', 'Video adaptativo · audio sincronizado': 'Adaptive video · synchronized audio',
  'Subtítulos oficiales activados cuando el video expone una pista compatible.': 'Official subtitles enabled when the video exposes a compatible track.',
  'Subtítulos oficiales desactivados.': 'Official subtitles disabled.', 'No hay una pista de subtítulos seleccionable para este contenido.': 'There is no selectable subtitle track for this content.',
  'No hay un video para previsualizar': 'There is no video to preview', 'No hay una descarga seleccionada': 'No download selected',
  'La playlist no contiene elementos.': 'The playlist contains no items.', 'Playlist vacía': 'Empty playlist', 'Playlist no válida': 'Invalid playlist',
  'Playlist todavía no reproducible': 'Playlist not playable yet', 'No hay elementos guardados en esta playlist.': 'There are no saved items in this playlist.',
  'Cargando todos los elementos y comprobando cuáles tienen archivo local reproducible.': 'Loading all items and checking which have a playable local file.',
  'Reproducción de audio local.': 'Local audio playback.', 'Reproducción nativa no disponible': 'Native playback unavailable', 'Vista previa no disponible': 'Preview unavailable',
  'El archivo existe, pero WebView2 no admite este codec o contenedor.': 'The file exists, but WebView2 does not support this codec or container.',
  'El archivo no pudo reproducirse': 'The file could not be played', 'La plataforma no devolvió una URL oficial de reproducción.': 'The platform did not return an official playback URL.',
  'No se pudo abrir el reproductor': 'The player could not be opened', 'No se pudo abrir la playlist': 'The playlist could not be opened',
  'El reproductor oficial tampoco está disponible.': 'The official player is not available either.', 'La fuente bloqueó esta vista previa': 'The source blocked this preview',
  'Actualización instalada. Windows cerrará la aplicación para finalizar.': 'Update installed. Windows will close the application to finish.',
  'Comprobación no disponible: el actualizador todavía no está configurado.': 'Check unavailable: the updater is not configured yet.',
  'Comprobando la versión publicada…': 'Checking published version…', 'Descargando y verificando la actualización firmada…': 'Downloading and verifying the signed update…',
  'Estás usando la versión más reciente.': 'You are using the latest version.', 'No se pudo comprobar la actualización.': 'The update could not be checked.',
  'Espera a que terminen las descargas activas antes de instalar.': 'Wait for active downloads to finish before installing.',
  'No se pudo completar la operación.': 'The operation could not be completed.', 'La operación tardó demasiado.': 'The operation took too long.', 'Archivo copiado al portapapeles.': 'File copied to the clipboard.', 'Archivo listo para cortar y pegar.': 'File ready to cut and paste.',
  'Acción completada': 'Action completed', 'Ajustes guardados': 'Settings saved', 'Diagnóstico copiado': 'Diagnostics copied', 'Diagnóstico visual copiado': 'Visual diagnostics copied',
  'Integración de Windows reparada': 'Windows integration repaired', 'Estado de componentes actualizado': 'Component status updated', 'Límite de velocidad guardado': 'Speed limit saved',
  'No se pudo copiar el diagnóstico': 'Diagnostics could not be copied', 'No se pudo copiar el diagnóstico visual': 'Visual diagnostics could not be copied',
  'No se pudo crear el archivo final.': 'The final file could not be created.', 'No se encontró una versión disponible para descargar.': 'No downloadable version was found.',
  'No se encontró la canción.': 'The song was not found.', 'No se pudo guardar la sesión multimedia:': 'The media session could not be saved:',
  'No se pudo guardar el archivo de cookies:': 'The cookies file could not be saved:', 'No se pudo conectar Spotify:': 'Spotify could not connect:',
  'No se pudo desconectar Spotify:': 'Spotify could not disconnect:', 'Sesión multimedia guardada en Ajustes': 'Media session saved in Settings',
  'Archivo de cookies guardado en Ajustes': 'Cookies file saved in Settings', 'Añade los pasos para reproducir el problema.': 'Add the steps to reproduce the problem.',
  'No se pudo reparar la integración:': 'The integration could not be repaired:', 'No se pudo sincronizar la jerarquía visual de ventanas.': 'Window visual hierarchy could not be synchronized.'
});

const FULL_ES_TO_EN = Object.freeze({ ...ES_TO_EN, ...EXTRA_ES_TO_EN });

const ES_PHRASES = Object.freeze([
  ['CacaTools', 'Clear Download Manager'],
  ['Esta versión de Clear Download Manager', 'This version of Clear Download Manager'],
  ['Clear Download Manager no puede', 'Clear Download Manager cannot'],
  ['Clear Download Manager todavía', 'Clear Download Manager still'],
  ['Se abrirá el navegador oficial de Spotify.', 'The official Spotify browser will open.'],
  ['No se pudieron inspeccionar las rutas.', 'The paths could not be inspected.'],
  ['La descarga ya no está disponible', 'The download is no longer available'],
  ['La fuente se entrega directamente', 'The source is sent directly'],
  ['CacaTools no reproduce archivos .part, fragmentos incompletos ni vídeo y audio separados.', 'Clear Download Manager does not play .part files, incomplete fragments, or separate video and audio streams.'],
  ['CacaTools continuará con el siguiente elemento reproducible.', 'Clear Download Manager will continue with the next playable item.'],
  ['CacaTools no simulará una reproducción que la fuente no permita.', 'Clear Download Manager will not simulate playback that the source does not allow.'],
  ['CacaTools encontró un error de interfaz', 'Clear Download Manager encountered an interface error']
]);

const EN_TO_ES = Object.freeze({
  ...Object.fromEntries(Object.entries(FULL_ES_TO_EN).map(([es, en]) => [en, es])),
  // “Playlist” is commonly used as-is in Spanish and keeps this toolbar compact.
  Playlist: 'Playlist'
});

export function translateRuntimeText(value, locale = 'es') {
  let text = String(value ?? '');
  if (locale === 'en') {
    const updatePercent = text.trim().match(/^Descargando la actualización firmada \((\d+)%\)\.$/);
    if (updatePercent) return text.replace(text.trim(), `Downloading the signed update (${updatePercent[1]}%).`);
    const exact = FULL_ES_TO_EN[text.trim()];
    if (exact) return text.replace(text.trim(), exact);
    for (const [from, to] of ES_PHRASES) text = text.split(from).join(to);
    for (const [from, to] of Object.entries(FULL_ES_TO_EN)) {
      if (from.length < 4 || !text.includes(from)) continue;
      text = text.split(from).join(to);
    }
    text = text.replace(/^(?:Abrir|Open) (.+) en el reproductor$/, 'Open $1 in the player');
    text = text.replace(/^Más acciones para (.+)$/, 'More actions for $1');
    text = text.replace(/^Eliminar (\d+)$/, 'Delete $1');
    text = text.replace(/^Eliminar (\d+) (?:descarga|descargas)$/, 'Delete $1 downloads');
    text = text.replace(/^Reproducir (.+)$/, 'Play $1');
    text = text.replace(/^Cancelar “(.+)”$/, 'Cancel “$1”');
    text = text.replace(/^Eliminar “(.+)”$/, 'Delete “$1”');
    text = text.replace(/^Descargar (\d+) seleccionados$/, 'Download $1 selected');
    text = text.replace(/^Descargando (.+)$/, 'Downloading $1');
    text = text.replace(/^CacaTools (.+)$/, 'Clear Download Manager $1');
    text = text.replace(/^Clear Download Manager no reproduce archivos \.part, fragmentos incompletos ni vídeo y audio separados\.\s*/i, 'Clear Download Manager does not play .part files, incomplete fragments, or separate video and audio streams. ');
    text = text.replace(/^El reproductor se habilitará cuando exista un archivo final seguro\./i, 'The player will be enabled when a safe final file exists.');
    text = text.replace(/Progreso actual:\s*(\d+)%/i, 'Current progress: $1%');
    text = text.replace(/^([^·]+) · reproducción online$/i, '$1 · online playback');
    text = text.replace(/^La calidad (\d+)p no está disponible en esta fuente\.?$/i, 'Quality $1p is not available from this source.');
    text = text.replace(/Original\s*\/\s*mejor audio disponible/gi, 'Original / best available audio');
    text = text.replace(/^(\d+) configurada?s?$/i, '$1 configured');
  } else {
    const exact = EN_TO_ES[text.trim()];
    if (exact) return text.replace(text.trim(), exact);
    text = text.replace(/^Delete (\d+) downloads?$/, 'Eliminar $1 descargas');
    text = text.replace(/^Play (.+)$/, 'Reproducir $1');
    text = text.replace(/^Cancel “(.+)”$/, 'Cancelar “$1”');
    text = text.replace(/^Delete “(.+)”$/, 'Eliminar “$1”');
    text = text.replace(/^Download (\d+) selected$/, 'Descargar $1 seleccionados');
    text = text.replace(/^Current progress:\s*(\d+)%/i, 'Progreso actual: $1%');
    text = text.replace(/Original\s*\/\s*best available audio/gi, 'Original / mejor audio disponible');
    text = text.replace(/^(\d+) configured$/i, '$1 configurada');
  }
  return text;
}

export const RUNTIME_TRANSLATION_TERMS = Object.freeze(Object.keys(FULL_ES_TO_EN));

export function localizeDom(root, locale = 'es') {
  if (!root || !['en', 'es'].includes(locale)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA|INPUT)$/i.test(parent.tagName)) continue;
    const next = translateRuntimeText(node.nodeValue, locale);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  root.querySelectorAll('title, [title], [aria-label], [placeholder], [data-tooltip]').forEach((element) => {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'data-tooltip']) {
      if (!element.hasAttribute(attribute)) continue;
      const value = element.getAttribute(attribute);
      const next = translateRuntimeText(value, locale);
      if (next !== value) element.setAttribute(attribute, next);
    }
  });
}
