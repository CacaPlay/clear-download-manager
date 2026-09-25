import fs from 'node:fs';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const read = (file) => fs.readFileSync(file, 'utf8');
const files = {
  packageJson: JSON.parse(read('package.json')),
  main: readFrontendSource('.js'),
  appCss: readFrontendSource('.css'),
  dmConstants: read('app-ui/download-manager/core/constants.js'),
  dmModel: read('app-ui/download-manager/core/model.js'),
  dmIndex: read('app-ui/download-manager/index.js'),
  dmShared: read('app-ui/download-manager/view/shared.js'),
  dmZen: read('app-ui/download-manager/view/zen-sidebar.js'),
  dmCss: read('app-ui/download-manager/styles.css'),
  sidepanelHtml: read('extension/sidepanel.html'),
  sidepanel: read('extension/sidepanel.js'),
  sidepanelCss: read('extension/sidepanel.css'),
  worker: read('extension/service-worker.js'),
  host: read('extension/native-host/src/main.rs'),
  bridge: read('src-tauri/src/extension_bridge.rs'),
  rust: fs.readdirSync('src-tauri/src', { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
    .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
    .join('\n'),
  bridgeConfig: read('src-tauri/resources/extension/extension-config.json'),
  extensionBuild: read('scripts/build-extension.ps1')
};

const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const checks = [
  ['Escala manual normalizada de 50 a 130 en pasos de 5', files.main.includes('type="number" min="50" max="130" step="5"') && files.dmShared.includes('type="number" min="50" max="130" step="5"')],
  ['La migración convierte 125 histórico en 100 sin cambiar el tamaño visual', files.main.includes('LEGACY_UI_OFFSET = 25') && files.main.includes('legacyEquivalentScale = displayedScale + LEGACY_UI_OFFSET')],
  ['La escala automática devuelve porcentajes normalizados', files.main.includes('const scale = Math.min(displayScale, heightFitCap, widthFitCap);') && files.main.includes('displayedScalePercent(scale - LEGACY_UI_OFFSET)')],
  ['El tamaño de texto es independiente y persistente', files.main.includes('textScale: Math.round(clamp') && files.main.includes("'#text-scale-range'") && files.appCss.includes('--text-scale')],
  ['Densidad y miniaturas tienen controles reales', files.main.includes('density-select') && files.main.includes('thumbnail-size-select') && files.main.includes('--thumbnail-scale')],
  ['La reducción de movimiento se aplica sin reiniciar', files.main.includes("'#motion-toggle'") && files.main.includes('root.dataset.motion = appearance.motion') && files.appCss.includes('html[data-motion="off"]')],
  ['Los ajustes se guardan automáticamente', files.main.includes('scheduleAppearancePersist') && files.main.includes('Los cambios se guardan automáticamente')],
  ['El layout de Ajustes responde a ventanas estrechas', files.appCss.includes('@media(max-width:1080px)') && files.appCss.includes('.settings-layout')],
  ['El gestor usa la escala normalizada y revisión actual', files.dmModel.includes('clampNumber(value.uiScale, 50, 130)') && files.dmModel.includes('appearanceRevision: 8') && files.dmConstants.includes('appearanceRevision: 8')],
  ['Rust valida escala y texto en pasos de 5', files.rust.includes('!self.scale.is_multiple_of(5)') && files.rust.includes('!self.text_scale.is_multiple_of(5)')],
  ['La app publica apariencia, cola y trabajos para la extensión', files.main.includes('function extensionStatePayload()') && files.main.includes("invoke('publish_extension_state'") && files.bridge.includes('pub fn publish_extension_state')],
  ['El estado sincronizado tiene escritura limitada y reemplazable', files.bridge.includes('MAX_STATE_BYTES') && files.bridge.includes('extension-state.json') && files.bridge.includes('fs::remove_file(&final_path)')],
  ['La extensión consulta y conserva el estado de la app', files.worker.includes('GET_APP_STATUS') && files.worker.includes('APP_STATE_POLL_MS') && files.sidepanel.includes('lastAppState')],
  ['El panel de descargas refleja trabajos de la app', files.sidepanelHtml.includes('data-panel="downloads"') && files.sidepanel.includes('function renderDownloads()') && files.sidepanelCss.includes('.download-progress')],
  ['Las descargas compactas conservan miniatura, estado y progreso', files.sidepanel.includes('download-thumb') && files.sidepanel.includes('download-state') && files.sidepanel.includes('download-progress') && files.sidepanelCss.includes('aspect-ratio:16/9')],
  ['El panel de descargas puede ocultarse', files.sidepanelHtml.includes('data-toggle-panel="downloads"') && files.sidepanel.includes("['downloads', 'links']")],
  ['El panel de enlaces puede ocultarse', files.sidepanelHtml.includes('data-toggle-panel="links"') && files.sidepanel.includes('extensionPanels')],
  ['Los enlaces se pegan manualmente, sin vigilancia del portapapeles', files.sidepanelHtml.includes('manual-links-input') && files.sidepanel.includes("addEventListener('paste'") && !files.sidepanel.includes('navigator.clipboard.readText') && !files.sidepanelHtml.includes('Detectar enlaces copiados')],
  ['El primer enlace ofrece crear una playlist', files.sidepanel.includes("window.confirm('¿Crear playlist?") && files.sidepanel.includes("window.prompt('Nombre de la playlist'")],
  ['Las playlists manuales reciben enlaces hasta salir o cambiar', files.sidepanel.includes('activeManualCollectionId') && files.sidepanel.includes('currentCollection()?.links || state.looseLinks') && files.sidepanelHtml.includes('leave-collection')],
  ['Se pueden crear varias carpetas y cambiar entre ellas', files.sidepanel.includes('manualLinkCollections') && files.sidepanel.includes('collection-select') && files.sidepanel.includes('new-collection')],
  ['Las colecciones pueden enviarse como playlist', files.sidepanel.includes('manualPlaylist: Boolean') && files.sidepanel.includes('playlistTitle') && files.worker.includes('manualPlaylist: Boolean')],
  ['La app puede permanecer en segundo plano o abrirse al frente', files.sidepanelHtml.includes('Mantener app en segundo plano') && files.sidepanelHtml.includes('Abrir app en primer plano') && files.worker.includes('windowMode: requestedWindowMode')],
  ['El host inicia silenciosamente solo cuando se solicita', files.host.includes('fn launch_app(background: bool)') && files.host.includes('command.arg("--background-startup")') && files.bridge.includes('fn ensure_app_running(background: bool)')],
  ['La captura aceptada no fuerza siempre la app al frente', !files.worker.includes("publish({ type: 'CAPTURE_ACCEPTED', item: capture, response });\n      await cacaToolsNative.open()")],
  ['La apariencia sigue a CacaTools o permite personalización', files.sidepanelHtml.includes('Seguir CacaTools') && files.sidepanelHtml.includes('Personalizada') && files.sidepanel.includes("state.appearanceMode === 'follow-app'")],
  ['La actualización de extensión aparece solo con evento real de Chrome', files.worker.includes('chrome.runtime.onUpdateAvailable') && files.sidepanelHtml.includes('id="extension-update"') && files.sidepanelHtml.includes('hidden') && !files.worker.includes('requestUpdateCheck')],
  ['La app muestra progreso visible durante la actualización', files.dmShared.includes('dm-update-progress') && files.dmCss.includes('@keyframes dm-update-travel') && files.dmZen.includes('dm-update-entry')],
  ['El botón de actualización conserva tamaño fijo y no se recorta al pasar el cursor', files.dmCss.includes('.dm-update-entry:hover') && files.dmCss.includes('max-width:2.8rem!important') && files.dmCss.includes('.dm-update-entry span{display:none!important}')],
  ['El ID publicado permanece fijo y prioritario', files.bridge.includes(`PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`) && files.bridgeConfig.includes(publishedId)],
  ['El ZIP de Chrome Store excluye código nativo y documentación', files.extensionBuild.includes('$RuntimeFiles = @(') && files.extensionBuild.includes("'thumbnail-service.js'") && !files.extensionBuild.includes('robocopy $Source $Destination')],
  ['Las capturas HTTP directas usan ambos puentes nativos', files.host.includes('browser_download_capture') && files.bridge.includes('browser_download_capture') && files.worker.includes('captureDownload')]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.1-fase-4-ajustes-extension',
  version: files.packageJson.version,
  publishedExtensionId: publishedId,
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-settings-extension.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 4 valida ${checks.length} condiciones de Ajustes y extensión sincronizada.`);
