import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const required = [
  'index.html', 'package.json', 'package-lock.json', 'MANIFEST.sha256',
  'app-ui/main.js', 'app-ui/styles.css', 'app-ui/subwindow.html', 'app-ui/subwindow.js', 'app-ui/subwindow.css', 'app-ui/assets/icons/lucide.js', 'app-ui/assets/icons/LICENSE', 'app-ui/assets/icons/NOTICE.md', 'app-ui/player/index.html', 'app-ui/player/player.js', 'app-ui/player/player.css',
  'app-ui/download-manager/index.js', 'app-ui/download-manager/styles.css',
  'app-ui/download-manager/core/constants.js', 'app-ui/download-manager/core/model.js',
  'app-ui/download-manager/view/icons.js', 'app-ui/download-manager/view/shared.js',
  'app-ui/download-manager/view/sections.js', 'app-ui/download-manager/view/unified.js',
  'app-ui/download-manager/view/zen-sidebar.js',
  'app-ui/download-manager/view/dialogs.js',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.store.conf.json', 'src-tauri/src/lib.rs', 'src-tauri/src/main.rs', 'src-tauri/src/subwindows.rs', 'src-tauri/src/commands/subwindows.rs',
  'src-tauri/src/update_manager.rs', 'src-tauri/src/store_update_manager.rs', 'src-tauri/src/extension_bridge.rs',
  'scripts/validation/native-host-handshake.mjs', 'scripts/build-store-msix.ps1',
  'scripts/validation/assets-brand-minimization.mjs', 'docs/ASSET-MARKS-AUDIT.md',
  'src-tauri/capabilities/main-capability.json', 'src-tauri/windows/hooks.nsh', 'src-tauri/resources/bin/.gitkeep',
  'src-tauri/resources/licenses/README.txt', 'src-tauri/resources/updater/updater-config.json',
  'src-tauri/resources/extension/extension-config.json', 'evidence/official-public-key.json',
  'extension/README.md', 'extension/manifest.json', 'extension/app-compat.json', 'extension/service-worker.js', 'extension/sidepanel.html', 'extension/sidepanel.js', 'extension/sidepanel.css', 'extension/thumbnail-service.js', 'extension/content/detector.js', 'extension/icons/icon16.png', 'extension/icons/icon32.png', 'extension/icons/icon48.png', 'extension/icons/icon128.png', 'extension/native-host/Cargo.toml', 'extension/native-host/Cargo.lock', 'extension/native-host/src/main.rs', 'extension/native-host/chromium-host.template.json', 'extension/native-host/firefox-host.template.json',
  'extension/sdk/cacatools-native-client.js', 'extension/sdk/manifest-v3.example.json', 'extension/sdk/service-worker.example.js',
  'scripts/build.mjs', 'scripts/generate-source-manifest.mjs', 'scripts/verify-binaries.mjs',
  'scripts/validation/source-manifest-scope.mjs',
  'scripts/prepare-windows-binaries.ps1', 'scripts/rust-gate-windows.ps1',
  'scripts/native-check-windows.ps1', 'scripts/final-windows-build.ps1',
  'scripts/configure-updater-windows.ps1', 'scripts/prepare-update-release.ps1',
  'scripts/register-extension-host-windows.ps1', 'scripts/configure-extension-integration.ps1', 'scripts/report-windows-size.ps1',
  'scripts/validation/phase19_ui_static.mjs', 'scripts/validation/phase19_render_fixture.mjs',
  'scripts/validation/phase19_dialog_fixture.mjs', 'scripts/validation/extension-module-graph.mjs', 'scripts/validation/phase19_final_gallery.py',
  'scripts/validation/phase19_performance_smoke.py', 'scripts/validation/phase19_visual_smoke.py',
  'scripts/validation/phase19_dialog_visual_smoke.py',
  'scripts/validation/phase20_ui_static.mjs', 'scripts/validation/phase32_ui_reference_v3.mjs', 'scripts/validation/phase20_live_fixture.mjs', 'scripts/validation/phase13_subwindows.mjs', 'scripts/validation/phase13_tauri_subwindow_smoke.mjs', 'scripts/validation/scan-mojibake.mjs',
  'scripts/validation/phase20_live_interaction_smoke.py', 'scripts/validation/phase20_workspace_visual_smoke.py',
  'scripts/validation/phase22_internal_workspace_smoke.py', 'scripts/validation/browser-capture-smoke.mjs', 'scripts/validation/video-detector-smoke.mjs', 'scripts/version-check.mjs', 'scripts/build-extension.ps1', 'docs/extension/INSTALL.md', 'docs/extension/STORE-SUBMISSION.md', 'docs/extension/PRIVACY.md', 'docs/RELEASE-GUIDE.md',
  'scripts/validation/phase20_icon_audit.mjs', 'scripts/validation/phase20_final_gallery.py', 'scripts/validation/startup-registration-smoke.ps1', 'scripts/validation/progress-acceptance-runtime.mjs', 'scripts/validation/phase30_media_e2e.mjs', 'scripts/validation/phase30_ytdlp_stabilization.mjs',
  'scripts/validation/phase24_1_baseline_audit.mjs', 'scripts/validation/phase24_1_hotfix3_ui_stability.mjs', 'scripts/validation/phase24_1_hotfix5_harmony.mjs', 'scripts/validation/phase24_1_window_lifecycle.mjs', 'scripts/validation/phase24_1_settings_extension.mjs', 'scripts/validation/phase24_1_visual_system_extension.mjs', 'scripts/validation/phase24_1_extension_visual_smoke.py', 'scripts/validation/phase24_1_app_contrast_visual_smoke.py', 'scripts/validation/extension-sync-smoke.mjs',
  'scripts/validation/phase24_2_phase1_download_progress.mjs',
  'scripts/validation/phase24_2_phase2_settings_search_sizes.mjs', 'scripts/validation/phase24_2_settings_fixture.mjs', 'scripts/validation/phase24_2_phase3_player_audio.mjs', 'scripts/validation/phase24_2_player_visual_smoke.py', 'scripts/validation/phase24_2_settings_visual_smoke.py',
  'scripts/validation/phase24_2_phase3_final_closure.mjs', 'scripts/validation/phase24_2_phase3_closure_visual.py',
  'scripts/validation/phase24_2_phase3_final_closure.mjs', 'scripts/validation/phase24_2_phase3_closure_visual.py',
  'scripts/validation/phase24_2_phase4_final.mjs', 'scripts/validation/phase24_2_phase4_performance.py', 'scripts/validation/phase24_2_phase4_sqlite.py',
  'scripts/validation/phase24_2_player_preview_online.mjs', 'scripts/validation/phase24_2_player_preview_visual.py',
  'scripts/validation/phase24_2_new_phase2_playlist_player_performance.mjs', 'scripts/validation/phase24_2_new_phase2_playlist_visual.py',
  'scripts/validation/phase24_2_new_phase3_color_picker_performance.mjs',
  'scripts/validation/phase25_0_evidence_hotfix.mjs', 'scripts/validation/phase25_1_beta_polish.mjs', 'scripts/validation/phase25_1_beta_interaction.py', 'scripts/validation/phase25_1_beta_visual.py', 'scripts/validation/phase25_0_evidence_fixture.mjs', 'scripts/validation/phase25_0_evidence_interaction.py',
  'scripts/validation/phase24_2_phase4_final.mjs', 'scripts/validation/phase24_2_phase4_performance.py', 'scripts/validation/phase24_2_phase4_sqlite.py'
];
let failed = false;
const fail = (message) => { console.error(message); failed = true; };
for (const file of required) if (!fs.existsSync(file)) fail(`FALTA: ${file}`);

