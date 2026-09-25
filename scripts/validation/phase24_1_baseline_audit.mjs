import fs from 'node:fs';
import path from 'node:path';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const ROOT = process.cwd();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const json = (relative) => JSON.parse(read(relative));
const checks = [];
const risks = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail });
}
function risk(id, detected, detail) {
  risks.push({ id, detected: Boolean(detected), detail });
}

const packageJson = json('package.json');
const tauriConfig = json('src-tauri/tauri.conf.json');
const extensionManifest = json('extension/manifest.json');
const cargoToml = read('src-tauri/Cargo.toml');
const nativeCargo = read('extension/native-host/Cargo.toml');
const main = readFrontendSource('.js');
const downloadIndex = read('app-ui/download-manager/index.js');
const downloadModel = read('app-ui/download-manager/core/model.js');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => read(path.join('src-tauri/src', file)))
  .join('\n');
const extensionWorker = read('extension/service-worker.js');
const extensionConfig = json('src-tauri/resources/extension/extension-config.json');

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || '';
const nativeVersion = nativeCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || '';
const versions = {
  package: packageJson.version,
  tauri: tauriConfig.version,
  rust: cargoVersion,
  extension: extensionManifest.version,
  nativeHost: nativeVersion,
};

check('La versión final está sincronizada en 0.24.1 sobre la base auditada 0.24.0', Object.values(versions).every((value) => value === '0.24.1'), versions);
check('Zen Sidebar es el único layout ejecutable', downloadIndex.includes('renderZenSidebar(sharedContext)') && downloadModel.includes("const layout = 'zen-sidebar'"), 'index.js + core/model.js');
check('Command Center no existe como módulo ejecutable', !exists('app-ui/download-manager/view/command-center.js'), 'view/command-center.js ausente');
check('El código principal de la aplicación está presente', ['app-ui/main.js', 'app-ui/download-manager/index.js', 'src-tauri/src/lib.rs'].every(exists), 'frontend + gestor + Rust');
check('La extensión y Native Messaging están presentes', ['extension/manifest.json', 'extension/service-worker.js', 'extension/native-host/src/main.rs'].every(exists), 'Manifest V3 + host nativo');
check('Los archivos de bloqueo están presentes', ['package-lock.json', 'src-tauri/Cargo.lock'].every(exists), 'npm + Cargo lock');
check('El ID publicado de Chrome permanece fijo', extensionConfig.chromiumExtensionIds?.[0] === 'aonppfnabjnicjjeoofkfjofolfibggp', extensionConfig.chromiumExtensionIds);

risk('spotify-activo', main.includes("invoke('resolve_spotify_source'") && rust.includes('fn resolve_spotify_source') && rust.includes('fn queue_spotify_download'), 'Spotify conserva rutas activas dedicadas en frontend y backend.');
risk('extension-no-fuerza-todas', main.includes('processExtensionBridgeRequests') && !main.includes('forceDownloadManagerAllView'), 'El bridge abre Descargas, pero no fuerza filtro y categoría a all.');
risk('desconocido-como-documento', /fn recent_kind_from_path[\s\S]*?_\s*=>\s*"doc"/.test(rust), 'El clasificador Rust usa doc como fallback para extensiones desconocidas.');
risk('zip-sin-content-disposition', !rust.includes('CONTENT_DISPOSITION') || !rust.includes('resolve_download_filename'), 'El worker no contiene recuperación de nombre mediante Content-Disposition.');
risk('cierre-a-bandeja-fijo', rust.includes('api.prevent_close()') && rust.includes('let _ = window.hide()') && !rust.includes('save_window_behavior_settings'), 'El cierre de ventana se intercepta y oculta sin una política completa configurable.');
risk('escala-inconsistente', /min="70"[^>]*max="150"[^>]*step="2"/.test(main), 'El control frontend usa pasos de 2 y límites distintos del backend.');
risk('validadores-command-center-heredados', exists('scripts/validation/phase19_ui_static.mjs') && read('scripts/validation/phase19_ui_static.mjs').includes('command-center.js'), 'Persisten validadores históricos no invocados que hacen referencia a Command Center.');
risk('captura-extension-ausente', !extensionWorker.includes('browser_download_capture'), 'La captura del navegador se perdió durante la corrección de nombres.');

const report = {
  gate: 'phase24.1-baseline-audit',
  passed: checks.every((item) => item.pass),
  versions,
  checks,
  risks,
};

const output = path.join(ROOT, 'docs/tests/phase24-1-baseline-audit.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

for (const item of checks) {
  console.log(`${item.pass ? 'OK' : 'FAIL'}: ${item.name}`);
}
for (const item of risks.filter((entry) => entry.detected)) {
  console.log(`DEUDA ${item.id}: ${item.detail}`);
}
if (!report.passed) process.exit(1);
console.log(`OK: auditoría base 0.24.1 registrada en ${path.relative(ROOT, output)}`);
