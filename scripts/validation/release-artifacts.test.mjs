import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lucideIcon } from '../../app-ui/assets/icons/lucide.js';
import { inspectSourcePaths, evaluateSourceReadiness, SOURCE_ONLY_GATE_IDS } from './source-release-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assetRights = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'rights/asset-provenance.json'), 'utf8'));
const officialListMusic = '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>';

const required = [
  'clear-download-manager-source/LICENSE.md',
  'clear-download-manager-source/COPYING',
  'clear-download-manager-source/NOTICE.md',
  'clear-download-manager-source/MANIFEST.sha256',
  'clear-download-manager-source/package-lock.json',
  'clear-download-manager-source/src-tauri/Cargo.lock',
  'clear-download-manager-source/extension/native-host/Cargo.lock',
  'clear-download-manager-source/src-tauri/resources/bin/runtime-manifest.json',
  'clear-download-manager-source/src-tauri/resources/licenses/NPM-SBOM.spdx.json',
  'clear-download-manager-source/src-tauri/resources/licenses/CARGO-DEPENDENCY-LICENSES.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/THIRD_PARTY_NOTICES.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/ARIA2-COPYING.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/ARIA2-OPENSSL-LICENSE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/ARIA2-NOTICE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/DENO-LICENSE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/DENO-NOTICE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/FFMPEG-BUILD-README.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/FFMPEG-LICENSE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/FFMPEG-NOTICE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/README.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/YT-DLP-LICENSE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/YT-DLP-NOTICE.txt',
  'clear-download-manager-source/src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt',
  'clear-download-manager-source/rights/release-rights.json',
];

test('source artifact accepts the required source and licensing inventory', () => {
  const result = inspectSourcePaths(required);
  assert.deepEqual(result.failures, []);
});

test('source artifact retains the runtime inventory needed by source builds without allowing executables', () => {
  const result = inspectSourcePaths(required);
  assert.deepEqual(result.failures, []);
  const withRuntime = inspectSourcePaths([...required, 'clear-download-manager-source/src-tauri/resources/bin/aria2c.exe']);
  assert.match(withRuntime.failures.join('\n'), /runtime binary/i);
});

test('source artifact rejects runtime binaries, installers, and personal PDFs', () => {
  const result = inspectSourcePaths([
    ...required,
    'clear-download-manager-source/src-tauri/resources/bin/ffmpeg.exe',
    'clear-download-manager-source/release/ClearDownloadManager.msi',
    'clear-download-manager-source/Pago en Línea - UASD.pdf',
  ]);
  assert.match(result.failures.join('\n'), /runtime binary/i);
  assert.match(result.failures.join('\n'), /installer or package/i);
  assert.match(result.failures.join('\n'), /PDF/i);
});

test('source artifact rejects traversal and requires the notices and lock inventories', () => {
  const result = inspectSourcePaths([
    ...required.filter((entry) => !entry.endsWith('/THIRD_PARTY_NOTICES.txt')),
    'clear-download-manager-source/../../outside.txt',
  ]);
  assert.match(result.failures.join('\n'), /traversal/i);
  assert.match(result.failures.join('\n'), /THIRD_PARTY_NOTICES/i);
});

test('source artifact rejects arbitrary credential and private-key files', () => {
  const result = inspectSourcePaths([
    ...required,
    'clear-download-manager-source/config/client-secret.txt',
    'clear-download-manager-source/keys/id_rsa',
  ]);
  assert.match(result.failures.join('\n'), /credential-bearing filename|private-key or credential file/i);
});

test('source readiness remains pending if ownership or asset provenance is pending', () => {
  const result = evaluateSourceReadiness([
    { id: 'artifact-inspection', status: 'PASS' },
    { id: 'rights', status: 'PENDING' },
    { id: 'asset-provenance', status: 'PENDING' },
  ]);
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.blockers, ['rights', 'asset-provenance']);
});

test('source-only gate requires global rights and assets but does not depend on GPL runtime sources', () => {
  assert.ok(SOURCE_ONLY_GATE_IDS.includes('check:rights'));
  assert.ok(SOURCE_ONLY_GATE_IDS.includes('check:asset-provenance'));
  assert.ok(!SOURCE_ONLY_GATE_IDS.includes('check:gpl-source'));
  assert.ok(!SOURCE_ONLY_GATE_IDS.includes('verify:binaries'));
});

