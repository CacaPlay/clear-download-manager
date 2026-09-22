import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const extensionCompatibility = JSON.parse(fs.readFileSync('extension/app-compat.json', 'utf8'));
const errors = [];
const requiredPermissions = ['activeTab', 'scripting', 'downloads', 'storage', 'sidePanel', 'nativeMessaging'];

const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const identity = JSON.parse(fs.readFileSync('evidence/official-public-key.json', 'utf8'));
const derivedId = [...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex').slice(0, 32)]
  .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join('');
if (identity.id !== publishedId || derivedId !== publishedId) errors.push('La clave pública de identidad no deriva el ID publicado');
const bridgeConfig = JSON.parse(fs.readFileSync('src-tauri/resources/extension/extension-config.json', 'utf8'));
if (bridgeConfig.chromiumExtensionIds?.[0] !== publishedId) errors.push('El ID publicado debe ser el primer origen Chromium');
const bridgeSource = fs.readFileSync('src-tauri/src/extension_bridge.rs', 'utf8');
if (!bridgeSource.includes(`PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`)) errors.push('El backend no fija el ID publicado de Chrome Web Store');
const registerScript = fs.readFileSync('scripts/register-extension-host-windows.ps1', 'utf8');
const chromiumHostTemplate = JSON.parse(fs.readFileSync('extension/native-host/chromium-host.template.json', 'utf8'));
if (!registerScript.includes(`[string]$ChromiumExtensionId = '${publishedId}'`)) errors.push('El registro manual no usa el ID publicado por defecto');
if (!registerScript.includes(`$PublishedId = '${publishedId}'`) || !registerScript.includes('$AllowedIds = @($PublishedId)')) errors.push('El registro manual puede reemplazar el ID publicado');
if (chromiumHostTemplate.allowed_origins?.[0] !== `chrome-extension://${publishedId}/`) errors.push('La plantilla Chromium no conserva el ID publicado');
if (manifest.manifest_version !== 3) errors.push('Manifest V2 no permitido');
if (Object.prototype.hasOwnProperty.call(manifest, 'minimumAppVersion') || Object.prototype.hasOwnProperty.call(manifest, 'maximumTestedAppVersion')) errors.push('El manifest contiene claves de compatibilidad no admitidas por Chrome');
if (extensionCompatibility.minimumAppVersion !== '0.24.1' || extensionCompatibility.maximumTestedAppVersion !== '0.95.x') errors.push('app-compat.json no conserva la compatibilidad de la serie 0.95.x');
if (!requiredPermissions.every((permission) => manifest.permissions.includes(permission))) errors.push('Faltan permisos básicos de la extensión');
const automaticDetectionMatches = ['https://*.youtube.com/*', 'https://youtu.be/*', 'https://*.spotify.com/*', 'https://*.pinterest.com/*', 'https://*.tiktok.com/*'];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(automaticDetectionMatches)) errors.push('Los host_permissions no coinciden con los cuatro dominios de detección automática');
if (manifest.permissions.includes('<all_urls>') || manifest.host_permissions?.includes('<all_urls>')) errors.push('No se permite <all_urls>');
if (!manifest.content_scripts?.some((entry) => entry.js?.includes('content/detector.js') && JSON.stringify(entry.matches) === JSON.stringify(automaticDetectionMatches))) errors.push('El content script persistente no coincide con los cuatro dominios de detección automática');
for (const file of ['service-worker.js', 'sidepanel.js', 'i18n.js', 'thumbnail-service.js', 'content/detector.js']) {
  if (!fs.existsSync(`extension/${file}`)) errors.push(`Falta extension/${file}`);
  const result = spawnSync(process.execPath, ['--check', `extension/${file}`], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(`JavaScript inválido: extension/${file}`);
}
const extensionBuild = fs.readFileSync('scripts/build-extension.ps1', 'utf8');
if (!extensionBuild.includes("'i18n.js'")) errors.push('El paquete de extensión no incluye extension/i18n.js');
const source = ['extension/service-worker.js', 'extension/sidepanel.js', 'extension/thumbnail-service.js', 'extension/content/detector.js'].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const pattern of [/document\.cookie/, /authorization/i, /password/i, /__dirname/, /https?:\/\/[^'"`]+\.js/]) {
  if (pattern.test(source)) errors.push(`Patrón no permitido en la extensión: ${pattern}`);
}
if (!fs.existsSync('extension/native-host/Cargo.lock')) errors.push('Falta lockfile del host nativo');
const worker = fs.readFileSync('extension/service-worker.js', 'utf8');
if (!worker.includes('function isAutomaticDetectionUrl') || !worker.includes('collectAutomatically') || !worker.includes('AUTOMATIC_DETECTION_DOMAINS')) errors.push('Falta el límite de detección automática por dominio');
// The real panel must not remain in its initial checking state when a worker
// or content detector stops answering. These are runtime-safety contracts,
// not relaxed assertions for the old harness.
const panel = fs.readFileSync('extension/sidepanel.js', 'utf8');
if (!panel.includes('RUNTIME_RESPONSE_TIMEOUT_MS') || !panel.includes('function sendRuntimeRequest')) errors.push('El panel no tiene límite para respuestas del runtime');
if (!panel.includes("$('#retry').addEventListener('click', () => void analyze())")) errors.push('Reintentar no vuelve a ejecutar el análisis de la pestaña');
if (!worker.includes('DETECTION_RESPONSE_TIMEOUT_MS') || !worker.includes('withTimeout(')) errors.push('El detector del worker puede quedar esperando indefinidamente');
if (!worker.includes('function youtubeUrlFallback') || !worker.includes('if (!detections.length) detections = youtubeUrlFallback')) errors.push('Falta el fallback de URL para vídeos YouTube');
// The capture timeout moved to the native host (CAPTURE_RESPONSE_TIMEOUT_MS).
// The old CAPTURE_TIMEOUT_MS worker token was a stale fixture expectation, not
// part of the current browser-capture contract.
for (const token of ['chrome.downloads.onCreated', 'chrome.downloads.onDeterminingFilename', 'chrome.downloads.onChanged', 'chrome.downloads.onErased', 'pause', 'resume', 'cancel', 'CAPTURE_ACCEPTED', 'CAPTURE_FALLBACK', 'browser_download_capture']) {
  if (!worker.includes(token)) errors.push(`Falta captura directa de descargas: ${token}`);
}
if (!worker.includes('openPanelOnActionClick: true')) errors.push('Chromium debe abrir el panel lateral nativamente desde el clic de la acción');
if (!worker.includes('appWindowIds.add(windowId)') || !worker.includes('enabled: false') || !worker.includes('if (appWindowIds.has(tab?.windowId))')) {
  errors.push('Las ventanas app deben evitar el panel nativo y conservar la vista alternativa');
}
if (!worker.includes('item.byExtensionId !== chrome.runtime.id')) errors.push('La extensión no respeta descargas iniciadas por otros gestores');
const captureBackend = fs.readFileSync('src-tauri/src/downloads/commands.rs', 'utf8');
if (!captureBackend.includes('"status": "review_opened"') || !captureBackend.includes('open_preparation_window')) errors.push('El modo de primer plano no abre la preparación HTTP');
const settings = fs.readFileSync('app-ui/modules/settings/index.js', 'utf8');
if (!settings.includes('data-settings-official-site')) errors.push('Falta el acceso al sitio oficial en Ajustes');
const nativeHost = fs.readFileSync('extension/native-host/src/main.rs', 'utf8');
for (const token of ['CAPTURE_RESPONSE_TIMEOUT_MS', '"temporary_failure"']) {
  if (!nativeHost.includes(token)) errors.push(`Falta estado de captura en el host nativo: ${token}`);
}
const nativeClient = fs.readFileSync('extension/sdk/cacatools-native-client.js', 'utf8');
if (!nativeClient.includes('captureDownload')) errors.push('Falta acción browser_download_capture en el cliente nativo');
const detector = fs.readFileSync('extension/content/detector.js', 'utf8');
for (const token of ['MutationObserver', 'ytInitialPlayerResponse', 'blob:', 'application/ld+json', 'popstate']) {
  if (!detector.includes(token)) errors.push(`Falta detección persistente de vídeo: ${token}`);
}
const moduleGate = spawnSync(process.execPath, ['scripts/validation/extension-module-graph.mjs'], { encoding: 'utf8' });
if (moduleGate.status !== 0) errors.push(`Grafo de módulos inválido:\n${moduleGate.stderr || moduleGate.stdout}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK: Manifest V3, permisos mínimos, detector y host nativo validados.');
