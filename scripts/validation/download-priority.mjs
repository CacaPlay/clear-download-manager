import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changeDownloadPriority } from '../../app-ui/download-manager/actions.js';
import { normalizeJobs, playlistJobId } from '../../app-ui/download-manager/core/model.js';
import {
  applyOptimisticJobStatuses,
  runtimeState,
  setOptimisticJobPriority
} from '../../app-ui/download-manager/state.js';
import { floatingRowMenu } from '../../app-ui/download-manager/view/shared.js';
import { downloadRowMarkup } from '../../app-ui/download-manager/view/unified.js';

const root = process.cwd();
const read = (path) => fs.readFileSync(path, 'utf8');
const occurrences = (text, token) => text.split(token).length - 1;
const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
};

const db = read('src-tauri/src/db/mod.rs');
const priority = read('src-tauri/src/priority.rs');
const dispatcher = read('src-tauri/src/dispatcher.rs');
const torrents = read('src-tauri/src/torrents/mod.rs');
const commands = read('src-tauri/src/commands/downloads.rs');
const lib = read('src-tauri/src/lib.rs');
const actions = read('app-ui/download-manager/actions.js');
const events = read('app-ui/download-manager/events.js');
const shared = read('app-ui/download-manager/view/shared.js');

check('Migración jobs.priority ausente', db.includes("ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high','normal','low'))"));
check('Migración playlist_batches.priority ausente', db.includes("ALTER TABLE playlist_batches ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high','normal','low'))"));
check('Orden HTTP no usa prioridad estricta y FIFO por id', dispatcher.includes("WHEN 'high' THEN 0") && dispatcher.includes('jobs.id LIMIT 64'));
check('Orden multimedia no conserva posición de playlist', dispatcher.includes('MIN(candidate.position)') && dispatcher.includes('ORDER BY priority_rank,enqueue_order LIMIT 64'));
check('Backlog torrent no usa prioridad y FIFO', torrents.includes('queued_torrent_jobs_for_recovery') && torrents.includes('ORDER BY CASE'));
check('El cap backend no es fijo en 256', priority.includes('MAX_PRIORITY_TARGETS: usize = 256'));
check('DTO de target no es cerrado', priority.includes('deny_unknown_fields') && priority.includes('tag = "kind"'));
check('La mutación no es transaccional', /let transaction = connection\s*\.transaction\(\)/.test(priority) && priority.includes('transaction.commit()'));
check('Comando backend debe existir exactamente una vez', occurrences(commands, 'fn set_download_priority') === 1);
check('Registro IPC debe aumentar exactamente una superficie', occurrences(lib, 'commands::downloads::set_download_priority') === 1);
check('Frontend debe invocar exactamente una ruta nueva', occurrences(actions, "invoke('set_download_priority'") === 1);
check('Menú no usa radio semántica', shared.includes('role="menuitemradio"') && shared.includes('aria-checked='));
check('Menú flotante no se mide tras render', events.includes('settleFloatingRowMenu') && events.includes('getBoundingClientRect'));
check('Escape no cierra el menú flotante', events.includes("event.key === 'Escape'") && events.includes('runtimeState.rowMenuJobId = null'));

const snapshot = {
  jobs: [
    { id: 1, title: 'Alta', status: 'queued', kind: 'http', priority: 'high', progress: 0 },
    { id: 2, title: 'Normal', status: 'paused', kind: 'http', priority: 'normal', progress: 0 },
    { id: 3, title: 'Baja', status: 'failed', kind: 'http', priority: 'low', progress: 0 },
    { id: 4, title: 'Terminada', status: 'completed', kind: 'http', priority: 'high', progress: 100 }
  ],
  playlist_batches: [
    { id: 7, title: 'Lista', status: 'queued', priority: 'high', total: 3, completed: 0 }
  ]
};
const jobs = normalizeJobs(snapshot);
const high = jobs.find((job) => job.id === 1);
const normal = jobs.find((job) => job.id === 2);
const low = jobs.find((job) => job.id === 3);
const completed = jobs.find((job) => job.id === 4);
const playlist = jobs.find((job) => job.kind === 'playlist');

check('Normalización no conserva high/normal/low', high?.priority === 'high' && normal?.priority === 'normal' && low?.priority === 'low');
check('Playlist pseudo-id no es estable', playlist?.id === playlistJobId(7));
check('Metadata inline high ausente', downloadRowMarkup(high, 0, null, null, null, null).includes('dm-priority-meta is-high') && downloadRowMarkup(high, 0, null, null, null, null).includes('Prioridad alta'));
check('Metadata inline low ausente', downloadRowMarkup(low, 1, null, null, null, null).includes('dm-priority-meta is-low') && downloadRowMarkup(low, 1, null, null, null, null).includes('Prioridad baja'));
check('Metadata inline normal implícita no debe renderizarse', !downloadRowMarkup(normal, 2, null, null, null, null).includes('dm-priority-meta'));
check('Completed no debe mostrar priority metadata', !downloadRowMarkup(completed, 3, null, null, null, null).includes('dm-priority-meta'));
check('Legacy priority badge must not render', !downloadRowMarkup(high, 0, null, null, null, null).includes('dm-priority-badge'));

const highMenu = floatingRowMenu(high, high.id, { left: 8, top: 8 });
const playlistMenu = floatingRowMenu(playlist, playlist.id, { left: 8, top: 8 });
check('Menú high no selecciona Alta', highMenu.includes('data-dm-set-priority="high"') && highMenu.includes('aria-checked="true"'));
check('Menú no ofrece las tres prioridades', ['high', 'normal', 'low'].every((value) => highMenu.includes(`data-dm-set-priority="${value}"`)));
check('Playlist no produce target de batch', playlistMenu.includes('data-priority-target="playlist"') && playlistMenu.includes('data-playlist-batch-id="7"'));

runtimeState.liveJobs = [normal, playlist];
runtimeState.optimisticJobPriorities.clear();
let successPayload = null;
await changeDownloadPriority({
  invoke: async (name, payload) => { successPayload = { name, payload }; },
  onRefresh: async () => undefined,
  onToast: () => undefined
}, runtimeState.liveJobs, [normal.id, normal.id, playlist.id], 'high', () => undefined);
const optimisticSuccess = applyOptimisticJobStatuses(runtimeState.liveJobs);
check('Optimistic success no actualiza ambas filas', optimisticSuccess.every((job) => job.priority === 'high'));
check('Multiselect no deduplica IDs visuales', successPayload?.payload?.targets?.length === 2);
check('Multiselect no emite target job + playlist', successPayload?.payload?.targets?.some((target) => target.kind === 'job') && successPayload?.payload?.targets?.some((target) => target.kind === 'playlist'));

runtimeState.optimisticJobPriorities.clear();
setOptimisticJobPriority(normal.id, null);
await changeDownloadPriority({
  invoke: async () => { throw new Error('fixture rejection'); },
  onToast: () => undefined
}, [normal], [normal.id], 'low', () => undefined);
check('Rollback optimista no restaura prioridad previa', applyOptimisticJobStatuses([normal])[0].priority === 'normal');

const extensionFiles = execFileSync('git', ['ls-files', 'extension'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
check('La extensión no debe conocer set_download_priority', extensionFiles.every((path) => !read(path).includes('set_download_priority')));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
assert.equal(runtimeState.optimisticJobPriorities.size, 0);
console.log('OK: priority persistence, strict scheduling, closed IPC, playlist targets, badges, menu semantics, multiselect and optimistic rollback validated.');
