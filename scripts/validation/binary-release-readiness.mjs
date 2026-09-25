import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCorrespondingSourceReleaseAssets } from './corresponding-source-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};
const sourceArchive = value('--source-archive') ? path.resolve(value('--source-archive')) : '';
const packagePath = value('--package') ? path.resolve(value('--package')) : '';
const inspectionRoot = value('--inspection-dir') ? path.resolve(value('--inspection-dir')) : '';
const releaseAssetsDir = value('--release-assets-dir') ? path.resolve(value('--release-assets-dir')) : '';
const checks = [];
const failures = [];
const pending = [];

function run(label, script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) checks.push({ label, status: 'PASS' });
  else if (result.status === 2 || (output.includes('PENDING') && !output.includes('FAIL:'))) {
    checks.push({ label, status: 'PENDING' });
    pending.push(label);
  } else {
    checks.push({ label, status: 'FAIL' });
    failures.push(`${label}: ${output.trim().split(/\r?\n/).slice(-4).join(' | ')}`);
  }
  console.log(`${checks.at(-1).status}: ${label}`);
}

function inventory(directory) {
  const files = [];
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`package inspection contains a symbolic link: ${child}`);
      if (entry.isDirectory()) walk(absolute, child);
      else if (entry.isFile()) files.push({ path: child, absolute });
    }
  };
  walk(directory);
  return files;
}

if (sourceArchive) run('source-release gate', 'scripts/validation/source-release-readiness.mjs', ['--archive', sourceArchive]);
else {
  pending.push('source-release gate');
  checks.push({ label: 'source-release gate', status: 'PENDING' });
  console.log('PENDING: source-release gate (no --source-archive supplied)');
}
run('check:gpl-source', 'scripts/validation/gpl-source-readiness.mjs');
run('verify:binaries', 'scripts/verify-binaries.mjs');

try {
  const sourceRegistry = JSON.parse(fs.readFileSync(path.join(root, 'third-party-source/corresponding-source.json'), 'utf8'));
  const sourceAssetIssues = inspectCorrespondingSourceReleaseAssets(sourceRegistry, releaseAssetsDir);
  for (const issue of sourceAssetIssues.failures) failures.push(`corresponding-source assets: ${issue}`);
  for (const issue of sourceAssetIssues.pending) pending.push(`corresponding-source assets: ${issue}`);
  const status = sourceAssetIssues.failures.length ? 'FAIL' : sourceAssetIssues.pending.length ? 'PENDING' : 'PASS';
  console.log(`${status}: exact runtime-linked corresponding-source release assets`);
  for (const issue of sourceAssetIssues.failures) console.error(`FAIL: corresponding-source assets: ${issue}`);
  for (const issue of sourceAssetIssues.pending) console.log(`PENDING: corresponding-source assets: ${issue}`);
} catch (error) {
  failures.push(`corresponding-source assets: ${error.message}`);
}

if (!packagePath || !fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
  pending.push('package inspection');
  checks.push({ label: 'package inspection', status: 'PENDING' });
  console.log('PENDING: package inspection (no existing package supplied)');
} else if (!inspectionRoot || !fs.existsSync(inspectionRoot) || !fs.statSync(inspectionRoot).isDirectory()) {
  pending.push('package inspection');
  checks.push({ label: 'package inspection', status: 'PENDING' });
  console.log('PENDING: package inspection (an expanded inspection directory is required)');
} else {
  try {
    const packageSha256 = crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');
    const files = inventory(inspectionRoot);
    const byName = new Map(files.map((file) => [path.basename(file.path).toLowerCase(), file]));
    const runtime = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/resources/bin/runtime-manifest.json'), 'utf8'));
    const expected = new Map([
      ['yt-dlp.exe', runtime.ytDlp?.sha256],
      ['aria2c.exe', runtime.aria2?.executableSha256],
      ['ffmpeg.exe', runtime.ffmpeg?.ffmpegSha256],
      ['ffprobe.exe', runtime.ffmpeg?.ffprobeSha256],
    ]);
    for (const [name, digest] of expected) {
      const file = byName.get(name);
      if (!file || !digest || crypto.createHash('sha256').update(fs.readFileSync(file.absolute)).digest('hex') !== digest.toLowerCase()) {
        failures.push(`package inspection: ${name} is missing or its hash differs from runtime-manifest.json.`);
      }
    }
    const requiredNotices = [
      'yt-dlp-license.txt', 'yt-dlp-notice.txt', 'yt-dlp-third-party-licenses.txt',
      'aria2-copying.txt', 'aria2-notice.txt', 'ffmpeg-license.txt',
      'ffmpeg-notice.txt', 'ffmpeg-build-readme.txt', 'third_party_notices.txt',
    ];
    const missingNotices = requiredNotices.filter((name) => !byName.has(name));
    if (missingNotices.length) failures.push(`package inspection: missing runtime/license notices: ${missingNotices.join(', ')}.`);
    console.log(`Package inspection SHA-256: ${packageSha256}`);
    console.log(`Expanded package files inspected: ${files.length}`);
    console.log(`${failures.some((entry) => entry.startsWith('package inspection:')) ? 'FAIL' : 'PASS'}: package contents, runtime hashes, and notices`);
  } catch (error) {
    failures.push(`package inspection: ${error.message}`);
  }
}

for (const failure of failures) console.error(`FAIL: ${failure}`);
if (failures.length) {
  console.error('BINARY RELEASE READINESS FAIL.');
  process.exit(1);
}
if (pending.length) {
  console.error(`BINARY RELEASE READINESS PENDING (${[...new Set(pending)].join(', ')}).`);
  process.exit(2);
}
console.log('BINARY RELEASE READINESS PASS.');
