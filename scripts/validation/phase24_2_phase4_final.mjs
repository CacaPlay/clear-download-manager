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
const packageJson = json('package.json');
const tauri = json('src-tauri/tauri.conf.json');
const extensionManifest = json('extension/manifest.json');
const extensionConfig = json('src-tauri/resources/extension/extension-config.json');
const cargo = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const main = readFrontendSource('.js');
const dmIndex = read('app-ui/download-manager/index.js');
const dmUnified = read('app-ui/download-manager/view/unified.js');
const dmModel = read('app-ui/download-manager/core/model.js');
const windowsGate = read('scripts/rust-gate-windows.ps1');
const versionCheck = read('scripts/version-check.mjs');
const performance = json('docs/tests/phase24-2-phase4-performance.json');
const sqlite = json('docs/tests/phase24-2-phase4-sqlite.json');
const phase3Closure = json('docs/tests/phase24-2-phase3-final-closure.json');
const phase3ClosureVisual = json('docs/tests/phase24-2-phase3-closure-visual.json');

const checks = [
  ['La aplicación usa la versión Beta 0.25.1 en npm, Tauri, Rust y UI', packageJson.version === '0.25.1' && tauri.version === '0.25.1' && cargo.includes('version = "0.25.1"') && cargoLock.includes('name = "cacatools-desktop"\nversion = "0.25.1"') && main.includes("const APP_VERSION = '0.25.1'") && dmUnified.includes('Beta 0.25.1')],
  ['El Build ID final está sincronizado', main.includes("CDM-0.25.1-BETA-20260807") && read('scripts/build-windows-beta.ps1').includes('CDM-0.25.1-BETA-20260807')],
  ['La extensión oficial está sincronizada en 0.25.1 y compatible con la serie 0.25.x', extensionManifest.version === '0.25.1' && extensionManifest.minimumAppVersion === '0.24.1' && extensionManifest.maximumTestedAppVersion === '0.25.x' && versionCheck.includes('compareSemver(manifest.minimumAppVersion, version)')],
  ['El ID oficial de Chrome permanece fijo y los registros heredados quedan protegidos', extensionConfig.chromiumExtensionIds?.[0] === 'aonppfnabjnicjjeoofkfjofolfibggp' && rust.includes('job_uses_legacy_removed_provider') && rust.includes("ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''")],
  ['Zen Sidebar continúa como único diseño y Command Center no reaparece', dmIndex.includes('renderZenSidebar(sharedContext)') && dmModel.includes("const layout = 'zen-sidebar'") && !fs.existsSync('app-ui/download-manager/view/command-center.js')],
  ['Las filas del gestor se actualizan por clave y preservan nodos', dmIndex.includes('function keyedDownloadRowsPatch') && dmIndex.includes('patchLiveDownloadRow') && dmUnified.includes('data-dm-row-live') && dmUnified.includes('data-dm-row-structure')],
  ['Las listas del dashboard actualizan solamente las filas cambiadas', dmIndex.includes('function keyedDownloadRowsPatch') && dmIndex.includes('function patchLiveDownloadRow') && dmUnified.includes('data-dm-row-structure') && dmUnified.includes('data-dm-row-live')],
  ['Fase 11.3 usa polling adaptativo y snapshot completo espaciado', main.includes('VISIBLE_ACTIVE_REFRESH_MS = 350') && main.includes('VISIBLE_IDLE_REFRESH_MS = 1200') && main.includes('BACKGROUND_ACTIVE_REFRESH_MS = 1800') && main.includes('HIDDEN_REFRESH_MS = 2500') && main.includes('FULL_SNAPSHOT_REFRESH_MS = 15_000') && main.includes("invoke('download_activity_snapshot')") && rust.includes('fn download_activity_snapshot') && rust.includes('fn read_download_activity')],
  ['El snapshot frecuente no consulta almacenamiento, divisas ni recientes', rust.includes('read_download_activity(&connection, true)') && rust.includes('read_download_activity(&connection, false)?;')],
  ['Fase 11.3 agrupa progreso y conserva estados críticos', rust.includes('ProgressPersistenceGate') && rust.includes('PROGRESS_MIN_BYTES_DELTA') && rust.includes('unchecked_transaction()') && rust.includes('MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250') && rust.includes('media_progress_throttle_keeps_precision_without_rewriting_sqlite')],
  ['El delta evita regenerar filas que no cambiaron', main.includes('snapshotChangedJobIds') && dmIndex.includes('changedJobIds') && dmIndex.includes('needsActivityPatch')],
  ['SQLite usa una espera corta para evitar colisiones', rust.includes('SQLITE_BUSY_TIMEOUT_MS: u64 = 750') && rust.includes('busy_timeout')],
  ['Las pruebas de polling cubren idle, activo, oculto y reconciliación completa', main.includes('snapshotPollingDelay') && main.includes('documentHidden') && main.includes('VISIBLE_FULL_SNAPSHOT_REFRESH_MS') && main.includes('const fullSnapshotRefreshMs = managerVisible') && main.includes('needsFullSnapshot = Date.now() - lastFullSnapshotAt >= fullSnapshotRefreshMs') && main.includes('visibilitychange')],
  ['Las pruebas de batching cubren primera muestra y cambios significativos', rust.includes('progress_persistence_gate_batches_small_updates_but_keeps_first_and_meaningful_changes') && rust.includes('PROGRESS_MIN_BYTES_DELTA') && rust.includes('PROGRESS_MIN_PERCENT_DELTA')],
  ['Las transiciones críticas y la salida conservan recuperación', rust.includes('set_media_processing_stage') && rust.includes("status='completed'") && rust.includes("status='cancelled'") && rust.includes('prepare_full_exit')],
  ['Playlist y contrato exacto/estimado/indeterminado permanecen cubiertos', rust.includes('playlist_snapshot_classifies_exact_estimated_unknown_and_final_sizes') && rust.includes('total_bytes_estimated') && rust.includes('final_size') && rust.includes('indeterminate')],
  ['La migración incluye índices para cola, historial, URL y playlists', ['idx_jobs_status_updated','idx_download_jobs_url','idx_recent_files_opened','idx_playlist_batches_status_updated','idx_playlist_items_batch_status_position','idx_playlist_items_job','idx_media_jobs_playlist_batch'].every((name) => rust.includes(name))],
  ['La cancelación conserva cierre del árbol de procesos', rust.includes('fn kill_process_tree') && rust.includes('.args(["/PID", &pid.to_string(), "/T", "/F"])') && rust.includes('fn stop_job_internal') && rust.includes('kill_process_tree(pid);')],
  ['Rust permanece en Edition 2021 y no usa let chains', cargo.includes('edition = "2021"') && !/&&\s*let\s+/.test(rust)],
  ['No reaparecen los errores Rust y Clippy ya corregidos', !rust.includes('if path.starts_with(destination) =>') && !rust.includes('.eval(&format!("window.cacatoolsPlayerLoadJob?.') && !/&&\s*let\s+/.test(rust)],
  ['Fase 11.4 limita la virtualizaci�n a historial y completadas largas', dmModel.includes('LONG_LIST_VIRTUALIZATION_POLICIES') && dmModel.includes('history: Object.freeze({ threshold: 120') && dmModel.includes('completed: Object.freeze({ threshold: 160') && dmModel.includes('if (!policy || Number(count) <= policy.threshold) return null')],
  ['Fase 11.4 monta ventanas con overscan y espaciadores medibles', dmIndex.includes('const VIRTUAL_OVERSCAN_ROWS = 8') && dmIndex.includes('function virtualListRange') && dmIndex.includes('function patchVirtualListWindow') && dmIndex.includes('data-dm-virtual-window') && dmUnified.includes('data-dm-virtual-spacer')],
  ['Fase 11.4 conserva acciones delegadas y foco en filas recicladas', dmIndex.includes('data-dm-live-replaced') && dmIndex.includes('data-dm-advanced-details') && dmIndex.includes('scroll.focus({ preventScroll: true })')],
  ['Fase 11.4 evita duplicar listeners directos en filas virtuales', dmIndex.includes("button.closest('.dm-download-scroll[data-dm-virtual-list=\"1\"]')") && dmIndex.includes('bindVirtualListScroll(root)')],
  ['El harness mide listas de 50, 100, 500 y 1,000 con pruebas de estado', performance.passed === true && [50, 100, 500, 1000].every((size) => performance.checks?.some((check) => check.name?.includes(String(size)))) && performance.checks?.some((check) => check.name === 'Long list uses virtualization' && check.pass === true)],
  ['Los espaciadores de la lista virtual tienen estilos acotados', read('app-ui/download-manager/styles.css').includes('.dm-virtual-spacer') && read('app-ui/download-manager/styles.css').includes('.dm-virtual-window')],
  ['Cargo.lock conserva protocol-asset sincronizado', cargo.includes('"protocol-asset"') && cargoLock.includes('name = "http-range"')],
  ['El gate Windows mantiene fmt, check, test y Clippy con warnings como errores', windowsGate.includes('"fmt", "--all", "--", "--check"') && windowsGate.includes('"check", "--locked", "--all-targets"') && windowsGate.includes('"test", "--locked", "--lib"') && windowsGate.includes('"clippy", "--locked", "--all-targets", "--", "-D", "warnings"')],
  ['La auditoría previa a compilación bloquea regresiones conocidas antes de Cargo', packageJson.scripts?.['check:0.25.1:precompile'] === 'node scripts/validation/phase24_2_precompile_audit.mjs' && windowsGate.includes('npm.cmd run check:0.25.1:precompile')],
  ['El cierre correcto de Fase 3 precede a la revalidación final', phase3Closure.passed === true && phase3Closure.failures?.length === 0 && phase3ClosureVisual.passed === true],
  ['La medición UI final pasa y documenta comparación antes/después', performance.passed === true && performance.baseline?.live_average_ms > performance.after?.live_patch?.avgMs && performance.comparison?.average_ms_reduction_percent >= 70],
  ['La medición SQLite final pasa y documenta planes e intervalos', sqlite.passed === true && sqlite.progress_persistence?.interval_ms === 250 && Object.keys(sqlite.query_plans || {}).length >= 7],
];

