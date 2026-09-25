import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const binDir = path.join(root, 'src-tauri', 'resources', 'bin');
const required = ['yt-dlp.exe', 'deno.exe', 'aria2c.exe', 'ffmpeg.exe', 'ffprobe.exe', 'runtime-manifest.json'];
let failed = false;

for (const filename of required) {
  const filepath = path.join(binDir, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`FALTA: ${filepath}`);
    failed = true;
  }
}

if (!failed) {
  const manifest = JSON.parse(fs.readFileSync(path.join(binDir, 'runtime-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const sha256 = (filename) => crypto.createHash('sha256').update(fs.readFileSync(path.join(binDir, filename))).digest('hex');
  const checks = [
    ['yt-dlp.exe', manifest.ytDlp?.sha256],
    ['deno.exe', manifest.deno?.executableSha256],
    ['aria2c.exe', manifest.aria2?.executableSha256],
    ['ffmpeg.exe', manifest.ffmpeg?.ffmpegSha256],
    ['ffprobe.exe', manifest.ffmpeg?.ffprobeSha256]
  ];
  for (const [filename, expected] of checks) {
    const actual = sha256(filename);
    if (!expected || actual !== expected) {
      console.error(`SHA-256 inválido para ${filename}`);
      failed = true;
    }
  }
  for (const [filename, args] of [['yt-dlp.exe', ['--version']], ['deno.exe', ['--version']], ['aria2c.exe', ['--version']], ['ffmpeg.exe', ['-version']], ['ffprobe.exe', ['-version']]]) {
    const result = spawnSync(path.join(binDir, filename), args, { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(`${filename} no se ejecuta correctamente: ${result.stderr || result.error}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('OK: yt-dlp, Deno, aria2c, FFmpeg y FFprobe presentes, ejecutables y con hashes coincidentes.');
