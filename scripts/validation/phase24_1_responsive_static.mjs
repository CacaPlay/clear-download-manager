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
const json = (file) => JSON.parse(read(file));
const downloadManagerCss = fs.readdirSync('app-ui/download-manager/styles', { recursive: true })
  .filter((file) => file.endsWith('.css'))
  .sort((a, b) => a.localeCompare(b))
  .map((file) => read(`app-ui/download-manager/styles/${file}`))
  .join('\n');
const files = {
  main: readFrontendSource('.js'),
  settings: read('app-ui/modules/settings/index.js'),
  appearance: read('app-ui/modules/appearance/index.js'),
  appearanceTokens: read('app-ui/modules/appearance/tokens.js'),
  dmIndex: read('app-ui/download-manager/index.js'),
  dmCss: downloadManagerCss,
  dmView: read('app-ui/download-manager/view/unified.js'),
  tauri: json('src-tauri/tauri.conf.json'),
  extensionHtml: read('extension/sidepanel.html'),
  extensionCss: read('extension/sidepanel.css'),
  extensionJs: read('extension/sidepanel.js'),
  worker: read('extension/service-worker.js'),
  manifest: json('extension/manifest.json')
};
const win = files.tauri.app.windows.find((entry) => entry.label === 'main');
const permissions = [...(files.manifest.permissions || [])].sort();
const expectedPermissions = ['activeTab', 'contextMenus', 'downloads', 'nativeMessaging', 'scripting', 'sidePanel', 'storage'].sort();
const densityRulesAreComplete = ['compact', 'balanced', 'spacious'].every((value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spacingRule = files.dmCss.match(new RegExp(`\\.dm-host\\[data-dm-density="${escaped}"\\]\\s*\\{([^}]*)\\}`));
  const rowHeightRule = new RegExp(`\\.dm-host\\[data-dm-density="${escaped}"\\]\\s+\\.dm-download-item\\s*\\{[^}]*min-height\\s*:`).test(files.dmCss);
  return spacingRule && /--dm-download-list-gap\s*:/.test(spacingRule[1]) && /--dm-row-min-height\s*:/.test(spacingRule[1]) && rowHeightRule;
});
const checks = [
  ['Los mínimos y dimensiones iniciales de la ventana son válidos', Number.isInteger(win?.width) && Number.isInteger(win?.height) && Number.isInteger(win?.minWidth) && Number.isInteger(win?.minHeight) && win.minWidth > 0 && win.minHeight > 0 && win.minWidth <= win.width && win.minHeight <= win.height],
  ['La densidad ofrece las tres opciones actuales', ["['compact', 'Compacta']", "['balanced', 'Equilibrada']", "['spacious', 'Amplia']"].every((option) => files.settings.includes(option))],
  ['Las densidades históricas migran a los valores actuales', files.appearance.includes("raw.density === 'balanced' ? 'normal'") && files.appearance.includes("density: raw.density === 'normal' ? 'balanced' : raw.density") && /APPEARANCE_REVISION\s*=\s*\d+/.test(files.appearanceTokens)],
  ['La densidad global llega al Centro de descargas', files.main.includes('appearanceDensity: appState.appearance.density') && files.dmIndex.includes('data-dm-density="${density}"')],
  ['Cada densidad define separación y altura propias', densityRulesAreComplete],
  ['La fila normal tiene respiración inferior adicional', files.dmCss.includes('--dm-row-padding-block:.76rem') && files.dmCss.includes('padding-bottom:.66rem')],
  ['El estado conserva texto accesible y puede reducirse visualmente', files.dmView.includes('aria-label="${escapeHtml(statusText)}"') && /@container\s+download-center\s*\(max-width:\s*560px\)/.test(files.dmCss) && /\.dm-item-status span\s*\{[^}]*position:\s*absolute/.test(files.dmCss)],
  ['El responsive continúa usando container queries', files.dmCss.includes('container-name:download-center') && files.dmCss.includes('@container download-center')],
  ['La extensión distingue app cerrada de puente ausente', files.extensionJs.includes("connected ? 'Disponible' : sleeping ? 'App cerrada' : 'No disponible'")],
  ['El estado de la extensión conserva tres estados semánticos', files.extensionCss.includes('.status::before') && files.extensionCss.includes('data-state="connected"') && files.extensionCss.includes('data-state="sleeping"') && files.extensionCss.includes('data-state="offline"')],
  ['En anchura estrecha la extensión oculta solo el texto del estado', files.extensionCss.includes('@media(max-width:390px)') && files.extensionCss.includes('font-size:0')],
  ['El service worker configura el panel también al arrancar', files.worker.includes('void configureSidePanel();') && files.worker.includes('openPanelOnActionClick: true')],
  ['El clic del icono usa el panel nativo y conserva fallback para ventanas app', files.worker.includes('chrome.action.onClicked.addListener') && files.worker.includes('openPanelOnActionClick: true') && files.worker.includes('void openExtensionPopup(tab)') && files.worker.includes('chrome.windows?.create?.')],
  ['Manifest V3 declara solo los permisos funcionales actuales', files.manifest.manifest_version === 3 && JSON.stringify(permissions) === JSON.stringify(expectedPermissions)],
  ['No se añadió popup que compita con el panel lateral', !files.manifest.action?.default_popup && files.manifest.side_panel?.default_path === 'sidepanel.html']
];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-responsive-static.json', `${JSON.stringify({ phase: '0.24.1-fase-7-responsive', checks: checks.length, failures, generatedAt: new Date().toISOString() }, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 7 valida ${checks.length} condiciones responsive y de apertura de extensión.`);
