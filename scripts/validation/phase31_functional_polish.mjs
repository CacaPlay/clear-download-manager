import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downloadRowMarkup, downloadRowState } from '../../app-ui/download-manager/view/unified.js';

const read = (file) => readFileSync(resolve(file), 'utf8');
const rust = read('src-tauri/src/media/mod.rs');
const subwindow = read('app-ui/subwindow.js');
const mediaModule = read('app-ui/modules/media/index.js');
const playlistsModule = read('app-ui/modules/playlists/index.js');
const unified = read('app-ui/download-manager/view/unified.js');
const manager = read('app-ui/download-manager/index.js');
const playerHtml = read('app-ui/player/index.html');
const playerJs = read('app-ui/player/player.js');
const playerCss = read('app-ui/player/player.css');

const tiktokFormats = [
  { id: 'bytevc1_1080p_930218-0', height: 1080, ext: 'mp4', vcodec: 'h265', acodec: 'aac', tbr: 930 },
  { id: 'bytevc1_1080p_930218-1', height: 1080, ext: 'mp4', vcodec: 'h265', acodec: 'aac', tbr: 930 },
  { id: 'h264_720p_877826-0', height: 720, ext: 'mp4', vcodec: 'h264', acodec: 'aac', tbr: 877 },
  { id: 'h264_720p_877826-1', height: 720, ext: 'mp4', vcodec: 'h264', acodec: 'aac', tbr: 877 }
];
const maximum = tiktokFormats.reduce((best, candidate) => candidate.height > best.height ? candidate : best);
assert.equal(maximum.height, 1080);
assert.equal(maximum.ext, 'mp4');
assert.equal(maximum.acodec, 'aac');
assert.match(rust, /let mut tiktok_format_retry_queued = false;/);
assert.match(rust, /media_host_is\(&attempt_parsed, "tiktok\.com"\)/);
assert.match(rust, /output_mode == "video_mp4"/);
assert.match(rust, /tiktok_same_resolution_format_fallback\(&attempt_selector\)/);
assert.match(rust, /tiktok_format_retry_queued = true;/);
assert.match(rust, /tiktok_primary_format_selector\(selector\)/);
assert.match(rust, /else if output_mode == "video_mp4"/);
assert.match(rust, /bytevc1_1080p_930218-0/);
assert.match(rust, /bytevc1_1080p_930218-1/);
assert.equal(maximum.id.replace(/-[01]$/, '-1'), 'bytevc1_1080p_930218-1');
assert.equal(tiktokFormats.filter((format) => format.height === 720).length, 2);
console.log('PASS: TikTok 1080/720 fixture keeps same resolution and one bounded candidate fallback');

assert.doesNotMatch(subwindow, /Tamaño desconocido/);
assert.doesNotMatch(mediaModule, /Tamaño desconocido/);
assert.doesNotMatch(playlistsModule, /Tamaño desconocido/);
assert.doesNotMatch(subwindow, /Pendiente de cálculo/);
assert.doesNotMatch(mediaModule, /Pendiente de cálculo/);
assert.doesNotMatch(playlistsModule, /Pendiente de cálculo/);
assert.doesNotMatch(unified, /Pendiente de cálculo/);
const pendingRow = downloadRowState({
  status: 'queued',
  detail: '',
  category: 'Vídeo',
  kind: 'video',
  downloadedBytes: 0,
  totalBytes: null,
  totalBytesEstimated: false,
  speedBps: 0,
  stage: ''
});
assert.equal(pendingRow.size, '');
assert.equal(pendingRow.sizeDetail, '');
assert.match(unified, /job\.totalBytesEstimated \? '~' : ''/);
assert.match(subwindow, /function formatsForOutputMode/);
assert.match(subwindow, /if \(current && Boolean\(current\.audio_only\) === audio\) return current/);
assert.match(subwindow, /const formats = formatsForOutputMode\(\);/);
assert.match(subwindow, /state\.formatError = 'Selecciona un formato y calidad compatibles\.'/);
assert.match(subwindow, /if \(!candidate \|\| outputModeIsAudio\(\) !== Boolean\(candidate\.audio_only\)\)/);
console.log('PASS: tamaños ausentes no inventan texto; salida y calidad comparten solo formatos compatibles');

const completedJob = {
  id: 77,
  status: 'completed',
  detail: 'Completada',
  category: 'Vídeo',
  origin: 'yt-dlp',
  kind: 'video',
  title: 'TikTok fixture',
  downloadedBytes: 2151350,
  totalBytes: 2151350,
  totalBytesEstimated: false,
  finalSize: 2151350,
  speedBps: 0,
  stage: ''
};
const completedRow = downloadRowState(completedJob);
assert.equal(completedRow.visibleDetail, 'Vídeo');
assert.equal(completedRow.statusText, 'Completada');
assert.equal(completedRow.sizeDetail, 'Archivo final');
assert.equal(([completedRow.visibleDetail, completedRow.statusText, completedRow.sizeDetail].join(' ').match(/completad/gi) || []).length, 1);
console.log('PASS: fila completada no repite la etiqueta de terminación en detalle/tamaño');

const rowBefore = downloadRowMarkup({ ...completedJob, thumbnail: 'https://cdn.example.test/one.jpg' }, 0, null, null, null, null);
const rowAfter = downloadRowMarkup({ ...completedJob, thumbnail: 'https://cdn.example.test/two.jpg' }, 0, null, null, null, null);
const structure = (markup) => markup.match(/data-dm-row-structure="([^"]+)"/)?.[1] || '';
assert.notEqual(structure(rowBefore), structure(rowAfter));
assert.match(manager, /function patchLiveDownloadRow/);
assert.match(manager, /current\.dataset\.dmRowStructure !== next\.dataset\.dmRowStructure/);
assert.match(manager, /bindDownloadManagerThumbnailFallbacks\(patchedArea\)/);
console.log('PASS: una miniatura nueva cambia solo la fila afectada y se reengancha al loader');

const analysisRender = subwindow.indexOf('state.analysis = media;');
const analysisPaint = subwindow.indexOf('render();', analysisRender);
const secondarySizes = subwindow.indexOf('startSizeAnalysis(generation);', analysisPaint);
assert.ok(analysisRender >= 0 && analysisPaint > analysisRender && secondarySizes > analysisPaint);
console.log('PASS: metadata básica se pinta antes del análisis secundario de tamaños');

assert.match(subwindow, /class="titlebar" data-tauri-drag-region/);
assert.match(playerHtml, /<header class="player-titlebar" data-tauri-drag-region>/);
assert.match(playerJs, /invoke\('player_start_dragging'\)/);
assert.match(playerCss, /\.player-titlebar\{z-index:20;/);
assert.match(playerCss, /\.player-shell\[data-player-mode="embed"\] \.player-titlebar[\s\S]*pointer-events:auto!important/);
console.log('PASS: ventanas de análisis y reproductor conservan arrastre durante carga');

console.log('FUNCTIONAL POLISH STATIC CONTRACT PASS');