const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');
const read = (file) => file === 'app-ui/main.js' ? readFrontendSource('.js') : fs.readFileSync(file, 'utf8');
const appUiJsFiles = fs.readdirSync('app-ui', { recursive: true }).filter((file) => file.endsWith('.js')).map((file) => `app-ui/${file}`);
const jsFiles = [
  ...appUiJsFiles, 'app-ui/player/player.js', 'scripts/build.mjs', 'scripts/generate-source-manifest.mjs', 'scripts/validation/store-edition.mjs', 'scripts/validation/native-host-handshake.mjs', 'scripts/validation/assets-brand-minimization.mjs',
  'scripts/verify-binaries.mjs', 'extension/sdk/cacatools-native-client.js',
  'extension/sdk/service-worker.example.js', 'extension/service-worker.js', 'extension/sidepanel.js', 'extension/thumbnail-service.js', 'extension/content/detector.js', 'scripts/version-check.mjs', 'scripts/validation/phase19_ui_static.mjs', 'scripts/validation/phase20_ui_static.mjs', 'scripts/validation/phase20_icon_audit.mjs', 'scripts/validation/phase20_live_fixture.mjs',
  'scripts/validation/phase19_render_fixture.mjs', 'scripts/validation/phase19_dialog_fixture.mjs', 'scripts/validation/phase24_2_phase1_download_progress.mjs', 'scripts/validation/phase24_2_phase2_settings_search_sizes.mjs', 'scripts/validation/phase24_2_settings_fixture.mjs', 'scripts/validation/phase24_2_phase3_player_audio.mjs', 'scripts/validation/phase24_2_phase3_final_closure.mjs', 'scripts/validation/phase24_2_phase4_final.mjs', 'scripts/validation/phase24_2_player_preview_online.mjs', 'scripts/validation/phase24_2_new_phase2_playlist_player_performance.mjs', 'scripts/validation/phase24_2_new_phase3_color_picker_performance.mjs', 'scripts/validation/phase25_0_evidence_hotfix.mjs', 'scripts/validation/phase25_1_beta_polish.mjs', 'scripts/validation/phase25_0_evidence_fixture.mjs', 'scripts/validation/browser-capture-smoke.mjs', 'scripts/validation/video-detector-smoke.mjs', 'scripts/validation/extension-sync-smoke.mjs', 'scripts/validation/progress-acceptance-runtime.mjs', 'scripts/validation/phase30_ytdlp_stabilization.mjs', 'scripts/validation/phase24_1_baseline_audit.mjs', 'scripts/validation/phase24_1_window_lifecycle.mjs', 'scripts/validation/phase24_1_settings_extension.mjs', 'scripts/validation/phase24_1_visual_system_extension.mjs', 'scripts/validation/phase24_1_hotfix3_ui_stability.mjs', 'scripts/validation/phase24_1_hotfix5_harmony.mjs',
  ...required.filter((file) => file.startsWith('app-ui/download-manager/') && file.endsWith('.js'))
];
for (const file of [...new Set(jsFiles)]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(`JavaScript inválido en ${file}:\n${result.stderr || result.stdout}`);
}

