import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (path) => fs.readFileSync(path, 'utf8');
const main = read('app-ui/main.js');
const actions = read('app-ui/download-manager/actions.js');
const events = read('app-ui/download-manager/events.js');
const shared = read('app-ui/download-manager/view/shared.js');
const dialogs = read('app-ui/download-manager/view/dialogs.js');
const unified = read('app-ui/download-manager/view/unified.js');
const dmBaseCss = read('app-ui/download-manager/styles/01-base.css');
const subwindow = read('app-ui/subwindow.js');
const player = read('app-ui/player/player.js');
const tauriCommands = read('src-tauri/src/lib.rs');

const { normalizeJobs, playlistJobId } = await import('../../app-ui/download-manager/core/model.js');
const { applyOptimisticJobStatuses, runtimeState, setOptimisticJobStatus } = await import('../../app-ui/download-manager/state.js');

const checks = [];
function check(label, condition) {
  checks.push([label, Boolean(condition)]);
  assert.ok(condition, label);
}

const invokeNames = (source) => new Set(Array.from(
  source.matchAll(/(?:\bcontext\.)?\binvoke(?:\?\.)?\s*\(\s*['"]([a-zA-Z0-9_]+)['"]/g),
  (match) => match[1]
));
const appJsFiles = execFileSync('git', ['ls-files', 'app-ui/*.js', 'app-ui/**/*.js'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
const currentInvokes = new Set(appJsFiles.flatMap((path) => [...invokeNames(read(path))]));
const headInvokes = new Set(appJsFiles.flatMap((path) => {
  const source = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
  return [...invokeNames(source)];
}));

const playlistId = playlistJobId(7);
const [playlist] = normalizeJobs({
  playlist_batches: [{ batch_id: 7, title: 'Playlist', status: 'running', total_items: 3, active_items: 1 }]
});
check('El id sintetico de playlist es estable', playlist.id === playlistId);
setOptimisticJobStatus(playlistId, 'paused');
const [pausedPlaylist] = applyOptimisticJobStatuses([playlist]);
check('La pausa de playlist se refleja optimistamente antes del snapshot', pausedPlaylist.status === 'paused' && pausedPlaylist.detail === 'En pausa');
runtimeState.optimisticJobStatuses.clear();
setOptimisticJobStatus(playlistId, 'queued', { resetProgress: true });
const [retriedPlaylist] = applyOptimisticJobStatuses([{ ...playlist, status: 'queued', progress: 100 }]);
check('El reintento de playlist abandona visualmente el error sin esperar al snapshot', retriedPlaylist.status === 'queued' && retriedPlaylist.progress === 0 && retriedPlaylist.detail === 'Reintentando…');
runtimeState.optimisticJobStatuses.clear();

check('Un panel de ajustes oculto no bloquea refrescos', main.includes('.dm-settings-popover:not([hidden])') && !main.includes('.dm-settings-popover, .dm-modal-backdrop'));
check('Pausa y reanudacion cierran el menu antes del parche vivo', actions.includes('closeRowMenu();\n          context.onOptimisticJobStatus') && events.includes('runtimeState.rowMenuJobId = null;\n          runtimeState.rowMenuPosition = null;'));
check('Playlist usa estado optimista y parche acotado', actions.includes('playlistJobId(batchId)') && actions.includes("resetProgress: action === 'retry'") && actions.includes("onRefresh?.({ liveOnly: true"));

check('Cancelar descarga es una accion de escritorio explicita', shared.includes('<span>Cancelar descarga</span>') && dialogs.includes("dialogShell('cancel', 'Cancelar descarga'"));
check('Cancelar conserva el backend seguro existente', actions.includes("invoke?.('emergency_stop_job'") && tauriCommands.includes('emergency_stop_job'));

check('Las rutas extendidas se normalizan solo para presentacion', main.includes("value.startsWith('\\\\\\\\?\\\\') ? value.slice(4) : value") && subwindow.includes('function displayWindowsPath(path)'));
check('La ventana de preparacion no muestra la nota secundaria obsoleta', !subwindow.includes('data-role="quality-note"'));
check('Los tamanos de formato quedan identificados como aproximados', subwindow.includes('`${label} · aprox. ${size}`'));
check('Las extensiones largas se acotan sin alterar EXE PDF DOCX o ZIP', unified.includes('function compactExtensionLabel') && unified.includes("extension.length <= 5 ? extension") && dmBaseCss.includes('max-width:calc(100% - .32rem)'));

check('Player consume la autoridad de apariencia v2 y el evento compartido', player.includes("from '../modules/appearance/sync.js") && player.includes("invoke('get_appearance_settings')") && player.includes("event.key === 'cacatools.desktop.appearance.v2'"));
check('Player no oculta controles mientras el usuario los apunta o enfoca', player.includes("playerControls?.matches(':hover') || playerControls?.contains(document.activeElement)"));
check('Fullscreen evita reentrada y difiere una sola captura acotada', player.includes('if (fullscreenTransitionPending) return;') && player.includes('scheduleFullscreenBackdropCapture()') && player.includes('Math.min(width, 720)') && !player.includes('if (entering) captureFullscreenBackdrop();'));

check('No se modifico codigo nativo ni el registro de comandos Tauri', execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src-tauri'], { encoding: 'utf8' }).trim() === '' && (tauriCommands.match(/generate_handler!/g) || []).length === 1);
check('La superficie de invocaciones IPC del frontend permanece identica', currentInvokes.size === headInvokes.size && [...currentInvokes].every((command) => headInvokes.has(command)));

for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: estabilizacion pre-2I validada (${checks.length} condiciones).`);
