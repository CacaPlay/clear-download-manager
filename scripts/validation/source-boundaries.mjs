import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
const blocked = /spotify|spotdl|spot-dl/i;
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.rs', '.toml']);

function collect(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return collect(child);
    return entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase()) ? [child] : [];
  });
}

function requireAbsent(relative, expression = blocked) {
  if (!fs.existsSync(path.join(root, relative))) return;
  const content = fs.readFileSync(path.join(root, relative), 'utf8');
  if (expression.test(content)) failures.push(`${relative} still contains a removed integration path.`);
}

for (const directory of ['app-ui', 'extension']) {
  for (const relative of collect(directory)) requireAbsent(relative);
}

for (const relative of [
  'src-tauri/src/spotify_auth.rs',
  'src-tauri/src/media/spotify.rs',
  'src-tauri/src/commands/media.rs',
  'src-tauri/src/commands/settings.rs',
  'src-tauri/src/app/runtime.rs',
  'src-tauri/src/extension_bridge.rs',
  'src-tauri/src/media/analysis.rs',
  'src-tauri/src/media/queue.rs',
  'src-tauri/src/media/download/progress.rs',
  'extension/native-host/src/main.rs'
]) {
  requireAbsent(relative);
}

const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
if (/resolve_spotify_source|queue_spotify_download|spotify_auth_status|spotify_login|spotify_logout|SpotifyTrackMetadata|spotify_api_get|run_spotdl_worker_inner/i.test(lib)) {
  failures.push('src-tauri/src/lib.rs still contains Spotify or spotDL feature code.');
}
if (!lib.includes('job_uses_legacy_removed_provider') || !lib.includes('playlist_batch_uses_legacy_removed_provider')) {
  failures.push('Legacy queued media items must remain protected from automatic resumption.');
}
if (lib.includes('disable_legacy_spotify_jobs')) {
  failures.push('Startup must not rewrite local historical jobs merely to remove the feature.');
}

const extensionManifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
if (JSON.stringify(extensionManifest).toLowerCase().includes('spotify')) {
  failures.push('extension/manifest.json still requests Spotify host access.');
}

const db = fs.readFileSync(path.join(root, 'src-tauri/src/db/mod.rs'), 'utf8');
if (!/ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''/.test(db)) {
  failures.push('The legacy playlist_items.spotify_url column must remain available to preserve existing databases.');
}
if (/DROP\s+(TABLE|COLUMN)\s+[^\n]*(spotify|playlist_items)/i.test(db)) {
  failures.push('A SQLite migration would delete legacy playlist data.');
}
if (!lib.includes('legacy_playlist_spotify_data_is_preserved_and_never_resumed')) {
  failures.push('A regression test must preserve legacy playlist history and prove old jobs remain unresumed.');
}

if (failures.length) {
  console.error('SOURCE BOUNDARY CHECK FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('SOURCE BOUNDARY CHECK PASSED (feature surfaces absent; legacy playlist storage preserved).');
