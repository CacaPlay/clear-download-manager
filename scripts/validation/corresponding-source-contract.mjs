import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = {
  aria2: {
    license: 'GPL-2.0-or-later',
    sourceRepository: 'https://github.com/aria2/aria2',
    sourceVersion: 'release-1.37.0',
    sourceCommit: '02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a',
    expectedFiles: runtime => [
      { name: 'aria2c.exe', sha256: runtime.aria2?.executableSha256 },
    ],
  },
  ffmpeg: {
    license: 'GPL-3.0-or-later',
    sourceRepository: 'https://github.com/FFmpeg/FFmpeg',
    sourceVersion: 'n9.0.2',
    sourceCommit: '946fcce07b6dcd0331c8cc609192aeff5e1924f8',
    expectedFiles: runtime => [
      { name: 'ffmpeg.exe', sha256: runtime.ffmpeg?.ffmpegSha256 },
      { name: 'ffprobe.exe', sha256: runtime.ffmpeg?.ffprobeSha256 },
    ],
  },
  'yt-dlp': {
    runtimeKey: 'ytDlp',
    license: 'GPL-3.0-or-later',
    sourceRepository: 'https://github.com/yt-dlp/yt-dlp',
    sourceVersion: '2026.08.19',
    sourceCommit: '3a08beaf031ab68f966401ead017ac81fe8486cf',
    distributionAssetHashField: 'binaryAssetSha256',
    distributionAssetHash: runtime => runtime.ytDlp?.officialAssetSha256,
    expectedFiles: runtime => [
      { name: 'yt-dlp.exe', sha256: runtime.ytDlp?.sha256 },
    ],
  },
};

const ALLOWED_ENTRY_KEYS = new Set([
  'id', 'version', 'sourceRepository', 'sourceVersion', 'sourceCommit', 'license',
  'binarySha256', 'ffprobeSha256', 'binarySourceUrl', 'binaryArchiveSha256', 'binaryAssetSha256',
  'buildConfigurationEvidence', 'runtimeFiles', 'distributionMethod',
  'sourceArchivePath', 'sourceArchiveSha256', 'buildInputsPath', 'buildInputsSha256',
  'releaseAssetName', 'releaseAssetSha256', 'writtenOfferPath', 'writtenOfferSha256',
  'humanReview',
]);

const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const validSha256 = value => typeof value === 'string' && sha256Pattern.test(value);
const expectedSourceAssetName = (id, version) => {
  if (id === 'aria2') return `aria2-${version}-win64-corresponding-source.tar.xz`;
  if (id === 'yt-dlp') return `yt-dlp-${version}-win64-corresponding-source.tar.xz`;
  return `ffmpeg-${version}-essentials-win64-corresponding-source.tar.xz`;
};

