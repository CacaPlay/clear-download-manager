import fs from 'node:fs';

const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');
const read = (file) => fs.readFileSync(file, 'utf8');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const checks = [
  ['HTTP downloads preserve response headers and final URL metadata', rust.includes('CONTENT_DISPOSITION') && rust.includes('remote_download_probe')],
  ['HTTP filenames use the shared resolver', rust.includes('resolve_download_filename')],
  ['Integrated bridge supports explicit browser captures', read('src-tauri/src/extension_bridge.rs').includes('browser_download_capture')],
  ['Published native host supports explicit browser captures', read('extension/native-host/src/main.rs').includes('browser_download_capture')],
  ['Extension capture uses the generic native request path', read('extension/sdk/cacatools-native-client.js').includes("sendCacaToolsNativeMessage('browser_download_capture', capture)")],
  ['Extension playlist input stays on the shared queue command', read('app-ui/modules/extension/index.js').includes("invoke('queue_playlist_selection'")],
  ['Unknown direct file types keep the generic fallback', read('app-ui/download-manager/view/unified.js').includes("visualByKind[kind] || ['file', 'generic']")],
  ['Existing playlist database storage remains additive', read('src-tauri/src/db/mod.rs').includes("ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''")],
  ['Spotify-specific UI and command routes are absent', !/resolve_spotify_source|queue_spotify_download|spotify_auth_status|spotify_login|spotify_logout/i.test(`${readFrontendSource('.js')}\n${rust}`)]
];

const failures = checks.filter(([, passed]) => !passed).map(([label]) => label);
for (const [label, passed] of checks) console.log(`${passed ? 'OK' : 'FALLO'}: ${label}`);
if (failures.length) process.exit(1);
console.log(`OK: ${checks.length} verificaciones de entrada genérica y compatibilidad histórica.`);
