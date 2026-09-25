import fs from 'node:fs';
import path from 'node:path';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const root = path.resolve(import.meta.dirname, '../..');
const main = readFrontendSource('.js');
const css = readFrontendSource('.css');
const rust = fs.readdirSync(path.join(root, 'src-tauri/src'), { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(path.join(root, 'src-tauri/src', file), 'utf8'))
  .join('\n');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const checks = [
  ['La etiqueta redundante de mejor coincidencia desaparece cuando la resolución está lista', main.includes("if (state === 'ready') return '';" ) && !main.includes("if (state === 'ready') return 'Lista · Mejor coincidencia';")],
  ['Cada miniatura de playlist puede abrir el mismo preview online', main.includes('data-action="preview-track"') && main.includes("invoke('open_online_media_player', { url: item.sourceUrl })")],
  ['El play de playlist se enlaza una sola vez por botón', main.includes('data-action="preview-track"') && main.includes("if (action === 'preview-track')")],
  ['La duración se integra dentro de la miniatura', main.includes('track-thumb') && main.includes('class="duration"')],
  ['La selección nativa usa una estructura compacta', main.includes('data-role="item-check"') && main.includes('data-track-id') && main.includes('data-role="track-scroll"')],
  ['Las miniaturas nativas de selección conservan superficie útil', css.includes('.track-thumb{') && css.includes('aspect-ratio:16/9')],
  ['La lista nativa conserva scroll y proporción audiovisual', css.includes('.track-scroll{') && css.includes('overflow:auto') && css.includes('.track-grid{')],
  ['El botón de reproducción nativo es un overlay y no altera la geometría', css.includes('.preview-play{position:absolute') && css.includes('inset:0')],
  ['El análisis de tamaños de playlist limita concurrencia', main.includes('state.sizeActive < 2') && main.includes('sizeQueue')],
  ['El enriquecimiento de tamaños se difiere tras el análisis nativo', main.includes('startSizeAnalysis') && main.includes('sizeGeneration')],
  ['Los análisis se espacian entre elementos', main.includes('const PLAYLIST_SIZE_BETWEEN_ITEMS_MS = 140;') && main.includes('PLAYLIST_SIZE_BETWEEN_ITEMS_MS')],
  ['El análisis nativo invalida generaciones al cambiar la selección', main.includes('state.sizeGeneration += 1') && main.includes('startSizeAnalysis(state.sizeGeneration)')],
  ['Los análisis repetidos reutilizan una caché acotada y con expiración', main.includes('PLAYLIST_ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000') && main.includes('PLAYLIST_ANALYSIS_CACHE_LIMIT = 64') && main.includes('playlistCachedAnalysis') && main.includes('cachePlaylistAnalysis')],
  ['Cada resultado de tamaño actualiza solo su fila y el resumen', main.includes('paintPlaylistSizeDom(item.id)') && main.includes("document.querySelector(`[data-playlist-id=\"${CSS.escape(normalizedId)}\"]`)")],
  ['La cola invalida su firma también cuando cambia la URL reproducible', main.includes('${item.status}:${playlistPreviewUrl(item)}')],
  ['La lista nativa conserva scroll propio desde el primer render', css.includes('.track-scroll{') && css.includes('overflow:auto') && css.includes('overscroll-behavior: contain')],
  ['El reproductor no depende de un detector del proveedor retirado', !main.includes('isSpotifyUrl') && rust.includes("ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''")],
  ['No se reintroduce sintaxis Rust 2024 ni fallos Clippy ya conocidos', !rust.includes('&& let Some(') && !rust.includes('.eval(&format!(') && !/if\s+path\.starts_with\(destination\)/.test(rust)],
  ['La fase usa la versión acumulativa 0.25.1', pkg.version === '0.25.1'],
];

checks[checks.length - 1] = ['La release usa la version acumulativa 0.45.0', pkg.version === '0.45.0'];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'FAIL'}: ${name}`);
if (failed.length) {
  console.error(`\nNueva Fase 2 falló: ${failed.length}/${checks.length} comprobaciones.`);
  process.exit(1);
}
console.log(`\nOK: Nueva Fase 2 validada (${checks.length} condiciones).`);
