import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cacatools-progress-acceptance-'));
const reportPath = path.join(tempRoot, 'progress-acceptance.json');
const dataDir = path.join(tempRoot, 'data');
const downloadsDir = path.join(tempRoot, 'downloads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });
const fixtureSize = 8 * 1024 * 1024;
const fixtureChunk = Buffer.alloc(64 * 1024, 0x5a);

const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(fixtureSize),
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="progress-acceptance.bin"'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  let sent = 0;
  const sendChunk = () => {
    if (response.destroyed || sent >= fixtureSize) {
      if (!response.destroyed) response.end();
      return;
    }
    sent += fixtureChunk.length;
    response.write(fixtureChunk);
    setTimeout(sendChunk, 120);
  };
  sendChunk();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const fixtureUrl = `http://127.0.0.1:${address.port}/progress-acceptance.bin`;
const childEnv = {
  ...process.env,
  CACATOOLS_PROGRESS_ACCEPTANCE: '1',
  CACATOOLS_PROGRESS_ACCEPTANCE_URL: fixtureUrl,
  CACATOOLS_PROGRESS_ACCEPTANCE_REPORT: reportPath,
  CACATOOLS_DATA_DIR: dataDir,
  CACATOOLS_DOWNLOADS_DIR: downloadsDir,
  RUST_BACKTRACE: '1'
};

console.log(`PROGRESS_ACCEPTANCE fixture=${fixtureUrl}`);
console.log(`PROGRESS_ACCEPTANCE report=${reportPath}`);

const commandShell = process.env.ComSpec || 'cmd.exe';
const child = spawn(commandShell, ['/d', '/s', '/c', 'npm.cmd exec tauri dev -- --no-watch'], {
  cwd: root,
  env: childEnv,
  windowsHide: false,
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (chunk) => process.stdout.write(`[tauri] ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`[tauri] ${chunk}`));

const deadline = Date.now() + 180_000;
let report = null;
while (Date.now() < deadline) {
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      break;
    } catch {
      // The app may still be writing the report; retry on the next tick.
    }
  }
  if (child.exitCode !== null && !fs.existsSync(reportPath)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

server.close();
if (child.exitCode === null) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill('SIGTERM');
}

if (!report) {
  console.error('FAIL progress-acceptance-runtime: la app no produjo informe');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
