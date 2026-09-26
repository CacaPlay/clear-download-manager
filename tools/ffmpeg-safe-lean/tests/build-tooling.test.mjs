import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = path.join(repositoryRoot, 'tools/ffmpeg-safe-lean/verify-sha256.sh');
const packageFile = name => {
  const inToolDir = path.join(repositoryRoot, 'tools/ffmpeg-safe-lean', name);
  return fs.existsSync(inToolDir) ? inToolDir : path.join(repositoryRoot, name);
};
const sourceInputs = packageFile('source-inputs.json');
const buildOptions = packageFile('build-options.json');
const toolchainLock = packageFile('toolchain.lock.json');
const bash = process.env.MSYS2_BASH || 'C:\\msys64\\usr\\bin\\bash.exe';
const cygpath = process.env.MSYS2_CYGPATH || 'C:\\msys64\\usr\\bin\\cygpath.exe';

function toMsysPath(filePath) {
  const result = spawnSync(cygpath, ['-u', filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'cygpath must convert the test path');
  return result.stdout.trim();
}

function runVerifier(expectedHash, filePath) {
  const command = `export PATH=/usr/bin:/ucrt64/bin; bash ${toMsysPath(verifier)} ${expectedHash} ${toMsysPath(filePath)}`;
  return spawnSync(bash, ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' });
}

test('source hash verifier accepts an unchanged file', () => {
  assert.ok(fs.existsSync(verifier), 'verify-sha256.sh must exist');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-lean-hash-'));
  const file = path.join(directory, 'input.txt');
  fs.writeFileSync(file, 'pinned input\n');
  const expectedHash = crypto.createHash('sha256').update('pinned input\n').digest('hex');

  const result = runVerifier(expectedHash, file);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('source hash verifier rejects changed bytes', () => {
  assert.ok(fs.existsSync(verifier), 'verify-sha256.sh must exist');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-lean-hash-'));
  const file = path.join(directory, 'input.txt');
  fs.writeFileSync(file, 'changed input\n');
  const expectedHash = crypto.createHash('sha256').update('pinned input\n').digest('hex');

  const result = runVerifier(expectedHash, file);

  assert.notEqual(result.status, 0, 'changed source must fail the preflight');
  assert.match(result.stderr + result.stdout, /SHA-256 mismatch/i);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('source input lock fixes all SAFE LEAN source identities and hashes', () => {
  assert.ok(fs.existsSync(sourceInputs), 'source-inputs.json must exist');
  const manifest = JSON.parse(fs.readFileSync(sourceInputs, 'utf8'));
  const records = Object.fromEntries(manifest.components.map(component => [component.id, component]));

  assert.equal(records.ffmpeg.sourceCommit, '946fcce07b6dcd0331c8cc609192aeff5e1924f8');
  assert.equal(records.ffmpeg.archive.sha256, '0aa2b1de2a5698b20a23e93d539a9a8e82ca0117496c5bdf05d198805f42bb3b');
  assert.equal(records.x264.sourceCommit, 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55');
  assert.equal(records.x264.archive.sha256, '56d1a073f1f67cf6d3419a02f7663dce76ffc47b4aefe814c048f79ce3040a3d');
  assert.equal(records.lame.version, '3.100');
  assert.equal(records.lame.archive.sha256, 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e');
  assert.equal(records.dav1d.sourceCommit, '54706fc6bc0cdecab7e9593974a4039cc038fca7');
  assert.equal(records.dav1d.archive.sha256, 'ffd903f96a657615796483435e578557fc976b8a8574c5154117d93f3f901ba4');
  assert.equal(manifest.components.length, 4, 'unidentified external dependencies must not be silently omitted');
});

test('build option record remains aligned with the SAFE LEAN selection', () => {
  assert.ok(fs.existsSync(buildOptions), 'build-options.json must exist');
  const options = JSON.parse(fs.readFileSync(buildOptions, 'utf8'));
  assert.equal(options.runtimeVersion, '9.0.2');
  assert.deepEqual(options.patches, []);
  assert.ok(options.ffmpegConfigureOptions.includes('--enable-libx264'));
  assert.ok(options.ffmpegConfigureOptions.includes('--enable-libmp3lame'));
  assert.ok(options.ffmpegConfigureOptions.includes('--enable-libdav1d'));
  assert.ok(options.ffmpegConfigureOptions.includes('--enable-gpl'));
  assert.ok(options.ffmpegConfigureOptions.includes('--enable-version3'));
  assert.match(options.dependencySearchEnvironment.CFLAGS, /\$BUILD_PREFIX\/lame\/include/);
  assert.match(options.dependencySearchEnvironment.LDFLAGS, /\$BUILD_PREFIX\/lame\/lib/);
  assert.deepEqual(options.outputs, ['ffmpeg.exe', 'ffprobe.exe', 'build-config.json']);
});

test('toolchain lock fixes every package and wheel digest', () => {
  const lock = JSON.parse(fs.readFileSync(toolchainLock, 'utf8'));
  assert.equal(lock.packageCount, 57);
  assert.equal(lock.packages.length, lock.packageCount);
  assert.equal(new Set(lock.packages.map(record => record.name)).size, lock.packageCount);
  for (const record of lock.packages) {
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.match(record.url, /^https:\/\/repo\.msys2\.org\//);
  }
  for (const wheel of lock.pythonWheels) {
    assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
    assert.match(wheel.url, /^https:\/\/files\.pythonhosted\.org\//);
  }
});

test('pinned wheel bootstrap verifies inputs and installs only Meson and Ninja tooling', () => {
  const script = packageFile('prepare-toolchain-wheels.ps1');
  assert.ok(fs.existsSync(script), 'prepare-toolchain-wheels.ps1 must be present in the source package');
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /Get-FileHash/);
  assert.match(text, /pythonWheels/);
  assert.match(text, /ninja-1\.13\.2\.data\/scripts\/ninja\.exe/);
  assert.match(text, /PYTHONPATH/);
  assert.ok(text.includes("Join-Path $toolRoot '..\\..\\toolchain.lock.json'"), 'wheel bootstrap must find the lock at the source-package root');
});

test('source packager converts Windows paths before passing them to MSYS2 tar', { skip: !fs.existsSync(packageFile('package-source.ps1')) }, () => {
  const script = packageFile('package-source.ps1');
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /cygpath\.exe/);
  assert.match(text, /& \$CygpathExe -u \$Path/);
  assert.match(text, /-J --create --file \$tarOutputPath --directory \$tarPackagePath/);
});