const packageJson = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const main = readFrontendSource('.js');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const rustMain = read('src-tauri/src/main.rs');
const bridge = read('src-tauri/src/extension_bridge.rs');
const updater = read('src-tauri/src/update_manager.rs');
const windowsHook = read('src-tauri/windows/hooks.nsh');
const windowsScripts = [
  'scripts/rust-gate-windows.ps1', 'scripts/native-check-windows.ps1',
  'scripts/final-windows-build.ps1', 'scripts/build-windows-beta.ps1'
].map(read).join('\n');
const all = [main, rust, rustMain, bridge, updater, windowsScripts].join('\n');
 const version = packageJson.version;
 const buildIdPrefix = `CDM-${version}-UI-`;
if (packageJson.version !== version) fail(`package.json debe usar ${version}`);
if (tauri.version !== version) fail(`tauri.conf.json debe usar ${version}`);
if (!cargo.includes(`version = "${version}"`)) fail(`Cargo.toml debe usar ${version}`);
if (!cargo.includes('features = ["blocking", "json", "gzip", "rustls-tls"]')) fail('reqwest debe habilitar json y gzip para las respuestas HTTP y search_video_suggestions');
if (packageJson.devDependencies?.['@tauri-apps/cli'] !== '2.11.5') fail('La CLI de Tauri debe permanecer fijada en 2.11.5');