test('playlist glyph uses the official Lucide list-music path in every UI icon map', () => {
  assert.ok(lucideIcon('playlist', 24).includes(officialListMusic));
  assert.ok(lucideIcon('music', 24).includes(officialListMusic));
  assert.ok(!lucideIcon('playlist', 24).includes('#4f9bff'));
  const mainSource = fs.readFileSync(path.join(repositoryRoot, 'app-ui/main.js'), 'utf8');
  assert.ok(mainSource.includes(`playlist: '${officialListMusic}'`));
  const downloadManagerIcons = fs.readFileSync(path.join(repositoryRoot, 'app-ui/download-manager/view/icons.js'), 'utf8');
  assert.ok(downloadManagerIcons.includes(`playlist: '${officialListMusic}'`));
});

test('vendored Lucide subset includes ISC and Feather-derived MIT notices', () => {
  const license = fs.readFileSync(path.join(repositoryRoot, 'app-ui/assets/icons/LICENSE'), 'utf8');
  assert.match(license, /ISC License/);
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /The following Lucide icons are derived from the Feather project:[\s\S]*check,[\s\S]*download,[\s\S]*link,[\s\S]*maximize,[\s\S]*minimize,[\s\S]*x/);
});

test('approved owner attestation clears only retained asset distribution rights', () => {
  const brand = assetRights.groups.find((group) => group.id === 'clear-brand-assets');
  const generated = assetRights.groups.find((group) => group.id === 'generated-tauri-platform-icons');
  const product = assetRights.groups.find((group) => group.id === 'clear-product-art');
  assert.equal(brand.assetCount, 62);
  assert.equal(brand.clearanceScope, 'DISTRIBUTION_RIGHTS_ONLY');
  assert.equal(brand.licenseTreatment, 'EXCLUDED_FROM_GPL');
  assert.equal(brand.status, 'CLEAR');
  assert.equal(brand.ownerAttestationStatus, 'CONFIRMED');
  assert.equal(generated.assetCount, 8);
  assert.equal(generated.status, 'CLEAR');
  assert.equal(generated.ownerAttestationStatus, 'CONFIRMED');
  assert.equal(product.assetCount, 95);
  assert.equal(product.status, 'CLEAR');
  assert.equal(product.ownerAttestationStatus, 'CONFIRMED');
  assert.deepEqual(product.attestationSubgroups.map((group) => [group.id, group.assetCount, group.status]), [
    ['clear-product-file-type-icons', 70, 'CONFIRMED'],
    ['clear-product-other-art', 25, 'CONFIRMED'],
  ]);
  assert.equal(assetRights.unknownProvenance.assetCount, 165);
  assert.equal(assetRights.unknownProvenance.status, 'CLEAR');
  assert.equal(assetRights.ownerStatement.status, 'APPROVED');
  assert.equal(assetRights.ownerStatement.approvedAt, '2026-09-25');
  assert.equal(assetRights.ownerStatement.approvedBy, 'Julio Angel / CacaPlay');
  const attestationPath = path.join(repositoryRoot, assetRights.ownerStatement.evidencePath);
  const attestationHash = crypto.createHash('sha256').update(fs.readFileSync(attestationPath)).digest('hex');
  assert.equal(assetRights.ownerStatement.evidenceSha256, attestationHash);
  assert.equal(assetRights.status, 'READY');
});

