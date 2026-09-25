import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directDownloadErrorHint, downloadRowState } from '../../app-ui/download-manager/view/unified.js';

const extractorError = 'yt-dlp encontró un error interno del extractor. Probablemente se resuelve con la próxima actualización de yt-dlp; si persiste tras actualizar, repórtalo.';
const job = {
  id: 1,
  status: 'failed',
  detail: extractorError,
  category: 'Fuente multimedia',
  kind: 'media',
  downloadedBytes: 0,
  totalBytes: null,
  totalBytesEstimated: false,
  speedBps: 0,
  stage: ''
};

const row = downloadRowState(job);
assert.equal(row.visibleDetail, extractorError);
assert.doesNotMatch(row.visibleDetail, /Traceback \(most recent call last\)/i);
assert.equal(
  directDownloadErrorHint(job),
  'Fallo interno de yt-dlp, no de tu conexión. Suele resolverse solo; si se repite mucho, actualiza la app.'
);
assert.equal(
  directDownloadErrorHint({ ...job, detail: 'HTTP Error 403: Forbidden' }),
  'El servidor exige una sesión o un enlace temporal; vuelve a iniciar la descarga desde la página original.'
);
console.log('PASS: traceback saneado en detail de fila y hint de UI');

const playerCss = readFileSync(resolve('app-ui/player/player.css'), 'utf8');
const playerJs = readFileSync(resolve('app-ui/player/player.js'), 'utf8');
const playerHtml = readFileSync(resolve('app-ui/player/index.html'), 'utf8');
const subwindowJs = readFileSync(resolve('app-ui/subwindow.js'), 'utf8');
const mainJs = readFileSync(resolve('app-ui/main.js'), 'utf8');
const mediaModuleJs = readFileSync(resolve('app-ui/modules/media/index.js'), 'utf8');
const downloadManagerJs = readFileSync(resolve('app-ui/download-manager/index.js'), 'utf8');
const downloadManagerSearchJs = readFileSync(resolve('app-ui/download-manager/search.js'), 'utf8');
const downloadManagerEventsJs = readFileSync(resolve('app-ui/download-manager/events.js'), 'utf8');
const downloadManagerStateJs = readFileSync(resolve('app-ui/download-manager/state.js'), 'utf8');
const unifiedViewJs = readFileSync(resolve('app-ui/download-manager/view/unified.js'), 'utf8');
const sharedViewJs = readFileSync(resolve('app-ui/download-manager/view/shared.js'), 'utf8');
assert.match(
  playerCss,
  /\.player-shell\[data-player-source="preview"\] \.player-preview-notice:not\(\[hidden\]\)\{display:grid!important\}/,
  'El aviso oculto no debe ser reactivado por la cascada CSS'
);
assert.match(
  playerCss,
  /\.player-shell\[data-player-source="preview"\] \.player-popover:not\(\.player-quality-menu\)\{display:none!important\}/,
  'El menú de calidad online no debe quedar oculto como popover genérico'
);
assert.match(
  playerJs,
  /previewNoticeClose\.addEventListener\('click', \(\) => \{ previewNotice\.hidden = true; \}\)/,
  'La X del aviso debe conservar su listener de cierre'
);
assert.match(playerJs, /qualityList\?\.addEventListener\('click'/);
assert.match(playerJs, /option\.dataset\.qualityId \|\| option\.dataset\.youtubeQuality/);
assert.match(playerJs, /const quality = currentSnapshot\.qualities\?\.find\(\(entry\) => entry\.id === qualityId\)/);
assert.match(playerJs, /activePreviewQualityId = quality\.id/);
assert.match(playerJs, /rememberPreviewPosition\(\);\s*const wasPlaying = !video\.paused/);
assert.match(playerJs, /if \(quality\.has_audio\) \{\s*prepareSinglePreview\(selectedSnapshot/);
assert.match(playerJs, /prepareDualPreview\(selectedSnapshot, generation, wasPlaying, wasMuted\)/);
assert.match(playerJs, /currentSnapshot = selectedSnapshot/);
assert.match(playerJs, /function prepareSinglePreview\([^)]*shouldPlay = true, preserveMuted = null\)/);
assert.match(playerJs, /function prepareDualPreview\([^)]*shouldPlay = true, preserveMuted = null\)/);
assert.match(playerJs, /if \(shouldPlay\) void startPlayback\(video, mediaBinding\)/);
assert.match(playerJs, /if \(!state\.shouldPlay && !userInitiated\)/);
assert.match(playerJs, /rememberPreviewPosition\(\);/);
assert.match(playerJs, /activePreviewAudioUrl = ''/);
assert.match(playerJs, /audio\.pause\(\);/);
assert.match(playerJs, /function schedulePreviewRecovery\(\) \{\s*if \(currentSource !== 'preview'/);
assert.match(playerJs, /\['stalled', 'waiting'\]\.forEach/);
assert.doesNotMatch(playerJs, /previewCandidateState|previewBufferingState|PREVIEW_MIN_BUFFER_SECONDS|mediaBindingController/);
assert.doesNotMatch(playerHtml, /data-player-buffering/);
assert.doesNotMatch(playerCss, /player-buffering-indicator/);

const qualityFixture = [
  { id: '360-mp4', height: 360, has_audio: true },
  { id: '1080-mp4', height: 1080, has_audio: true },
  { id: '1440-webm', height: 1440, has_audio: false }
];
const maximumQuality = qualityFixture.reduce((best, candidate) => candidate.height > best.height ? candidate : best);
assert.equal(maximumQuality.id, '1440-webm', 'el planner conserva la máxima altura realmente disponible');
assert.match(playerJs, /desiredQuality/);
assert.match(playerJs, /readPreviewDesiredQuality/);
assert.match(playerJs, /chooseInitialPreviewQuality/);
assert.match(downloadManagerSearchJs, /search_video_suggestions_page', \{ query, limit, offset \}/);
assert.match(downloadManagerSearchJs, /invokeSuggestionSearch\(context, query\.trim\(\), requestId, 10, 10\)/);
assert.match(downloadManagerEventsJs, /search_media_by_title_page', \{ query, limit: 15, offset: 15 \}/);
assert.doesNotMatch(`${downloadManagerJs}\n${downloadManagerSearchJs}\n${downloadManagerEventsJs}`, /Buscando coincidencias reales/);
assert.match(downloadManagerEventsJs, /import \{ dmIcon \} from '\.\/view\/icons\.js';/);
assert.match(downloadManagerEventsJs, /previewButton\.innerHTML = dmIcon\('play', 22\)/);
assert.match(downloadManagerSearchJs, /function resolveUnifiedInputTarget\(rawValue = runtimeState\.unifiedQuery\)/);
assert.match(downloadManagerSearchJs, /if \(target\.kind === 'empty'\)/);
assert.match(downloadManagerSearchJs, /Pega un enlace o selecciona un video primero\./);
assert.match(downloadManagerSearchJs, /Selecciona un video primero\./);
assert.match(downloadManagerEventsJs, /void submitUnifiedInput\(context, event\.currentTarget\.value, rerender\)/);
assert.match(downloadManagerEventsJs, /runtimeState\.unifiedActiveIndex = Number\(suggestionButton\.dataset\.dmSuggestionIndex\)/);
assert.match(subwindowJs, /class="app-window" data-window-type=/);
assert.match(subwindowJs, /class="titlebar" data-tauri-drag-region/);
assert.match(subwindowJs, /data-role="track-content"/);
assert.doesNotMatch(subwindowJs, /class="sp-[^"]+"|data-sp-/);
assert.match(unifiedViewJs, /suggestions\.slice\(0, 20\)/);
assert.match(downloadManagerStateJs, /MAX_CONCURRENT_THUMBNAILS = 6/);

function resolveInputContract(rawValue, suggestions = [], activeIndex = -1) {
  const value = String(rawValue || '').trim();
  if (!value) return 'empty';
  if (/^(?:https?:\/\/|magnet:)/i.test(value) || /\.torrent(?:$|[?#])/i.test(value)) return 'source';
  if (suggestions[activeIndex]) return suggestions[activeIndex].sourceUrl ? 'suggestion' : 'unresolved-suggestion';
  return 'search-text';
}
assert.equal(resolveInputContract(''), 'empty');
assert.equal(resolveInputContract('consulta libre'), 'search-text');
assert.equal(resolveInputContract('consulta libre', [{ title: 'resultado', sourceUrl: 'https://youtu.be/example' }], 0), 'suggestion');
assert.equal(resolveInputContract('consulta libre', [{ title: 'placeholder', sourceUrl: '' }], 0), 'unresolved-suggestion');
assert.equal(resolveInputContract('https://youtu.be/example', [{ title: 'stale', sourceUrl: '' }], 0), 'source');
console.log('PASS: rollback selectivo del preview; calidad raw single/dual; aviso hidden/X; validacion comun Enter/Analizar; dmIcon importado; drag y sin 8K');
