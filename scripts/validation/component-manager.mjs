import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const mainConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const storeConfig = JSON.parse(read('src-tauri/tauri.store.conf.json'));
const runtimeManifest = JSON.parse(read('src-tauri/resources/bin/runtime-manifest.json').replace(/^\uFEFF/, ''));
const packageJson = JSON.parse(read('package.json'));
const manager = read('src-tauri/src/components.rs');
const componentTests = read('src-tauri/src/components/tests.rs');
const componentCommands = read('src-tauri/src/commands/components.rs');
const appState = read('src-tauri/src/app/state.rs');
const packageBuilder = read('scripts/package-local-components.ps1');
const frontend = read('app-ui/main.js');
const settings = read('app-ui/modules/settings/index.js');
const docs = read('docs/COMPONENT-MANAGER.md');

for (const config of [mainConfig, storeConfig]) {
  assert.ok(!config.bundle.resources.includes('resources/bin/*'), 'Core packages must exclude runtime executables.');
  assert.ok(config.bundle.resources.includes('resources/licenses/*'), 'License notices must remain in Core packages.');
}
assert.ok(runtimeManifest.ytDlp && runtimeManifest.ffmpeg && runtimeManifest.deno && runtimeManifest.aria2, 'Runtime inventory must remain available to pin local packages.');
assert.equal(packageJson.scripts['package:components:local'], 'powershell -ExecutionPolicy Bypass -File scripts/package-local-components.ps1');
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
for (const operation of ['list_components', 'verify_component', 'install_component_from_package', 'remove_component']) {
  assert.ok(componentCommands.includes(`fn ${operation}`), `Component command is missing: ${operation}`);
}
assert.ok(appState.includes('app_local_data_dir') || appState.includes('ComponentManager'), 'Component storage must be managed through LocalState.');
assert.ok(packageBuilder.includes('Get-Sha256') && packageBuilder.includes('runtime-manifest.json'), 'Local package builder must verify the pinned inventory.');
assert.ok(!packageBuilder.includes('Invoke-WebRequest'), 'V1 package builder must not download runtimes from a new host.');
assert.ok(frontend.includes("invoke('install_component_from_package'") && frontend.includes("invoke('remove_component'"), 'Settings actions must call the local package manager.');
assert.ok(settings.includes('.cdmcomponent') && settings.includes('data-component-action'), 'Settings must explain and expose local package actions.');
assert.ok(docs.includes('binary release gate remains fail-closed') && docs.includes('do not establish a public'), 'Distribution and pending legal review must remain explicit.');

console.log('OK: Core package excludes optional runtimes; local component packages remain hash-pinned, installable, and separate from binary release readiness.');
