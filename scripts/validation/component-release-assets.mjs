import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--directory');
const directory = dirIndex >= 0 ? path.resolve(args[dirIndex + 1] || '') : '';
const required = [
  'component-catalog-v1.json',
  'media-tools-1.0.0.cdmcomponent',
  'torrent-engine-1.0.0.cdmcomponent',
  'ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz',
  'aria2-1.37.0-win64-corresponding-source.tar.xz',
  'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz',
  'YT-DLP-NOTICE.txt',
  'FFMPEG-NOTICE.txt',
  'DENO-NOTICE.txt',
  'ARIA2-NOTICE.txt',
];

function fail(message) {
  console.error(`COMPONENT RELEASE ASSETS FAIL: ${message}`);
  process.exit(1);
}

if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
  fail('pass an existing release assets directory with --directory <path>.');
}

const files = new Map();
for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`release asset must be a regular flat file: ${entry.name}`);
  files.set(entry.name, path.join(directory, entry.name));
}
for (const name of required) if (!files.has(name)) fail(`required exact release asset is missing: ${name}`);
for (const name of files.keys()) {
  if (name === 'component-catalog-payload.json' || name === 'component-catalog-v1.json.sig') {
    fail(`temporary or detached-signature asset is forbidden: ${name}`);
  }
}

const catalog = JSON.parse(fs.readFileSync(files.get('component-catalog-v1.json'), 'utf8'));
const payload = catalog.payload;
if (!payload || typeof catalog.signature !== 'string' || !catalog.signature || Object.keys(catalog).length !== 2) {
  fail('catalog must use the inline {payload, signature} envelope.');
}
if (payload.schemaVersion !== 1 || payload.catalogVersion !== '1' ||
    payload.keyId !== 'component-catalog-2026-01' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
  fail('catalog schema, stable production key ID, or sequence is invalid.');
}
if (!Array.isArray(payload.components) || payload.components.length !== 2) fail('catalog must contain exactly two components.');

const expectedSources = {
  ffmpeg: ['946fcce07b6dcd0331c8cc609192aeff5e1924f8', 'ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz', 'GPL-3.0-or-later'],
  'yt-dlp': ['3a08beaf031ab68f966401ead017ac81fe8486cf', 'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz', 'GPL-3.0-or-later'],
  aria2: ['02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a', 'aria2-1.37.0-win64-corresponding-source.tar.xz', 'GPL-2.0-or-later'],
};
const expectedNotices = {
  'yt-dlp': ['GPL-3.0-or-later', 'YT-DLP-NOTICE.txt'],
  ffmpeg: ['GPL-3.0-or-later', 'FFMPEG-NOTICE.txt'],
  deno: ['MIT', 'DENO-NOTICE.txt'],
  aria2: ['GPL-2.0-or-later', 'ARIA2-NOTICE.txt'],
};
const assetUrl = (name) => `https://github.com/CacaPlay/clear-download-manager/releases/download/${payload.components[0].releaseTag}/${name}`;
function inspectAsset(name, bytes, sha256) {
  const file = files.get(name);
  const actual = fs.readFileSync(file);
  assert.equal(actual.length, bytes, `${name} byte count mismatch`);
  assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), sha256, `${name} SHA-256 mismatch`);
}

const components = new Map(payload.components.map((component) => [component.id, component]));
if (components.size !== 2 || !components.has('media-tools') || !components.has('torrent-engine')) fail('component IDs must be exactly media-tools and torrent-engine.');
for (const [id, name] of [['media-tools', 'media-tools-1.0.0.cdmcomponent'], ['torrent-engine', 'torrent-engine-1.0.0.cdmcomponent']]) {
  const component = components.get(id);
  if (component.version !== '1.0.0' || component.assetName !== name || component.packageUrl !== assetUrl(name)) fail(`${id} package identity or URL does not match the exact release asset.`);
  inspectAsset(name, component.packageBytes, component.packageSha256);
  const seenSources = new Set();
  for (const source of component.correspondingSources || []) {
    const expected = expectedSources[source.runtimeId];
    if (!expected || source.sourceCommit !== expected[0] || source.assetName !== expected[1] || source.license !== expected[2] || source.humanReview !== 'APPROVED' || source.assetUrl !== assetUrl(source.assetName) || seenSources.has(source.runtimeId)) {
      fail(`${id} has an invalid or duplicate source contract for ${source.runtimeId}.`);
    }
    seenSources.add(source.runtimeId);
    inspectAsset(source.assetName, source.bytes, source.sha256);
  }
  const expectedSourceIds = id === 'media-tools' ? ['ffmpeg', 'yt-dlp'] : ['aria2'];
  if (expectedSourceIds.some((runtimeId) => !seenSources.has(runtimeId)) || seenSources.size !== expectedSourceIds.length) fail(`${id} does not link the exact corresponding-source set.`);
  const seenNotices = new Set();
  for (const notice of component.licenseNotices || []) {
    const expected = expectedNotices[notice.runtimeId];
    if (!expected || notice.spdx !== expected[0] || notice.noticeFile !== expected[1] || seenNotices.has(notice.runtimeId)) {
      fail(`${id} has an invalid or duplicate notice mapping for ${notice.runtimeId}.`);
    }
    seenNotices.add(notice.runtimeId);
    const actual = fs.readFileSync(files.get(notice.noticeFile));
    if (crypto.createHash('sha256').update(actual).digest('hex') !== notice.noticeSha256) fail(`${notice.noticeFile} hash does not match the catalog.`);
  }
  const expectedNoticeIds = id === 'media-tools' ? ['yt-dlp', 'ffmpeg', 'deno'] : ['aria2'];
  if (expectedNoticeIds.some((runtimeId) => !seenNotices.has(runtimeId)) || seenNotices.size !== expectedNoticeIds.length) fail(`${id} does not link the exact notice set.`);
}

console.log(`PASS: exact component assets, corresponding sources, notices, and inline catalog links validated (${required.length} required files).`);
