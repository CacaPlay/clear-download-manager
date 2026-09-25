const ROOT = 'clear-download-manager-source';

export const REQUIRED_SOURCE_FILES = [
  'LICENSE.md',
  'COPYING',
  'NOTICE.md',
  'MANIFEST.sha256',
  'package-lock.json',
  'src-tauri/Cargo.lock',
  'extension/native-host/Cargo.lock',
  'src-tauri/resources/bin/runtime-manifest.json',
  'src-tauri/resources/licenses/NPM-SBOM.spdx.json',
  'src-tauri/resources/licenses/CARGO-DEPENDENCY-LICENSES.txt',
  'src-tauri/resources/licenses/THIRD_PARTY_NOTICES.txt',
  'src-tauri/resources/licenses/ARIA2-COPYING.txt',
  'src-tauri/resources/licenses/ARIA2-OPENSSL-LICENSE.txt',
  'src-tauri/resources/licenses/ARIA2-NOTICE.txt',
  'src-tauri/resources/licenses/DENO-LICENSE.txt',
  'src-tauri/resources/licenses/DENO-NOTICE.txt',
  'src-tauri/resources/licenses/FFMPEG-BUILD-README.txt',
  'src-tauri/resources/licenses/FFMPEG-LICENSE.txt',
  'src-tauri/resources/licenses/FFMPEG-NOTICE.txt',
  'src-tauri/resources/licenses/README.txt',
  'src-tauri/resources/licenses/YT-DLP-LICENSE.txt',
  'src-tauri/resources/licenses/YT-DLP-NOTICE.txt',
  'src-tauri/resources/licenses/YT-DLP-THIRD-PARTY-LICENSES.txt',
  'rights/release-rights.json',
];

export const SOURCE_ONLY_GATE_IDS = [
  'check:manifest',
  'check:manifest:scope',
  'check:licenses',
  'check:rights',
  'check:asset-rights',
  'check:asset-provenance',
  'check:assets',
  'check:source-boundaries',
  'check:source-secrets',
];

const forbiddenPathSegments = new Set([
  '.git', '.superpowers', 'dist', 'dist-store', 'extension-dist',
  'node_modules', 'output', 'target', '__pycache__',
]);
const forbiddenExtensions = /\.(?:exe|dll|msi|msix|msixbundle|appx|appxbundle|zip|7z|rar|cab|nupkg)$/i;
const publicTestPrivateKeyFixture = 'src-tauri/tools/catalog-test-vectors/v1/test-private-key.base64';

function normalizeEntry(raw) {
  return String(raw).replaceAll('\\', '/').replace(/\/+$/, '');
}

export function inspectSourcePaths(rawEntries) {
  const failures = [];
  const paths = [];
  const seen = new Set();

  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw);
    if (!entry || entry === ROOT) continue;
    if (entry.startsWith('/') || /^[a-z]:\//i.test(entry)) {
      failures.push(`absolute path is forbidden: ${entry}`);
      continue;
    }
    const parts = entry.split('/');
    if (parts.some((part) => part === '..')) {
      failures.push(`path traversal is forbidden: ${entry}`);
      continue;
    }
    if (parts[0] !== ROOT || parts.length < 2) {
      failures.push(`archive entry must be below ${ROOT}/: ${entry}`);
      continue;
    }
    const relative = parts.slice(1).join('/');
    if (!relative) continue;
    if (seen.has(relative)) failures.push(`duplicate archive entry: ${relative}`);
    else seen.add(relative);
    paths.push(relative);

    if (parts.some((part) => forbiddenPathSegments.has(part.toLowerCase()))) {
      failures.push(`generated output/cache directory is forbidden: ${relative}`);
    }
    if (relative.startsWith('src-tauri/resources/bin/')
      && relative !== 'src-tauri/resources/bin/runtime-manifest.json') {
      failures.push(`only runtime-manifest.json is permitted under resources/bin in a source artifact: ${relative}`);
    }
    if (/\.pdf$/i.test(relative)) failures.push(`PDF files are forbidden in the source artifact: ${relative}`);
    if (forbiddenExtensions.test(relative)) {
      const kind = /\.(?:exe|dll)$/i.test(relative) ? 'runtime binary' : 'installer or package binary';
      failures.push(`${kind} is forbidden in the source artifact: ${relative}`);
    }
    const filename = parts.at(-1);
    const sensitiveName = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|client[-_]?secret(?:[-_.].*)?)$/i.test(filename)
      || /private[-_]?key/i.test(filename);
    if (sensitiveName && relative !== publicTestPrivateKeyFixture) {
      failures.push(`credential-bearing filename is forbidden: ${relative}`);
    }
    if (/private[-_]?key/i.test(filename) && relative !== publicTestPrivateKeyFixture) {
      failures.push(`private-key or credential file is forbidden: ${relative}`);
    }
  }

  for (const required of REQUIRED_SOURCE_FILES) {
    if (!seen.has(required)) failures.push(`required source inventory is missing: ${required}`);
  }

  return { failures: [...new Set(failures)], paths, filesCount: paths.length };
}

export function evaluateSourceReadiness(checks) {
  const blockers = checks.filter((check) => check.status === 'PENDING').map((check) => check.id);
  const failures = checks.filter((check) => !['PASS', 'PENDING'].includes(check.status)).map((check) => check.id);
  const status = failures.length ? 'FAIL' : blockers.length ? 'PENDING' : 'PASS';
  return { status, blockers, failures };
}

