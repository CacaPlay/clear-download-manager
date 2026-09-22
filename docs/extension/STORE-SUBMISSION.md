# Ficha de Chrome Web Store 0.95.4

## Nombre

Clear Download Manager

## Descripción corta

Captura descargas HTTP/HTTPS normales y detecta videos, audio y playlists automáticamente en YouTube, Spotify, Pinterest y TikTok. En otros sitios, el usuario inicia la detección desde el panel.

## Justificación de permisos

- `host_permissions` y `content_scripts`: observar reproductores, metadatos públicos y navegación SPA automáticamente solo en YouTube, Spotify, Pinterest y TikTok.
- `activeTab`: interacción iniciada por el usuario en la pestaña activa.
- `scripting`: inyectar el detector bajo demanda en cualquier pestaña cuando el usuario abre el panel o solicita el análisis.
- `downloads`: observar descargas normales para ofrecer transferencia segura.
- `sidePanel`: interfaz persistente de selección.
- `storage`: preferencias del panel y modo de captura.
- `nativeMessaging`: enviar URLs y metadatos no sensibles a la aplicación instalada.

No se solicita `<all_urls>` ni acceso permanente a todos los sitios: solo se declaran los patrones HTTPS de esos cuatro servicios. No se capturan cookies, credenciales, tokens, cabeceras de autorización ni contenido DRM. Las descargas privadas, blobs, data URLs y actualizaciones del navegador continúan en Chrome/Edge.

## Publicación

Genera el paquete con `npm.cmd run extension:build` y súbelo desde el panel de
desarrollador. Añade las capturas requeridas y enlaza `PRIVACY.md`
como política pública. La aplicación no reemplaza una copia instalada desde la
Web Store.

## Enlaces públicos

- Release público de la aplicación: `https://github.com/CacaPlay/clear-download-manager/releases/latest`
- La extensión se distribuye exclusivamente mediante Chrome Web Store; el ZIP
  local se usa solo para actualizar la ficha existente.

El `homepage_url` del manifest apunta al release de la aplicación para que el
usuario pueda instalar Clear Download Manager desde la ficha de la extensión.
