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
const main = readFrontendSource('.js');
const index = read('app-ui/download-manager/index.js');
const shared = read('app-ui/download-manager/view/shared.js');
const dialogs = read('app-ui/download-manager/view/dialogs.js');
const unified = read('app-ui/download-manager/view/unified.js');
const css = read('app-ui/download-manager/styles.css');
const appCss = readFrontendSource('.css');
const cargo = read('src-tauri/Cargo.toml');
const settingsVisual = JSON.parse(read('docs/tests/phase24-2-settings-visual-smoke.json'));

const checks = [
  ['Ajustes usa seis secciones internas', ['general', 'downloads', 'multimedia', 'appearance', 'integrations', 'diagnostics'].every((id) => shared.includes(`['${id}'`))],
  ['Solo se representa el panel activo', shared.includes('panels[active]') && shared.includes('data-dm-settings-panel="${active}"')],
  ['Navegación de Ajustes se adapta a ventanas pequeñas', css.includes('@media(max-width:900px)') && css.includes('.dm-settings-nav') && css.includes('overflow-x:auto') && css.includes('flex:0 0 auto')],
  ['Controles de Ajustes conectan funciones reales', index.includes('onChooseDownloadDirectory') && index.includes('onMediaPreferencesChange') && index.includes('onRepairIntegration') && index.includes('onRefreshRuntime') && index.includes('onCopyDiagnostics')],
  ['Los estados semánticos permanecen independientes del acento', index.includes('dmEffectiveAccent') && index.includes('const effectiveSuccess = runtimeState.preferences.success') && shared.includes('permanecen independientes del acento principal') && !index.includes("root.style.setProperty('--dm-warning', effective") && !index.includes("root.style.setProperty('--dm-danger', effective")],
  ['Búsqueda aplica debounce corto e invalida respuestas antiguas', index.includes('UNIFIED_SUGGESTION_DEBOUNCE_MS = 120') && index.includes('const requestId = ++runtimeState.unifiedRequestId') && index.includes('requestId !== runtimeState.unifiedRequestId')],
  ['Caché de búsqueda tiene TTL y límite', index.includes('UNIFIED_SUGGESTION_CACHE_LIMIT = 32') && index.includes('UNIFIED_SUGGESTION_CACHE_TTL_MS') && index.includes('unifiedSuggestionCache.size > UNIFIED_SUGGESTION_CACHE_LIMIT')],
  ['Miniaturas se cargan progresivamente con concurrencia limitada', index.includes('MAX_CONCURRENT_THUMBNAILS = 6') && index.includes('IntersectionObserver') && unified.includes('data-dm-thumbnail-src') && dialogs.includes('progressiveThumbnailMarkup')],
  ['Miniatura rota no bloquea otros resultados', index.includes('thumbnailCache') && index.includes("entry.state === 'failed'") && index.includes('pumpThumbnailQueue()') && index.includes('THUMBNAIL_FAILURE_TTL_MS')],
  ['Cada formato distingue tamaño exacto, aproximado o desconocido', main.includes('function formatLabel(format = {})') && main.includes('formatBytes(format.filesize') && main.includes('format.filesize_estimated')],
  ['Calidad de vídeo persiste separada del formato de audio', main.includes('selectedVideoQuality: storedMediaDownloadPreferences.videoQuality') && main.includes('videoQuality: normalizeVideoQuality(appState.selectedVideoQuality)') && main.includes('preferredVideoFormat')],
  ['Video y audio separados se suman en Rust', rust.includes('merge_media_format_sizes') && rust.includes('best_video_format(entries, max_height)') && rust.includes('best_audio_format(entries, None)')],
  ['Playlist calcula tamaños progresivamente sin cientos de procesos', main.includes('PLAYLIST_SIZE_CONCURRENCY = 1') && main.includes('analyzePlaylistItemForSize') && main.includes("invoke('analyze_media_url'") && main.includes('playlistFormatFromAnalysis')],
  ['Total seleccionado conserva estado parcial sin inventar tamaño', main.includes('selectedPlaylistSizeSummary') && main.includes('if (pending > 0 || unknown > 0) return `${label} parcial`;') && main.includes('data-playlist-size-summary') && !main.includes('Pendiente de cálculo')],
  ['Diagnóstico informa versiones reales de motores', rust.includes('yt_dlp_version') && rust.includes('ffmpeg_version') && rust.includes('ffprobe_version') && rust.includes('aria2_version') && shared.includes('media.yt_dlp_version')],
  ['Rust permanece en Edition 2021 y sin let chains', cargo.includes('edition = "2021"') && !/&&\s*let\s+/.test(rust)],
  ['Modo claro cubre el nuevo texto de tamaños', appCss.includes('Phase 2 · real media-size states') && appCss.includes('[data-theme="light"] .playlist-item-size')],
  ['Ajustes no queda recortado por la barra lateral', settingsVisual.passed === true && css.includes('z-index:120') && css.includes('grid-template-rows:auto minmax(0,1fr)')]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.2-phase-2-settings-search-format-sizes',
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-2-phase2-settings-search-sizes.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 2 de 0.24.2 valida ${checks.length} condiciones de Ajustes, búsqueda y tamaños.`);
