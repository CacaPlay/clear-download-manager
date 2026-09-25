# Privacidad y almacenamiento local

**Revisión estática de fuente:** 2026-09-24.  
Este documento describe lo que el código actual guarda o transmite. No se abrió
el perfil real de WebView2, la base SQLite de ninguna instalación, el perfil
de Brave, el archivo de cookies del usuario ni el almacenamiento del navegador.
Tampoco se hizo captura de tráfico en una ejecución real.

## Datos que Clear conserva localmente

- **Base SQLite de la aplicación.** De forma predeterminada se crea en el
  directorio de datos de Tauri con identificador
  `lat.cacaplay.cacatools.downloadmanager` como `cacatools.sqlite3`; la variable
  `CACATOOLS_DATA_DIR` puede cambiar la ubicación. El esquema incluye títulos,
  estados y detalles de trabajos; URL de origen, destino, archivo temporal,
  progreso y errores de descargas; origen y carpeta de torrents; URL, título,
  creador, miniatura y estado de elementos de playlists; rutas de archivos
  recientes; enlaces guardados, programaciones y ajustes. El historial de
  playlists puede conservar campos heredados. Esta auditoría no leyó filas de
  una instalación.
- **Cookies multimedia.** El ajuste `media_session_v1` guarda si se habilitó
  Brave y, si se eligió un archivo Netscape, su ruta local. El código declara y
  serializa esos campos, no el contenido de las cookies. La preferencia se
  conserva hasta que se desactive; se aplica a análisis, descargas y playlists.
  El archivo elegido sigue en su ubicación original: quitar su ruta de Clear
  no borra el archivo.
- **Perfil del WebView.** El proyecto no fija un directorio WebView propio ni
  llama a APIs para limpiar cookies o datos de navegación. Tauri 2.11.6 asigna
  por defecto el directorio WebView bajo `LocalData/<identifier>` en Windows.
  WebView2 puede guardar allí cookies, permisos, caché, `localStorage`,
  IndexedDB y otros datos del perfil, incluido un tipo de datos de historial de
  navegación. El código no los limpia al cerrar la app. La base de la
  aplicación contiene historial de descargas, pero no se encontró una tabla de
  páginas visitadas; no se verificó en runtime si los marcos embebidos escriben
  entradas en el historial de WebView2. No se inspeccionó qué existe actualmente
  en ese directorio ni se comprobó la política del desinstalador.
- **`localStorage` de la interfaz.** Se usa para idioma, apariencia, ajustes de
  multimedia/calidad, preferencias y avisos de actualización, datos visuales y
  de rendimiento, y una proyección del estado del gestor de descargas. Persiste
  en el perfil del WebView.
- **`sessionStorage`.** No se encontró uso directo en el código de la interfaz.
  Esto no impide que las páginas de terceros dentro de marcos usen su propio
  almacenamiento.
- **IndexedDB del editor de imágenes.** El editor local puede guardar imágenes
  recientes como blobs (hasta 12 elementos, cada uno con tope de 25 MiB) y
  proyectos de edición en el almacén `cacatools-images-v3`. El código los
  mantiene en IndexedDB, no en un servicio de Clear. Se pueden borrar desde la
  biblioteca del editor o al eliminar los datos del perfil WebView; no se
  inspeccionaron imágenes ni proyectos existentes.
- **Caché de yt-dlp.** Los procesos pasan `--ignore-config`, pero no
  `--no-cache-dir`; por tanto queda habilitada la caché predeterminada del
  motor. yt-dlp documenta que guarda de forma permanente cierta información
  descargada, como identificadores de cliente y firmas. No se leyó ni se borró
  esa caché.
- **Noticias y actualizaciones.** El feed remoto validado se guarda como JSON
  limitado en ajustes, junto con origen, hora y validadores HTTP (`ETag` y
  `Last-Modified`). También se guardan avisos leídos/descartados y preferencias
  de actualización.
- **Descargas y parciales.** Los archivos terminados quedan en la carpeta que
  el usuario elige. Los parciales y sidecars se conservan para reanudar; no se
  borran como parte de esta revisión.
- **Diagnóstico optativo.** Solo si se define
  `CACATOOLS_DEBUG_TELEMETRY=1/true/on`, se añade localmente una línea con hora
  y latencia del bucle de eventos a `debug_telemetry.log` junto a la base. El
  código revisado no envía ese registro por red.
- **Puente de extensión.** La app escribe un `extension-state.json` local que
  puede contener hasta 80 trabajos con URL, título, destino y estado para que
  la extensión muestre la cola; también hay archivos temporales de solicitud y
  respuesta locales.

## Cookies: lectura, copia temporal y destino

1. Por defecto, las descargas multimedia usan el modo anónimo. Al activar
   **Usar cookies de Brave**, Clear guarda esa preferencia y pasa a yt-dlp
   `--cookies-from-browser brave`. La versión fijada en este árbol es
   `2026.08.19`. Su lector abre el almacén local de Brave y usa una copia
   temporal de la base de cookies para extraerlas; el directorio temporal se
   limpia al terminar normalmente ese bloque de lectura. La limpieza no es un
   borrado seguro y un cierre forzado puede impedir la limpieza normal.