checks[0] = ['Release 0.45.0 sincronizado', packageJson.version === '0.45.0' && tauri.version === '0.45.0' && cargo.includes('version = "0.45.0"') && cargoLock.includes('name = "cacatools-desktop"\nversion = "0.45.0"') && main.includes("const APP_VERSION = '0.45.0'") && dmUnified.includes('CacaTools 0.45.0')];
checks[1] = ['Build ID 0.45.0 sincronizado', main.includes('CDM-0.45.0-UI-20260825') && read('scripts/build-windows-beta.ps1').includes('CDM-0.45.0-UI-20260825')];
checks[2] = ['Extension 0.45.x sincronizada', extensionManifest.version === '0.45.0' && extensionManifest.minimumAppVersion === '0.24.1' && extensionManifest.maximumTestedAppVersion === '0.45.x' && versionCheck.includes('compareSemver(manifest.minimumAppVersion, version)')];
const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
const report = {
  phase: '0.25.1-phase4-revalidated',
  checks: checks.length,
  failures,
  performance: performance.comparison,
  sqlite: {
    before: sqlite.median_query_ms_before_indexes,
    after: sqlite.median_query_ms_after_indexes,
  },
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-2-phase4-final.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [name] of checks) console.log(`OK: ${name}`);
console.log(`OK: Fase 4 acumulativa revalidada en 0.25.1 valida ${checks.length} condiciones acumulativas de rendimiento, estabilidad y versión.`);
