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
import { inspectCorePackageFiles } from './core-package-contract.mjs';

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
  assert.equal(brand.assetCount, 68);
  assert.equal(brand.clearanceScope, 'DISTRIBUTION_RIGHTS_ONLY');
  assert.equal(brand.licenseTreatment, 'EXCLUDED_FROM_GPL');
  assert.equal(brand.status, 'CLEAR');
  assert.equal(brand.ownerAttestationStatus, 'CONFIRMED');
  assert.equal(generated.assetCount, 8);
  assert.equal(generated.status, 'CLEAR');
  assert.equal(generated.ownerAttestationStatus, 'CONFIRMED');
  assert.equal(product.assetCount, 136);
  assert.equal(product.status, 'CLEAR');
  assert.equal(product.ownerAttestationStatus, 'CONFIRMED');
  assert.deepEqual(product.attestationSubgroups.map((group) => [group.id, group.assetCount, group.status]), [
    ['clear-product-file-type-icons', 105, 'CONFIRMED'],
    ['clear-product-other-art', 31, 'CONFIRMED'],
  ]);
  assert.equal(assetRights.unknownProvenance.assetCount, 212);
  const navbar = assetRights.groups.find((group) => group.id === 'clear-supplied-navigation-icons');
  assert.equal(navbar.assetCount, 8);
  assert.equal(navbar.ownerAttestationStatus, 'CONFIRMED');
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
  const pr5 = releaseRights.items.find((item) => item.id === 'pr5-platform-output');
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

