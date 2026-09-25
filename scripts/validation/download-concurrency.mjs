import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configureSettings, settingsMarkup } from '../../app-ui/modules/settings/index.js';

const root = process.cwd();
const read = (path) => fs.readFileSync(path, 'utf8');
const occurrences = (text, token) => text.split(token).length - 1;
const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
};

const concurrency = read('src-tauri/src/downloads/concurrency.rs');
const dispatcher = read('src-tauri/src/dispatcher.rs');
const media = read('src-tauri/src/media/mod.rs');
const commands = read('src-tauri/src/commands/settings.rs');
const lib = read('src-tauri/src/lib.rs');
const main = read('app-ui/main.js');
const runtime = read('app-ui/modules/runtime/index.js');
const settings = read('app-ui/modules/settings/index.js');

check('Defaults backend 2/1 ausentes', concurrency.includes('http: 2') && concurrency.includes('multimedia: 1'));
check('Rango HTTP 1–8 ausente', concurrency.includes('MIN_HTTP_CONCURRENCY: u8 = 1') && concurrency.includes('MAX_HTTP_CONCURRENCY: u8 = 8'));
check('Rango multimedia 1–4 ausente', concurrency.includes('MIN_MULTIMEDIA_CONCURRENCY: u8 = 1') && concurrency.includes('MAX_MULTIMEDIA_CONCURRENCY: u8 = 4'));
check('Persistencia download_concurrency_v1 ausente', concurrency.includes('download_concurrency_v1'));
check('DTO cerrado ausente', concurrency.includes('deny_unknown_fields'));
check('El dispatcher no usa una compuerta dinámica local', dispatcher.includes('struct DynamicSlotGate') && dispatcher.includes('state.active >= state.limit'));
check('Bajar el límite intenta revocar tareas activas', dispatcher.includes('set_limit') && !dispatcher.includes('forget_permits'));
check('Subir el límite no despierta el dispatcher', dispatcher.includes('update_concurrency') && dispatcher.includes('self.wake()'));
check('Priority dejó de ordenar el próximo slot', dispatcher.includes("WHEN 'high' THEN 0") && dispatcher.includes('ORDER BY priority_rank,enqueue_order LIMIT 64'));
check('Playlist perdió secuencia interna', media.includes("status='running'") && media.includes('ORDER BY position LIMIT 1'));
check('Getter Settings existente no expone concurrencia', lib.includes('downloadConcurrency') && runtime.includes('desktopSettings?.downloadConcurrency'));
check('Debe existir un único comando de guardado', occurrences(commands, 'fn save_download_concurrency') === 1 && occurrences(lib, 'commands::settings::save_download_concurrency') === 1);
check('Frontend debe invocar una sola ruta de guardado', occurrences(main, "invoke('save_download_concurrency'") === 1);
check('UI HTTP incompleta', settings.includes('id="http-concurrency-input"') && settings.includes('min="1" max="8"'));
check('UI multimedia incompleta', settings.includes('id="multimedia-concurrency-input"') && settings.includes('min="1" max="4"'));

const state = {
  settingsCategory: 'downloads',
  downloadDirectory: 'D:\\Downloads',
  downloadConcurrency: { http: 4, multimedia: 2 },
  bandwidthSettings: { mode: 'unlimited' }
};
configureSettings({
  getAppState: () => state,
  icon: () => '',
  escapeHtml: (value) => String(value ?? ''),
  downloadDirectoryLabel: () => 'D:\\Downloads'
});
const markup = settingsMarkup();
check('UI no conserva HTTP=4', markup.includes('id="http-concurrency-input"') && markup.includes('value="4"'));
check('UI no conserva Multimedia=2', markup.includes('id="multimedia-concurrency-input"') && markup.includes('value="2"'));
check('UI no explica cambios sin reinicio', markup.includes('Las tareas activas continúan'));

const protectedPaths = [
  'src-tauri/src/downloads/bandwidth.rs',
  'src-tauri/src/priority.rs',
  'src-tauri/src/torrents',
  'extension'
];
const protectedDiff = execFileSync('git', [
  'diff', '--name-only', 'dee92586ec0565b5c3610a37eae85b3dd102e4f9', '--', ...protectedPaths
], { cwd: root, encoding: 'utf8' }).trim();
check(`Priority, Bandwidth, torrent o extensión modificados: ${protectedDiff}`, protectedDiff === '');

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: configurable 2/1 defaults, strict ranges, dynamic local slots, Settings persistence, Priority/Bandwidth isolation and protected scopes validated.');
