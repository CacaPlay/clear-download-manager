import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tauriConfig = JSON.parse(read('../../src-tauri/tauri.qa.conf.json'));
const cargo = read('../../src-tauri/Cargo.toml');
const build = read('../../src-tauri/build.rs');
const qaRuntime = read('../../src-tauri/src/qa_build.rs');
const componentManager = read('../../src-tauri/src/components.rs');
const distribution = read('../../src-tauri/src/components/distribution.rs');
const extensionBridge = read('../../src-tauri/src/extension_bridge.rs');
const startup = read('../../src-tauri/src/lib.rs');
const noUpdater = read('../../src-tauri/src/no_update_manager.rs');
const qaBuildScript = read('../../scripts/build-local-qa-exe.ps1');

test('QA configuration has a separate app identity and no updater route', () => {
  assert.equal(tauriConfig.identifier, 'lat.cacaplay.cleardownloadmanager.qa');
  assert.equal(tauriConfig.productName, 'Clear Download Manager QA');
  assert.equal(tauriConfig.bundle.active, false);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, false);
  assert.equal(tauriConfig.build.frontendDist, '../artifacts/qa-redesign/dist-optimized');
  assert.equal(tauriConfig.plugins.updater.pubkey, '');
  assert.deepEqual(tauriConfig.plugins.updater.endpoints, []);
  assert.match(noUpdater, /pub fn updater_plugin_is_configured\(\) -> bool \{\s*false/s);
  assert.match(noUpdater, /UPDATE_DISABLED_MESSAGE/);
  assert.match(cargo, /qa-component-manager\s*=\s*\[\]/);
  assert.doesNotMatch(cargo.match(/^default\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '', /qa-component-manager/);
});

test('QA component trust and network policy are compile-time isolated', () => {
  assert.match(qaRuntime, /lat\.cacaplay\.cleardownloadmanager\.qa/);
  assert.match(qaRuntime, /validate_runtime_configuration/);
  assert.match(qaRuntime, /config\.plugins\.0\.get\("updater"\)/);
  assert.match(distribution, /http:\/\/127\.0\.0\.1:49301\/component-catalog-v1\.json/);
  assert.match(distribution, /component-catalog-qa-20260927/);
  assert.match(distribution, /!cfg!\(feature = "qa-component-manager"\)[\s\S]*?target\.scheme\(\) == "https"/);
  assert.match(distribution, /target\.port\(\) == Some\(49301\)/);
  assert.match(distribution, /parsed\.port\(\) == Some\(49301\)/);
  assert.match(build, /CDM_QA_EXPECTED_IDENTIFIER/);
  assert.match(build, /CDM_QA_EXPECTED_COMPONENT_ENDPOINT/);
  assert.match(build, /CDM_QA_EXPECTED_COMPONENT_KEY_ID/);
  assert.match(build, /CARGO_FEATURE_GITHUB_UPDATER/);
  assert.match(read('../../src-tauri/src/lib.rs'), /all\(feature = "qa-component-manager", feature = "github-updater"\)/);
});

test('QA key fingerprint remains pinned to the prepared signed catalog', () => {
  const keySource = read('../../src-tauri/src/components/catalog_key.rs');
  const match = keySource.match(/#\[cfg\(feature = "qa-component-manager"\)\]\s*pub\(crate\) const PUBLIC_KEY_BASE64: &str = "([^"]+)";/s);
  assert.ok(match, 'QA public key must be selected only by the QA build feature');
  const fingerprint = createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex');
  assert.equal(fingerprint, '7910b5251d799b5160471f860db7de4bd478dea5280e5ebd7a63a1ec2a655313');
});

test('QA executable builder computes the public-key fingerprint with compatible .NET crypto APIs', () => {
  assert.match(qaBuildScript, /SHA256\]::Create\(\)/);
  assert.match(qaBuildScript, /\.ComputeHash\(\$PublicKeyBytes\)/);
  assert.doesNotMatch(qaBuildScript, /SHA256\]::HashData/);
});

test('QA executable builder preserves an open preview and writes a fresh artifact name', () => {
  assert.match(qaBuildScript, /catch\s*\{[\s\S]*?Get-Date -Format 'yyyyMMdd-HHmmss'[\s\S]*?Copy-Item -LiteralPath \$BuiltExe -Destination \$OutputExe/);
});

test('QA startup keeps user data, downloads, bridge, and Windows startup separate', () => {
  assert.match(startup, /if cfg!\(feature = "qa-component-manager"\)[\s\S]*?app\.path\(\)\.app_data_dir\(\)/);
  assert.match(startup, /data_dir\.join\("Downloads"\)/);
  assert.match(startup, /all\(windows, not\(feature = "qa-component-manager"\)\)/);
  assert.match(extensionBridge, /root\.join\("CDM-QA"\)\.join\("ExtensionBridge"\)/);
  assert.match(extensionBridge, /const WINDOWS_STARTUP_VALUE: &str = "Clear Download Manager QA"/);
  assert.match(extensionBridge, /#\[cfg\(feature = "qa-component-manager"\)\][\s\S]*?pub fn initialize_app_bridge\(\) -> Result<\(\), String> \{\s*Ok\(\(\)\)/);
});
