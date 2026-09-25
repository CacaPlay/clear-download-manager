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
  dmIndex: read('app-ui/download-manager/index.js'),
  dmCss: read('app-ui/download-manager/styles.css'),
  sidepanelHtml: read('extension/sidepanel.html'),
  sidepanel: read('extension/sidepanel.js'),
  sidepanelCss: read('extension/sidepanel.css'),
  worker: read('extension/service-worker.js'),
  detector: read('extension/content/detector.js'),
  manifest: JSON.parse(read('extension/manifest.json')),
  rust: fs.readdirSync('src-tauri/src', { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
    .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
    .join('\n'),
  bridge: read('src-tauri/src/extension_bridge.rs'),
  bridgeConfig: read('src-tauri/resources/extension/extension-config.json')
};

const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const detectedIndex = files.sidepanelHtml.indexOf('class="detected-panel primary-section"');
const downloadsIndex = files.sidepanelHtml.indexOf('data-panel="downloads"');
const linksIndex = files.sidepanelHtml.indexOf('data-panel="links"');
const checks = [
  ['Contenido detectado aparece antes que descargas y enlaces', detectedIndex > -1 && detectedIndex < downloadsIndex && detectedIndex < linksIndex],
  ['Contenido detectado está marcado como sección principal', files.sidepanelHtml.includes('primary-section') && files.sidepanelHtml.includes('PESTAÑA ACTUAL')],
  ['Modo claro usa colores semánticos de alto contraste', files.sidepanelCss.includes('body[data-theme="light"]{--warning:#7a4b00;--success:#005a34;--danger:#a91f35}')],
  ['El acento calcula tinta y detalle legibles', files.sidepanel.includes('relativeLuminance') && files.sidepanel.includes('readableAccent') && files.sidepanel.includes("--accent-ink") && files.sidepanel.includes("--accent-detail")],
  ['Los botones rellenos usan tinta dinámica', files.sidepanelCss.includes('color:var(--accent-ink)') && files.dmCss.includes('var(--dm-accent-ink)')],
  ['El gestor calcula contraste según tema y luminosidad', files.dmIndex.includes('dmAccentPresentation') && files.dmIndex.includes('--dm-accent-detail') && files.dmIndex.includes('--dm-accent-ink')],
  ['La extensión sigue el tema y acento reales del gestor', files.main.includes('const managerAppearance = downloadManagerVisualPreferences()') && files.main.includes('theme: managerAppearance.theme') && files.main.includes('accent: managerAppearance.accent')],
  ['El icono de marca de la extensión no añade marco verde', files.sidepanelCss.includes('.brand-mark') && files.sidepanelCss.includes('border:0') && files.sidepanelCss.includes('background:transparent') && files.dmCss.includes('--dm-icon-surface')],
  ['Los iconos de archivos no se rellenan con el color principal', files.dmCss.includes('.dm-job-file[class*="file-"],.dm-file-glyph[class*="file-"]{background:var(--dm-icon-surface)!important}')],
  ['Categorías usan superficie verde fija y borde de acento', files.dmCss.includes('--dm-section-selected') && files.dmCss.includes('.dm-filter.is-active') && files.dmCss.includes('border-color:var(--dm-accent)!important')],
  ['Filas seleccionadas usan superficie fija, no relleno masivo del acento', files.dmCss.includes('.dm-download-item.is-selected') && files.dmCss.includes('background:var(--dm-section-selected)!important')],
  ['Descargas compactas conservan miniatura 16:9, estado y barra', files.sidepanelCss.includes('.download-row') && files.sidepanelCss.includes('aspect-ratio:16/9') && files.sidepanel.includes('download-progress')],
  ['Enlaces manuales muestran miniatura pequeña y título', files.sidepanelCss.includes('.manual-link-thumb') && files.sidepanel.includes('entry.thumbnail') && files.sidepanel.includes('entry.title')],
  ['Los metadatos manuales se resuelven sin código remoto', files.sidepanel.includes('RESOLVE_LINK_METADATA') && files.worker.includes('resolveLinkMetadata') && files.worker.includes('www.youtube.com/oembed')],
  ['La detección reintenta para páginas dinámicas', files.worker.includes('for (const wait of [0, 320, 780])') && files.worker.includes('detectionQuality')],
  ['YouTube SPA vuelve a detectar tras navegación y metadatos', files.detector.includes('yt-navigate-finish') && files.detector.includes('yt-page-data-updated') && files.detector.includes('loadedmetadata')],
  ['La detección de YouTube usa título, canal, duración y miniaturas de calidad', files.detector.includes('ytd-watch-metadata h1') && files.detector.includes('ytd-channel-name a') && files.detector.includes('maxresdefault.jpg')],
  ['Primer plano restaura y eleva temporalmente la app', files.rust.includes('window.set_always_on_top(true)') && files.rust.includes('window.set_always_on_top(false)') && files.main.includes('async function forceExtensionForeground()')],
  ['Primer plano vuelve a enfocar tras renderizar', files.main.includes("await new Promise((resolve) => window.setTimeout(resolve, 90));") && (files.main.match(/invoke\('wake_main_window'\)/g) || []).length >= 2],
  ['Segundo plano no fuerza foco en captura del navegador', files.rust.includes('if foreground && response.get("status")') && files.rust.includes('.get("windowMode")')],
  ['Una playlist foreground se encola sin abrir renderer legacy', files.main.includes("open_preparation_window") && !files.main.includes('prepareLocalDownloadWorkspace') && !files.main.includes('workspaceMarkup')],
  ['Manifest V3 y CSP local permanecen intactos', files.manifest.manifest_version === 3 && files.manifest.content_security_policy?.extension_pages === "script-src 'self'; object-src 'self'"],
  ['No se añadieron scripts inline ni código remoto', !files.sidepanelHtml.match(/<script(?![^>]*src=)[^>]*>/i) && !files.worker.includes('eval(') && !files.detector.includes('eval(')],
  ['No se añadieron permisos nuevos innecesarios', JSON.stringify(files.manifest.permissions) === JSON.stringify(['activeTab','scripting','downloads','storage','sidePanel','nativeMessaging'])],
  ['El ID publicado permanece fijo', files.bridge.includes(`PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`) && files.bridgeConfig.includes(publishedId)]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.1-fase-5-sistema-visual-deteccion',
  version: files.packageJson.version,
  publishedExtensionId: publishedId,
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-visual-system-extension.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 5 valida ${checks.length} condiciones visuales, de detección y primer plano.`);
