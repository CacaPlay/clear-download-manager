import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(read(relative));
const failures = [];
const requireText = (file, text, reason = `missing required text: ${text}`) => {
  if (!read(file).includes(text)) failures.push(`${file}: ${reason}`);
};

const license = read('LICENSE.md');
const copying = fs.existsSync(path.join(root, 'COPYING')) ? read('COPYING') : '';
if (!license.includes('GPL-3.0-or-later') || !license.includes('](COPYING)')) {
  failures.push('LICENSE.md must identify GPL-3.0-or-later and link to the full license text.');
}
if (!copying.trimStart().startsWith('GNU GENERAL PUBLIC LICENSE') || !copying.includes('Version 3, 29 June 2007') || !copying.includes('END OF TERMS AND CONDITIONS')) {
  failures.push('COPYING must contain the complete, unmodified GNU GPL version 3 text.');
}
const projectLicense = 'GPL-3.0-or-later';
requireText('NOTICE.md', 'app-ui/assets/brand/');
requireText('NOTICE.md', 'src-tauri/icons/');
requireText('NOTICE.md', 'Lucide Icons');
requireText('NOTICE.md', 'Third-party components');
requireText('NOTICE.md', projectLicense, 'NOTICE must identify the project source license.');
requireText('CONTRIBUTING.md', projectLicense, 'Contribution terms must match the project source license.');

const pkg = JSON.parse(read('package.json'));
const pkgVersion = pkg.version;
const lock = JSON.parse(read('package-lock.json'));
if (pkg.license !== projectLicense || lock.packages?.['']?.license !== projectLicense) {
  failures.push(`package.json and package-lock.json must both declare ${projectLicense}.`);
}
for (const file of ['src-tauri/Cargo.toml', 'extension/native-host/Cargo.toml']) {
  requireText(file, `license = "${projectLicense}"`);
}

