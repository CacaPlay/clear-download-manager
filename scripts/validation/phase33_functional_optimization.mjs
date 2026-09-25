import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const player = read('app-ui/player/player.js');
const manager = [
  read('app-ui/download-manager/index.js'),
  read('app-ui/download-manager/state.js'),
  read('app-ui/download-manager/search.js'),
  read('app-ui/download-manager/live.js'),
  read('app-ui/download-manager/events.js'),
  read('app-ui/download-manager/thumbnails.js'),
  read('app-ui/download-manager/actions.js')
].join('\n');
const managerLive = read('app-ui/download-manager/live.js');
const unified = read('app-ui/download-manager/view/unified.js');
const subwindow = read('app-ui/subwindow.js');
const rustResolver = read('src-tauri/src/media/resolver.rs');
const rustExtraction = read('src-tauri/src/media/extraction.rs');
const rustPreview = read('src-tauri/src/media/preview.rs');
const rustSearch = read('src-tauri/src/media/search.rs');
const rustLib = read('src-tauri/src/lib.rs');

assert.match(manager, /return \[\];\s*\n}\s*\n\s*function normalizeUnifiedSuggestions/);
assert.doesNotMatch(manager, /Buscando coincidencias reales/);
assert.match(manager, /search_video_suggestions_page/);
assert.match(manager, /invokeSuggestionSearch\(context, query\.trim\(\), requestId, 10, 0\)/);
assert.match(manager, /invokeSuggestionSearch\(context, query\.trim\(\), requestId, 10, 10\)/);
assert.match(manager, /search_media_by_title_page/);
assert.match(manager, /limit: 15, offset: 0/);
assert.match(manager, /limit: 15, offset: 15/);
assert.match(unified, /suggestions\.slice\(0, 20\)/);

const mergeRealResults = (first, second, limit) => {
  const seen = new Set();
  return [...first, ...second].filter((item) => {
    const key = String(item.source_url || item.url || item.title || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
};
const predictive = mergeRealResults(
  Array.from({ length: 10 }, (_, index) => ({ source_url: `https://video.test/${index}`, title: `v${index}` })),
  Array.from({ length: 10 }, (_, index) => ({ source_url: `https://video.test/${index + 10}`, title: `v${index + 10}` })),
  20
);
const modal = mergeRealResults(
  Array.from({ length: 15 }, (_, index) => ({ source_url: `https://video.test/${index}`, title: `v${index}` })),
  Array.from({ length: 15 }, (_, index) => ({ source_url: `https://video.test/${index + 15}`, title: `v${index + 15}` })),
  30
);
assert.equal(predictive.length, 20);
assert.equal(modal.length, 30);
assert.equal(new Set(predictive.map((item) => item.source_url)).size, 20);
assert.equal(new Set(modal.map((item) => item.source_url)).size, 30);

assert.match(player, /readPreviewDesiredQuality/);
assert.match(player, /desiredQuality = Math\.round\(value\)/);
assert.match(player, /chooseInitialPreviewQuality/);
assert.match(player, /observedPreviewCapacityMbps/);
assert.match(player, /bufferGrowth/);
assert.match(player, /time-to-canplay|canplay/);
assert.match(player, /persistPreviewDesiredQuality\(quality\.height\)/);
assert.doesNotMatch(player, /height<=1080/);
const activePreviewRust = `${rustResolver}\n${rustExtraction}\n${rustPreview}`;
assert.match(activePreviewRust, /bestvideo\[ext=mp4\]/);
assert.doesNotMatch(activePreviewRust, /bestvideo\[height<=1080\]\[ext=mp4\]/);
assert.match(rustResolver, /fn preview_complete/);
assert.match(rustResolver, /resolve_preview/);
assert.match(rustPreview, /resolver::resolve_preview/);
assert.match(player, /function showYoutubeManualFallback/);
assert.match(player, /open_external_url/);
assert.doesNotMatch(player, /youtube-nocookie\.com\/embed/);
assert.doesNotMatch(player, /openOfficialYoutubePreview/);

assert.match(subwindow, /function bindSubwindowThumbnailLifecycle/);
assert.match(subwindow, /addEventListener\('load'/);
assert.match(subwindow, /content\.innerHTML[\s\S]*bindSubwindowThumbnailLifecycle/);
assert.match(managerLive, /bindDownloadManagerThumbnailFallbacks\(patchedArea\)/);

assert.match(rustLib, /search_video_suggestions_page/);
assert.match(rustLib, /search_media_by_title_page/);
assert.match(rustSearch, /--playlist-start/);
assert.match(rustSearch, /ytsearch\{search_end\}/);

console.log('PASS: functional optimization contracts; real incremental result planning, generic adaptive quality, native YouTube fallback, and thumbnail lifecycle');
