import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectSourcePaths } from './validation/source-release-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveRoot = 'clear-download-manager-source';
const supplementalFiles = [
  'MANIFEST.sha256',
  'package-lock.json',
  'src-tauri/Cargo.lock',
  'extension/native-host/Cargo.lock',
  'src-tauri/resources/licenses/ARIA2-COPYING.txt',
  'src-tauri/resources/licenses/ARIA2-OPENSSL-LICENSE.txt',
  'src-tauri/resources/licenses/ARIA2-NOTICE.txt',
  'src-tauri/resources/licenses/DENO-LICENSE.txt',
  'src-tauri/resources/licenses/DENO-NOTICE.txt',
  'src-tauri/resources/licenses/FFMPEG-BUILD-README.txt',
  'src-tauri/resources/licenses/FFMPEG-LICENSE.txt',
  'src-tauri/resources/licenses/FFMPEG-NOTICE.txt',
  'src-tauri/resources/licenses/README.txt',
  'src-tauri/resources/licenses/THIRD_PARTY_NOTICES.txt',
  'src-tauri/resources/licenses/YT-DLP-LICENSE.txt',
  'src-tauri/resources/licenses/YT-DLP-NOTICE.txt',
  'src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt',
];

function fail(message) {
  console.error(`SOURCE ARCHIVE CREATION FAILED: ${message}`);
  process.exit(1);
}

function parseManifest(text) {
  const files = [];
  const seen = new Set();
  for (const [index, line] of text.replaceAll('\r\n', '\n').split('\n').entries()) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    if (!match) fail(`invalid MANIFEST.sha256 row ${index + 1}`);
    const relative = match[2].replaceAll('\\', '/');
    if (relative.startsWith('/') || relative.split('/').includes('..')) fail(`unsafe source path in MANIFEST.sha256: ${relative}`);
    if (!seen.has(relative)) files.push(relative);
    seen.add(relative);
  }
  return files;
}

const manifest = path.join(root, 'MANIFEST.sha256');
if (!fs.existsSync(manifest)) fail('MANIFEST.sha256 is missing; regenerate it after reviewing source changes.');
const manifestCheck = spawnSync(process.execPath, [path.join(root, 'scripts/generate-source-manifest.mjs'), '--check'], {
  cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
});
if (manifestCheck.error || manifestCheck.status !== 0) {
  fail(`source manifest is stale or invalid: ${manifestCheck.error?.message ?? manifestCheck.stderr ?? 'check failed'}`);
}
const manifestFiles = parseManifest(fs.readFileSync(manifest, 'utf8'));
const relativeFiles = [...new Set([...manifestFiles, ...supplementalFiles])].sort((a, b) => a.localeCompare(b));
const stagedEntries = relativeFiles.map((file) => `${archiveRoot}/${file}`);
const inspected = inspectSourcePaths(stagedEntries);
if (inspected.failures.length) fail(inspected.failures.join('\n'));

const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-source-release-'));
const stagingRoot = path.join(stagingParent, archiveRoot);
const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
const archivePath = path.join(os.tmpdir(), `clear-download-manager-source-${timestamp}.tar`);
if (fs.existsSync(archivePath)) fail(`refusing to overwrite an existing archive: ${archivePath}`);

try {
  for (const relative of relativeFiles) {
    const source = path.resolve(root, relative);
    const destination = path.resolve(stagingRoot, relative);
    if (!source.startsWith(`${root}${path.sep}`) || !destination.startsWith(`${stagingRoot}${path.sep}`)) {
      fail(`path escapes its staging boundary: ${relative}`);
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`required regular source file is missing: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }

  const tar = spawnSync('tar', ['-cf', archivePath, '-C', stagingParent, archiveRoot], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (tar.error || tar.status !== 0) fail(`tar failed: ${tar.error?.message ?? tar.stderr ?? `exit ${tar.status}`}`);
} finally {
  if (fs.existsSync(stagingRoot) && path.resolve(stagingRoot).startsWith(`${path.resolve(stagingParent)}${path.sep}`)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
console.log(JSON.stringify({ archive: archivePath, sha256: digest, files: relativeFiles.length, format: 'tar' }, null, 2));
