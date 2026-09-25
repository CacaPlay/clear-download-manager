import fs from 'node:fs';
import { configureSettings, settingsMarkup } from '../../app-ui/modules/settings/index.js';

const read = (path) => fs.readFileSync(path, 'utf8');
const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
};
const occurrences = (text, token) => text.split(token).length - 1;

const bandwidth = read('src-tauri/src/downloads/bandwidth.rs');
const worker = read('src-tauri/src/downloads/worker.rs');
const torrent = read('src-tauri/src/torrents/mod.rs');
const media = read('src-tauri/src/media/mod.rs');
const mediaWorker = read('src-tauri/src/media/download/worker.rs');
const commands = read('src-tauri/src/commands/settings.rs');
const lib = read('src-tauri/src/lib.rs');
const main = read('app-ui/main.js');
const extension = read('app-ui/modules/extension/index.js');

check('Autoridad SI decimal ausente', bandwidth.includes('MIN_BANDWIDTH_BYTES_PER_SECOND: u64 = 64_000') && bandwidth.includes('MAX_BANDWIDTH_BYTES_PER_SECOND: u64 = 10_000_000_000'));
check('Persistencia download_bandwidth_v1 ausente', bandwidth.includes('download_bandwidth_v1'));
check('DTO cerrado no verificado', bandwidth.includes('deny_unknown_fields') && bandwidth.includes('bytesPerSecond'));
check('Adapter yt-dlp ausente', bandwidth.includes('apply_to_yt_dlp') && bandwidth.includes('"--limit-rate"'));
check('HTTP secuencial no consume presupuesto real', worker.includes('limiter.throttle_bytes(count'));
check('HTTP secuencial no acota lecturas', worker.includes('limiter.read_grant(buffer.len())'));
check('Worker HTTP conserva la ruta secuencial única', !worker.includes('try_segmented_http_download') && !worker.includes('run_curl_download_worker') && !worker.includes('run_aria2c'));
check('Adapter curl heredado reapareció', !bandwidth.includes('apply_to_curl'));
check('El adapter aria2 permanece limitado al torrent', torrent.includes('bandwidth_policy.apply_to_aria2'));
check('yt-dlp no aplica policy', media.includes('bandwidth_policy.apply_to_yt_dlp'));
check('Snapshot multimedia no se toma por invocación', mediaWorker.includes('read_bandwidth_policy(&connection)') || mediaWorker.includes('read_job_bandwidth_policy(&connection, id)'));
check('Gate FFmpeg HLS ausente', media.includes('use_ffmpeg_network_downloader') && media.includes('allows_ffmpeg_network_downloader'));
check('IPC get debe existir exactamente una vez en handler', occurrences(lib, 'commands::settings::get_bandwidth_settings') === 1);
check('IPC save debe existir exactamente una vez en handler', occurrences(lib, 'commands::settings::save_bandwidth_settings') === 1);
check('Comando get ausente', occurrences(commands, 'fn get_bandwidth_settings') === 1);
check('Comando save ausente', occurrences(commands, 'fn save_bandwidth_settings') === 1);
check('Frontend podría aceptar números no enteros o fuera de rango', main.includes('Number.isSafeInteger(value)') && main.includes('Number.isSafeInteger(bytesPerSecond)') && main.includes('bytesPerSecond < 64_000') && main.includes('bytesPerSecond > 10_000_000_000'));
check('La extensión no debe poseer setting de bandwidth', !/bandwidth/i.test(extension));

function renderFor(bandwidthSettings, editorMode = null) {
  const state = {
    settingsCategory: 'downloads',
    downloadDirectory: 'D:\\Downloads',
    bandwidthSettings,
    bandwidthEditorMode: editorMode,
    bandwidthCustomValue: 3,
    bandwidthCustomUnit: 'MB'
  };
  configureSettings({
    getAppState: () => state,
    icon: () => '',
    escapeHtml: (value) => String(value ?? ''),
    downloadDirectoryLabel: () => 'D:\\Downloads'
  });
  return settingsMarkup();
}

const unlimitedMarkup = renderFor({ mode: 'unlimited' });
const presetMarkup = renderFor({ mode: 'limited', bytesPerSecond: 5_000_000 });
const customMarkup = renderFor({ mode: 'limited', bytesPerSecond: 3_000_000 }, 'custom');
check('UI no comunica máximo por descarga', unlimitedMarkup.includes('Máximo por descarga'));
check('UI no comunica nuevas/reanudadas', unlimitedMarkup.includes('Se aplicará a descargas nuevas y reanudadas.'));
check('Preset 5 MB/s no queda seleccionado', presetMarkup.includes('value="5000000" selected'));
check('Editor personalizado incompleto', customMarkup.includes('bandwidth-custom-value') && customMarkup.includes('bandwidth-custom-unit') && customMarkup.includes('save-bandwidth-custom'));
check('UI usa Mb/s en lugar de MB/s', !unlimitedMarkup.includes('Mb/s'));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: bandwidth policy, active engine adapters, closed IPC, Settings UI and protected scopes validated.');
