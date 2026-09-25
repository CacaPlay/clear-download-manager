import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseGateIds } from './release-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const windows = process.platform === 'win32';
const npm = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const scriptPath = fileURLToPath(import.meta.url);

export const qualityGateIds = [
  ...releaseGateIds.filter((gate) => gate !== 'check:gpl-source'),
  'check:manifest',
  'check:source-release',
];

function runNpmGate(gate) {
  const args = windows
    ? ['/d', '/s', '/c', `npm.cmd run ${gate} --silent`]
    : ['run', gate, '--silent'];
  return spawnSync(npm, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: windows,
  });
}

function runSourceReleaseGate() {
  const creator = path.join(root, 'scripts/create-source-archive.mjs');
  const readiness = path.join(root, 'scripts/validation/source-release-readiness.mjs');
  const created = spawnSync(process.execPath, [creator], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (created.error || created.status !== 0) {
    console.error(created.stdout || '');
    console.error(created.stderr || '');
    console.error(`Source archive creation failed: ${created.error?.message ?? `exit ${created.status}`}`);
    return false;
  }

  let archiveInfo;
  try {
    archiveInfo = JSON.parse(created.stdout.trim());
  } catch (error) {
    console.error(`Source archive command returned invalid metadata: ${error.message}`);
    return false;
  }

  const archivePath = path.resolve(String(archiveInfo.archive || ''));
  const tempRelative = path.relative(path.resolve(os.tmpdir()), archivePath);
  const archiveIsTemporary = tempRelative
    && tempRelative !== '..'
    && !tempRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(tempRelative)
    && path.basename(archivePath).startsWith('clear-download-manager-source-');
  if (!archiveIsTemporary || !fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    console.error('Source archive command did not return an existing temporary archive in the expected location.');
    return false;
  }

  console.log(`Source archive created: ${archiveInfo.files} files; SHA-256 ${archiveInfo.sha256}`);
  try {
    const checked = spawnSync(process.execPath, [readiness, '--archive', archivePath], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (checked.error) {
      console.error(`Source release readiness failed to start: ${checked.error.message}`);
      return false;
    }
    if (checked.status !== 0) {
      console.error(`Source release readiness exited with status ${checked.status}.`);
      return false;
    }
    return true;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

function runQualityGate() {
  const failures = [];
  for (const gate of qualityGateIds) {
    console.log(`\n== quality gate: ${gate} ==`);
    if (gate === 'check:source-release') {
      if (!runSourceReleaseGate()) failures.push(`${gate}: failed`);
      continue;
    }

    const result = runNpmGate(gate);
    if (result.error) failures.push(`${gate}: ${result.error.message}`);
    else if (result.status !== 0) failures.push(`${gate}: exit ${result.status}`);
  }

  if (failures.length) {
    console.error('\nQUALITY GATE FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nQUALITY GATE PASSED: ${qualityGateIds.length} source and current-contract checks`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.slice(2).includes('--list')) {
    console.log(JSON.stringify({ gates: qualityGateIds }));
  } else {
    runQualityGate();
  }
}
