import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const manager = read('app-ui/download-manager/index.js');
const dialogs = read('app-ui/download-manager/view/dialogs.js');
const shared = read('app-ui/download-manager/view/shared.js');
const styles = read('app-ui/download-manager/styles.css');
const failures = [];
const checks = [];

function check(name, condition, detail = '') {
  const pass = Boolean(condition);
  checks.push({ name, pass, detail });
  if (!pass) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}
function has(source, token) { return source.includes(token); }

check('Existe una vista previa nativa de almacenamiento', has(rust, 'fn job_storage_preview') && has(rust, 'JobStoragePreview'));
check('Existe detención de emergencia dedicada', has(rust, 'fn emergency_stop_job') && has(rust, 'fn stop_job_internal'));
check('Existe eliminación real de tarea', has(rust, 'fn delete_download_job') && has(rust, 'DeleteJobReceipt'));
check('Cancelar por estado reutiliza la detención segura', /if status == "cancelled"\s*\{\s*stop_job_internal\(id, false, &state\)/.test(rust));
check('La detención bloquea reintentos programados', has(rust, "UPDATE download_schedules SET enabled=0"));
check('La detención pone velocidad y ETA en cero', ['UPDATE download_jobs SET speed_bps=0', 'UPDATE media_jobs SET speed_bps=0', 'UPDATE torrent_jobs SET speed_bps=0'].every((token) => has(rust, token)));
check('La detención finaliza el árbol de procesos externos', /fn stop_job_internal[\s\S]{0,4200}kill_process_tree\(pid\)/.test(rust));
check('La limpieza espera a que lectores y workers terminen', has(rust, 'fn cleanup_managed_paths_when_idle') && has(rust, 'if !direct_busy && !external_busy'));
check('Los workers no borran directamente al observar cancelación', !/SELECT cancel_cleanup[\s\S]{0,280}fs::remove_(?:file|dir_all)/.test(rust));
check('La eliminación exige rutas absolutas administradas', has(rust, 'fn validate_managed_candidate') && has(rust, 'if !candidate.is_absolute()'));
check('La eliminación rechaza ParentDir', has(rust, 'std::path::Component::ParentDir'));
check('La eliminación impide borrar la raíz administrada', has(rust, 'No se permite eliminar la carpeta administrada completa'));
check('La eliminación rechaza enlaces simbólicos', has(rust, 'file_type().is_symlink()') && has(rust, 'No se seguirá un enlace simbólico'));
check('La eliminación de carpetas no sigue enlaces internos', has(rust, 'fn remove_directory_tree_without_following_links'));
check('La tarea activa se detiene antes de eliminar', /fn delete_download_job[\s\S]{0,1800}stop_job_internal\(id, false, &state\)[\s\S]{0,500}wait_for_job_idle/.test(rust));
check('El borrado de SQLite usa transacción y cascada', /fn delete_download_job[\s\S]{0,4200}\.transaction\(\)[\s\S]{0,1200}DELETE FROM jobs WHERE id=\?1/.test(rust));
check('Una programación no arranca trabajos cancelados', has(rust, 'if affected == 0') && has(rust, 'ya está completada, cancelada o eliminada'));
check('La cancelación programada desactiva ejecuciones futuras', /fn execute_scheduled_action[\s\S]{0,7600}UPDATE download_schedules SET enabled=0/.test(rust));
check('El programador agrupa recursos sin exceder el límite de argumentos', has(rust, 'struct SchedulerRuntime') && /fn execute_scheduled_action\(\s*db_path: &Path,\s*runtime: &SchedulerRuntime,/.test(rust));
check('Rust prueba la protección y eliminación administrada', ['managed_storage_validation_rejects_root_escape_and_parent_segments', 'managed_storage_removal_keeps_unrelated_files', 'completed_torrent_directory_is_not_reported_as_partial'].every((token) => has(rust, token)));
check('Los comandos están registrados en Tauri', ['job_storage_preview,', 'emergency_stop_job,', 'delete_download_job,'].every((token) => has(rust, token)));
check('La interfaz muestra rutas antes de borrar', has(dialogs, 'Archivo o carpeta final') && has(dialogs, 'Temporales relacionados') && has(dialogs, 'Raíz administrada'));
check('Eliminar almacenamiento exige confirmación explícita', has(dialogs, 'data-dm-delete-storage-ack') && has(manager, "[data-dm-delete-storage-ack]") && has(manager, 'button.disabled = !event.currentTarget.checked'));
check('La interfaz ofrece las dos eliminaciones reales', has(dialogs, 'Solo de CacaTools') && has(dialogs, 'CacaTools y almacenamiento'));
check('La interfaz invoca los comandos nuevos', has(manager, "'job_storage_preview'") && has(manager, "'emergency_stop_job'") && has(manager, "'delete_download_job'"));
check('Completadas no muestran detención de emergencia', has(shared, "const cancellableStatuses = new Set(['running', 'queued', 'paused', 'failed'])"));
check('Todas las tareas normales permiten eliminar registro', has(shared, 'data-dm-delete-job'));
check('El diálogo es responsive', has(styles, '.dm-delete-options') && has(styles, '@media(max-width:720px)'));

const report = {
  gate: 'phase24.1-process-safety',
  passed: failures.length === 0,
  checks,
};
const output = path.join(ROOT, 'docs/tests/phase24-1-process-safety.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

for (const item of checks) console.log(`${item.pass ? 'OK' : 'FAIL'}: ${item.name}`);
if (failures.length) {
  console.error(`\n${failures.length} comprobación(es) fallaron:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK: Fase 2B valida detención de emergencia, eliminación diferenciada y protección de rutas. Informe: ${path.relative(ROOT, output)}`);
