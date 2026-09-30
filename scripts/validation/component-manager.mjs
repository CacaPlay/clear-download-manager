import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const mainConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const storeConfig = JSON.parse(read('src-tauri/tauri.store.conf.json'));
const runtimeManifest = JSON.parse(read('src-tauri/resources/bin/runtime-manifest.json').replace(/^\uFEFF/, ''));
const packageJson = JSON.parse(read('package.json'));
const manager = read('src-tauri/src/components.rs');
const distribution = read('src-tauri/src/components/distribution.rs');
const componentCatalogTooling = read('src-tauri/src/component_catalog_tooling.rs');
const catalogKey = read('src-tauri/src/components/catalog_key.rs');
const toolTrust = read('src-tauri/src/tools/trust.rs');
const componentTests = read('src-tauri/src/components/tests.rs');
const componentCommands = read('src-tauri/src/commands/components.rs');
const appState = read('src-tauri/src/app/state.rs');
const packageBuilder = read('scripts/package-local-components.ps1');
const frontend = read('app-ui/main.js');
const settings = read('app-ui/modules/settings/index.js');
const docs = read('docs/COMPONENT-MANAGER.md');
const optionalInstall = read('app-ui/modules/components/optional-install.js');
const downloadActions = read('app-ui/download-manager/actions.js');
const optionalInstallTests = read('scripts/validation/optional-component-install.test.mjs');

