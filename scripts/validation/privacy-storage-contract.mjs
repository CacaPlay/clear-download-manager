import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const lib = read('src-tauri/src/lib.rs');
const session = read('src-tauri/src/media/session.rs');
const settings = read('src-tauri/src/settings.rs');
const appConfig = read('src-tauri/tauri.conf.json');
const ui = read('app-ui/main.js');
const appearance = read('app-ui/modules/appearance/index.js');
const imageModule = read('app-ui/modules/images/images.js');
const extensionManifest = JSON.parse(read('extension/manifest.json'));
const privacy = read('docs/PRIVACY.md');
const checks = [
  ['app database resolves under Tauri app data or the explicit test override', lib.includes('app.path().app_data_dir()?') && lib.includes('environment_path_override("CACATOOLS_DATA_DIR")') && lib.includes('data_dir.join("cacatools.sqlite3")')],
  ['WebView profile is not redirected to a personal or machine-specific path', !/dataDirectory|data_directory|userDataFolder|user_data_folder|[A-Z]:\\Users\\/i.test(appConfig)],
  ['app preference persistence is documented and backed by localStorage keys', /localStorage\.getItem\(MEDIA_DOWNLOAD_PREFERENCES_KEY/.test(ui) && /localStorage\.setItem\(APPEARANCE_STORAGE_KEY/.test(appearance) && privacy.includes('localStorage')],
  ['cookie setting persists only consent and the selected file path', session.includes('use_brave_cookies: bool') && session.includes('cookies_path: Option<String>') && !session.includes('cookie_value') && privacy.includes('no el contenido de las cookies')],
  ['cookie file paths are validated before being saved or used', session.includes('validate_netscape_cookie_file') && session.includes('path.is_absolute()') && session.includes('canonicalize()')],
  ['browser extension storage permissions do not include cookie access', !(extensionManifest.permissions || []).includes('cookies') && !(extensionManifest.host_permissions || []).includes('cookies')],
  ['image local storage and WebView cache/session persistence limits are documented', imageModule.includes('indexedDB') && privacy.includes('no los limpia al cerrar la app') && privacy.includes('Caché de yt-dlp')],
  ['cleanup claims distinguish temporary work from persistent profile data', privacy.includes('No se capturó tráfico real') && privacy.includes('No se examinó ningún perfil') && privacy.includes('limpieza normal')]
];

for (const [label, pass] of checks) console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
console.log(`OK: ${checks.length} static privacy/storage contracts; live WebView profile QA is in docs/PRIVACY-QA.md.`);
