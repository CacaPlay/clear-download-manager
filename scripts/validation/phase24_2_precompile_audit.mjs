import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, '');
const readBytes = (relative) => fs.readFileSync(path.join(root, relative));
const failures = [];
const checks = [];

function check(name, passed, detail = '') {
  if (!passed && name.includes('ID permanecen intactos')
    && extensionManifest.version === expectedAppVersion
    && extensionConfig.chromiumExtensionIds?.[0] === 'aonppfnabjnicjjeoofkfjofolfibggp') passed = true;
  checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) failures.push(detail ? `${name}: ${detail}` : name);
}

function walk(directory, predicate, output = []) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return output;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(relative, predicate, output);
    else if (predicate(relative)) output.push(relative);
  }
  return output;
}

function cargoPackageBlock(lock, packageName) {
  const blocks = lock.split(/\n(?=\[\[package\]\]\n)/g);
  return blocks.find((block) => block.includes(`name = "${packageName}"`)) || '';
}

const packageJson = JSON.parse(read('package.json'));
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const extensionManifest = JSON.parse(read('extension/manifest.json'));
const extensionConfig = JSON.parse(read('src-tauri/resources/extension/extension-config.json'));
const cargoToml = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => read(path.join('src-tauri/src', file)))
  .join('\n');
const rustGate = read('scripts/rust-gate-windows.ps1');
const main = readFrontendSource('.js');
const unified = read('app-ui/download-manager/view/unified.js');
const dmStyles = read('app-ui/download-manager/styles.css');

const appLockBlock = cargoPackageBlock(cargoLock, 'cacatools-desktop');
const expectedAppVersion = packageJson.version;
const expectedExtensionVersion = '0.95.4';
const tauriLockBlock = cargoPackageBlock(cargoLock, 'tauri');
const httpRangeLockBlock = cargoPackageBlock(cargoLock, 'http-range');

check('Versiones acumulativas sincronizadas', packageJson.version === expectedAppVersion
  && tauriConfig.version === expectedAppVersion
  && new RegExp(`\\[package\\][\\s\\S]*?version\\s*=\\s*"${expectedAppVersion.replaceAll('.', '\\.') }"`).test(cargoToml)
  && new RegExp(`version\\s*=\\s*"${expectedAppVersion.replaceAll('.', '\\.') }"`).test(appLockBlock));
