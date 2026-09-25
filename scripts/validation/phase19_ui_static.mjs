import fs from 'node:fs';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const read = (file) => fs.readFileSync(file, 'utf8');
const packageJson = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const files = {
  main: readFrontendSource('.js'),
  css: read('app-ui/download-manager/styles.css'),
  appCss: readFrontendSource('.css'),
  constants: read('app-ui/download-manager/core/constants.js'),
  model: read('app-ui/download-manager/core/model.js'),
  index: read('app-ui/download-manager/index.js'),
  unified: read('app-ui/download-manager/view/unified.js'),
  shared: read('app-ui/download-manager/view/shared.js'),
  command: read('app-ui/download-manager/view/command-center.js'),
  zen: read('app-ui/download-manager/view/zen-sidebar.js'),
  rust: fs.readdirSync('src-tauri/src', { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
    .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
    .join('\n'),
  bridge: read('src-tauri/src/extension_bridge.rs'),
  updater: read('src-tauri/src/update_manager.rs'),
  cargo: read('src-tauri/Cargo.toml'),
  configureUpdater: read('scripts/configure-updater-windows.ps1'),
  releaseUpdater: read('scripts/prepare-update-release.ps1'),
  registerExtension: read('scripts/register-extension-host-windows.ps1'),
  configureExtension: read('scripts/configure-extension-integration.ps1'),
  extensionConfig: read('src-tauri/resources/extension/extension-config.json'),
  extensionSdk: read('extension/sdk/cacatools-native-client.js'),
  sizeReport: read('scripts/report-windows-size.ps1'),
  smoke: read('scripts/smoke-test-installed-beta.ps1')
};

const assertions = [
  ['version 0.19.0', packageJson.version === '0.19.0' && tauri.version === '0.19.0' && files.cargo.includes('version = "0.19.0"')],
  ['Zen default', files.constants.includes("layout: 'zen-sidebar'") && files.model.includes("stored.layout = 'zen-sidebar'")],
  ['phase19 appearance revision', files.constants.includes('appearanceRevision: 4') && files.model.includes('appearanceRevision: 4')],
  ['default scale 125', files.constants.includes('uiScale: 125') && files.main.includes('scale: 125') && files.index.includes('syncPreferences({ uiScale: 125 })') && files.rust.includes('fn default_ui_scale() -> u8 {\n    125')],
  ['Command secondary selectable', files.model.includes("value.layout === 'command-center'")],
  ['dialogs are integrated workspaces', files.appCss.includes('Phase 19 · Download Center and Playlist Manager are first-class app workspaces') && files.appCss.includes('width: 100% !important') && files.appCss.includes('height: 100% !important')],
  ['playlist manager enlarged', files.appCss.includes('.playlist-current-card') && files.appCss.includes('min-height: 14rem') && files.appCss.includes('.playlist-next-strip')],
  ['stable unified input repaint', files.index.includes('function paintUnifiedSearch') && files.index.includes("input?.closest?.('.dm-unified-search')")],
  ['debounced suggestions', files.index.includes('280') && files.index.includes('runtimeState.unifiedRequestId')],
  ['bounded remote search', files.index.includes('2600')],
  ['full refresh deferred while interacting', files.main.includes('downloadManagerInteractionIsActive') && files.main.includes('deferredDownloadManagerRefresh')],
  ['single search border', files.css.includes('El borde pertenece al contenedor') && files.css.includes('border:0!important')],
  ['larger navigation icons', files.css.includes('width:24px;height:24px')],
  ['stable Zen rows', files.css.includes('.dm-zen-sidebar .dm-item-meta { display: none !important; }')],
  ['floating row menu portal', files.shared.includes('floatingRowMenu') && files.css.includes('.dm-row-menu-floating')],
  ['speed separated from percent', files.css.includes('Speed gets its own line') && files.css.includes('.dm-item-progress > small')],
  ['next playlist item hydrated', files.main.includes('hydratePlaylistRuntimeItem')],
  ['percent encoded filename decoded', files.rust.includes('decode_percent_encoded_filename')],
  ['video thumbnails persisted', files.rust.includes("thumbnail TEXT NOT NULL DEFAULT ''") && files.rust.includes('NULLIF(media_jobs.thumbnail')],
  ['playlist stacked covers', files.unified.includes('dm-playlist-stack')],
  ['updater plugin conditionally enabled in Rust', files.cargo.includes('tauri-plugin-updater') && files.rust.includes('if update_manager::updater_plugin_is_configured()') && files.updater.includes('pub fn updater_plugin_is_configured()')],
  ['updater signed workflow prepared', files.configureUpdater.includes('TAURI_SIGNING_PRIVATE_KEY') && files.configureUpdater.includes('createUpdaterArtifacts') && files.releaseUpdater.includes('latest.json')],
  ['updater UI integrated', files.shared.includes('data-dm-check-update') && files.main.includes('checkForAppUpdate')],
  ['extension native host prepared', files.bridge.includes('lat.cacaplay.cacatools.downloadmanager') && files.bridge.includes('run_native_messaging_host')],
  ['extension exact origin registration', files.registerExtension.includes('allowed_origins') && files.registerExtension.includes("ValidatePattern('^[a-p]{32}$')")],
  ['extension production auto-registration', files.bridge.includes('ensure_extension_host_registration') && files.bridge.includes('host-registration.json') && files.configureExtension.includes('chromiumExtensionIds') && files.extensionConfig.includes('\"enabled\": false')],
  ['extension SDK prepared', files.extensionSdk.includes('sendNativeMessage') && files.extensionSdk.includes('analyze') && files.extensionSdk.includes('enqueue')],
  ['extension requests feed unified analysis', files.main.includes('processExtensionBridgeRequests') && files.main.includes('analyzeDownloadSource')],
  ['extension lock files explicitly preserve contents', (files.bridge.match(/\.truncate\(false\)/g) || []).length === 2 && !files.bridge.includes('.write(true)\n        .open(lock_path())')],
  ['Rustfmt 1.9 canonical extension include', files.bridge.includes('const BUNDLED_EXTENSION_CONFIG: &str = include_str!("../resources/extension/extension-config.json");')],
  ['stable release binary optimized', files.cargo.includes('lto = true') && files.cargo.includes('opt-level = "s"') && files.cargo.includes('strip = true') && files.cargo.includes('panic = "abort"') && files.cargo.includes('codegen-units = 1') && !files.cargo.includes('trim-paths') && tauri.build?.removeUnusedCommands === true],
  ['NSIS LZMA', tauri.bundle?.windows?.nsis?.compression === 'lzma'],
  ['WebView2 bootstrapper', tauri.bundle?.windows?.webviewInstallMode?.type === 'downloadBootstrapper'],
  ['size report prepared', files.sizeReport.includes('windows-size-report.json') && packageJson.scripts?.['report:size:windows']],
  ['startup smoke captures Rust abort diagnostics', files.smoke.includes('RedirectStandardError') && files.smoke.includes('RUST_BACKTRACE') && files.smoke.includes('$CrashText')],
  ['PowerShell 5.1 size report property safety', files.sizeReport.includes('return [pscustomobject][ordered]@{') && files.sizeReport.includes('Measure-Object -Property bytes -Sum') && files.sizeReport.includes('Sort-Object -Property bytes -Descending') && !files.sizeReport.includes('Measure-Object bytes -Sum')],
  ['no old technical blocks', !files.command.includes('dm-command-lower') && !files.zen.includes('dm-zen-engines')]
];

const failed = assertions.filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length) {
  console.error(`Phase 19 UI/infrastructure static gate failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`OK: ${assertions.length} comprobaciones Phase 19.`);
