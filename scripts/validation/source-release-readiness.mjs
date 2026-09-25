import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateSourceReadiness, inspectSourcePaths, SOURCE_ONLY_GATE_IDS } from './source-release-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const archiveFlag = args.indexOf('--archive');
const archivePath = archiveFlag >= 0 ? path.resolve(args[archiveFlag + 1] || '') : '';
const expectedSupplementalFiles = new Set([
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
]);
const checks = [];
const failures = [];

function run(executable, commandArgs, cwd, label) {
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return { label, status: result.error ? 'FAIL' : result.status === 0 ? 'PASS' : 'FAIL', output, error: result.error?.message };
}

function listTar(archive, argsForTar) {
  const result = spawnSync('tar', argsForTar, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `tar exit ${result.status}`);
  return result.stdout;
}

if (!archivePath || archiveFlag + 1 >= args.length || !fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
  console.error('SOURCE RELEASE PENDING: pass an existing source archive with --archive <path>.');
  process.exit(2);
}

let extractedRoot;
let archiveFiles;
try {
  const listed = listTar(archivePath, ['-tf', archivePath]).split(/\r?\n/).filter((entry) => entry && !entry.endsWith('/'));
  const verbose = listTar(archivePath, ['-tvf', archivePath]).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => /^[lh]/.test(line))) failures.push('archive contains a symbolic or hard link; links are not allowed.');
  const inspection = inspectSourcePaths(listed);
  failures.push(...inspection.failures);
  archiveFiles = inspection.paths;

  const topLevels = new Set(listed.map((entry) => entry.replaceAll('\\', '/').split('/')[0]));
  if (topLevels.size !== 1 || !topLevels.has('clear-download-manager-source')) {
    failures.push('archive must contain only the clear-download-manager-source/ root.');
  }
  if (failures.length) throw new Error('archive entry validation failed');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-source-gate-'));
  const extracted = spawnSync('tar', ['-xf', archivePath, '-C', tempRoot], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (extracted.error || extracted.status !== 0) throw new Error(extracted.error?.message ?? extracted.stderr ?? `tar extract exit ${extracted.status}`);
  extractedRoot = path.join(tempRoot, 'clear-download-manager-source');
  if (!fs.existsSync(extractedRoot) || !fs.statSync(extractedRoot).isDirectory()) throw new Error('archive root did not extract as a directory.');

  const manifestPath = path.join(extractedRoot, 'MANIFEST.sha256');
  const manifestFiles = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^[a-f0-9]{64}  (.+)$/i.exec(line);
    if (!match) throw new Error('archive MANIFEST.sha256 contains an invalid row.');
    return match[1].replaceAll('\\', '/');
  });
  const expectedFiles = new Set([...manifestFiles, ...expectedSupplementalFiles]);
  const actualFiles = new Set(archiveFiles.map((entry) => entry.replace(/^clear-download-manager-source\//, '')));
  const missing = [...expectedFiles].filter((entry) => !actualFiles.has(entry));
  const unexpected = [...actualFiles].filter((entry) => !expectedFiles.has(entry));
  if (missing.length || unexpected.length) {
    if (missing.length) failures.push(`archive is missing ${missing.length} manifested/supplemental source file(s): ${missing.slice(0, 10).join(', ')}`);
    if (unexpected.length) failures.push(`archive contains ${unexpected.length} unmanifested file(s): ${unexpected.slice(0, 10).join(', ')}`);
  }
} catch (error) {
  if (error.message !== 'archive entry validation failed') failures.push(error.message);
}

if (!failures.length && extractedRoot) {
  // Intentionally does not invoke check:gpl-source or verify:binaries: the
  // exact artifact under review is a source archive with runtime binaries out.
  const gateScripts = new Map([
    ['check:manifest', ['scripts/generate-source-manifest.mjs', ['--check']]],
    ['check:manifest:scope', ['scripts/validation/source-manifest-scope.mjs', []]],
    ['check:licenses', ['scripts/validation/license-readiness.mjs', []]],
    ['check:rights', ['scripts/validation/rights-readiness.mjs', []]],
    ['check:asset-rights', ['scripts/validation/asset-distribution-readiness.mjs', []]],
    ['check:asset-provenance', ['scripts/validation/asset-provenance-readiness.mjs', []]],
    ['check:assets', ['scripts/validation/assets-brand-minimization.mjs', []]],
    ['check:source-boundaries', ['scripts/validation/source-boundaries.mjs', []]],
    ['check:source-secrets', ['scripts/validation/source-secret-scan.mjs', []]],
  ]);
  const gates = SOURCE_ONLY_GATE_IDS.map((id) => [id, ...(gateScripts.get(id) || [])]);
  if (gates.some(([, script]) => !script) || gateScripts.size !== SOURCE_ONLY_GATE_IDS.length) {
    failures.push('source-only gate registry is inconsistent.');
  }
  const rights = JSON.parse(fs.readFileSync(path.join(extractedRoot, 'rights/release-rights.json'), 'utf8'));
  for (const [label, script, scriptArgs] of gates) {
    const result = run(process.execPath, [script, ...scriptArgs], extractedRoot, label);
    const isExpectedRightsPending = label === 'check:rights'
      && rights.status === 'PENDING'
      && result.output.includes('FIRST-PARTY RIGHTS READINESS BLOCKED')
      && result.output.includes('overall rights status is PENDING, not READY');
    const isExpectedAssetPending = label === 'check:asset-provenance'
      && result.output.includes('ASSET PROVENANCE PENDING:')
      && !result.output.includes('ASSET PROVENANCE INVENTORY INVALID');
    if (isExpectedRightsPending || isExpectedAssetPending) result.status = 'PENDING';
    if (result.status === 'FAIL') failures.push(`${label}: ${result.error || result.output.trim().split(/\r?\n/).slice(-4).join(' | ')}`);
    checks.push({ id: label, status: result.status });
    console.log(`${result.status}: ${label}`);
  }
}

const integrity = evaluateSourceReadiness([
  { id: 'archive-inspection', status: failures.length ? 'FAIL' : 'PASS' },
  ...checks,
]);
const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
const runtimeCount = archiveFiles?.filter((entry) => /\/src-tauri\/resources\/bin\/[^/]+\.exe$/i.test(`/${entry}`)
  || /\/(?:aria2c|ffmpeg|ffprobe)\.exe$/i.test(`/${entry}`)).length ?? 0;
const installerCount = archiveFiles?.filter((entry) => /\.(?:msi|msix|msixbundle|appx|appxbundle|nsis)$/i.test(entry)).length ?? 0;
const personalPdfCount = archiveFiles?.filter((entry) => /\.pdf$/i.test(entry)).length ?? 0;

console.log(`Archive SHA-256: ${digest}`);
console.log(`Archive source files: ${archiveFiles?.length ?? 0}`);
console.log(`Runtime binaries: ${runtimeCount}; installer/package binaries: ${installerCount}; PDFs: ${personalPdfCount}`);
for (const failure of failures) console.error(`FAIL: ${failure}`);
if (integrity.failures.length) {
  console.error(`SOURCE RELEASE READINESS FAIL (${integrity.failures.join(', ')})`);
  process.exit(1);
}
if (integrity.status === 'PENDING') {
  console.error(`SOURCE RELEASE READINESS PENDING (${integrity.blockers.join(', ')}). The archive is sanitized, but cannot be declared ready.`);
  process.exit(2);
}
console.log('SOURCE RELEASE READINESS PASS.');
