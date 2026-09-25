import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configureMedia, preferredVideoFormat } from '../../app-ui/modules/media/index.js';
import { preferredExtensionMediaFormat } from '../../app-ui/modules/extension/index.js';

const subwindow = fs.readFileSync('app-ui/subwindow.js', 'utf8');
const shared = fs.readFileSync('app-ui/download-manager/view/shared.js', 'utf8');
const rust = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const formatRust = fs.readFileSync('src-tauri/src/media/formats.rs', 'utf8');
const mediaRust = fs.readFileSync('src-tauri/src/media/mod.rs', 'utf8');
const qualities = ['144', '240', '360', '480', '720', '1080', '1440', '2160'];
const normalize = (value) => qualities.includes(String(value)) ? String(value) : 'best';

configureMedia({ getAppState: () => ({ selectedVideoQuality: 'best' }), normalizeVideoQuality: normalize });
const formats = qualities.map((height) => ({ id: `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best[height<=${height}]`, resolution: `${height}p`, label: `${height}p · vídeo + audio`, audio_only: false }));
for (const quality of qualities) {
  const selected = preferredVideoFormat(formats, quality);
  assert.equal(selected?.resolution, `${quality}p`, `frontend must select ${quality}p`);
}
assert.equal(preferredVideoFormat([{ id: '720', resolution: '720p', audio_only: false }], '144'), null, 'no explicit quality may fall back above its cap');
for (const quality of ['144p', '480p', '720p', '1080p']) {
  const selector = preferredExtensionMediaFormat({ preferredQuality: quality }).formatSelector;
  assert.match(selector, new RegExp(`height<=${quality.replace('p', '')}`));
  assert.doesNotMatch(selector, /bestvideo\+bestaudio\/best$/);
}
assert.match(subwindow, /VIDEO_QUALITY_VALUES = new Set\(\['best'.*'144'\]\)/s);
assert.match(subwindow, /height<=\$\{quality\}/);
assert.match(subwindow, /selectorHasUnsafeBestFallback/);
assert.match(subwindow, /state\.videoQuality !== 'best' && selectorHasUnsafeBestFallback/);
for (const quality of qualities) assert.match(shared, new RegExp(`value="${quality}"`));
assert.match(rust, /2160, 1440, 1080, 720, 480, 360, 240, 144/);
assert.match(formatRust, /best\[height<=\{max_height\}\]/);
assert.match(mediaRust, /bv\*\[ext=mp4\]\[height<=\{height\}\]/);
console.log('PASS: explicit multimedia quality remains capped from UI through extension and Rust selectors; Best remains separate.');
