# Instalar la extensión de Clear Download Manager (Chrome/Edge)

La extensión usa Manifest V3, captura directa de descargas, detección persistente
de vídeo/audio, un panel lateral y Native Messaging. Detecta automáticamente en
YouTube, Pinterest y TikTok; en otros sitios analiza la pestaña solo
cuando el usuario abre el panel o solicita la detección.

## Prueba local para principiantes

1. Ejecuta `npm.cmd run extension:build` en la carpeta del proyecto. Se crea
   un paquete local; el ZIP y `extension-dist` son artefactos temporales y no se suben al
   repositorio.
2. Abre `chrome://extensions` (en Edge: `edge://extensions`) y activa
   **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta `extension` del
   proyecto. Para probar el paquete generado, descomprímelo primero.
4. La extensión publicada usa siempre el ID fijo
   `aonppfnabjnicjjeoofkfjofolfibggp`. La aplicación lo registra de forma
   automática y nunca debe sustituirse por otro ID.
5. Para una prueba local con una extensión desempaquetada, puedes añadir
   temporalmente su ID con `CONFIGURAR_EXTENSION_WINDOWS.cmd
   -ChromiumExtensionIds aonppfnabjnicjjeoofkfjofolfibggp,<ID_LOCAL>`. El ID
   publicado seguirá incluido y tendrá prioridad.
6. Abre una página con vídeo, audio o playlist, pulsa el icono de Clear Download Manager y
   abre el panel lateral. En YouTube, Pinterest y TikTok la detección
   es automática; en otros sitios abre el panel o pulsa **Actualizar detección**.
   Selecciona elementos y pulsa **Enviar**.

7. Las descargas normales de Chrome/Edge se capturan automáticamente aunque el panel esté cerrado. La extensión las pausa durante un máximo de 3 segundos; solo las cancela después de recibir `accepted` desde Clear Download Manager. Si CDM no responde, la descarga se reanuda en el navegador.

   Puedes cambiar el modo en el panel: **Automático**, **Avisar sin transferir** o **Desactivado**.

Si el panel dice **Host no instalado**, comprueba que la aplicación esté
instalada y que el ID de Chrome coincida exactamente. La extensión nunca
instala archivos silenciosamente.

## Qué permisos se usan

`host_permissions` y el content script detectan reproductores y metadatos
públicos automáticamente solo en YouTube, Pinterest y TikTok;
`activeTab` y `scripting` cubren el análisis interactivo de cualquier pestaña;
`storage` guarda preferencias locales;
`sidePanel` muestra el panel; y
   `nativeMessaging` comunica la selección con Clear Download Manager. No se leen cookies,
contraseñas, tokens, cabeceras ni URLs `blob:` como descargas finales.

Para publicar en Chrome Web Store usa el ZIP, `STORE-SUBMISSION.md`
y `PRIVACY.md`. Chrome gestionará las actualizaciones de una
extensión publicada; el ZIP local se recarga manualmente.
