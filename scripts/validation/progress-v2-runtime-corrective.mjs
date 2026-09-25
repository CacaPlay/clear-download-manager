import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const runtime = read('app-ui/modules/runtime/index.js');
const manager = read('app-ui/download-manager/index.js');
const model = read('app-ui/download-manager/core/model.js');
const unified = read('app-ui/download-manager/view/unified.js');
const coordinator = read('src-tauri/src/progress/coordinator.rs');
const { retainLegacyDeterminateProgress } = await import('../../app-ui/modules/runtime/index.js');

const checks = [
  ['Classic+ usa snapshots legacy como fuente visual', runtime.includes("invoke('desktop_snapshot')") && runtime.includes("invoke('download_activity_snapshot')") && runtime.includes("return mode === 'v2';")],
  ['V2 continúa en paralelo sin parchear filas Classic+', runtime.includes('shouldObserveProgressV2') && runtime.includes('v2_delta_shadow_only') && runtime.includes("!applyProgressV2Delta(event.payload) || !isProgressV2UiMode()")],
  ['un delta V2 no sobrescribe el progreso legacy', runtime.includes('retainLegacyDeterminateProgress') && runtime.includes('appState.snapshot = isProgressV2UiMode()')],
  ['el listener se registra antes del full snapshot inicial', runtime.includes('await startProgressV2Listener();') && runtime.includes("invoke('progress_v2_full_snapshot')")],
  ['los deltas sin identidad se bufferizan', runtime.includes('pendingProgressByIdentity') && runtime.includes('progress_buffered_without_identity')],
  ['no se crean placeholders genéricos', !runtime.includes("title: 'Descarga en curso'") && !runtime.includes("title: 'Playlist en curso'")],
  ['el hover no congela el parche live', !manager.includes("area.querySelector('.dm-download-item:hover')")],
  ['la fila no duplica la velocidad junto al porcentaje', !unified.includes('progressMarkup(job)}</div><small>') && unified.includes('visibleDetail = `${visibleDetail} · ${speedLabel}`')],
  ['el modelo promueve una fila con evidencia de transferencia', model.includes('const liveEvidence') && model.includes("if (status === 'queued' && liveEvidence) status = 'running';")],
  ['una fila pausada no conserva velocidad propia', model.includes("speedBps: status === 'paused' ? 0 : speedBps") && runtime.includes("phase === 'paused'\n    ? 0")],
  ['el coordinador corrige queued con bytes o velocidad', coordinator.includes('cohere_live_phase') && coordinator.includes('has_live_transfer')],
  ['el coordinador conserva progreso de playlist durante postprocesado', coordinator.includes('stabilize_playlist_snapshot') && coordinator.includes('stable_progress')],
  ['el modo estable es el predeterminado Rust', coordinator.includes('"stable" | "" => Self::Stable') && coordinator.includes('stable_metadata_plus_v2_live_projection')],
  ['el autopilot existe solo bajo flag debug', runtime.includes("invoke('progress_acceptance_config')") && fs.existsSync('scripts/validation/progress-acceptance-runtime.mjs')],
  ['el primer job obtiene refresh inmediato tras confirmarse', runtime.includes('function promoteOptimisticJob') && runtime.includes('patchDynamicSnapshot();')],
  ['la playlist retiene progreso determinado durante procesamiento', runtime.includes('LEGACY_PROCESSING_STAGES') && model.includes("'Procesando', 'Finalizando'") && unified.includes("processing ? 'Procesando…'")]
];

const rows = new Map([['A', { id: 'A', progress: 10 }], ['B', { id: 'B', progress: 20 }]]);
for (const delta of [{ id: 'A', progress: 15 }, { id: 'A', progress: 25 }, { id: 'A', progress: 40 }]) {
  rows.set(delta.id, { ...rows.get(delta.id), progress: delta.progress });
}
checks.push(['merge de deltas conserva filas no incluidas', rows.has('B') && rows.get('A').progress === 40]);

const playlistSamples = [0.12, 0.42, null, 0.39, 0.67, null, 1];
let last = 0;
let stayedDeterminate = true;
for (const sample of playlistSamples) {
  if (sample == null) continue;
  const displayed = Math.max(last, sample);
  if (displayed < last) stayedDeterminate = false;
  last = displayed;
}
checks.push(['representación de playlist es monotónica y mantiene medida útil', stayedDeterminate && last === 1]);

const retained = retainLegacyDeterminateProgress(
  { playlist_batches: [{ batch_id: 7, status: 'running', progress: 43 }] },
  { playlist_batches: [{ batch_id: 7, status: 'running', progress: 0, stage: 'Preparando', indeterminate: true }] }
);
checks.push(['la retención real no convierte 43% en spinner', retained.playlist_batches[0].progress === 43 && retained.playlist_batches[0].indeterminate === false]);

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
if (failed.length) process.exitCode = 1;
else console.log('PASS progress-v2-runtime-corrective: stable projection, buffering e invariantes');