function addFileState(issues, root, relative, expectedHash, label) {
  if (relative == null || expectedHash == null) {
    issues.pending.push(`${label}: archive/input and SHA-256 are not recorded.`);
    return null;
  }
  if (typeof relative !== 'string' || !relative.trim()) {
    issues.failures.push(`${label}: path must be a non-empty relative path.`);
    return null;
  }
  if (!validSha256(expectedHash)) {
    issues.failures.push(`${label}: SHA-256 must contain exactly 64 lowercase hexadecimal characters.`);
    return null;
  }
  const base = path.resolve(root, 'third-party-source');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${base}${path.sep}`)) {
    issues.failures.push(`${label}: path must remain inside third-party-source/.`);
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    issues.pending.push(`${label}: file is not present under third-party-source/.`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    issues.failures.push(`${label}: must be a regular file, not a link or directory.`);
    return null;
  }
  const actualHash = digest(absolute);
  if (actualHash !== expectedHash) {
    issues.failures.push(`${label}: SHA-256 does not match the file.`);
    return null;
  }
  return actualHash;
}

export function validateCorrespondingSourceRegistry(manifest, runtime, root) {
  const issues = { failures: [], pending: [] };
  if (manifest?.schemaVersion !== 2) issues.failures.push('corresponding-source.json: schemaVersion must be 2.');
  if (!['PENDING', 'READY'].includes(manifest?.status)) {
    issues.failures.push('corresponding-source.json: status must be PENDING or READY.');
  }
  if (!Array.isArray(manifest?.runtimes)) {
    issues.failures.push('corresponding-source.json: runtimes must be an array.');
    return issues;
  }

  const entriesById = new Map();
  for (const entry of manifest.runtimes) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      issues.failures.push('corresponding-source.json: every runtime record must have an id.');
      continue;
    }
    if (entriesById.has(entry.id)) issues.failures.push(`${entry.id}: duplicate runtime record.`);
    entriesById.set(entry.id, entry);
    const unknownKeys = Object.keys(entry).filter(key => !ALLOWED_ENTRY_KEYS.has(key));
    if (unknownKeys.length) issues.failures.push(`${entry.id}: unsupported fields: ${unknownKeys.join(', ')}.`);
  }
  for (const id of Object.keys(REQUIRED)) {
    if (!entriesById.has(id)) issues.failures.push(`${id}: required runtime record is missing.`);
  }
  for (const id of entriesById.keys()) {
    if (!Object.hasOwn(REQUIRED, id)) issues.failures.push(`${id}: unexpected runtime record.`);
  }
  if (entriesById.size !== Object.keys(REQUIRED).length) return issues;

  for (const [id, spec] of Object.entries(REQUIRED)) {
    const entry = entriesById.get(id);
    const runtimeRecord = runtime?.[spec.runtimeKey || id];
    if (!runtimeRecord) {
      issues.failures.push(`${id}: runtime manifest record is missing.`);
      continue;
    }
    const outputVersion = String(runtimeRecord.version || '').match(/(?:version )?([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
    if (!outputVersion || entry.version !== outputVersion) {
      issues.failures.push(`${id}.version: must match the runtime manifest version.`);
    }
    for (const field of ['sourceRepository', 'sourceVersion']) {
      const expected = field === 'sourceRepository' ? spec.sourceRepository : spec.sourceVersion;
      if (entry[field] !== expected || runtimeRecord[field] !== expected) {
        issues.failures.push(`${id}.${field}: must match the pinned upstream source identity.`);
      }
    }
    if (!commitPattern.test(entry.sourceCommit || '') || entry.sourceCommit !== spec.sourceCommit || runtimeRecord.sourceCommit !== spec.sourceCommit) {
      issues.failures.push(`${id}.sourceCommit: the full pinned 40-character source commit matching runtime-manifest.json is required.`);
    }
    if (entry.license !== spec.license || (id === 'yt-dlp' && runtimeRecord.effectiveLicense !== spec.license)) {
      issues.failures.push(`${id}.license: does not match the verified runtime license metadata.`);
    }
    if (!/^https:\/\//.test(entry.binarySourceUrl || '') || entry.binarySourceUrl !== runtimeRecord.source) {
      issues.failures.push(`${id}.binarySourceUrl: must exactly match the pinned runtime source URL.`);
    }
    const assetHashField = spec.distributionAssetHashField || 'binaryArchiveSha256';
    const expectedAssetHash = spec.distributionAssetHash ? spec.distributionAssetHash(runtime) : runtimeRecord.archiveSha256;
    if (!validSha256(entry[assetHashField]) || entry[assetHashField] !== expectedAssetHash) {
      issues.failures.push(`${id}.${assetHashField}: a full SHA-256 matching the exact upstream distribution asset in runtime-manifest.json is required.`);
    }
    if (assetHashField !== 'binaryAssetSha256' && entry.binaryAssetSha256 != null) {
      issues.failures.push(`${id}.binaryAssetSha256: is only valid for a directly distributed executable asset.`);
    }
    if (assetHashField !== 'binaryArchiveSha256' && entry.binaryArchiveSha256 != null) {
      issues.failures.push(`${id}.binaryArchiveSha256: is only valid for an upstream archive asset.`);
    }
    const expectedFiles = spec.expectedFiles(runtime);
    if (id === 'aria2' && entry.binarySha256 !== expectedFiles[0].sha256) {
      issues.failures.push('aria2.binarySha256: must match the aria2c.exe runtime hash.');
    }
    if (id === 'ffmpeg' && (entry.binarySha256 !== expectedFiles[0].sha256 || entry.ffprobeSha256 !== expectedFiles[1].sha256)) {
      issues.failures.push('ffmpeg binary hashes: ffmpeg.exe and ffprobe.exe must match runtime-manifest.json.');
    }
    for (const file of expectedFiles) {
      if (!validSha256(file.sha256)) issues.failures.push(`${id}: runtime-manifest.json is missing the full SHA-256 for ${file.name}.`);
    }
    if (!validSha256(entry.binarySha256)) issues.failures.push(`${id}.binarySha256: a full SHA-256 is required.`);
    if (id === 'ffmpeg' && !validSha256(entry.ffprobeSha256)) issues.failures.push('ffmpeg.ffprobeSha256: a full SHA-256 is required.');

    const expectedName = expectedSourceAssetName(id, entry.version);
    if (entry.releaseAssetName !== expectedName || /[\\/]/.test(entry.releaseAssetName || '')) {
      issues.failures.push(`${id}.releaseAssetName: must be exactly ${expectedName}.`);
    }
    const expectedRuntimeFiles = expectedFiles.map(file => ({
      name: file.name,
      sha256: file.sha256,
      correspondingSourceAsset: expectedName,
    }));
    if (JSON.stringify(entry.runtimeFiles) !== JSON.stringify(expectedRuntimeFiles)) {
      issues.failures.push(`${id}.runtimeFiles: exact runtime filenames, hashes, and corresponding-source asset links are required.`);
    }

    const review = entry.humanReview;
    if (!review || review.required !== true || !['PENDING', 'APPROVED'].includes(review.status)) {
      issues.failures.push(`${id}.humanReview: explicit required=true and a PENDING or APPROVED status are mandatory.`);
    } else if (review.status !== 'APPROVED') {
      issues.pending.push(`${id}: distributor human review is still required.`);
    } else {
      if (typeof review.reviewRecordPath !== 'string' || !review.reviewRecordPath) {
        issues.failures.push(`${id}: an approved human review must reference its review record.`);
      } else {
        addFileState(issues, root, review.reviewRecordPath, review.reviewRecordSha256, `${id}.humanReview`);
      }
    }

    if (entry.distributionMethod === 'corresponding-source-archive') {
      const sourceHash = addFileState(issues, root, entry.sourceArchivePath, entry.sourceArchiveSha256, `${id}.sourceArchive`);
      addFileState(issues, root, entry.buildInputsPath, entry.buildInputsSha256, `${id}.buildInputs`);
      if (entry.releaseAssetSha256 == null) {
        issues.pending.push(`${id}: release asset SHA-256 is not recorded.`);
      } else if (!validSha256(entry.releaseAssetSha256) || sourceHash && entry.releaseAssetSha256 !== sourceHash) {
        issues.failures.push(`${id}: release asset hash must be a full SHA-256 equal to the corresponding-source archive hash.`);
      }
    } else if (entry.distributionMethod === 'written-offer') {
      const offerHash = addFileState(issues, root, entry.writtenOfferPath, entry.writtenOfferSha256, `${id}.writtenOffer`);
      if (entry.releaseAssetSha256 == null) {
        issues.pending.push(`${id}: release asset SHA-256 is not recorded.`);
      } else if (!validSha256(entry.releaseAssetSha256) || offerHash && entry.releaseAssetSha256 !== offerHash) {
        issues.failures.push(`${id}: release asset hash must be a full SHA-256 equal to the written-offer hash.`);
      }
    } else if (entry.distributionMethod == null) {
      issues.pending.push(`${id}: distributor has not selected an approved distribution method.`);
    } else {
      issues.failures.push(`${id}.distributionMethod: must be corresponding-source-archive or written-offer.`);
    }
  }
  if (manifest.status === 'PENDING') issues.pending.push('overall corresponding-source status is PENDING.');
  return issues;
}

export function inspectCorrespondingSourceReleaseAssets(manifest, directory) {
  const issues = { failures: [], pending: [] };
  if (!directory) {
    issues.pending.push('no --release-assets-dir was supplied.');
    return issues;
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(directory);
  } catch {
    issues.failures.push('release assets directory does not exist.');
    return issues;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    issues.failures.push('release assets path must be a real directory.');
    return issues;
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const records = new Map((manifest?.runtimes || []).map(entry => [entry.id, entry]));
  for (const id of Object.keys(REQUIRED)) {
    const record = records.get(id);
    if (!record || typeof record.releaseAssetName !== 'string' || !record.releaseAssetName || /[\\/]/.test(record.releaseAssetName)) {
      issues.failures.push(`${id}: exact corresponding-source release asset name is missing or invalid.`);
      continue;
    }
    const exact = entries.filter(entry => entry.name === record.releaseAssetName);
    const caseOnly = entries.some(entry => entry.name.toLowerCase() === record.releaseAssetName.toLowerCase());
    if (!exact.length) {
      if (caseOnly) issues.failures.push(`${id}: release asset filename must exactly match ${record.releaseAssetName}.`);
      else issues.pending.push(`${id}: exact release asset ${record.releaseAssetName} is not present.`);
      continue;
    }
    if (exact.length !== 1 || exact[0].isSymbolicLink() || !exact[0].isFile()) {
      issues.failures.push(`${id}: exact release asset must be one regular file named ${record.releaseAssetName}.`);
      continue;
    }
    const expectedHash = record.releaseAssetSha256;
    if (expectedHash == null) {
      issues.pending.push(`${id}: release asset SHA-256 is not recorded.`);
      continue;
    }
    if (!validSha256(expectedHash)) {
      issues.failures.push(`${id}: release asset SHA-256 must contain exactly 64 lowercase hexadecimal characters.`);
      continue;
    }
    const actualHash = digest(path.join(directory, exact[0].name));
    if (actualHash !== expectedHash) issues.failures.push(`${id}: exact release asset SHA-256 does not match the approved registry.`);
  }
  return issues;
}