2. yt-dlp puede enviar las cookies que coincidan con el host a la plataforma y
   a otros hosts que necesite para resolver o descargar el contenido. No se
   guardan los valores en la base SQLite de Clear, pero sí salen del equipo
   hacia los destinatarios de red que requiere ese contenido.
3. Si se elige un archivo Netscape `.txt`, Clear guarda la ruta absoluta y
   entrega esa ruta a yt-dlp mediante `--cookies`. Clear no copia ni elimina el
   archivo. Los valores permanecen en el archivo elegido y pueden enviarse a
   los hosts pertinentes durante la tarea.
4. Desactivar Brave o quitar la ruta evita el uso futuro de esa opción. No
   elimina cookies del perfil Brave, el archivo `.txt`, cookies del perfil
   WebView2 ni la caché de yt-dlp.

El consentimiento se guarda como preferencia, no se vuelve a pedir en cada
enlace. Revisa el dominio del contenido antes de usar una sesión autenticada.

## Solicitudes de red

- Las descargas HTTP, torrents y multimedia contactan el enlace que el usuario
  introduce o confirma, sus redirecciones y, para multimedia, los servicios,
  CDNs, trackers y peers requeridos por el sitio o metadatos. Esos destinos
  reciben la IP pública y los datos propios de la solicitud; cuando se habilitan
  cookies, se aplican las reglas descritas arriba.
- Las vistas previas y miniaturas usan YouTube, `i.ytimg.com`, TikTok,
  Instagram y Pinterest. El WebView carga el API de reproductor de YouTube y
  marcos remotos para los proveedores admitidos. Esos proveedores reciben
  solicitudes normales del navegador y pueden escribir datos en el perfil del
  WebView.
- La app consulta `raw.githubusercontent.com` para el feed de noticias y
  `api.github.com` para metadatos de versiones. Envía los validadores HTTP
  guardados cuando los reutiliza. El actualizador consulta el endpoint GitHub
  Releases configurado. El catálogo de herramientas declara
  `ozelot.github.io`; su consulta manual puede contactar ese host, aunque la
  lista de claves de confianza de producción está vacía y la verificación de
  manifiestos falla cerrada.
- yt-dlp puede descargar el componente remoto `ejs` desde GitHub cuando la
  extracción lo requiere.
- La extensión consulta `youtube.com/oembed` y `i.ytimg.com` al resolver enlaces
  de YouTube guardados. Envía URL/ID públicos del enlace para obtener sus
  metadatos.
- Los botones de ayuda abren sitios externos cuando el usuario los pulsa. El
  formulario de reporte abre GitHub con un título y cuerpo prellenados en la
  URL; abrirlo contacta GitHub y el usuario decide si envía el reporte.
- No se encontró una integración de analítica remota ni un endpoint de
  telemetría de producto en la fuente revisada. Este hallazgo estático no
  sustituye una captura de tráfico en runtime ni cubre comportamiento interno
  de componentes externos.

## Extensión del navegador

La extensión no declara el permiso `cookies`; la inspección de fuente no
encontró lectura de `document.cookie` ni llamadas a la API de cookies. Esto
describe solo la extensión y no la opción separada de cookies multimedia de la
app de escritorio.

Chrome/Edge `storage.local` conserva preferencias de captura y apariencia,
colecciones manuales de enlaces (URL, título y metadatos), el estado recibido
de la app y un journal de idempotencia. El estado recibido puede incluir hasta
80 trabajos, incluso URL de origen, destino, título, estado y progreso. Esa
copia y el archivo local del puente no se envían a un servicio de Clear en la
nube. Una selección confirmada o una captura automática habilitada se entrega
por Native Messaging al proceso local de Clear. Las páginas compatibles
también hacen solicitudes normales a sus propios proveedores.

No se encontró telemetría remota en el código de la extensión. Los elementos
guardados en `storage.local` y el estado del puente no se purgan por esta app al
cerrarla; se administran desde el perfil del navegador o la biblioteca local.

## Alcance de CSP

`connect-src` está limitado a IPC, `object-src` se niega y el protocolo de
assets tiene alcance vacío. `frame-src` enumera los proveedores que soportan
previsualización. `script-src` conserva YouTube para su API de reproductor;
`img-src` y `media-src` permiten HTTPS (y HTTP para medios) porque los
proveedores entregan miniaturas y streams desde hosts CDN variables. No se
estrecharon esas dos reglas: un allowlist fijo no quedó demostrado compatible
con la resolución actual de multimedia. Se mantiene como riesgo de superficie
documentado, no como una recomendación de abrir más orígenes.

## Límites de esta revisión

- No se examinó ningún perfil, cookie, archivo personal, base real ni contenido
  descargado del usuario.
- La persistencia de WebView2 se infiere de la configuración del proyecto y del
  comportamiento documentado del runtime; no se observó el UDF de esta máquina.
- No se capturó tráfico real; las solicitudes enumeradas se derivan de URLs y
  rutas de ejecución del código actual. Las rutas de proveedores multimedia
  cambian según el enlace.
- Este documento describe una revisión de fuente, no una política legal ni una
  promesa de que terceros nunca reciban datos necesarios para su servicio.

Referencias técnicas: [WebView2 user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder), [Tauri 2.11.6 WebView defaults](https://docs.rs/tauri/2.11.6/src/tauri/manager/webview.rs.html), [yt-dlp cookies.py 2026.08.19](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/cookies.py), [yt-dlp README 2026.08.19](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md).