const windowConfig = tauri.app?.windows?.find((item) => item.label === 'main') || tauri.app?.windows?.[0] || {};
if (windowConfig.maximized !== false || windowConfig.center !== true) fail('La app debe abrir centrada y no maximizada');
if (Number(windowConfig.width) !== 1180 || Number(windowConfig.height) !== 780) fail('La ventana inicial debe ser 1180x780');
if (Number(windowConfig.minWidth) !== 1180 || Number(windowConfig.minHeight) !== 720) fail('La ventana debe imponer el mínimo funcional 1180x720');

for (const [source, token, label] of [
  [main, buildIdPrefix, `identificador CDM ${version}`],
  [rust, 'provider_id', 'proveedor persistente de descarga'],
  [rust, 'job_uses_legacy_removed_provider', 'protección de tareas históricas retiradas'],
  [rust, "ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''", 'compatibilidad con historial de playlists existente'],
  [rust, 'selected_source_url', 'separacion metadata/source seleccionada'],
  [main, 'deferredDownloadManagerRefresh', 'refresco no bloqueante'],
  [main, 'hydratePlaylistRuntimeItem', 'siguiente elemento hidratado'],
  [rust, 'decode_percent_encoded_filename', 'nombre URL decodificado'],
  [rustMain, '--native-messaging-host', 'modo host de extensión'],
  [bridge, 'BRIDGE_PROTOCOL_VERSION', 'protocolo de extensión'],
  [bridge, 'ensure_extension_host_registration', 'registro automático de la extensión'],
  [rust, 'fn hide_main_window', 'ocultación robusta del arranque en segundo plano'],
  [updater, 'download_and_install', 'instalación automática'],
  [windowsScripts, buildIdPrefix, `build Windows CDM ${version}`]
]) if (!source.includes(token)) fail(`Falta ${label}: ${token}`);

if (!windowsHook.includes('NSIS_HOOK_POSTINSTALL') || !windowsHook.includes('NSIS_HOOK_POSTUNINSTALL') || !windowsHook.includes('cacatools-desktop.exe')) {
  fail('El instalador NSIS debe registrar y retirar el inicio minimizado de CacaTools');
}

const explicitNonTruncatingLocks = (bridge.match(/\.truncate\(false\)/g) || []).length;
if (explicitNonTruncatingLocks !== 2) fail(`El puente de extensión debe declarar exactamente dos locks no truncables; encontrados: ${explicitNonTruncatingLocks}`);
if (!bridge.includes('const BUNDLED_EXTENSION_CONFIG: &str = include_str!("../resources/extension/extension-config.json");')) fail('extension_bridge.rs no coincide con el formato canónico de Rustfmt 1.9.0');
if (bridge.includes('.write(true)\n        .open(lock_path())')) fail('OpenOptions vuelve a omitir truncate(false)');
if (!updater.includes('pub fn updater_plugin_is_configured()')) fail('El actualizador debe exponer su guardia de configuración de compilación');
if (!rust.includes('if update_manager::updater_plugin_is_configured()')) fail('El plugin updater no puede cargarse cuando la fuente aún no tiene clave/endpoints');
if (rust.includes('app.handle()\n                .plugin(tauri_plugin_updater::Builder::new().build())')) fail('El updater vuelve a cargarse incondicionalmente durante setup');
const smokeScript = read('scripts/smoke-test-installed-beta.ps1');
if (!smokeScript.includes('RedirectStandardError') || !smokeScript.includes('RUST_BACKTRACE') || !smokeScript.includes('$CrashText')) fail('El smoke test debe capturar el motivo de un abort de arranque');

