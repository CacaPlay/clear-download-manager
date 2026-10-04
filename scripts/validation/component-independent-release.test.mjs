import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const workflow = read('.github/workflows/release-components.yml');
const preflight = read('scripts/prepare-component-release.ps1');
const localPackager = read('scripts/package-local-components.ps1');
const releasePackager = read('scripts/package-release-components.ps1');
const assembler = read('scripts/assemble-component-release-assets.ps1');
const assetValidator = read('scripts/validation/component-release-assets.mjs');
const distribution = read('src-tauri/src/components/distribution.rs');

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1, `workflow job ${name} exists`);
  const nextJob = workflow.slice(start + 1).search(/\n  [A-Za-z][A-Za-z0-9-]*:\n/);
  const next = nextJob < 0 ? -1 : start + 1 + nextJob;
  return workflow.slice(start, next < 0 ? undefined : next);
}

test('component release is manual-only and rejects dispatches outside main', () => {
  const triggers = workflow.slice(0, workflow.indexOf('\npermissions:'));
  assert.match(triggers, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /^\s+(push|schedule|pull_request):/m);
  assert.match(preflight, /GITHUB_REF\s+-ne\s+'refs\/heads\/main'/);
  assert.match(preflight, /MEDIA_TOOLS_VERSION/);
  assert.match(preflight, /TORRENT_ENGINE_VERSION/);
  assert.match(preflight, /catalog\.payload\.sequence/);
  assert.match(preflight, /distribution\/components\/component-catalog-v1\.json/);
});

test('component package and release tags use validated explicit versions', () => {
  for (const source of [localPackager, releasePackager, assembler]) {
    assert.match(source, /MediaToolsVersion/);
    assert.match(source, /TorrentEngineVersion/);
    assert.match(source, /ValidatePattern\('.*\d.*\'/s);
  }
  assert.match(localPackager, /version\s*=\s*\$Version/);
  assert.match(localPackager, /\$Id-\$Version\.cdmcomponent/);
  assert.match(releasePackager, /-MediaToolsVersion \$MediaToolsVersion -TorrentEngineVersion \$TorrentEngineVersion/);
  assert.match(assembler, /components-\[0-9\]/);
  assert.match(workflow, /-Sequence \(\[UInt64\]\$env:COMPONENT_CATALOG_SEQUENCE\)/);
  assert.match(workflow, /-MediaToolsVersion \$env:MEDIA_TOOLS_VERSION -TorrentEngineVersion \$env:TORRENT_ENGINE_VERSION/);
  assert.match(assetValidator, /--media-tools-version/);
  assert.match(assetValidator, /--torrent-engine-version/);
  assert.match(assetValidator, /component\.releaseTag !== releaseTag/);
});

test('component Release accepts only its exact component assets, never app installers or upload notes', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-component-release-junk-'));
  try {
    fs.writeFileSync(path.join(temporaryDirectory, 'ClearDownloadManagerSetup.exe'), 'app installer');
    fs.writeFileSync(path.join(temporaryDirectory, 'LEEME_PARA_SUBIR.txt'), 'operator notes');
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts/validation/component-release-assets.mjs'),
      '--directory',
      temporaryDirectory,
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unexpected|not allowed|forbidden/i);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('only the signing job step receives the catalog signing secret and actions are pinned', () => {
  const sign = jobBlock('sign-catalog');
  const build = jobBlock('build-assets');
  const publish = jobBlock('publish');
  const secretRefs = [...workflow.matchAll(/secrets\.RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY/g)];
  assert.equal(secretRefs.length, 1);
  assert.match(sign, /secrets\.RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(build, /RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(publish, /RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY/);
  assert.match(sign, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(sign, /environment:\s*release/, 'catalog signing must use the protected environment that holds its key');
  assert.match(publish, /contents:\s*write[\s\S]*pull-requests:\s*write/);
  const usesLines = workflow.split(/\r?\n/).filter((line) => /^\s*uses:/.test(line));
  assert.ok(usesLines.length > 0);
  for (const line of usesLines) assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/i, `action reference is SHA-pinned: ${line}`);
});

test('component releases stay non-latest and update the stable catalog through a PR', () => {
  assert.match(workflow, /gh release create[\s\S]*?--latest=false/);
  assert.match(workflow, /git push origin \$branch/);
  assert.match(workflow, /gh pr create --base main --head \$branch/);
  assert.doesNotMatch(workflow, /git push origin main/);
  assert.doesNotMatch(workflow, /Copy-Item[^\r\n]*latest\.json|gh release upload[^\r\n]*latest\.json/);
  assert.match(workflow, /stable catalog update through a pull request/);
  assert.match(preflight, /pulls\/\$number\/files/);
  assert.match(preflight, /component-catalog-v1\.json/);
});

test('production catalog uses the fixed raw main file and package downloads keep GitHub release policy', () => {
  assert.ok(distribution.includes('https://raw.githubusercontent.com/CacaPlay/clear-download-manager/main/distribution/components/component-catalog-v1.json'));
  assert.match(distribution, /let catalog_redirect_policy = Policy::none\(\)/);
  assert.match(distribution, /let catalog_redirect_policy = redirect_policy\(_allow_loopback_http\)/);
  assert.match(distribution, /Some\(\s*"github\.com"/);
  assert.match(distribution, /production_catalog_url_is_exact_raw_main_file_and_not_a_package_redirect/);
  assert.ok(fs.statSync(path.join(process.cwd(), 'distribution/components/component-catalog-v1.json')).size > 0);
});
