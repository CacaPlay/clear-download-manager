import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cacatools-phase13-window-'));
const server = http.createServer((request, response) => {
  if (request.method !== 'HEAD' && request.method !== 'GET') return response.writeHead(405).end();
  const body = Buffer.alloc(512 * 1024, 0x43);
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'Content-Disposition': 'attachment; filename="phase13-window.bin"' });
  if (request.method === 'HEAD') return response.end();
  response.end(body);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
const fixtureUrl = `http://127.0.0.1:${address.port}/phase13-window.bin`;
const DEV_SERVER_PORT = 4173;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function waitForPortAvailable(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await isPortAvailable(port))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runKind(kind) {
  const dataDir = path.join(tempRoot, kind, 'data');
  const downloadsDir = path.join(tempRoot, kind, 'downloads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  const output = [];
  const environment = {
    ...process.env,
    CACATOOLS_SUBWINDOW_ACCEPTANCE: '1',
    CACATOOLS_SUBWINDOW_ACCEPTANCE_KIND: kind,
    CACATOOLS_SUBWINDOW_ACCEPTANCE_URL: fixtureUrl,
    CACATOOLS_DATA_DIR: dataDir,
    CACATOOLS_DOWNLOADS_DIR: downloadsDir,
    RUST_BACKTRACE: '1'
  };
  const commandShell = process.env.ComSpec || 'cmd.exe';
  const child = spawn(commandShell, ['/d', '/s', '/c', 'npm.cmd exec tauri dev -- --no-watch'], { cwd: root, env: environment, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 120_000;
  // Tauri WebView2 loads `WebviewUrl::App` through the internal app protocol,
  // so the dev HTTP server is not a reliable signal for a native subwindow.
  // The debug-only acceptance branch emits the result after the native window
  // has been built, shown, and focused.
  const openedPattern = new RegExp(`CACATOOLS_SUBWINDOW_ACCEPTANCE_RESULT kind=${kind} status=PASS`);
  while (Date.now() < deadline && child.exitCode === null) {
    if (openedPattern.test(output.join(''))) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const log = output.join('');
  const opened = openedPattern.test(log);
  const appStarted = log.includes('target\\debug\\cacatools-desktop.exe') || log.includes('CACATOOLS_SUBWINDOW_ACCEPTANCE_RESULT');
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else child.kill('SIGTERM');
  }
  // Tauri's dev command owns the WebView process and the beforeDevCommand
  // server owns port 4173.  Wait for the process tree to actually exit before
  // starting the next window variant; a short fixed delay is racy on Windows.
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 8_000))
    ]);
  }
  await waitForPortAvailable(DEV_SERVER_PORT);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return { appStarted, opened, log };
}

const media = await runKind('media');
const playlist = await runKind('playlist');
server.close();
for (let attempt = 0; attempt < 5; attempt += 1) {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
}
const report = {
  status: media.appStarted && media.opened && playlist.appStarted && playlist.opened ? 'PASS' : 'FAIL',
  appStarted: media.appStarted && playlist.appStarted,
  mediaWindowOpened: media.opened,
  playlistWindowOpened: playlist.opened
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') {
  console.error(media.log.slice(-4000));
  console.error(playlist.log.slice(-4000));
  process.exit(1);
}
