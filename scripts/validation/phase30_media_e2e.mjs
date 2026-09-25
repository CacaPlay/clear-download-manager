import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cacatools-media-e2e-'));
const fixtureRoot = path.join(tempRoot, 'fixtures');
const dataDir = path.join(tempRoot, 'data');
const downloadsDir = path.join(tempRoot, 'downloads');
const reportPath = path.join(tempRoot, 'media-e2e.json');
const ffmpeg = path.join(root, 'src-tauri', 'resources', 'bin', 'ffmpeg.exe');
const ffprobe = path.join(root, 'src-tauri', 'resources', 'bin', 'ffprobe.exe');
fs.mkdirSync(fixtureRoot, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });

function generateFixture(output, color, frequency) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=2`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', output
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg no pudo crear el fixture');
}

generateFixture(path.join(fixtureRoot, 'one.mp4'), 'blue', 880);
generateFixture(path.join(fixtureRoot, 'two.mp4'), 'green', 660);
generateFixture(path.join(fixtureRoot, 'three.mp4'), 'red', 440);
const fixtures = new Map([
  ['/one.mp4', path.join(fixtureRoot, 'one.mp4')],
  ['/two.mp4', path.join(fixtureRoot, 'two.mp4')],
  ['/three.mp4', path.join(fixtureRoot, 'three.mp4')]
]);

const server = http.createServer((request, response) => {
  const fixture = fixtures.get(new URL(request.url || '/', 'http://127.0.0.1').pathname);
  if (!fixture || !['GET', 'HEAD'].includes(request.method || '')) return response.writeHead(404).end();
  const body = fs.readFileSync(fixture);
  const range = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  if (start >= body.length || end < start) return response.writeHead(416).end();
  const payload = body.subarray(start, end + 1);
  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(payload.length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD') return response.end();
  response.end(payload);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const urls = [
  `http://127.0.0.1:${address.port}/one.mp4`,
  `http://127.0.0.1:${address.port}/two.mp4`,
  `http://127.0.0.1:${address.port}/three.mp4`
];
const environment = {
  ...process.env,
  CACATOOLS_MEDIA_E2E_ACCEPTANCE: '1',
  CACATOOLS_MEDIA_E2E_URLS: urls.join('|'),
  CACATOOLS_MEDIA_E2E_DURATIONS: '2|2|2',
  CACATOOLS_MEDIA_E2E_REPORT: reportPath,
  CACATOOLS_PROGRESS_ACCEPTANCE: '1',
  CACATOOLS_PROGRESS_ACCEPTANCE_URL: urls[0],
  CACATOOLS_DATA_DIR: dataDir,
  CACATOOLS_DOWNLOADS_DIR: downloadsDir,
  RUST_BACKTRACE: '1'
};
const shell = process.env.ComSpec || 'cmd.exe';
const child = spawn(shell, ['/d', '/s', '/c', 'npm.cmd exec tauri dev -- --no-watch'], {
  cwd: root,
  env: environment,
  windowsHide: false,
  stdio: ['ignore', 'pipe', 'pipe']
});
const output = [];
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));
const snapshotCode = String.raw`
import json, sqlite3, sys
db = sys.argv[1]
try:
    connection = sqlite3.connect(db, timeout=0.25)
    batch = connection.execute("SELECT id,status,title FROM playlist_batches WHERE title='Media E2E playlist' ORDER BY id DESC LIMIT 1").fetchone()
    if not batch:
        print(json.dumps({'status': 'NO_BATCH'}))
    else:
        rows = connection.execute("SELECT pi.position,pi.status,j.status,j.detail,mj.resolution_state,COALESCE(mj.output_path,''),COALESCE(mj.error,'') FROM playlist_items pi JOIN jobs j ON j.id=pi.job_id JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=? ORDER BY pi.position", (batch[0],)).fetchall()
        print(json.dumps({'status': 'OK', 'batchId': batch[0], 'batchStatus': batch[1], 'title': batch[2], 'jobsTotal': connection.execute("SELECT COUNT(*) FROM jobs WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?)", (batch[0],)).fetchone()[0], 'rows': [{'position': row[0], 'itemStatus': row[1], 'jobStatus': row[2], 'detail': row[3], 'resolutionState': row[4], 'outputPath': row[5], 'error': row[6]} for row in rows]}))
except Exception as error:
    print(json.dumps({'status': 'BUSY', 'reason': str(error)}))
`;
const deadline = Date.now() + 240_000;
let report = null;
let nextItemObserved = false;
let ffmpegStageObserved = false;
while (Date.now() < deadline) {
  const snapshotProcess = spawnSync('python', ['-c', snapshotCode, path.join(dataDir, 'cacatools.sqlite3')], { encoding: 'utf8' });
  let snapshot = null;
  try { snapshot = JSON.parse(snapshotProcess.stdout || 'null'); } catch { snapshot = null; }
  if (snapshot?.status === 'OK') {
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const firstCompleted = rows.some((row) => row.position === 0 && row.itemStatus === 'completed');
    const laterStarted = rows.some((row) => row.position > 0 && ['running', 'completed'].includes(row.itemStatus));
    nextItemObserved ||= firstCompleted && laterStarted;
    ffmpegStageObserved ||= rows.some((row) => ['validating', 'finalizing'].includes(row.resolutionState))
      || rows.filter((row) => row.outputPath).every((row) => row.outputPath.toLowerCase().endsWith('.mp3'));
    const terminal = ['completed', 'completed_with_errors'].includes(snapshot.batchStatus);
    if (terminal) {
      const allCompleted = rows.length === 3 && rows.every((row) => row.itemStatus === 'completed' && row.jobStatus === 'completed' && !row.error && fs.existsSync(row.outputPath) && fs.statSync(row.outputPath).size > 1024);
      report = {
        ...snapshot,
        status: snapshot.batchStatus === 'completed' && rows.length === 3 && snapshot.jobsTotal === 3 && allCompleted && nextItemObserved && ffmpegStageObserved ? 'PASS' : 'FAIL',
        nextItemObserved,
        ffmpegStageObserved,
        outputFilesValid: allCompleted,
        noPhantomRows: rows.length === 3 && snapshot.jobsTotal === 3
      };
      break;
    }
  }
  if (child.exitCode !== null) break;
  await new Promise((resolve) => setTimeout(resolve, 400));
}
if (child.exitCode === null) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill('SIGTERM');
}
server.close();

if (report?.status === 'PASS') {
  const outputPaths = (report.rows || []).map((item) => item.outputPath).filter(Boolean);
  const mediaChecks = outputPaths.map((file) => {
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    return { file, ffprobeExit: probe.status, duration: Number.parseFloat(String(probe.stdout || '').trim()) };
  });
  report.ffprobeValidated = mediaChecks.length === 3 && mediaChecks.every((check) => check.ffprobeExit === 0 && Number.isFinite(check.duration) && check.duration > 0);
  report.mediaChecks = mediaChecks;
  if (!report.ffprobeValidated) report.status = 'FAIL';
}
if (!report) {
  report = { status: 'FAIL', reason: 'La app no produjo un estado terminal E2E', logTail: output.join('').slice(-6000) };
}
console.log(JSON.stringify(report, null, 2));
for (let attempt = 0; attempt < 8; attempt += 1) {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
}
if (report.status !== 'PASS') process.exitCode = 1;