test('PR5 owner review records explicit approval while preserving evidence limits', () => {
  const assetDraft = fs.readFileSync(path.join(repositoryRoot, 'rights/owner-asset-rights-attestation.md'), 'utf8');
  const pr5Draft = fs.readFileSync(path.join(repositoryRoot, 'rights/pr5-owner-review-draft.md'), 'utf8');
  const releaseRights = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'rights/release-rights.json'), 'utf8'));
  const pr5Register = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'rights/pr5-evidence-register.json'), 'utf8'));
  assert.match(assetDraft, /APROBADA EXPLÍCITAMENTE/);
  assert.match(assetDraft, /Julio Angel \/ CacaPlay/);
  assert.match(assetDraft, /2026-09-25/);
  assert.match(assetDraft, /NO estoy relicenciando bajo GPL-3\.0-or-later/);
  assert.match(pr5Draft, /declaración directa del titular/i);
  assert.match(pr5Draft, /0505a2fb68854e28a6468f1370f0da06/);
  assert.match(pr5Draft, /78ceb49a8ff2e870fbeb604e586f6e7212e5c5d2/);
  assert.match(pr5Draft, /no se afirma ni se\s+inventa un timestamp/i);
  assert.equal(releaseRights.status, 'READY');
  assert.equal(releaseRights.assetDistributionReview.status, 'APPROVED');
  assert.equal(releaseRights.formalActionRequired.ownerApprovalStatus, 'APPROVED');
  const pr5 = releaseRights.items.find((item) => item.id === 'pr5-devin-output');
  assert.equal(pr5.status, 'APPROVED');
  assert.equal(pr5.formalClearanceStatus, 'APPROVED');
  assert.equal(pr5.reviewedBy, 'Julio Angel / CacaPlay');
  assert.equal(pr5.reviewedAt, '2026-09-25');
  assert.equal(pr5.evidencePath, 'rights/pr5-owner-review-draft.md');
  const reviewHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repositoryRoot, pr5.evidencePath))).digest('hex');
  assert.equal(pr5.evidenceSha256, reviewHash);
  assert.equal(pr5Register.publicEvidence.ownerDeclaration.independentlyVerified, false);
  assert.equal(pr5Register.decision.PR5_PUBLIC_CHAIN, 'PASS');
  assert.equal(pr5Register.decision.ACCOUNT_TO_TERMS_CHAIN, 'PASS_OWNER_DECLARATION_AND_PUBLIC_TERMS');
  assert.equal(pr5Register.decision.OUTPUT_RIGHTS, 'SUPPORTED_BY_SECTION_3_1_AND_OWNER_AUTHORIZATION');
  assert.equal(pr5Register.decision.GPL_RELICENSING_READINESS, 'PASS_FOR_REVIEWED_PR5_DIFF');
});