test('release preparation adds a stable installer alias from the verified versioned setup bytes', () => {
  const script = fs.readFileSync(path.join(repositoryRoot, 'scripts/prepare-update-release.ps1'), 'utf8');
  assert.match(script, /\$StableInstallerName = 'ClearDownloadManagerSetup\.exe'/);
  assert.match(script, /Copy-Item -LiteralPath \$SetupInstaller\.FullName -Destination \$StableInstallerPath/);
  assert.match(script, /\$StableHash -cne \$VersionedHash/);
  const guide = fs.readFileSync(path.join(repositoryRoot, 'docs/RELEASE-GUIDE.md'), 'utf8');
  assert.match(guide, /releases\/latest\/download\/ClearDownloadManagerSetup\.exe/);
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
  const componentSecretRefs = [...workflow.matchAll(/secrets\.RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY/g)];

  assert.match(buildTest, /npm run check:local-build/);
  assert.match(buildTest, /npm run check:release/);
  assert.doesNotMatch(buildTest, /check:release-build/);
  assert.match(buildTest, /npm run source:archive/);
  assert.match(buildTest, /npm run test:release-artifacts/);
  assert.match(buildTest, /npm run source:yt-dlp:fetch/);
  assert.match(buildTest, /name: Checkout pinned release tooling[\s\S]*?ref:\s*\$\{\{\s*github\.workflow_sha\s*\}\}[\s\S]*?path:\s*output\/release-tools/);
  assert.match(buildTest, /python output\/release-tools\/scripts\/assemble-yt-dlp-corresponding-source\.py/);
  assert.doesNotMatch(buildTest, /python scripts\/assemble-yt-dlp-corresponding-source\.py/);
  assert.match(buildTest, /78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184/);
  assert.match(buildTest, /yt_dlp_source_artifact_id:\s*\$\{\{\s*steps\.yt_dlp_source_artifact\.outputs\.artifact-id\s*\}\}/);
  assert.match(buildTest, /id:\s*yt_dlp_source_artifact[\s\S]*?yt-dlp-2026\.08\.19-win64-corresponding-source\.tar\.xz/);
  assert.doesNotMatch(buildTest, /check:binary-release/);
  assert.match(buildTest, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(buildTest, /secrets\./);
  assert.match(packageSign, /environment:\s*\n\s+name: release/);
  assert.match(packageSign, /contents:\s*read/);
  assert.match(packageSign, /npm run build:windows:final/);
  assert.match(packageSign, /artifact-ids:\s*\$\{\{\s*needs\.build-test\.outputs\.yt_dlp_source_artifact_id\s*\}\}/);
  assert.match(packageSign, /yt-dlp-2026\.08\.19-win64-corresponding-source\.tar\.xz/);
  assert.match(packageSign, /output\/update-release/);
  assert.match(packageSign, /uses:\s*actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(packageSign, /release_artifact_id:\s*\$\{\{\s*steps\.release_artifact\.outputs\.artifact-id\s*\}\}/);
  assert.equal(secretRefs.length, 2);
  assert.ok(secretRefs.every((match) => match.index >= workflow.indexOf('  package-sign:')));
  assert.equal(componentSecretRefs.length, 1);
  assert.ok(componentSecretRefs[0].index >= workflow.indexOf('  package-sign:'));
  assert.ok(componentSecretRefs[0].index < workflow.indexOf('  verify-binary-release:'));
  assert.match(packageSign, /Sign inline Component Manager catalog/);
  assert.match(packageSign, /verify-production/);
  assert.match(packageSign, /component-release-assets\.mjs/);
  assert.match(verify, /artifact-ids:\s*\$\{\{\s*needs\.package-sign\.outputs\.release_artifact_id\s*\}\}/);
  assert.match(verify, /component-release-assets\.mjs/);
  assert.match(verify, /verify-production/);
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

test('release preparation trusts PowerShell errors, validates native exit codes, and keeps binary verification before publish', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const prepareScript = fs.readFileSync(path.join(repositoryRoot, 'scripts/prepare-update-release.ps1'), 'utf8');
  const jobsText = workflow.slice(workflow.indexOf('\njobs:') + '\njobs:'.length);
  const packageSignStart = jobsText.indexOf('\n  package-sign:');
  const verifyStart = jobsText.indexOf('\n  verify-binary-release:');
  const publishStart = jobsText.indexOf('\n  publish:');
  assert.ok(packageSignStart >= 0 && verifyStart > packageSignStart && publishStart > verifyStart);
  const packageSign = jobsText.slice(packageSignStart, verifyStart);
  const verify = jobsText.slice(verifyStart, publishStart);
  const publish = jobsText.slice(publishStart);
  const prepareStepStart = packageSign.indexOf('- name: Prepare signed Core/update files and CDM source archive');
  const prepareStepEnd = packageSign.indexOf('\n      - name:', prepareStepStart + 1);
  assert.ok(prepareStepStart >= 0 && prepareStepEnd > prepareStepStart);
  const prepareStep = packageSign.slice(prepareStepStart, prepareStepEnd);
  const assemblyStepStart = packageSign.indexOf('- name: Assemble exact optional component packages and release evidence');
  const assemblyStepEnd = packageSign.indexOf('\n      - name:', assemblyStepStart + 1);
  assert.ok(assemblyStepStart >= 0 && assemblyStepEnd > assemblyStepStart);
  const assemblyStep = packageSign.slice(assemblyStepStart, assemblyStepEnd);
  const signStepStart = packageSign.indexOf('- name: Sign inline Component Manager catalog');
  const signStepEnd = packageSign.indexOf('\n      - name:', signStepStart + 1);
  const catalogVerifyStepStart = packageSign.indexOf('- name: Verify catalog with the production public key embedded in Core');
  const catalogVerifyStepEnd = packageSign.indexOf('\n      - name:', catalogVerifyStepStart + 1);
  assert.ok(signStepStart >= 0 && signStepEnd > signStepStart);
  assert.ok(catalogVerifyStepStart >= 0 && catalogVerifyStepEnd > catalogVerifyStepStart);
  const signStep = packageSign.slice(signStepStart, signStepEnd);
  const catalogVerifyStep = packageSign.slice(catalogVerifyStepStart, catalogVerifyStepEnd);

  assert.match(prepareStep, /\.\/scripts\/prepare-update-release\.ps1[^\n]*/);
  assert.match(prepareStep, /\$sourceArchives/);
  assert.doesNotMatch(prepareStep, /\$LASTEXITCODE/);
  for (const step of workflow.split(/(?=^\s{6}- (?:name|uses):)/m)) {
    if (/^\s*run:\s*\|/m.test(step) && /\.\/scripts\/[^\r\n]+\.ps1/m.test(step)) {
      assert.doesNotMatch(step, /\$LASTEXITCODE/, 'direct .ps1 workflow steps must use PowerShell terminating errors');
    }
  }
  assert.match(assemblyStep, /\.\/scripts\/assemble-component-release-assets\.ps1[^\n]*/);
  assert.match(assemblyStep, /\.\/scripts\/validation\/inspect-component-packages\.ps1[^\n]*/);
  assert.doesNotMatch(assemblyStep, /\$LASTEXITCODE/, 'direct PowerShell scripts must report failures through terminating errors');
  for (const runtimeFile of [
    'runtime-manifest.json',
    'yt-dlp.exe',
    'ffmpeg.exe',
    'ffprobe.exe',
    'deno.exe',
    'aria2c.exe',
  ]) {
    assert.ok(assemblyStep.includes(runtimeFile), `component packaging must preflight ${runtimeFile}`);
  }
  assert.match(prepareScript, /^\$ErrorActionPreference\s*=\s*'Stop'\s*$/m);
  assert.match(prepareScript, /\bthrow\b/);
  assert.match(packageSign, /npm run build:windows:final\s*\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw 'The signed Windows package build failed\.' \}/);
  assert.match(signStep, /cargo run[^\n]* -- sign[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(catalogVerifyStep, /cargo run[^\n]*verify-production[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(catalogVerifyStep, /node scripts\/validation\/component-release-assets\.mjs[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(verify, /npm run check:binary-release[\s\S]*?if \(\$LASTEXITCODE -ne 0\) \{ throw 'The final binary release gate did not pass; publication is blocked\.' \}/);
  assert.match(publish, /needs:[\s\S]*- verify-binary-release/);
  assert.match(publish, /needs\.verify-binary-release\.result\s*==\s*'success'/);
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
  assert.doesNotMatch(binaryReadiness, /run\('verify:binaries'/, 'the Core release gate must not require optional runtimes under resources/bin');
  assert.match(binaryReadiness, /--component-packages-dir/);
  assert.match(binaryReadiness, /inspect-component-packages\.ps1/);
  const componentInspector = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/inspect-component-packages.ps1'), 'utf8');
  assert.match(componentInspector, /assetName="media-tools-\$MediaToolsVersion\.cdmcomponent"/);
  assert.match(componentInspector, /assetName="torrent-engine-\$TorrentEngineVersion\.cdmcomponent"/);
  assert.match(componentInspector, /yt-dlp\.exe/);
  const licenseReadiness = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/license-readiness.mjs'), 'utf8');
  assert.match(licenseReadiness, /inspect-component-packages\.ps1/);
  assert.doesNotMatch(licenseReadiness, /Binary package inspection must verify the bundled yt-dlp\.exe hash/);
});

test('corresponding-source inventory pins full upstream revisions and exact runtime-to-release assets', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'third-party-source/corresponding-source.json'), 'utf8'));
  const byId = new Map(manifest.runtimes.map((entry) => [entry.id, entry]));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.status, 'READY');

  for (const id of ['aria2', 'ffmpeg', 'yt-dlp']) {
    const entry = byId.get(id);
    assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(entry.sourceVersion);
    assert.match(entry.binarySha256, /^[a-f0-9]{64}$/);
    assert.match(entry.releaseAssetName, /^[a-z0-9.-]+\.tar\.xz$/);
    assert.equal(entry.distributionApproval.required, true);
    assert.equal(Object.hasOwn(entry, 'humanReview'), false, 'the public source registry must not retain the legacy approval field');
    if (id === 'ffmpeg') {
      assert.equal(entry.runtimeManifestKey, 'ffmpegSafeLeanCandidate');
      assert.equal(entry.releaseAssetName, 'ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz');
      assert.equal(entry.binarySha256, 'e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f');
      assert.equal(entry.ffprobeSha256, '787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3');
      assert.equal(entry.distributionApproval.status, 'APPROVED');
      assert.equal(entry.distributionMethod, 'corresponding-source-archive');
      assert.equal(entry.releaseAssetSha256, 'b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58');
      assert.equal(entry.sourceArchiveSha256, entry.releaseAssetSha256);
      if (entry.id === 'yt-dlp') {
        assert.equal(entry.sourceArchivePath, `output/release-assets/${entry.releaseAssetName}`);
        assert.equal(entry.sourceArchiveGenerated, true);
      } else {
        assert.match(entry.sourceArchivePath, /^third-party-source\//);
      }
      assert.match(entry.buildInputsPath, /^third-party-source\//);
      assert.match(entry.distributionApproval.approvalRecordPath, /^third-party-source\//);
      assert.match(entry.distributionApproval.approvalRecordSha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.binarySourceUrl, null, 'a locally built candidate must not claim the old upstream binary URL');
      assert.equal(entry.binaryArchiveSha256, null, 'a locally built candidate has no upstream binary archive digest');
    } else if (id === 'aria2') {
      assert.equal(entry.distributionApproval.status, 'APPROVED');
      assert.equal(entry.distributionApproval.approvalRecordPath, 'third-party-source/reviews/aria2-1.37.0-win64-distributor-review.md');
      assert.match(entry.distributionApproval.approvalRecordSha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.distributionMethod, 'corresponding-source-archive');
      assert.equal(entry.technicalStatus, 'READY_FOR_DISTRIBUTOR_APPROVAL');
      assert.deepEqual(entry.technicalBlockers, []);
      assert.equal(entry.releaseAssetName, 'aria2-1.37.0-win64-corresponding-source.tar.xz');
      assert.match(entry.sourceArchiveSha256, /^[a-f0-9]{64}$/);
      assert.match(entry.buildInputsSha256, /^[a-f0-9]{64}$/);
      assert.match(entry.binaryArchiveSha256, /^[a-f0-9]{64}$/);
    } else {
      assert.equal(entry.distributionApproval.status, 'APPROVED');
      assert.equal(entry.distributionApproval.approvalRecordPath, 'third-party-source/reviews/yt-dlp-2026.08.19-win64-distributor-review.md');
      assert.match(entry.distributionApproval.approvalRecordSha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.distributionMethod, 'corresponding-source-archive');
      assert.equal(entry.technicalStatus, 'READY_FOR_DISTRIBUTOR_APPROVAL');
      assert.deepEqual(entry.technicalBlockers, []);
      assert.equal(entry.releaseAssetName, 'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz');
      assert.equal(entry.binaryAssetSha256, '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a');
      assert.match(entry.sourceArchiveSha256, /^[a-f0-9]{64}$/);
      assert.match(entry.buildInputsSha256, /^[a-f0-9]{64}$/);
    }
    if (id === 'aria2' || id === 'yt-dlp') {
      const buildInputsBytes = fs.readFileSync(path.join(repositoryRoot, entry.buildInputsPath));
      assert.equal(buildInputsBytes.includes(0x0d), false, `${id} build-input record must use the exact LF bytes tracked by Git`);
    }
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
  assert.equal(runtime.ffmpeg.profile, 'SAFE LEAN');
  assert.equal(runtime.ffmpeg.approvedCandidateKey, 'ffmpegSafeLeanCandidate');
  assert.equal(runtime.ffmpeg.ffmpegSha256, byId.get('ffmpeg').binarySha256);
  assert.equal(runtime.ffmpeg.ffprobeSha256, byId.get('ffmpeg').ffprobeSha256);
  assert.equal(runtime.ffmpeg.sourceArchiveSha256, byId.get('ffmpeg').sourceArchiveSha256);
  assert.equal(runtime.ffmpeg.distributionApprovalSha256, byId.get('ffmpeg').distributionApproval.approvalRecordSha256);
  assert.doesNotMatch(runtime.ffmpeg.source, /GyanD|gyan\.dev/i);
  const settingsScript = fs.readFileSync(path.join(repositoryRoot, 'app-ui/main.js'), 'utf8');
  assert.match(settingsScript, /ffmpeg:\s*'https:\/\/github\.com\/FFmpeg\/FFmpeg'/);
  assert.doesNotMatch(settingsScript, /https:\/\/github\.com\/GyanD\/codexffmpeg/i);
  assert.equal(runtime.ffmpegSafeLeanCandidate.ffmpegSha256, byId.get('ffmpeg').binarySha256);
  assert.equal(runtime.ffmpegSafeLeanCandidate.ffprobeSha256, byId.get('ffmpeg').ffprobeSha256);
  assert.equal(runtime.ffmpegSafeLeanCandidate.sourceArchiveSha256, byId.get('ffmpeg').sourceArchiveSha256);
  assert.equal(runtime.ffmpegSafeLeanCandidate.distributionApprovalSha256, byId.get('ffmpeg').distributionApproval.approvalRecordSha256);
  const issues = validateCorrespondingSourceRegistry(manifest, runtime, repositoryRoot);
  assert.deepEqual(issues.failures, []);
  assert.deepEqual(issues.pending, []);
  assert.equal(issues.pending.some((issue) => issue.includes('SAFE LEAN candidate is approved but not the active FFmpeg runtime')), false);
  for (const id of ['aria2', 'yt-dlp']) {
    const approval = byId.get(id).distributionApproval;
    const record = fs.readFileSync(path.join(repositoryRoot, approval.approvalRecordPath), 'utf8');
    assert.match(record, /Status: \*\*APPROVED\*\*/);
    assert.match(record, /limitations are explicitly accepted/i);
  }
  const reviewRecord = fs.readFileSync(path.join(repositoryRoot, byId.get('ffmpeg').distributionApproval.approvalRecordPath), 'utf8');
  assert.match(reviewRecord, /“Apruebo el par canónico SAFE LEAN y su corresponding-source package para integrarlos en CDM\. Autoriza registrar la revisión humana y continuar con PR #16, sin tag ni release\.”/);
  assert.match(reviewRecord, /aria2.*PENDING/s);
  assert.match(reviewRecord, /yt-dlp.*PENDING/s);
  assert.match(runtime.aria2.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(runtime.ffmpeg.sourceCommit, /^[a-f0-9]{40}$/);
  const prepareScript = fs.readFileSync(path.join(repositoryRoot, 'scripts/prepare-windows-binaries.ps1'), 'utf8');
  const safeLeanPrepareScript = fs.readFileSync(path.join(repositoryRoot, 'scripts/prepare-safe-lean-ffmpeg.ps1'), 'utf8');
  assert.match(prepareScript, /standalone Windows executable is a combined PyInstaller distribution/i);
  assert.match(prepareScript, /Mutagen as GPL-2\.0-or-later/i);
  assert.match(prepareScript, /Aria2SourceCommit\s*=\s*"02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a"/);
  assert.match(prepareScript, /FfmpegSourceCommit\s*=\s*"946fcce07b6dcd0331c8cc609192aeff5e1924f8"/);
  assert.match(prepareScript, /FullCommitPattern/);
  assert.match(prepareScript, /FfmpegSourceCommit\s+-ne\s+"946fcce07b6dcd0331c8cc609192aeff5e1924f8"/);
  assert.doesNotMatch(prepareScript, /GyanD|gyan\.dev|essentials_build/i);
  assert.match(prepareScript, /ffmpeg-9\.0\.2-safe-lean-win64-corresponding-source\.tar\.xz/);
  assert.match(prepareScript, /prepare-safe-lean-ffmpeg\.ps1/);
  assert.match(prepareScript, /e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f/);
  assert.match(prepareScript, /787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3/);
  const activeFfmpegNotice = fs.readFileSync(path.join(repositoryRoot, 'src-tauri/resources/licenses/FFMPEG-NOTICE.txt'), 'utf8');
  assert.match(activeFfmpegNotice, /SAFE LEAN/);
  assert.doesNotMatch(activeFfmpegNotice, /GyanD|gyan\.dev/i);
  assert.match(safeLeanPrepareScript, /Assert-PinnedFile \$SourceArchivePath/);
  assert.match(safeLeanPrepareScript, /Assert-PinnedFile \$ffmpegPath/);
  assert.match(safeLeanPrepareScript, /Assert-PinnedFile \$ffprobePath/);
  assert.match(safeLeanPrepareScript, /build-safe-lean\.sh/);
  assert.match(safeLeanPrepareScript, /COPYING\.GPLv3/);

  const badCommitManifest = structuredClone(manifest);
  badCommitManifest.runtimes.find((entry) => entry.id === 'ffmpeg').sourceCommit = '946fcce07b';
  const badCommit = validateCorrespondingSourceRegistry(badCommitManifest, runtime, repositoryRoot);
  assert.match(badCommit.failures.join('\n'), /full pinned 40-character source commit/);

  const badLinkManifest = structuredClone(manifest);
  badLinkManifest.runtimes.find((entry) => entry.id === 'ffmpeg').runtimeFiles[0].correspondingSourceAsset = 'ffmpeg-any-source.tar.xz';
  const badLink = validateCorrespondingSourceRegistry(badLinkManifest, runtime, repositoryRoot);
  assert.match(badLink.failures.join('\n'), /exact runtime filenames, hashes, and corresponding-source asset links/);

  const badSafeLeanAssetManifest = structuredClone(manifest);
  badSafeLeanAssetManifest.runtimes.find((entry) => entry.id === 'ffmpeg').releaseAssetName = 'ffmpeg-9.0.2-essentials-win64-corresponding-source.tar.xz';
  const badSafeLeanAsset = validateCorrespondingSourceRegistry(badSafeLeanAssetManifest, runtime, repositoryRoot);
  assert.match(badSafeLeanAsset.failures.join('\n'), /must be exactly ffmpeg-9\.0\.2-safe-lean-win64-corresponding-source\.tar\.xz/);

  const badCandidateHashManifest = structuredClone(manifest);
  const badCandidateHashEntry = badCandidateHashManifest.runtimes.find((entry) => entry.id === 'ffmpeg');
  const badCandidateHashRuntime = structuredClone(runtime);
  badCandidateHashRuntime.ffmpegSafeLeanCandidate.ffmpegSha256 = 'a'.repeat(64);
  badCandidateHashEntry.binarySha256 = 'a'.repeat(64);
  badCandidateHashEntry.runtimeFiles[0].sha256 = 'a'.repeat(64);
  const badCandidateHash = validateCorrespondingSourceRegistry(badCandidateHashManifest, badCandidateHashRuntime, repositoryRoot);
  assert.match(badCandidateHash.failures.join('\n'), /canonical executable hashes do not match the approved runtime pair/);

  const badReviewLinkRuntime = structuredClone(runtime);
  badReviewLinkRuntime.ffmpegSafeLeanCandidate.distributionApprovalRecordPath = 'third-party-source/README.md';
  const badReviewLink = validateCorrespondingSourceRegistry(manifest, badReviewLinkRuntime, repositoryRoot);
  assert.match(badReviewLink.failures.join('\n'), /approval record path and SHA-256 must exactly match runtime-manifest\.json/);

  const reviewDisabledManifest = structuredClone(manifest);
  reviewDisabledManifest.runtimes.find((entry) => entry.id === 'aria2').distributionApproval.required = false;
  const reviewDisabled = validateCorrespondingSourceRegistry(reviewDisabledManifest, runtime, repositoryRoot);
  assert.match(reviewDisabled.failures.join('\n'), /explicit required=true/);

  const legacyApprovalManifest = structuredClone(manifest);
  const legacyEntry = legacyApprovalManifest.runtimes.find((entry) => entry.id === 'aria2');
  legacyEntry.humanReview = legacyEntry.distributionApproval;
  delete legacyEntry.distributionApproval;
  const legacyApproval = validateCorrespondingSourceRegistry(legacyApprovalManifest, runtime, repositoryRoot);
  assert.match(legacyApproval.failures.join('\n'), /unsupported fields: humanReview/);
  assert.match(legacyApproval.failures.join('\n'), /\.distributionApproval: explicit required=true/);

  const oldRegistrySchema = structuredClone(manifest);
  oldRegistrySchema.schemaVersion = 2;
  const oldRegistry = validateCorrespondingSourceRegistry(oldRegistrySchema, runtime, repositoryRoot);
  assert.match(oldRegistry.failures.join('\n'), /schemaVersion must be 3/);
});

test('yt-dlp source candidate is hash-pinned and approved against its explicit review record', () => {
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
  assert.equal(entry.distributionApproval.required, true);
  assert.equal(entry.distributionApproval.status, 'APPROVED');
  assert.equal(entry.distributionApproval.approvalRecordPath, 'third-party-source/reviews/yt-dlp-2026.08.19-win64-distributor-review.md');
  assert.match(entry.distributionApproval.approvalRecordSha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.distributionMethod, 'corresponding-source-archive');
  assert.equal(entry.technicalStatus, 'READY_FOR_DISTRIBUTOR_APPROVAL');
  assert.deepEqual(entry.technicalBlockers, []);
  assert.equal(entry.sourceArchivePath, 'output/release-assets/yt-dlp-2026.08.19-win64-corresponding-source.tar.xz');
  assert.equal(entry.sourceArchiveGenerated, true);
  assert.equal(entry.sourceArchiveBytes, 89855212);
  assert.equal(entry.sourceArchiveSha256, '78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184');
  assert.equal(entry.releaseAssetSha256, entry.sourceArchiveSha256);
  assert.match(entry.buildInputsSha256, /^[a-f0-9]{64}$/);
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
  const buildInputs = JSON.parse(fs.readFileSync(path.join(repositoryRoot, entry.buildInputsPath), 'utf8'));
  assert.equal(buildInputs.schemaVersion, 2);
  assert.equal(buildInputs.runtime.binarySha256, entry.binarySha256);
  assert.deepEqual(buildInputs.pinnedDownloadInputs, {
    path: 'third-party-source/reviews/yt-dlp-2026.08.19-win64-download-inputs.json',
    sha256: 'afc4027a5c6ec497028406f1c7c530db3149f29c3722a9d66abce167ae3ff36d',
  });
  assert.deepEqual(buildInputs.cleanFetchAssembly, {
    stagingWasEmpty: true,
    verifiedDownloadCount: 40,
    inventoryCount: 1,
    archiveName: 'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz',
    bytes: 89855212,
    sha256: '78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184',
  });
  const pyinstallerRelease = buildInputs.upstreamBuildRecipe.pyinstallerDistribution;
  assert.deepEqual(pyinstallerRelease, {
    repository: 'https://github.com/yt-dlp/Pyinstaller-Builds',
    releaseTag: '2026.08.19.215425',
    releaseUrl: 'https://github.com/yt-dlp/Pyinstaller-Builds/releases/tag/2026.08.19.215425',
    releaseId: 373374519,
    createdAt: '2026-08-15T22:43:15Z',
    publishedAt: '2026-08-19T22:00:11Z',
    immutable: true,
    wheelAsset: {
      name: 'pyinstaller-6.22.0-py3-none-win_amd64.whl',
      url: 'https://github.com/yt-dlp/Pyinstaller-Builds/releases/download/2026.08.19.215425/pyinstaller-6.22.0-py3-none-win_amd64.whl',
      bytes: 1101025,
      sha256: '294099ecb5fdd2a13ae4c29006d4e335b697a63b6a16cf052b90ec2b40bef05a',
    },
    sourceAsset: {
      name: 'pyinstaller-6.22.0.tar.gz',
      url: 'https://github.com/yt-dlp/Pyinstaller-Builds/releases/download/2026.08.19.215425/pyinstaller-6.22.0.tar.gz',
      bytes: 3527013,
      sha256: '2fadbed5d951d53f003ed899312823a07dbba59990a223cbe538933e1c42a168',
      sourceCommit: '70fc17210920bce17f4ab09bbf8104b0dbd45338',
    },
  });
  assert.equal(buildInputs.upstreamBuildRecipe.repository, 'https://github.com/yt-dlp/Pyinstaller-Builds');
  assert.equal(buildInputs.correspondingSourceArchive.bytes, entry.sourceArchiveBytes);
  assert.equal(buildInputs.correspondingSourceArchive.path, entry.sourceArchivePath);
  assert.equal(buildInputs.correspondingSourceArchive.sha256, entry.sourceArchiveSha256);
  assert.equal(buildInputs.correspondingSourceArchive.generatedFromPinnedInputs, true);
  assert.equal(buildInputs.rebuildAssessment.cleanWindowsRebuildPerformed, false);
  assert.equal(buildInputs.rebuildAssessment.distributionApproval, 'PENDING');
  const reviewRecord = fs.readFileSync(path.join(repositoryRoot, entry.distributionApproval.approvalRecordPath), 'utf8');
  assert.match(reviewRecord, /runtime: yt-dlp 2026\.08\.19/i);
  assert.match(reviewRecord, /clean empty staging fetch:\s*\*\*PASS\*\*/i);
  assert.match(reviewRecord, /40 pinned inputs were verified by size and SHA-256/i);
  assert.match(reviewRecord, /no bit-identical rebuild has been established/i);
  const issues = validateCorrespondingSourceRegistry(manifest, runtime, repositoryRoot);
  assert.deepEqual(issues.failures, []);
  assert.deepEqual(issues.pending, []);
});

test('yt-dlp generated metadata remains guarded by one exact corresponding-source archive pin', () => {
  const expected = {
    bytes: 89855212,
    sha256: '78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184',
    internalManifestSha256: '7cb5d0d0a0e1e818b0e7f800a3ecefb85a3231be8e1186180cc587eec0bb186d',
  };
  const assembler = fs.readFileSync(path.join(repositoryRoot, 'scripts/assemble-yt-dlp-corresponding-source.py'), 'utf8');
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const sourceContract = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/corresponding-source-contract.mjs'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'third-party-source/corresponding-source.json'), 'utf8'));
  const entry = manifest.runtimes.find((runtime) => runtime.id === 'yt-dlp');
  const buildInputs = JSON.parse(fs.readFileSync(path.join(repositoryRoot, entry.buildInputsPath), 'utf8'));

  assert.equal(Number(assembler.match(/^EXPECTED_ARCHIVE_BYTES = (\d+)$/m)?.[1]), expected.bytes);
  assert.equal(assembler.match(/^EXPECTED_ARCHIVE_SHA256 = "([a-f0-9]{64})"$/m)?.[1], expected.sha256);
  assert.match(assembler, /"distributionApproval": \{"required": True, "status": "PENDING"\}/);
  assert.doesNotMatch(assembler, /"humanReview"/);
  assert.match(assembler, /if actual_bytes != EXPECTED_ARCHIVE_BYTES or actual_hash != EXPECTED_ARCHIVE_SHA256:/);
  assert.equal(entry.sourceArchiveBytes, expected.bytes);
  assert.equal(entry.sourceArchiveSha256, expected.sha256);
  assert.equal(entry.releaseAssetSha256, expected.sha256);
  assert.equal(buildInputs.correspondingSourceArchive.bytes, expected.bytes);
  assert.equal(buildInputs.correspondingSourceArchive.sha256, expected.sha256);
  assert.equal(buildInputs.correspondingSourceArchive.internalManifestSha256, expected.internalManifestSha256);
  assert.equal(buildInputs.correspondingSourceArchive.sourcePackageManifestSha256, expected.internalManifestSha256);
  assert.deepEqual(buildInputs.cleanFetchAssembly, {
    stagingWasEmpty: true,
    verifiedDownloadCount: 40,
    inventoryCount: 1,
    archiveName: 'yt-dlp-2026.08.19-win64-corresponding-source.tar.xz',
    bytes: expected.bytes,
    sha256: expected.sha256,
  });
  assert.equal((workflow.match(new RegExp(expected.sha256, 'g')) || []).length, 2);
  assert.equal((workflow.match(new RegExp(String(expected.bytes), 'g')) || []).length, 2);
  assert.match(sourceContract, new RegExp(`entry\\.sourceArchiveBytes !== ${expected.bytes}`));
  assert.ok(sourceContract.includes(expected.sha256));
  const reviewRecord = fs.readFileSync(path.join(repositoryRoot, 'third-party-source/reviews/yt-dlp-2026.08.19-win64-distributor-review.md'), 'utf8');
  assert.match(reviewRecord, /Generated metadata archive revision \(2026-10-01\)/);
  assert.match(reviewRecord, /historical evidence/i);
  assert.ok(reviewRecord.includes(expected.sha256));
});

test('binary release requires exact corresponding-source assets outside the expanded installer tree', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');
  const binaryReadiness = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/binary-release-readiness.mjs'), 'utf8');
  const sourceContract = fs.readFileSync(path.join(repositoryRoot, 'scripts/validation/corresponding-source-contract.mjs'), 'utf8');
  assert.doesNotMatch(binaryReadiness, /files\.some\(\(file\)\s*=>\s*\/\(\?:aria2\|ffmpeg\)/);
  assert.match(binaryReadiness, /--release-assets-dir/);
  assert.match(binaryReadiness, /inspectCorrespondingSourceReleaseAssets/);
  assert.match(binaryReadiness, /inspectCorePackageFiles/);
  assert.match(binaryReadiness, /runtimeManifestText\.replace\(\/\^\\uFEFF\/, ''\)/, 'package inspection must accept a PowerShell UTF-8 BOM in the runtime manifest');
  assert.match(binaryReadiness, /runtime\.ffmpeg\?\.profile/);
  assert.match(binaryReadiness, /SAFE LEAN/);
  assert.match(binaryReadiness, /Gyan|gyan\.dev/i);
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
      entry.sourceArchiveBytes = bytes.length;
    }
    const present = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.deepEqual(present, { failures: [], pending: [] });

    exactManifest.runtimes[0].releaseAssetSha256 = '0'.repeat(64);
    const tampered = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.match(tampered.failures.join('\n'), /SHA-256 does not match/);

    exactManifest.runtimes[0].releaseAssetSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(temp, exactManifest.runtimes[0].releaseAssetName))).digest('hex');
    exactManifest.runtimes[0].sourceArchiveBytes += 1;
    const wrongSize = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.match(wrongSize.failures.join('\n'), /byte count does not match/);

    exactManifest.runtimes[0].sourceArchiveBytes -= 1;
    exactManifest.runtimes[2].sourceArchiveBytes += 1;
    const wrongYtDlpSize = inspectCorrespondingSourceReleaseAssets(exactManifest, temp);
    assert.match(wrongYtDlpSize.failures.join('\n'), /yt-dlp: exact release asset byte count does not match/);

    const renamedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-corresponding-source-renamed-'));
    try {
      const ytDlp = exactManifest.runtimes.find(entry => entry.id === 'yt-dlp');
      fs.copyFileSync(path.join(temp, ytDlp.releaseAssetName), path.join(renamedDir, 'yt-dlp-wrong-name.tar.xz'));
      const renamed = inspectCorrespondingSourceReleaseAssets(exactManifest, renamedDir);
      assert.equal(renamed.failures.length, 0);
      assert.ok(renamed.pending.includes(`yt-dlp: exact release asset ${ytDlp.releaseAssetName} is not present.`));
    } finally {
      fs.rmSync(renamedDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Core installer excludes optional runtime binaries and component distribution assets', () => {
  assert.deepEqual(inspectCorePackageFiles([
    'ClearDownloadManager.exe',
    'resources/licenses/THIRD_PARTY_NOTICES.txt',
  ]), { failures: [] });
  const rejected = inspectCorePackageFiles([
    'resources/bin/yt-dlp.exe',
    'resources/bin/ffmpeg.exe',
    'resources/bin/ffprobe.exe',
    'resources/bin/deno.exe',
    'resources/bin/aria2c.exe',
    'components/media-tools-1.0.0.cdmcomponent',
    'component-catalog-v1.json',
  ]);
  assert.equal(rejected.failures.length, 7);
  assert.match(rejected.failures.join('\n'), /optional runtime yt-dlp\.exe/);
  assert.match(rejected.failures.join('\n'), /optional component package/);
  assert.match(rejected.failures.join('\n'), /distribution metadata/);
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
  const verifyStart = release.indexOf('\n  verify-binary-release:');
  assert.ok(buildTestStart >= 0 && packageSignStart > buildTestStart && verifyStart > packageSignStart);
  const buildTest = release.slice(buildTestStart, packageSignStart);
  const packageSign = release.slice(packageSignStart, verifyStart);

  for (const [name, workflow, gateCommand] of [
    ['Quality', quality, 'npm run check:quality'],
    ['release build-test', buildTest, 'npm run check:release'],
    ['release package-sign', packageSign, 'npm run build:windows:final'],
  ]) {
    const installIndex = workflow.indexOf('playwright==1.62.0');
    const browserIndex = workflow.indexOf('python -m playwright install chromium');
    const gateIndex = workflow.indexOf(gateCommand);
    assert.ok(installIndex >= 0, `${name} must install the pinned Python Playwright package`);
    assert.ok(browserIndex > installIndex, `${name} must install Chromium after Playwright`);
    assert.ok(gateIndex > browserIndex, `${name} must install Chromium before ${gateCommand}`);
  }
});

test('release workflow retries an existing immutable tag from main without inheriting the expected 404 exit code', () => {
  const release = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-windows.yml'), 'utf8');

  assert.match(release, /workflow_dispatch:[\s\S]*?release_tag:[\s\S]*?required:\s*true/);
  assert.match(release, /RELEASE_TAG:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.release_tag\s*\|\|\s*github\.ref_name\s*\}\}/);
  assert.match(release, /GITHUB_EVENT_NAME.*push/);
  assert.match(release, /\$global:LASTEXITCODE\s*=\s*0/);
  assert.match(release, /ref:\s*\$\{\{\s*env\.RELEASE_TAG\s*\}\}/);
  assert.equal((release.match(/uses:\s*actions\/checkout@/g) ?? []).length, 5);
  assert.equal((release.match(/ref:\s*\$\{\{\s*env\.RELEASE_TAG\s*\}\}/g) ?? []).length, 4);
  assert.equal((release.match(/ref:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/g) ?? []).length, 1);
  assert.match(release, /-Tag\s+\$env:RELEASE_TAG/);
  assert.match(release, /-ReleaseTag\s+\$env:RELEASE_TAG/);
  assert.match(release, /\$tag\s*=\s*\$env:RELEASE_TAG/);
});

test('component release assembly removes only its generated package stage in finally', () => {
  const assembly = fs.readFileSync(path.join(repositoryRoot, 'scripts/assemble-component-release-assets.ps1'), 'utf8');
  assert.match(assembly, /\$packageOutput\s*=\s*Join-Path\s+\$env:TEMP\s+\("cdm-component-package-stage-/);
  assert.match(assembly, /try\s*\{[\s\S]*?\$packageBuild\s*=/);
  assert.match(assembly, /finally\s*\{[\s\S]*?Remove-Item\s+-LiteralPath\s+\$stagePath\s+-Recurse\s+-Force/);
  assert.match(assembly, /\$stageName\s+-match\s+'\^cdm-component-package-stage-\[0-9a-f\]\{32\}\$'/);
  const finallyBody = assembly.slice(assembly.lastIndexOf('} finally {'));
  assert.doesNotMatch(finallyBody, /Remove-Item[^\r\n]*\$output\b/);
});

test('source manifest canonicalizes shell-script line endings across Windows checkouts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-source-manifest-eol-test-'));
  const generator = path.join(temp, 'scripts', 'generate-source-manifest.mjs');
  const shellScript = path.join(temp, 'tools', 'probe.sh');
  fs.mkdirSync(path.dirname(generator), { recursive: true });
  fs.mkdirSync(path.dirname(shellScript), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'scripts/generate-source-manifest.mjs'), generator);

  try {
    const lfContent = '#!/bin/sh\nprintf ok\n';
    fs.writeFileSync(shellScript, lfContent, 'utf8');
    const generate = spawnSync(process.execPath, [generator], { cwd: temp, encoding: 'utf8' });
    assert.equal(generate.status, 0, generate.stderr || generate.stdout);

    fs.writeFileSync(shellScript, lfContent.replaceAll('\n', '\r\n'), 'utf8');
    const check = spawnSync(process.execPath, [generator, '--check'], { cwd: temp, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr || check.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Windows size report accepts an NSIS-only bundle and an empty installed Core directory', () => {
  const outputRoot = path.join(repositoryRoot, 'output');
  const outputRootExisted = fs.existsSync(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const reportDirectory = fs.mkdtempSync(path.join(outputRoot, '.windows-size-report-test-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-windows-size-report-test-'));

  try {
    const targetRoot = path.join(fixtureRoot, 'cargo-target');
    const bundleDirectory = path.join(targetRoot, 'release', 'bundle', 'nsis');
    const installedCoreDirectory = path.join(fixtureRoot, 'installed-core');
    const installerPath = path.join(bundleDirectory, 'clear-download-manager_1.0.0_x64-setup.exe');
    const installerBytes = Buffer.from('NSIS installer fixture');
    fs.mkdirSync(bundleDirectory, { recursive: true });
    fs.mkdirSync(installedCoreDirectory, { recursive: true });
    fs.writeFileSync(installerPath, installerBytes);

    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repositoryRoot, 'scripts/report-windows-size.ps1'),
      '-OutputDirectory', path.relative(repositoryRoot, reportDirectory),
      '-InstalledCoreDirectory', installedCoreDirectory,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
    });
    assert.equal(result.error, undefined, `PowerShell could not start: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(fs.readFileSync(path.join(reportDirectory, 'windows-size-report.json'), 'utf8'));
    assert.equal(report.totals.normalMsiBytes, 0);
    assert.equal(report.totals.installedCorePayloadBytes, 0);
    assert.equal(report.totals.normalNsisBytes, installerBytes.length);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(reportDirectory, { recursive: true, force: true });
    if (!outputRootExisted && fs.readdirSync(outputRoot).length === 0) fs.rmdirSync(outputRoot);
  }
});
