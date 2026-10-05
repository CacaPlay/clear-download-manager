import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCorrespondingSourceReleaseAssets } from './corresponding-source-contract.mjs';
import { inspectCorePackageFiles } from './core-package-contract.mjs';

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
const componentAssetsDir = value('--component-assets-dir') ? path.resolve(value('--component-assets-dir')) : '';
const componentPackagesDir = value('--component-packages-dir') ? path.resolve(value('--component-packages-dir')) : '';
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

const componentKeySource = fs.readFileSync(path.join(root, 'src-tauri/src/components/catalog_key.rs'), 'utf8');
const keyIdMatch = componentKeySource.match(/KEY_ID:\s*&str\s*=\s*"([^"]*)"/);
const publicKeyMatch = componentKeySource.match(/PUBLIC_KEY_BASE64:\s*&str\s*=\s*"([^"]*)"/);
let productionComponentKey = null;
if (!keyIdMatch || keyIdMatch[1] !== 'component-catalog-2026-01' || !publicKeyMatch) {
  failures.push('Component Manager production trust anchor is malformed.');
} else if (!publicKeyMatch[1]) {
  pending.push('production Component Manager public key');
  checks.push({ label: 'production Component Manager public key', status: 'PENDING' });
  console.log('PENDING: production Component Manager public key is not embedded; remote activation remains fail-closed.');
} else {
  const decoded = Buffer.from(publicKeyMatch[1], 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== publicKeyMatch[1]) {
    failures.push('Component Manager public key is not canonical 32-byte base64.');
  } else {
    productionComponentKey = publicKeyMatch[1];
    checks.push({ label: 'production Component Manager public key', status: 'PASS' });
    console.log('PASS: production Component Manager public key is embedded with the expected keyId.');
  }
}

if (releaseAssetsDir && fs.existsSync(releaseAssetsDir)) {
  if (!componentAssetsDir || !fs.existsSync(componentAssetsDir) || !fs.statSync(componentAssetsDir).isDirectory()) {
    failures.push('exact component release assets: supply --component-assets-dir with the isolated component assets directory.');
    checks.push({ label: 'exact component release assets and inline catalog links', status: 'FAIL' });
    console.error('FAIL: exact component release assets require --component-assets-dir to point to the isolated component assets directory.');
  } else {
    run('exact component release assets and inline catalog links', 'scripts/validation/component-release-assets.mjs', ['--directory', componentAssetsDir]);
  }
  if (productionComponentKey && componentAssetsDir && fs.existsSync(componentAssetsDir) && fs.statSync(componentAssetsDir).isDirectory()) {
    const catalogPath = path.join(componentAssetsDir, 'component-catalog-v1.json');
    const result = spawnSync('cargo', [
      'run', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--quiet',
      '--features', 'maintainer-tooling', '--example', 'component-catalog-tool', '--',
      'verify-production', '--input', catalogPath,
    ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status === 0) {
      checks.push({ label: 'production inline catalog signature', status: 'PASS' });
      console.log('PASS: inline component catalog signature verifies with the public key embedded in Core.');
    } else {
      failures.push(`production inline catalog signature: ${`${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).slice(-4).join(' | ')}`);
      checks.push({ label: 'production inline catalog signature', status: 'FAIL' });
      console.error(`${result.stdout || ''}${result.stderr || ''}`);
    }
  }
}

if (!componentPackagesDir || !fs.existsSync(componentPackagesDir) || !fs.statSync(componentPackagesDir).isDirectory()) {
  pending.push('optional component package inspection');
  checks.push({ label: 'optional component package inspection', status: 'PENDING' });
  console.log('PENDING: optional component package inspection (supply --component-packages-dir with both exact packages)');
} else {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts/validation/inspect-component-packages.ps1'),
    '-PackageDirectory', componentPackagesDir,
    '-RuntimeManifestPath', path.join(root, 'src-tauri/resources/bin/runtime-manifest.json'),
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const output = String(result.stdout || '') + String(result.stderr || '');
  if (result.status === 0) {
    checks.push({ label: 'optional component package inspection', status: 'PASS' });
    console.log(output.trim());
  } else {
    failures.push('optional component package inspection: ' + output.trim().split(/\r?\n/).slice(-4).join(' | '));
    checks.push({ label: 'optional component package inspection', status: 'FAIL' });
    console.error(output);
  }
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
    const coreContents = inspectCorePackageFiles(files.map(file => file.path));
    failures.push(...coreContents.failures.map(issue => `package inspection: ${issue}`));
    const runtimeManifestText = fs.readFileSync(path.join(root, 'src-tauri/resources/bin/runtime-manifest.json'), 'utf8');
    const runtime = JSON.parse(runtimeManifestText.replace(/^\uFEFF/, ''));
    if (runtime.ffmpeg?.profile !== 'SAFE LEAN'
      || runtime.ffmpeg?.approvedCandidateKey !== 'ffmpegSafeLeanCandidate'
      || /gyan\.dev|GyanD/i.test(String(runtime.ffmpeg?.source || ''))) {
      failures.push('package inspection: active FFmpeg runtime must be the approved SAFE LEAN build with no Gyan source metadata.');
    }
    if (files.some((file) => /gyan|essentials_build/i.test(file.path))) {
      failures.push('package inspection: retired Gyan FFmpeg files or names are still present.');
    }
    console.log(`Package inspection SHA-256: ${packageSha256}`);
    console.log(`Expanded package files inspected: ${files.length}`);
    console.log(`${failures.some((entry) => entry.startsWith('package inspection:')) ? 'FAIL' : 'PASS'}: standalone Core package excludes optional runtimes and component distribution assets`);
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