test('release pipeline builds once, verifies the uploaded artifact, and gates publication', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const jobsText = workflow.slice(workflow.indexOf('\njobs:') + '\njobs:'.length);
  const headers = [...jobsText.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  const jobNames = headers.map((match) => match[1]);
  assert.deepEqual(jobNames, [
    'validate-release-ref',
    'preflight-release',
    'build-test',
    'package-sign',
    'verify-binary-release',
    'publish',
  ]);

  const job = (name) => {
    const index = jobNames.indexOf(name);
    assert.notEqual(index, -1, `missing workflow job ${name}`);
    const start = headers[index].index;
    const end = headers[index + 1]?.index ?? jobsText.length;
    return jobsText.slice(start, end);
  };
  const buildTest = job('build-test');
  const packageSign = job('package-sign');
  const verify = job('verify-binary-release');
  const publish = job('publish');
  const secretRefs = [...workflow.matchAll(/secrets\.(RELEASE_TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?)/g)];

  assert.match(buildTest, /npm run check:local-build/);
  assert.match(buildTest, /npm run check:release/);
  assert.doesNotMatch(buildTest, /check:release-build/);
  assert.match(buildTest, /npm run source:archive/);
  assert.match(buildTest, /npm run test:release-artifacts/);
  assert.doesNotMatch(buildTest, /check:binary-release/);
  assert.match(buildTest, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(buildTest, /secrets\./);
  assert.match(packageSign, /environment:\s*\n\s+name: release/);
  assert.match(packageSign, /contents:\s*read/);
  assert.match(packageSign, /npm run build:windows:final/);
  assert.match(packageSign, /uses:\s*actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(packageSign, /release_artifact_id:\s*\$\{\{\s*steps\.release_artifact\.outputs\.artifact-id\s*\}\}/);
  assert.equal(secretRefs.length, 2);
  assert.ok(secretRefs.every((match) => match.index >= workflow.indexOf('  package-sign:')));
  assert.match(verify, /artifact-ids:\s*\$\{\{\s*needs\.package-sign\.outputs\.release_artifact_id\s*\}\}/);
  assert.match(verify, /npm run check:binary-release/);
  assert.match(verify, /--package/);
  assert.match(verify, /--inspection-dir/);
  assert.match(verify, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(verify, /build:windows:final|TAURI_SIGNING_PRIVATE_KEY|prepare-update-release/);
  assert.match(publish, /needs:[\s\S]*- verify-binary-release/);
  assert.match(publish, /needs\.verify-binary-release\.result\s*==\s*'success'/);
  assert.match(publish, /artifact-ids:\s*\$\{\{\s*needs\.package-sign\.outputs\.release_artifact_id\s*\}\}/);
  assert.match(publish, /SHA256SUMS\.txt/);
  assert.match(publish, /gh release create/);
  assert.match(publish, /permissions:\s*\n\s+contents:\s*write/);
  assert.doesNotMatch(publish, /build:windows:final|TAURI_SIGNING_PRIVATE_KEY|prepare-update-release/);
  assert.doesNotMatch(verify, /secrets\.RELEASE_TAURI_SIGNING_PRIVATE_KEY/);
});

test('release artifact checksum verifier rejects changed and unlisted files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-release-artifact-test-'));
  const verifier = path.join(repositoryRoot, 'scripts/validation/verify-release-artifact.mjs');
  try {
    fs.writeFileSync(path.join(temp, 'ClearDownloadManager.nsis.zip'), 'verified package bytes');
    fs.writeFileSync(path.join(temp, 'latest.json'), '{"version":"0.95.4"}\n');
    const names = ['ClearDownloadManager.nsis.zip', 'latest.json'];
    const checksumText = names.map((name) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(temp, name))).digest('hex')}  ${name}`).join('\n') + '\n';
    const checksumPath = path.join(temp, 'SHA256SUMS.txt');
    fs.writeFileSync(checksumPath, checksumText);
    const invoke = () => spawnSync(process.execPath, [verifier, '--directory', temp], { encoding: 'utf8', windowsHide: true });

    assert.equal(invoke().status, 0);
    fs.appendFileSync(path.join(temp, 'latest.json'), 'tampered');
    assert.notEqual(invoke().status, 0);
    fs.writeFileSync(path.join(temp, 'latest.json'), '{"version":"0.95.4"}\n');
    fs.writeFileSync(path.join(temp, 'unlisted.txt'), 'extra');
    assert.notEqual(invoke().status, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('build and normal Windows package commands retain the complete strict release gate', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const releaseGate = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/release-gate.mjs'), 'utf8');
  const windowsBuild = fs.readFileSync(path.join(repositoryRoot, 'scripts/build-windows-beta.ps1'), 'utf8');
  const finalBuild = fs.readFileSync(path.join(repositoryRoot, 'scripts/final-windows-build.ps1'), 'utf8');

  assert.match(releaseGate, /'check:gpl-source'/);
  assert.equal(packageJson.scripts['check:release-build'], undefined);
  assert.match(windowsBuild, /npm\.cmd" @\("run", "check:release"\)/);
  assert.doesNotMatch(windowsBuild, /ForBinaryVerification/);
  assert.match(windowsBuild, /prepare:windows-binaries/);
  assert.match(windowsBuild, /verify:binaries/);
  assert.doesNotMatch(finalBuild, /ForBinaryVerification/);
});

test('PR #14 local build support remains present on the updated PR #13 tree', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const quality = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/quality.yml'), 'utf8');
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const contributing = fs.readFileSync(path.join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8');

  assert.equal(packageJson.scripts['build:local'], 'tauri build --no-bundle');
  assert.equal(packageJson.scripts['check:local-build'], 'node scripts/validation/local-app-build-command.mjs');
  assert.ok(fs.existsSync(path.join(repositoryRoot, 'scripts/validation/local-app-build-command.mjs')));
  assert.match(quality, /npm run check:local-build/);
  assert.match(readme, /npm\.cmd run build:local/);
  assert.match(contributing, /npm\.cmd run build:local/);
});