assert.equal(mainConfig.bundle.windows?.webviewInstallMode?.type, 'downloadBootstrapper', 'Normal Core installer must use the compact WebView2 bootstrapper.');
assert.equal(storeConfig.bundle.windows?.webviewInstallMode?.type, 'offlineInstaller', 'Store Core installer must embed the standalone/offline WebView2 installer.');
for (const config of [mainConfig, storeConfig]) {
  assert.ok(!config.bundle.resources.includes('resources/bin/*'), 'Core packages must exclude runtime executables.');
  assert.ok(config.bundle.resources.includes('resources/licenses/*'), 'License notices must remain in Core packages.');
}
assert.ok(runtimeManifest.ytDlp && runtimeManifest.ffmpeg && runtimeManifest.deno && runtimeManifest.aria2, 'Runtime inventory must remain available to pin local packages.');
assert.equal(packageJson.scripts['package:components:local'], 'powershell -ExecutionPolicy Bypass -File scripts/package-local-components.ps1');
assert.ok(distribution.includes('pub(crate) fn production_trust()') && distribution.includes('super::catalog_key::PUBLIC_KEY_BASE64'), 'Component Manager must use its own production trust root.');
assert.ok(catalogKey.includes('component-catalog-2026-01') && distribution.includes('PUBLIC_KEY_BASE64'), 'Component Manager must have its own versioned production trust anchor.');
assert.ok(toolTrust.includes('pub(crate) fn production()') && !toolTrust.includes('component_catalog_production'), 'Tool Catalog trust must remain unchanged and separate.');
assert.ok(componentCatalogTooling.includes('serde_json::to_vec(&payload)'), 'Component catalog tooling must use the production verifier canonicalization.');
assert.ok(componentCatalogTooling.includes('verify_component_catalog(&bytes, &trust, current_time()?, false)'), 'Component catalog signer must self-verify using the runtime verifier.');
assert.ok(!componentCatalogTooling.includes('catalog_tooling::'), 'Component Catalog tooling must not invoke Tool Catalog schema tooling.');
assert.ok(read('src-tauri/examples/component-catalog-tool.rs').includes('sign_payload'), 'The schema-specific maintainer CLI must be present.');
for (const [capability, variant] of [
  ['media-extraction', 'MediaExtraction'], ['media-merge', 'MediaMerge'], ['media-probe', 'MediaProbe'],
  ['media-transcode', 'MediaTranscode'], ['js-runtime', 'JsRuntime'], ['bittorrent', 'Bittorrent']
]) {
  assert.ok(manager.includes(variant), `Component capability is missing: ${capability}`);
}
for (const invariant of ['validate_archive_entries', 'validate_manifest', 'HashMismatch', 'reject_reparse_path', 'atomic_replace']) {
  assert.ok(manager.includes(invariant), `Safe local package installation check is missing: ${invariant}`);
}
assert.ok(
  manager.includes('let staging_setup = (|| -> Result<(), ComponentError> {')
    && manager.includes('ensure_directory_without_reparse(&staging_root)?;')
    && manager.includes('startup staging recovery deferred')
    && manager.includes('"Component recovery required"'),
  'Optional staging recovery errors must not prevent Core startup.'
);
assert.ok(
  componentTests.includes('fn staging_root_junction_does_not_prevent_core_manager_startup'),
  'The unsafe staging-root startup regression test is missing.'
);
for (const operation of ['list_components', 'component_prompt_info', 'verify_component', 'install_component_from_package', 'install_component_from_catalog', 'cancel_component_install', 'refresh_component_catalog', 'remove_component']) {
  assert.ok(componentCommands.includes(`fn ${operation}`), `Component command is missing: ${operation}`);
}
assert.ok(manager.includes('accept_catalog_sequence') && manager.includes('CATALOG_PROOF_NAME'), 'Remote updates must persist anti-rollback sequence and signed install proof.');
assert.ok(distribution.includes('MAX_COMPONENT_PACKAGE_BYTES') && manager.includes('download_asset_to_path'), 'Remote package downloads must be bounded and hash-verified.');
assert.ok(distribution.includes('CATALOG_REQUEST_TIMEOUT') && distribution.includes('PACKAGE_READ_TIMEOUT') && !distribution.includes('Duration::from_secs(5 * 60)'), 'Catalog total timeout and package inactivity timeout must remain separate without an arbitrary transfer deadline.');
assert.ok(manager.includes('ComponentInstallPhase') && manager.includes('ComponentInstallProgress') && manager.includes('cancellation_token'), 'Backend must expose typed operation phases and safe download cancellation.');
assert.ok(manager.includes('managed_tree_bytes') && manager.includes('reclaimable_bytes'), 'Removal space may be shown only from a safe manager-owned file walk.');
assert.ok(/\.operation\s*\.try_lock\(\)\s*\.map_err\(\|_\|\s*ComponentError::Busy\(id\)\)\?/s.test(manager), 'Removal must reject while a component-manager operation is active.');
assert.ok(componentTests.includes('signed_remote_component_catalog_downloads_verifies_installs_and_activates_atomically'), 'Local HTTP signed-catalog install coverage is missing.');
assert.ok(componentTests.includes('failed_remote_update_preserves_the_previously_active_component'), 'Remote update rollback coverage is missing.');
assert.ok(appState.includes('app_local_data_dir') || appState.includes('ComponentManager'), 'Component storage must be managed through LocalState.');
assert.ok(packageBuilder.includes('Get-Sha256') && packageBuilder.includes('runtime-manifest.json'), 'Local package builder must verify the pinned inventory.');
assert.ok(!packageBuilder.includes('Invoke-WebRequest'), 'V1 package builder must not download runtimes from a new host.');
assert.ok(frontend.includes("invoke('install_component_from_catalog'") && frontend.includes("invoke('remove_component'"), 'Settings actions must use the approved remote component catalog and retain remove support.');
assert.ok(frontend.includes("invoke('cancel_component_install'") && settings.includes('operation?.progressRatio') && settings.includes('operation?.bytesPerSecond') && settings.includes('operation?.bytesDownloaded'), 'Settings must use backend byte, ratio, speed, and cancellation data.');
assert.ok(optionalInstall.includes('CDM_MISSING_CAPABILITY:') && optionalInstall.includes("invoke('component_prompt_info'"), 'Contextual prompts must route on stable capability identifiers and use verified metadata.');
assert.ok(optionalInstallTests.includes('uninstall leaves capability absent') && optionalInstallTests.includes('installed capability bypasses contextual prompt'), 'Uninstall must be covered through absent capability and contextual reinstall routing.');
assert.ok(frontend.includes('component-download-progress'), 'Remote component download progress must be displayed.');
assert.ok(optionalInstall.includes('install_component_from_catalog') && optionalInstall.includes('return invoke(command, args)'), 'Missing optional components must be consent-installed and the original operation retried.');
assert.ok(optionalInstall.includes("id: 'media-tools'") && optionalInstall.includes("id: 'torrent-engine'"), 'Only known optional component IDs may be installed from the signed catalog.');
assert.ok(downloadActions.includes("invokeWithOptionalComponent(context.invoke, 'queue_torrent_download'") && downloadActions.includes('optional-install.js'), 'A missing Torrent Engine must be installed after consent and the torrent action retried.');
assert.ok(optionalInstallTests.includes('declining component installation') && optionalInstallTests.includes('installation progress') && optionalInstallTests.includes('safe message'), 'Optional component consent, progress, and safe-error tests are required.');
assert.ok(settings.includes('data-component-action') && settings.includes('component-catalog-check'), 'Settings must expose remote install and catalog refresh actions.');
const normalizedDocs = docs.replace(/\s+/g, ' ');
assert.ok(normalizedDocs.includes('signed catalog') && normalizedDocs.includes('binary release gate remains fail-closed') && normalizedDocs.includes('production trust root is empty'), 'Remote distribution, trust provisioning, and pending legal review must remain explicit.');

console.log('OK: Core package excludes optional runtimes; remote component installs require the fixed signed catalog, exact package pins, and passing source gates.');
