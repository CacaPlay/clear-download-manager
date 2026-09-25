import assert from 'node:assert/strict';
import fs from 'node:fs';
import { floatingRowMenu } from '../../app-ui/download-manager/view/shared.js';
import { normalizeJobs } from '../../app-ui/download-manager/core/model.js';

const read = (path) => fs.readFileSync(path, 'utf8');
const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

const shared = read('app-ui/download-manager/view/shared.js');
const events = read('app-ui/download-manager/events.js');
const db = read('src-tauri/src/db/mod.rs');
const settings = read('src-tauri/src/commands/settings.rs');
const bandwidth = read('src-tauri/src/downloads/bandwidth.rs');

check('La UI no ofrece el límite editable en una sola fila', shared.includes('Límite de descarga') && shared.includes('data-dm-speed-custom-value') && shared.includes('class="dm-speed-unit"') && shared.includes('data-dm-apply-speed-limit') && !shared.includes('dm-speed-presets'));
check('El menú no usa el grupo semántico de límite', shared.includes('dm-speed-menu') && shared.includes('aria-label="Límite de descarga"'));
check('La caja de velocidad personalizada no está disponible', shared.includes('data-dm-speed-custom-value') && shared.includes('data-dm-apply-speed-limit') && events.includes('readCustomSpeedLimit'));
check('La caja personalizada no inicia en KB/s entero', shared.includes('inputmode="numeric"') && shared.includes('pattern="[0-9]*"') && shared.includes('KB/s') && shared.includes('placeholder="Sin límite"'));
check('El evento no invoca set_download_speed_limit', events.includes("invoke?.('set_download_speed_limit'") && events.includes('bytesPerSecond'));
check('El menú flotante no tiene delegado de clic acotado', events.includes('document.addEventListener(\'click\', handleFloatingMenuClick)') && events.includes('if (root.contains(event.target)) return'));
check('El capturador pointerdown cerraría el editor antes del clic', events.includes('.dm-inspector,.dm-speed-menu') && events.includes('detach the button before the delegated click handler'));
check('La UI de playlist no expone el limitador', shared.includes('data-dm-apply-playlist-speed-limit') && events.includes("invoke?.('set_playlist_speed_limit'"));
check('La persistencia download_speed_limits no está protegida', db.includes('download_speed_limits') && settings.includes('set_download_speed_limit'));
check('El runtime no contiene la aplicación de ancho de banda', bandwidth.includes('bytes_per_second') && bandwidth.includes('BandwidthLimiter'));

const jobs = normalizeJobs({ jobs: [
  { id: 11, title: 'HTTP', kind: 'http', status: 'running', progress: 20 },
  { id: 12, title: 'Media', kind: 'media', status: 'paused', progress: 20 },
  { id: 13, title: 'Torrent', kind: 'torrent', status: 'queued', progress: 0 },
  { id: 14, title: 'Final', kind: 'http', status: 'completed', progress: 100 }
] });
for (const job of jobs) {
  const menu = floatingRowMenu(job, job.id, { left: 8, top: 8 });
  if (['running', 'paused', 'queued'].includes(job.status)) {
    check(`Falta el límite para ${job.kind}/${job.status}`, menu.includes('Límite de descarga'));
    check(`Falta la acción personalizada para ${job.kind}/${job.status}`, menu.includes('data-dm-apply-speed-limit') && menu.includes('data-dm-speed-custom-value'));
  } else {
    check('Una descarga completada muestra un límite editable', !menu.includes('Límite de descarga'));
  }
}
const [playlist] = normalizeJobs({ playlist_batches: [{ batch_id: 21, title: 'Playlist', format: 'video', status: 'running', total_items: 2, active_items: 1 }] });
const playlistMenu = floatingRowMenu(playlist, playlist.id, { left: 8, top: 8 });
check('La playlist activa no muestra el límite', playlistMenu.includes('Límite de descarga'));
check('La playlist no ofrece su acción personalizada', playlistMenu.includes('data-dm-apply-playlist-speed-limit') && playlistMenu.includes('data-dm-speed-custom-value'));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
assert.equal(failures.length, 0);
console.log('OK: límites por descarga validados para HTTP, multimedia y torrent en running/paused/queued, con persistencia e IPC.');
