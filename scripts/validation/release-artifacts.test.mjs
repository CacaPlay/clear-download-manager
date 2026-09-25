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
import { validateCorrespondingSourceRegistry, inspectCorrespondingSourceReleaseAssets } from './corresponding-source-contract.mjs';

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

test('current playlist icon contract passes the dedicated icon audit', () => {
  const audit = path.join(repositoryRoot, 'scripts/validation/phase20_icon_audit.mjs');
  const result = spawnSync(process.execPath, [audit], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
});

test('source manifest excludes the .git pointer file used by linked worktrees', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-worktree-manifest-test-'));
  const generator = path.join(repositoryRoot, 'scripts/generate-source-manifest.mjs');
  try {
    fs.writeFileSync(path.join(temp, '.git'), 'gitdir: ../worktrees/example/.git\n');
    fs.writeFileSync(path.join(temp, 'source.js'), 'export const clean = true;\n');
    const generated = spawnSync(process.execPath, [generator], { cwd: temp, encoding: 'utf8', windowsHide: true });
    assert.equal(generated.status, 0, `${generated.stdout || ''}${generated.stderr || ''}`);
    const manifest = fs.readFileSync(path.join(temp, 'MANIFEST.sha256'), 'utf8');
    assert.doesNotMatch(manifest, /  \.git\r?\n/);
    assert.match(manifest, /  source\.js\r?\n/);
    const checked = spawnSync(process.execPath, [generator, '--check'], { cwd: temp, encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, `${checked.stdout || ''}${checked.stderr || ''}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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

test('PR Quality uses a source-only gate while binary release keeps GPL source readiness', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const quality = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/quality.yml'), 'utf8');
  const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const releaseGate = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/release-gate.mjs'), 'utf8');
  const binaryReadiness = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/binary-release-readiness.mjs'), 'utf8');
  const qualityGatePath = path.join(repositoryRoot, 'scripts/validation/quality-gate.mjs');
  const qualityList = spawnSync(process.execPath, [qualityGatePath, '--list'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(packageJson.scripts['check:quality'], 'node scripts/validation/quality-gate.mjs');
  assert.match(quality, /npm run check:quality/);
  assert.doesNotMatch(quality, /npm run check:release/);
  assert.equal(qualityList.status, 0, `${qualityList.stdout || ''}${qualityList.stderr || ''}`);
  const qualityGates = JSON.parse(qualityList.stdout).gates;
  assert.ok(!qualityGates.includes('check:gpl-source'));
  assert.ok(qualityGates.includes('check:rights'));
  assert.ok(qualityGates.includes('check:asset-rights'));
  assert.ok(qualityGates.includes('check:asset-provenance'));
  assert.ok(qualityGates.includes('check:licenses'));
  assert.ok(qualityGates.includes('check:manifest'));
  assert.ok(qualityGates.includes('check:source-release'));
  assert.match(releaseGate, /'check:gpl-source'/);
  assert.match(releaseWorkflow, /npm run check:release/);
  assert.match(releaseWorkflow, /npm run check:binary-release/);
  assert.match(binaryReadiness, /run\('check:gpl-source'/);
  assert.match(binaryReadiness, /run\('verify:binaries'/);
});

test('corresponding-source inventory pins full upstream revisions and exact runtime-to-release assets', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'third-party-source/corresponding-source.json'), 'utf8'));
  const byId = new Map(manifest.runtimes.map((entry) => [entry.id, entry]));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.status, 'PENDING');

  for (const id of ['aria2', 'ffmpeg']) {
    const entry = byId.get(id);
    assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(entry.sourceVersion);
    assert.match(entry.binarySha256, /^[a-f0-9]{64}$/);
    assert.match(entry.binaryArchiveSha256, /^[a-f0-9]{64}$/);
    assert.match(entry.releaseAssetName, /^[a-z0-9.-]+\.tar\.xz$/);
    assert.equal(entry.humanReview.required, true);
    assert.equal(entry.humanReview.status, 'PENDING');
    assert.equal(entry.distributionMethod, null);
    for (const runtimeFile of entry.runtimeFiles) {
      assert.match(runtimeFile.sha256, /^[a-f0-9]{64}$/);
      assert.equal(runtimeFile.correspondingSourceAsset, entry.releaseAssetName);
    }
  }
  assert.equal(byId.get('aria2').license, 'GPL-2.0-or-later');
  assert.equal(byId.get('ffmpeg').license, 'GPL-3.0-or-later');
  assert.deepEqual(byId.get('aria2').runtimeFiles.map((file) => file.name), ['aria2c.exe']);
  assert.deepEqual(byId.get('ffmpeg').runtimeFiles.map((file) => file.name), ['ffmpeg.exe', 'ffprobe.exe']);
  const runtime = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'src-tauri/resources/bin/runtime-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const issues = validateCorrespondingSourceRegistry(manifest, runtime, repositoryRoot);
  assert.deepEqual(issues.failures, []);
  assert.ok(issues.pending.length > 0);
  assert.match(runtime.aria2.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(runtime.ffmpeg.sourceCommit, /^[a-f0-9]{40}$/);
  const prepareScript = fs.readFileSync(path.join(repositoryRoot, 'scripts/prepare-windows-binaries.ps1'), 'utf8');
  assert.match(prepareScript, /Aria2SourceCommit\s*=\s*"02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a"/);
  assert.match(prepareScript, /FfmpegSourceCommit\s*=\s*"946fcce07b6dcd0331c8cc609192aeff5e1924f8"/);
  assert.match(prepareScript, /FullCommitPattern/);
  assert.match(prepareScript, /FfmpegSourceCommit\s+-ne\s+"946fcce07b6dcd0331c8cc609192aeff5e1924f8"/);

  const badCommitManifest = structuredClone(manifest);
  badCommitManifest.runtimes.find((entry) => entry.id === 'ffmpeg').sourceCommit = '946fcce07b';
  const badCommit = validateCorrespondingSourceRegistry(badCommitManifest, runtime, repositoryRoot);
  assert.match(badCommit.failures.join('\n'), /full pinned 40-character source commit/);

  const badLinkManifest = structuredClone(manifest);
  badLinkManifest.runtimes.find((entry) => entry.id === 'ffmpeg').runtimeFiles[0].correspondingSourceAsset = 'ffmpeg-any-source.tar.xz';
  const badLink = validateCorrespondingSourceRegistry(badLinkManifest, runtime, repositoryRoot);
  assert.match(badLink.failures.join('\n'), /exact runtime filenames, hashes, and corresponding-source asset links/);

  const reviewDisabledManifest = structuredClone(manifest);
  reviewDisabledManifest.runtimes.find((entry) => entry.id === 'aria2').humanReview.required = false;
  const reviewDisabled = validateCorrespondingSourceRegistry(reviewDisabledManifest, runtime, repositoryRoot);
  assert.match(reviewDisabled.failures.join('\n'), /explicit required=true/);
});

test('yt-dlp Windows standalone is a GPL runtime and remains source-pending', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'third-party-source/corresponding-source.json'), 'utf8'));
  const byId = new Map(manifest.runtimes.map((entry) => [entry.id, entry]));
  const entry = byId.get('yt-dlp');
  assert.ok(entry, 'yt-dlp.exe must participate in corresponding-source readiness');
  assert.equal(entry.license, 'GPL-3.0-or-later');
  assert.equal(entry.version, '2026.08.19');
  assert.equal(entry.sourceRepository, 'https://github.com/yt-dlp/yt-dlp');
  assert.equal(entry.sourceVersion, '2026.08.19');
  assert.equal(entry.sourceCommit, '3a08beaf031ab68f966401ead017ac81fe8486cf');
  assert.equal(entry.binarySha256, '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a');
  assert.equal(entry.binaryAssetSha256, entry.binarySha256);
  assert.equal(entry.releaseAssetName, 'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz');
  assert.equal(entry.humanReview.required, true);
  assert.equal(entry.humanReview.status, 'PENDING');
  assert.equal(entry.distributionMethod, null);
  assert.deepEqual(entry.runtimeFiles, [{
    name: 'yt-dlp.exe',
    sha256: entry.binarySha256,
    correspondingSourceAsset: entry.releaseAssetName,
  }]);

  const runtime = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'src-tauri/resources/bin/runtime-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(runtime.ytDlp.effectiveLicense, 'GPL-3.0-or-later');
  assert.equal(runtime.ytDlp.sourceCommit, entry.sourceCommit);
  assert.match(runtime.deno.version, /^deno 2\.9\.7/);
  assert.equal(byId.has('deno'), false);
  const licenses = fs.readFileSync(path.join(repositoryRoot, 'src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt'), 'utf8');
  assert.match(licenses, /mutagen \| GPL-2\.0-or-later/);
  const issues = validateCorrespondingSourceRegistry(manifest, runtime, repositoryRoot);
  assert.deepEqual(issues.failures, []);
  assert.ok(issues.pending.some((issue) => issue.startsWith('yt-dlp:')));
});

test('binary release requires exact corresponding-source assets outside the expanded installer tree', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const binaryReadiness = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/binary-release-readiness.mjs'), 'utf8');
  const sourceContract = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/corresponding-source-contract.mjs'), 'utf8');
  assert.doesNotMatch(binaryReadiness, /files\.some\(\(file\)\s*=>\s*\/\(\?:aria2\|ffmpeg\)/);
  assert.match(binaryReadiness, /--release-assets-dir/);
  assert.match(binaryReadiness, /inspectCorrespondingSourceReleaseAssets/);
  assert.match(binaryReadiness, /\['yt-dlp\.exe', runtime\.ytDlp\?\.sha256\]/, 'package inspection must hash-check the bundled yt-dlp.exe');
  assert.match(binaryReadiness, /'yt-dlp-notice\.txt'/, 'package inspection must require the yt-dlp effective-license notice');
  assert.match(binaryReadiness, /'yt-dlp-third-party-licenses\.txt'/, 'package inspection must require the pinned yt-dlp third-party license inventory');
  assert.match(sourceContract, /releaseAssetName/);
  assert.match(sourceContract, /releaseAssetSha256/);
  assert.match(workflow, /--release-assets-dir\s+output\/update-release/);

  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'third-party-source/corresponding-source.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-corresponding-source-test-'));
  try {
    fs.writeFileSync(path.join(temp, 'unrelated-aria2-source-files.tar.xz'), 'not the named release asset');
    const absent = inspectCorrespondingSourceReleaseAssets(manifest, temp);
    assert.deepEqual(absent.failures, []);
    assert.equal(absent.pending.length, 3);

    const exactManifest = structuredClone(manifest);
    for (const entry of exactManifest.runtimes) {
      const bytes = Buffer.from(`fixture for ${entry.id}`);
      fs.writeFileSync(path.join(temp, entry.releaseAssetName), bytes);
      entry.releaseAssetSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    const present = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.deepEqual(present, { failures: [], pending: [] });

    exactManifest.runtimes[0].releaseAssetSha256 = '0'.repeat(64);
    const tampered = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.match(tampered.failures.join('\n'), /SHA-256 does not match/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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

test('Quality and release CI install pinned Playwright Chromium before their respective gates', () => {
  const quality = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/quality.yml'), 'utf8');
  const release = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const buildTestStart = release.indexOf('\n  build-test:');
  const packageSignStart = release.indexOf('\n  package-sign:');
  assert.ok(buildTestStart >= 0 && packageSignStart > buildTestStart);
  const buildTest = release.slice(buildTestStart, packageSignStart);

  for (const [name, workflow, gateCommand] of [
    ['Quality', quality, 'npm run check:quality'],
    ['release build-test', buildTest, 'npm run check:release'],
  ]) {
    const installIndex = workflow.indexOf('playwright==1.62.0');
    const browserIndex = workflow.indexOf('python -m playwright install chromium');
    const gateIndex = workflow.indexOf(gateCommand);
    assert.ok(installIndex >= 0, `${name} must install the pinned Python Playwright package`);
    assert.ok(browserIndex > installIndex, `${name} must install Chromium after Playwright`);
    assert.ok(gateIndex > browserIndex, `${name} must install Chromium before ${gateCommand}`);
  }
});