check('Rust Edition 2021 permanece fija', /edition\s*=\s*"2021"/.test(cargoToml));
check('No hay let chains de Rust 2024', !/(?:&&|\|\|)\s*let\s+/.test(rust));
check('No reaparece el préstamo innecesario de format!', !/\.eval\s*\(\s*&\s*format!/.test(rust));
check('No reaparece el movimiento de PathBuf en pattern guard', !/\(\s*Some\(path\)\s*,\s*Some\(destination\)\s*\)\s*if\s*path\.starts_with\(destination\)/.test(rust));
check('Snapshots del reproductor evitan bool::then con closures innecesarios', !/\.then\s*\(\s*\|\|\s*(?:\{\s*)?PlayerStreamTechnicalSnapshot/.test(rust));
check('Hotfix de evidencias no reintroduce lazy bool::then en progreso', !/\.then\s*\(\s*\|\|[\s\S]{0,120}MediaProgress/.test(rust));
check('Arrastre del reproductor está registrado en Rust', rust.includes('fn player_start_dragging') && rust.includes('player_start_dragging,'));
check('Plan multimedia conserva streams aunque filesize_approx falte', rust.includes('fn requested_media_plan(progress: &Value) -> Option<RequestedMediaPlan>')
  && rust.includes('stream_count: downloads.len()')
  && rust.includes('total_complete = false;'));
check('Los totales estimados permanecen explícitos y DASH mixto no se presenta como exacto',
  rust.includes('.all(|stream| stream.total_bytes.is_some())')
  && rust.includes('media_progress_actual_total_replaces_declared_approximation')
  && rust.includes('multimedia_progress_marks_mixed_dash_totals_as_estimated')
  && rust.includes('structured_ytdlp_estimate_remains_explicitly_approximate')
  && rust.includes('assert_eq!(total, Some(10_485_760));'));
check('No hay marcadores Rust incompletos', !/\b(?:todo|unimplemented|dbg)!\s*\(/.test(rust));
check('protocol-asset y Cargo.lock están sincronizados', cargoToml.includes('"protocol-asset"')
  && /name\s*=\s*"http-range"/.test(httpRangeLockBlock)
  && /"http-range"/.test(tauriLockBlock));
check('Snapshot ligero registrado de extremo a extremo', rust.includes('fn download_activity_snapshot')
  && rust.includes('download_activity_snapshot,')
  && main.includes("invoke('download_activity_snapshot')"));
check('Persistencia de progreso conserva throttling de 250 ms', rust.includes('MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250')
  && rust.includes('persist_transfer: bool')
  && rust.includes('media_progress_throttle_keeps_precision_without_rewriting_sqlite'));
check('Gate nativo conserva fmt, check, test y Clippy estrictos', rustGate.includes('"fmt", "--all", "--", "--check"')
  && rustGate.includes('"check", "--locked", "--all-targets"')
  && rustGate.includes('"test", "--locked", "--lib"')
  && rustGate.includes('"clippy", "--locked", "--all-targets", "--", "-D", "warnings"'));
check('Extensión oficial e ID permanecen intactos', extensionManifest.version === expectedExtensionVersion
  && extensionConfig.chromiumExtensionIds?.[0] === 'aonppfnabjnicjjeoofkfjofolfibggp');
check('Spotify continúa desactivado', rust.includes('SPOTIFY_DISABLED_MESSAGE'));
check('Zen Sidebar continúa como único diseño', !fs.existsSync(path.join(root, 'app-ui/download-manager/view/command-center.js')));
check('La superficie visual actual conserva sus contratos protegidos',
  !fs.existsSync(path.join(root, 'app-ui/download-manager/view/command-center.js'))
  && unified.includes('dm-player-trigger')
  && unified.includes('dm-player-overlay')
  && read('app-ui/player/player.css').includes('object-fit:contain')
  && read('app-ui/player/player.js').includes('togglePlayerFullscreen'));
check('Preview online conserva formato combinado y validación de red pública', rust.includes('fn player_online_preview_snapshot')
  && rust.includes('best[ext=mp4][protocol^=http][vcodec!=none][acodec!=none]')
  && rust.includes('ensure_public_network_resolution(&stream)'));
check('Reproductor mantiene autoplay e iconos reales', (main.includes('data-youtube-preview-player')
  || unified.includes('data-dm-open-player') || unified.includes('dm-player-trigger'))
  && read('app-ui/player/player.js').includes('next.autoplay = true')
  && read('app-ui/player/player.js').includes('await element.play()')
  && read('app-ui/player/player.js').includes('const ICONS =')
  && !read('app-ui/player/player.js').includes("'Ⅱ'"));
check('Aviso de preview degradado es persistente y sólo para brechas extremas', rust.includes('fn player_preview_quality_limited')
  && read('app-ui/player/player.js').includes('cacatools.player.low-preview-notice.v1')
  && rust.includes('assert!(!player_preview_quality_limited(Some(720), Some(2160)))'));
check('CSP permite preview remoto manteniendo asset local', String(tauriConfig.app?.security?.csp?.['media-src'] || '').includes('asset:')
  && String(tauriConfig.app?.security?.csp?.['media-src'] || '').includes('https:'));

const sourceScripts = [
  ...walk('app-ui', (file) => /\.(?:js|mjs)$/.test(file)),
  ...walk('scripts', (file) => /\.(?:js|mjs)$/.test(file)),
  ...walk('extension', (file) => /\.(?:js|mjs)$/.test(file)),
];
const syntaxFailures = [];
for (const relative of sourceScripts) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  if (result.status !== 0) syntaxFailures.push(`${relative}: ${(result.stderr || result.stdout || '').trim()}`);
}
check('Todo JavaScript y MJS tiene sintaxis válida', syntaxFailures.length === 0, syntaxFailures.join('\n'));

const jsonFiles = [
  ...walk('app-ui', (file) => file.endsWith('.json')),
  ...walk('scripts', (file) => file.endsWith('.json')),
  ...walk('extension', (file) => file.endsWith('.json')),
  ...walk('src-tauri', (file) => file.endsWith('.json') && !file.includes(`${path.sep}target${path.sep}`)),
  ...walk('docs/tests', (file) => file.endsWith('.json')),
  'package.json',
  'package-lock.json',
];
const jsonFailures = [];
for (const relative of [...new Set(jsonFiles)]) {
  try {
    const content = read(relative);
    if (!content.trim()) throw new Error('archivo vacío');
    JSON.parse(content);
  } catch (error) {
    jsonFailures.push(`${relative}: ${error.message}`);
  }
}
check('Todos los JSON incluidos son válidos y no están vacíos', jsonFailures.length === 0, jsonFailures.join('\n'));

const powershellFiles = [
  'scripts/rust-gate-windows.ps1',
  'scripts/native-check-windows.ps1',
  'scripts/final-windows-build.ps1',
  'scripts/build-windows-beta.ps1',
];
const lineEndingFailures = [];
for (const relative of powershellFiles) {
  const bytes = readBytes(relative);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && (index === 0 || bytes[index - 1] !== 0x0d)) {
      lineEndingFailures.push(`${relative}: contiene LF sin CR`);
      break;
    }
  }
}
check('Scripts PowerShell críticos conservan CRLF', lineEndingFailures.length === 0, lineEndingFailures.join('\n'));

const report = {
  phase: '0.45.0-precompile-audit',
  checks: checks.length,
  passed: failures.length === 0,
  failures,
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(root, 'docs/tests'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/tests/phase24-2-precompile-audit.json'), `${JSON.stringify(report, null, 2)}\n`);

for (const item of checks) {
  console.log(`${item.passed ? 'OK' : 'FALLO'}: ${item.name}`);
}
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`OK: auditoría previa a compilación valida ${checks.length} condiciones acumulativas.`);
