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
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const normalizedRust = rust
  .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
  .replace(/\s+/g, ' ');
const model = read('app-ui/download-manager/core/model.js');
const shared = read('app-ui/download-manager/view/shared.js');
const unified = read('app-ui/download-manager/view/unified.js');
const dmCss = read('app-ui/download-manager/styles.css');
const appCss = readFrontendSource('.css');

const checks = [
  ['yt-dlp agrega flujos separados', rust.includes('struct MediaProgressTracker') && rust.includes('streams: HashMap<String, MediaStreamProgress>')],
  ['aria2c publica tamaño, velocidad y ETA reales', rust.includes('parse_aria2_progress_line') && rust.includes('--show-console-readout=true') && rust.includes('update_torrent_progress')],
  ['aria2c permanece indeterminado mientras no conoce el total', rust.includes('aria2c · obteniendo metadatos y pares…') && rust.includes('total_bytes=COALESCE(?2,total_bytes)')],
  ['El total aproximado se conserva como dato explícito', rust.includes('total_bytes_estimated INTEGER NOT NULL DEFAULT 0') && model.includes('totalBytesEstimated')],
  ['El modelo no usa una estimación como denominador exacto', model.includes('const exactDownloaded = total && !totalBytesEstimated') && model.includes('total && !totalBytesEstimated\n        ? clampNumber')],
  ['El tamaño final solo se expone al completar', rust.includes('let final_size = (status == "completed")') && rust.includes('final_size,') && model.includes("finalSize: status === 'completed'")],
  ['DASH mixto conserva la clasificación estimada', rust.includes('multimedia_progress_marks_mixed_dash_totals_as_estimated') && rust.includes('known_totals_complete')],
  ['Etapas de procesamiento no fuerzan 99 %', !rust.includes("progress=99.0") && !rust.includes("progress=99.5") && !rust.includes("progress=99.6")],
  ['Combinación y conversión tienen estados reales', normalizedRust.includes('\"merging\", \"Combinando video y audio…\"') && (normalizedRust.includes('Convirtiendo para Windows…') || normalizedRust.includes('El contenedor necesita conversión de compatibilidad…'))],
  ['El archivo final fija tamaño exacto', rust.includes('total_bytes=?1,speed_bps=0') && rust.includes('total_bytes_estimated=0')],
  ['La UI respeta indeterminado del backend', shared.includes('const indeterminate = Boolean(job.indeterminate)') && shared.includes('Progreso indeterminado') && model.includes('total == null')],
  ['La barra marca porcentajes estimados con ~', shared.includes('const estimated = Boolean(job.totalBytesEstimated || job.progressEstimated)') && shared.includes('Progreso estimado')],
  ['La UI diferencia tamaño aproximado y ausencia de tamaño', unified.includes("job.totalBytesEstimated ? '~' : ''") && unified.includes("job.downloadedBytes > 0") && !unified.includes("'Pendiente de cálculo'")],
  ['Las filas permiten títulos de dos líneas', dmCss.includes('-webkit-line-clamp:2!important')],
  ['El progreso baja bajo el título en ancho medio', dmCss.includes('@container download-center (max-width:1040px)') && dmCss.includes('grid-template-columns:minmax(0,1fr)!important')],
  ['Las cifras usan color neutro del tema', dmCss.includes('--dm-progress-number:#f7fbff') && dmCss.includes('--dm-progress-number:#101b2b')],
  ['Mejor disponible permanece verde semántico', appCss.includes('.analysis-v2-badges.is-compact>span') && appCss.includes('color:var(--green)!important')],
  ['La barra URL clara ya no fuerza fondo oscuro', appCss.includes('.dm-dialog-theme-light .dm-workspace-sourcebar .url-field{background:var(--dl-panel)!important')],
  ['La extensión oficial permanece presente y se valida por su gate dedicado', fs.existsSync('extension/manifest.json')]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.2-phase-1-download-progress-responsive',
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-2-phase1-download-progress.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 1 de 0.24.2 valida ${checks.length} condiciones de progreso, tamaños, estados y responsive.`);