const rustGate = read('scripts/rust-gate-windows.ps1');
for (const [label, pattern] of [
  ['cargo fmt', /Invoke-RustGate\s+"cargo-fmt"\s+@\("fmt",\s*"--all",\s*"--",\s*"--check"\)/],
  ['cargo check', /Invoke-RustGate\s+"cargo-check"\s+@\("check",\s*"--locked",\s*"--all-targets"\)/],
  ['cargo clippy', /Invoke-RustGate\s+"cargo-clippy"\s+@\("clippy",\s*"--locked",\s*"--all-targets",\s*"--",\s*"-D",\s*"warnings"\)/],
  ['cargo test', /Invoke-RustGate\s+"cargo-test"\s+@\("test",\s*"--locked",\s*"--lib"\)/]
]) if (!pattern.test(rustGate)) fail(`El gate Windows no ejecuta correctamente ${label}`);

for (const pattern of [/sk-[A-Za-z0-9_-]{20,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AIza[0-9A-Za-z_-]{25,}/]) {
  if (pattern.test(all)) fail(`Posible secreto detectado: ${pattern}`);
}
for (const forbidden of ['tools.cacaplay.lat', 'cloudflared', 'CasaOS', 'docker compose']) {
  if (all.toLowerCase().includes(forbidden.toLowerCase())) fail(`Dependencia prohibida: ${forbidden}`);
}

const staticGate = spawnSync(process.execPath, ['scripts/validation/phase20_ui_static.mjs'], { encoding: 'utf8' });
if (staticGate.status !== 0) fail(staticGate.stderr || staticGate.stdout || 'Falló el gate Phase 20');
const sourceBoundaryGate = spawnSync(process.execPath, ['scripts/validation/source-boundaries.mjs'], { encoding: 'utf8' });
if (sourceBoundaryGate.status !== 0) fail(sourceBoundaryGate.stderr || sourceBoundaryGate.stdout || 'Falló la verificación de eliminación y preservación histórica');
const assetMarksGate = spawnSync(process.execPath, ['scripts/validation/assets-brand-minimization.mjs'], { encoding: 'utf8' });
if (assetMarksGate.status !== 0) fail(assetMarksGate.stderr || assetMarksGate.stdout || 'Falló la verificación de assets, marcas y empaquetado');
const phase13SubwindowsGate = spawnSync(process.execPath, ['scripts/validation/phase13_subwindows.mjs'], { encoding: 'utf8' });
if (phase13SubwindowsGate.status !== 0) fail(phase13SubwindowsGate.stderr || phase13SubwindowsGate.stdout || 'Falló el gate de subventanas Fase 13');
const iconGate = spawnSync(process.execPath, ['scripts/validation/phase20_icon_audit.mjs'], { encoding: 'utf8' });
if (iconGate.status !== 0) fail(iconGate.stderr || iconGate.stdout || 'Falló la auditoría de iconos');
const encodingGate = spawnSync(process.execPath, ['scripts/validation/scan-mojibake.mjs'], { encoding: 'utf8' });
if (encodingGate.status !== 0) fail(encodingGate.stderr || encodingGate.stdout || 'Falló el escaneo de codificación');
const versionGate = spawnSync(process.execPath, ['scripts/version-check.mjs'], { encoding: 'utf8' });
if (versionGate.status !== 0) fail(versionGate.stderr || versionGate.stdout || 'Falló la sincronización de versiones');
const sourceManifestScopeGate = spawnSync(process.execPath, ['scripts/validation/source-manifest-scope.mjs'], { encoding: 'utf8' });
if (sourceManifestScopeGate.status !== 0) fail(sourceManifestScopeGate.stderr || sourceManifestScopeGate.stdout || 'Falló el control de alcance del manifiesto fuente');
const windowLifecycleGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_window_lifecycle.mjs'], { encoding: 'utf8' });
if (windowLifecycleGate.status !== 0) fail(windowLifecycleGate.stderr || windowLifecycleGate.stdout || 'Falló el gate de ventana 0.24.1');
const processSafetyGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_process_safety.mjs'], { encoding: 'utf8' });
if (processSafetyGate.status !== 0) fail(processSafetyGate.stderr || processSafetyGate.stdout || 'Falló el gate de seguridad de procesos');
const downloadInputsGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_download_inputs.mjs'], { encoding: 'utf8' });
if (downloadInputsGate.status !== 0) fail(downloadInputsGate.stderr || downloadInputsGate.stdout || 'Falló el gate de entradas de descarga');
const settingsExtensionGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_settings_extension.mjs'], { encoding: 'utf8' });
if (settingsExtensionGate.status !== 0) fail(settingsExtensionGate.stderr || settingsExtensionGate.stdout || 'Falló el gate de Ajustes/extensión 0.24.1');
const visualSystemGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_visual_system_extension.mjs'], { encoding: 'utf8' });
if (visualSystemGate.status !== 0) fail(visualSystemGate.stderr || visualSystemGate.stdout || 'Falló el gate visual/detección 0.24.1');
const extensionSyncGate = spawnSync(process.execPath, ['scripts/validation/extension-sync-smoke.mjs'], { encoding: 'utf8' });
if (extensionSyncGate.status !== 0) fail(extensionSyncGate.stderr || extensionSyncGate.stdout || 'Falló la sincronización de la extensión');
const storeEditionGate = spawnSync(process.execPath, ['scripts/validation/store-edition.mjs'], { encoding: 'utf8' });
if (storeEditionGate.status !== 0) fail(storeEditionGate.stderr || storeEditionGate.stdout || 'Falló la validación de la edición Microsoft Store');
const hotfix3Gate = spawnSync(process.execPath, ['scripts/validation/phase24_1_hotfix3_ui_stability.mjs'], { encoding: 'utf8' });
if (hotfix3Gate.status !== 0) fail(hotfix3Gate.stderr || hotfix3Gate.stdout || 'Falló el gate Hotfix 3 de estabilidad visual');
const hotfix5Gate = spawnSync(process.execPath, ['scripts/validation/phase24_1_hotfix5_harmony.mjs'], { encoding: 'utf8' });
if (hotfix5Gate.status !== 0) fail(hotfix5Gate.stderr || hotfix5Gate.stdout || 'Falló el gate Hotfix 5 de armonía');
const ytdlpStabilityGate = spawnSync(process.execPath, ['scripts/validation/phase30_ytdlp_stabilization.mjs'], { encoding: 'utf8' });
if (ytdlpStabilityGate.status !== 0) fail(ytdlpStabilityGate.stderr || ytdlpStabilityGate.stdout || 'Falló el gate de estabilización de yt-dlp');
const componentsGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_components_playlists_progress.mjs'], { encoding: 'utf8' });
if (componentsGate.status !== 0) fail(componentsGate.stderr || componentsGate.stdout || 'Falló el gate de componentes y playlists');
const responsiveGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_responsive_static.mjs'], { encoding: 'utf8' });
if (responsiveGate.status !== 0) fail(responsiveGate.stderr || responsiveGate.stdout || 'Falló el gate responsive');
const extensionReleaseGate = spawnSync(process.execPath, ['scripts/validation/phase24_1_extension_release.mjs'], { encoding: 'utf8' });
if (extensionReleaseGate.status !== 0) fail(extensionReleaseGate.stderr || extensionReleaseGate.stdout || 'Falló el gate de publicación de extensión');
const hotfix8Gate = spawnSync(process.execPath, ['scripts/validation/phase24_1_hotfix8_final_polish.mjs'], { encoding: 'utf8' });
if (hotfix8Gate.status !== 0) fail(hotfix8Gate.stderr || hotfix8Gate.stdout || 'Falló el gate Hotfix 8');
const phase24_2Phase1Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_phase1_download_progress.mjs'], { encoding: 'utf8' });
if (phase24_2Phase1Gate.status !== 0) fail(phase24_2Phase1Gate.stderr || phase24_2Phase1Gate.stdout || 'Falló el gate 0.24.2 Fase 1 de progreso y filas responsive');
const phase24_2Phase2Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_phase2_settings_search_sizes.mjs'], { encoding: 'utf8' });
if (phase24_2Phase2Gate.status !== 0) fail(phase24_2Phase2Gate.stderr || phase24_2Phase2Gate.stdout || 'Falló el gate 0.24.2 Fase 2 de Ajustes, búsqueda y tamaños');
const phase24_2Phase3Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_phase3_player_audio.mjs'], { encoding: 'utf8' });
if (phase24_2Phase3Gate.status !== 0) fail(phase24_2Phase3Gate.stderr || phase24_2Phase3Gate.stdout || 'Falló el gate 0.24.2 Fase 3 de reproductor y audio');
const prePhase4Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_prephase4_corrections.mjs'], { encoding: 'utf8' });
if (prePhase4Gate.status !== 0) fail(prePhase4Gate.stderr || prePhase4Gate.stdout || 'Falló el hotfix visual previo a Fase 4');
const phase3ClosureGate = spawnSync(process.execPath, ['scripts/validation/phase24_2_phase3_final_closure.mjs'], { encoding: 'utf8' });
if (phase3ClosureGate.status !== 0) fail(phase3ClosureGate.stderr || phase3ClosureGate.stdout || 'Falló el cierre final de Fase 3');
const phase24_2Phase4Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_phase4_final.mjs'], { encoding: 'utf8' });
if (phase24_2Phase4Gate.status !== 0) fail(phase24_2Phase4Gate.stderr || phase24_2Phase4Gate.stdout || 'Falló el gate 0.24.2 Fase 4 de optimización final');
const playerPreviewGate = spawnSync(process.execPath, ['scripts/validation/phase24_2_player_preview_online.mjs'], { encoding: 'utf8' });
if (playerPreviewGate.status !== 0) fail(playerPreviewGate.stderr || playerPreviewGate.stdout || 'Falló la nueva Fase 1 de reproductor y preview online');
const newPhase2Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_new_phase2_playlist_player_performance.mjs'], { encoding: 'utf8' });
if (newPhase2Gate.status !== 0) fail(newPhase2Gate.stderr || newPhase2Gate.stdout || 'Falló la nueva Fase 2 de playlists reproducibles y fluidas');
const newPhase3Gate = spawnSync(process.execPath, ['scripts/validation/phase24_2_new_phase3_color_picker_performance.mjs'], { encoding: 'utf8' });
if (newPhase3Gate.status !== 0) fail(newPhase3Gate.stderr || newPhase3Gate.stdout || 'Falló la nueva Fase 3 de color en tiempo real');
const evidenceHotfixGate = spawnSync(process.execPath, ['scripts/validation/phase25_0_evidence_hotfix.mjs'], { encoding: 'utf8' });
if (evidenceHotfixGate.status !== 0) fail(evidenceHotfixGate.stderr || evidenceHotfixGate.stdout || 'Falló el hotfix acumulativo de evidencias reales');
const beta251Gate = spawnSync(process.execPath, ['scripts/validation/phase25_1_beta_polish.mjs'], { encoding: 'utf8' });
if (beta251Gate.status !== 0) fail(beta251Gate.stderr || beta251Gate.stdout || `Falló el gate Beta ${version}`);
const uiReferenceGate = spawnSync(process.execPath, ['scripts/validation/phase32_ui_reference_v3.mjs'], { encoding: 'utf8' });
if (uiReferenceGate.status !== 0) fail(uiReferenceGate.stderr || uiReferenceGate.stdout || 'Falló el gate UI Reference v3');

if (failed) process.exitCode = 1;
