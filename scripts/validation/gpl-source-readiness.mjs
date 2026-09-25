import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
const manifest = readJson('third-party-source/corresponding-source.json');
const runtime = readJson('src-tauri/resources/bin/runtime-manifest.json');
const fail = [];
const validSha256 = value => /^[a-f0-9]{64}$/i.test(String(value || ''));
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const byId = new Map((manifest.runtimes || []).map(entry => [entry.id, entry]));

if (manifest.schemaVersion !== 1) fail.push('corresponding-source.json: unsupported schemaVersion.');
for (const id of ['aria2', 'ffmpeg']) {
  const entry = byId.get(id);
  if (!entry) {
    fail.push(`${id}: missing GPL runtime record.`);
    continue;
  }
  const expected = id === 'aria2'
    ? { version: runtime.aria2?.version?.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1], binarySha256: runtime.aria2?.executableSha256, binaryArchiveSha256: runtime.aria2?.archiveSha256 }
    : { version: runtime.ffmpeg?.version?.match(/version ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1], binarySha256: runtime.ffmpeg?.ffmpegSha256, ffprobeSha256: runtime.ffmpeg?.ffprobeSha256, binaryArchiveSha256: runtime.ffmpeg?.archiveSha256 };
  for (const [field, value] of Object.entries(expected)) {
    if (!value || entry[field] !== value) fail.push(`${id}.${field}: must match the current runtime manifest (${value || 'missing'}).`);
  }
  if (!entry.binarySourceUrl || !/^https:\/\//.test(entry.binarySourceUrl)) fail.push(`${id}: exact binary source URL is required.`);
  if (!validSha256(entry.binarySha256) || !validSha256(entry.binaryArchiveSha256)) fail.push(`${id}: binary and upstream archive SHA-256 values are required.`);
  if (entry.humanReview?.status !== 'APPROVED' || !entry.humanReview?.reviewRecordPath) fail.push(`${id}: distributor review record is pending.`);
  const method = entry.distributionMethod;
  if (method === 'corresponding-source-archive') {
    for (const [pathField, hashField] of [['sourceArchivePath', 'sourceArchiveSha256'], ['buildInputsPath', 'buildInputsSha256']]) {
      const relative = entry[pathField];
      const expectedHash = entry[hashField];
      const absolute = typeof relative === 'string' ? path.resolve(root, relative) : '';
      if (!relative || !absolute.startsWith(`${path.resolve(root, 'third-party-source')}${path.sep}`) || !fs.existsSync(absolute)) {
        fail.push(`${id}.${pathField}: corresponding source/build inputs are missing under third-party-source/.`);
      } else if (!validSha256(expectedHash) || hashFile(absolute) !== expectedHash.toLowerCase()) {
        fail.push(`${id}.${hashField}: missing or mismatched SHA-256.`);
      }
    }
    if (!entry.releaseAssetName) fail.push(`${id}: releaseAssetName must identify the archive published beside the binaries.`);
  } else if (method === 'written-offer') {
    const relative = entry.writtenOfferPath;
    const absolute = typeof relative === 'string' ? path.resolve(root, relative) : '';
    if (!relative || !absolute.startsWith(`${path.resolve(root, 'third-party-source')}${path.sep}`) || !fs.existsSync(absolute)) {
      fail.push(`${id}: reviewed written offer is missing under third-party-source/.`);
    }
    if (!entry.releaseAssetName) fail.push(`${id}: releaseAssetName must identify the offer published beside the binaries.`);
  } else {
    fail.push(`${id}: distributionMethod must be corresponding-source-archive or written-offer.`);
  }
}

if (manifest.status !== 'READY' || fail.length) {
  console.error('GPL SOURCE READINESS BLOCKED: do not distribute GPL runtime binaries.');
  for (const item of fail) console.error(`- ${item}`);
  if (manifest.status !== 'READY') console.error(`- overall status is ${manifest.status}, not READY.`);
  console.error('This gate checks inventory and file integrity only; the distributor must still determine legal sufficiency.');
  process.exit(1);
}

console.log('GPL source inventory is present and hash-matched. Distributor legal review remains a separate release prerequisite.');