for (const file of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.store.conf.json']) {
  requireText(file, 'resources/licenses/*', 'Windows package must bundle its license notices.');
}
for (const file of ['scripts/build-windows-beta.ps1', 'scripts/build-store-msix.ps1']) {
  requireText(file, 'prepare:third-party-notices', 'Windows package build must regenerate third-party notices.');
}
requireText('scripts/build-extension.ps1', "@('LICENSE.md', 'COPYING', 'NOTICE.md')", 'extension ZIP must include project licensing notices and the full GPL text.');
requireText('scripts/generate-third-party-notices.mjs', 'NPM-SBOM.spdx.json');
requireText('scripts/generate-third-party-notices.mjs', 'CARGO-DEPENDENCY-LICENSES.txt');
requireText('scripts/generate-third-party-notices.mjs', 'FFMPEG-BUILD-README.txt');
requireText('scripts/generate-third-party-notices.mjs', "'COPYING'");
requireText('scripts/generate-third-party-notices.mjs', projectLicense, 'Generated package notices must label the first-party source license.');
requireText('scripts/validation/release-gate.mjs', "'check:gpl-source'", 'Release gate must require corresponding GPL source readiness.');
requireText('scripts/validation/release-gate.mjs', "'check:rights'", 'Release gate must require first-party rights readiness.');
requireText('scripts/validation/release-gate.mjs', "'check:asset-rights'", 'Release gate must require source-snapshot asset rights readiness.');
requireText('scripts/validation/release-gate.mjs', "'check:asset-provenance'", 'Release gate must require retained asset provenance readiness.');
requireText('package.json', '"check:source-release"', 'The source release gate must be exposed as a package script.');
requireText('package.json', '"check:binary-release"', 'The binary release gate must be exposed as a package script.');
requireText('package.json', '"source:archive"', 'A source archive builder must be exposed as a package script.');
requireText('scripts/validation/source-release-readiness.mjs', 'check:gpl-source', 'The source-only gate must document/guard its distinct runtime boundary.');
requireText('scripts/validation/binary-release-readiness.mjs', "'scripts/validation/gpl-source-readiness.mjs'", 'Binary readiness must require the strict GPL source gate.');
requireText('scripts/validation/binary-release-readiness.mjs', "'scripts/verify-binaries.mjs'", 'Binary readiness must verify the runtime binaries.');
requireText('scripts/validation/binary-release-readiness.mjs', "['yt-dlp.exe', runtime.ytDlp?.sha256]", 'Binary package inspection must verify the bundled yt-dlp.exe hash.');
requireText('scripts/validation/binary-release-readiness.mjs', "'yt-dlp-third-party-licenses.txt'", 'Binary package inspection must require the pinned yt-dlp license inventory.');
requireText('scripts/build-store-msix.ps1', "@('run', 'check:release')", 'Store packaging must require the release/GPL readiness gate.');
requireText('third-party-source/corresponding-source.json', 'aria2');
requireText('third-party-source/corresponding-source.json', 'ffmpeg');
requireText('third-party-source/corresponding-source.json', '"id": "yt-dlp"', 'The bundled yt-dlp.exe GPL combined work must be included in the corresponding-source registry.');
requireText('src-tauri/resources/licenses/YT-DLP-NOTICE.txt', 'GPL-3.0-or-later', 'The yt-dlp executable notice must state the effective upstream GPL license expression.');
requireText('src-tauri/resources/licenses/YT-DLP-NOTICE.txt', 'mutagen', 'The yt-dlp executable notice must identify its included GPL dependency.');
requireText('src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt', 'mutagen | GPL-2.0-or-later', 'The pinned yt-dlp third-party inventory must retain Mutagen license evidence.');
requireText('src-tauri/resources/licenses/DENO-LICENSE.txt', 'MIT License', 'The Deno runtime notice must preserve its MIT license text.');
requireText('third-party-source/README.md', 'complete source');
requireText('README.md', projectLicense, 'README must identify the first-party source license.');
requireText('extension/README.md', projectLicense, 'Extension README must identify the source license.');
requireText('LICENSE.md', 'Clearance status: PENDING', 'LICENSE.md must not imply rights clearance is complete.');
requireText('docs/OPEN-SOURCE-RIGHTS-REVIEW.md', 'PR #5', 'The identified contribution rights question must remain documented.');
const sbom = json('src-tauri/resources/licenses/NPM-SBOM.spdx.json');
const rootSbomPackage = sbom.packages.find((packageEntry) => packageEntry.name === 'clear-download-manager' && packageEntry.versionInfo === pkgVersion);
if (rootSbomPackage?.licenseDeclared !== projectLicense) {
  failures.push(`NPM-SBOM.spdx.json must declare ${projectLicense} for the root package.`);
}
const runtimeManifest = JSON.parse(read('src-tauri/resources/bin/runtime-manifest.json').replace(/^\uFEFF/, ''));
const ytDlpLicenseInventory = read('src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt').replace(/\r\n/g, '\n');
const ytDlpLicenseInventorySha256 = crypto.createHash('sha256').update(ytDlpLicenseInventory, 'utf8').digest('hex');
if (runtimeManifest.ytDlp?.thirdPartyLicensesPinnedSha256 !== ytDlpLicenseInventorySha256 ||
    runtimeManifest.ytDlp?.thirdPartyLicensesSha256 !== ytDlpLicenseInventorySha256) {
  failures.push('YT-DLP-THIRD-PARTY-LICENSES.txt canonical LF SHA-256 must match both pinned and recorded runtime-manifest hashes.');
}
if (/Apache License 2\.0|Apache-2\.0|license remains proprietary/i.test([
  license,
  copying,
  read('NOTICE.md'),
  read('CONTRIBUTING.md'),
  read('README.md'),
  read('extension/README.md'),
  read('package.json'),
  read('src-tauri/Cargo.toml'),
  read('extension/native-host/Cargo.toml'),
  read('scripts/generate-third-party-notices.mjs')
].join('\n'))) {
  failures.push('First-party licensing metadata still contains Apache-specific or proprietary terms.');
}

if (failures.length) {
  console.error('LICENSE READINESS CHECK FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('LICENSE METADATA AND PACKAGING CHECK PASSED (static only; rights clearance remains separately pending).');
