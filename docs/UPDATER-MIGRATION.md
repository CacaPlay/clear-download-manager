# Migración del actualizador

## Repositorios y compatibilidad

Desde la versión 0.95.3, Clear Download Manager consulta el canal de releases
del repositorio principal `CacaPlay/clear-download-manager`. La versión 0.95.4
es el primer release publicado allí.

Para conservar compatibilidad con los clientes antiguos, el repositorio
público de releases se renombró a `CacaPlay/cacatools-download-manager-releases`.
GitHub redirige el nombre público anterior a este repositorio. Así se conserva
el endpoint que tienen incorporado los instaladores 0.95.1-build4 y anteriores
que apuntan a ese slug.

El repositorio privado que tenía el mismo slug necesario para ese endpoint se
renombró a `CacaPlay/cacatools-download-manager-releases-private-archive` y
permanece privado, con su historial de releases intacto. No eliminarlo ni
cambiar su visibilidad.

La estrategia para cada nueva versión es:

1. Publicar la versión firmada y sus artefactos en `CacaPlay/clear-download-manager`.
2. Copiar el `latest.json` de esa release a una release puente de la misma
   versión en `CacaPlay/cacatools-download-manager-releases`. El catálogo sigue
   apuntando al artefacto firmado del repositorio principal.
3. Comprobar ambos endpoints, la firma y la descarga antes de dar por terminada
   la migración.

No se cambia la clave de firma. El release puente solo permite que las
instalaciones antiguas descubran la actualización; no requiere recompilar el
instalador antiguo. Las instalaciones 0.95.3 y posteriores actualizan desde el
repositorio principal.

## Feed de novedades

Los builds nuevos leen `news.json` desde la raíz de `main` en
`CacaPlay/clear-download-manager`. El feed se valida aparte del catálogo
firmado del actualizador y no sustituye la comprobación de la firma de la
actualización.

## Estado de esta transición — 2026-09-22

- La release principal 0.95.4 está publicada en
  `https://github.com/CacaPlay/clear-download-manager/releases/tag/v0.95.4`.
  Incluye instalador NSIS, firma Tauri, `latest.json` y `SHA256SUMS.txt`.
- La release puente 0.95.4 está publicada en
  `https://github.com/CacaPlay/cacatools-download-manager-releases/releases/tag/v0.95.4`.
  Su `latest.json` es una copia byte por byte del catálogo principal y apunta
  al instalador firmado del repositorio principal; no duplica el instalador.
- Se comprobó que el endpoint del repo principal, el endpoint legacy y el
  nombre público anterior `clear-download-manager-releases` entregan versión
  0.95.4. El URL del instalador del catálogo responde HTTP 200.
- El archivo privado histórico permanece privado como
  `CacaPlay/cacatools-download-manager-releases-private-archive`.
- El instalador 0.95.4 pesa 116,941,840 bytes; el anterior instalador 0.95.1
  pesaba 114,229,164 bytes. El aumento es de 2,712,676 bytes (aprox. 2.6 MB).
- La configuración de Tauri, el paquete Cargo y la extensión se alinean en
  versión 0.95.4.
- El usuario validó la extensión en Brave y confirma que funciona plenamente,
  sin fallos y como esperaba. También considera que la auditoría de textos en
  inglés está bastante bien.
- El usuario no ha podido validar visualmente la barra de progreso del updater
  porque aún no ha tenido una actualización disponible para instalar.
- `version:check`, `check:release` (26 contratos), `check:extension`,
  `check:extension-ui`, `build:web`, `verify:binaries` y `git diff --check`
  pasaron en la revisión previa de 0.95.3. `check:media-e2e` no terminó con un
  estado E2E, así que no se cuenta como aprobado ni como regresión confirmada.
- FFmpeg/FFprobe 9.0.2 y Deno 2.9.7 quedaron preparados; aria2 sigue en 1.37.0
  y yt-dlp en 2026.08.19. Los hashes de binarios se verificaron. El tamaño
  empaquetado debe registrarse desde el artefacto de release.
- Los secretos de firma Tauri están configurados en GitHub Actions. La clave
  privada no se copia al repositorio, no se busca en el disco y no se cambia.
- Los workflows de GitHub completaron versión/fuente, Rust, build firmado y
  verificación de endpoint con éxito. En local pasaron `version:check`, el
  gate `check:release` (26 contratos), extensión, i18n, build web, verificación
  de binarios/manifiesto, `cargo check`, `cargo test --lib` (375 pasaron, 2
  ignorados), Clippy y formato.
- Se verificó la continuidad de los metadatos y la disponibilidad HTTP, pero
  no se ejecutó una actualización interactiva desde una instalación 0.95.1 ni
  desde 0.45.0. Esa última comprobación depende de una instalación Windows
  real; no se afirma aquí como probada.
