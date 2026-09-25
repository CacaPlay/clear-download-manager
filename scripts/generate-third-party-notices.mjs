import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const licenses = path.join(root, 'src-tauri', 'resources', 'licenses');
const output = path.join(licenses, 'THIRD_PARTY_NOTICES.txt');
const npmSbomOutput = path.join(licenses, 'NPM-SBOM.spdx.json');
const cargoInventoryOutput = path.join(licenses, 'CARGO-DEPENDENCY-LICENSES.txt');
const groups = [
  ['yt-dlp', ['YT-DLP-NOTICE.txt', 'YT-DLP-LICENSE.txt', 'YT-DLP-THIRD-PARTY-LICENSES.txt']],
  ['Deno', ['DENO-NOTICE.txt', 'DENO-LICENSE.txt']],
  ['FFmpeg and FFprobe', ['FFMPEG-NOTICE.txt', 'FFMPEG-LICENSE.txt', 'FFMPEG-BUILD-README.txt']],
  ['aria2c', ['ARIA2-NOTICE.txt', 'ARIA2-COPYING.txt', 'ARIA2-OPENSSL-LICENSE.txt']]
];

function run(command, args, label, options = {}) {
  const useWindowsCommandShell = process.platform === 'win32' && command === 'npm.cmd';
  const executable = useWindowsCommandShell ? (process.env.ComSpec || 'cmd.exe') : command;
  const executableArgs = useWindowsCommandShell
    ? ['/d', '/s', '/c', `${command} ${args.join(' ')}`]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  return result.stdout;
}

// Produce an SPDX SBOM for the full npm lockfile, including development tools
// used to build the open-source application and extension.
const npmArgs = ['sbom', '--package-lock-only', '--sbom-format=spdx', '--sbom-type=application'];
const npmResult = run(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  npmArgs,
  'npm SPDX SBOM generation'
);
let npmSbom;
try {
  npmSbom = JSON.parse(npmResult);
} catch (error) {
  throw new Error(`npm returned invalid SPDX JSON: ${error.message}`);
}
if (npmSbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(npmSbom.packages)) {
  throw new Error('npm returned an SPDX document without the expected package inventory.');
}
fs.writeFileSync(npmSbomOutput, `${JSON.stringify(npmSbom, null, 2)}\n`, 'utf8');

// Both Windows executables have separate Cargo manifests/lockfiles. Inventory
// each graph so the bundled native messaging host is not omitted.
const cargoProjects = [
  ['desktop', path.join(root, 'src-tauri', 'Cargo.toml')],
  ['native-host', path.join(root, 'extension', 'native-host', 'Cargo.toml')]
];
const resolvedPackages = [];
for (const [project, manifestPath] of cargoProjects) {
  const cargoText = run('cargo', [
    'metadata', '--format-version', '1', '--locked', '--all-features',
    '--filter-platform', 'x86_64-pc-windows-msvc',
    '--manifest-path', manifestPath
  ], `Cargo dependency inventory (${project})`);
  let cargoMetadata;
  try {
    cargoMetadata = JSON.parse(cargoText);
  } catch (error) {
    throw new Error(`cargo metadata returned invalid JSON for ${project}: ${error.message}`);
  }
  const packageById = new Map(cargoMetadata.packages.map(pkg => [pkg.id, pkg]));
  const projectPackages = [...new Set((cargoMetadata.resolve?.nodes ?? []).map(node => node.id))]
    .map(id => packageById.get(id))
    .filter(pkg => pkg && pkg.source?.startsWith('registry+'))
    .map(pkg => ({ project, ...pkg }));
  resolvedPackages.push(...projectPackages);
}
resolvedPackages.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const packagesWithoutLicense = resolvedPackages.filter(pkg => !pkg.license?.trim());
if (packagesWithoutLicense.length) {
  throw new Error(`Cargo packages without declared license metadata: ${packagesWithoutLicense.map(pkg => pkg.name).join(', ')}`);
}
const cargoInventory = [
  'Clear Download Manager — resolved Rust dependency license inventory',
  'Generated from both desktop and native-host Cargo.lock files with cargo metadata --locked --all-features --filter-platform x86_64-pc-windows-msvc.',
  'License expressions are declarations from each upstream Cargo package; OR means alternatives and AND means combined terms.',
  `Resolved registry packages: ${resolvedPackages.length}`,
  '',
  'PROJECT | PACKAGE | VERSION | DECLARED LICENSE',
  ...resolvedPackages.map(pkg => `${pkg.project} | ${pkg.name} | ${pkg.version} | ${pkg.license}`),
  ''
].join('\n');
fs.writeFileSync(cargoInventoryOutput, cargoInventory, 'utf8');

const sections = [
  'Clear Download Manager — Third-party notices and license texts',
  'This generated package notice aggregates the project license, third-party notices, and runtime-tool license texts.',
  'The adjacent SPDX SBOM and Cargo dependency inventory identify resolved npm and Rust package versions and declared licenses.',
  'The individual runtime binaries have separate version, source, hash and license records in this folder.',
  '',
  '===== Clear Download Manager source =====',
  '',
  '----- LICENSE.md (first-party source scope; GPL-3.0-or-later) -----',
  '',
  fs.readFileSync(path.join(root, 'LICENSE.md'), 'utf8').trim(),
  '',
  '----- COPYING (GNU GPL version 3 text) -----',
  '',
  fs.readFileSync(path.join(root, 'COPYING'), 'utf8').trim(),
  '',
  '----- NOTICE.md -----',
  '',
  fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8').trim(),
  '',
  '----- Lucide Icons (ISC) -----',
  '',
  fs.readFileSync(path.join(root, 'app-ui', 'assets', 'icons', 'LICENSE'), 'utf8').trim(),
  '',
  '----- Resolved dependency inventories -----',
  '',
  `npm SBOM: ${path.basename(npmSbomOutput)} (SPDX-2.3; ${npmSbom.packages.length} packages)`,
  `Rust inventory: ${path.basename(cargoInventoryOutput)} (${resolvedPackages.length} Windows x64 registry packages)`,
  ''
];

for (const [component, files] of groups) {
  sections.push(`===== ${component} =====`, '');
  for (const name of files) {
    const filePath = path.join(licenses, name);
    if (!fs.existsSync(filePath)) throw new Error(`Required bundled license text is missing: ${name}`);
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) throw new Error(`Bundled license text is empty: ${name}`);
    sections.push(`----- ${name} -----`, '', text, '');
  }
}

fs.writeFileSync(output, `${sections.join('\n').trimEnd()}\n`, 'utf8');
console.log(`OK: generated ${path.relative(root, output)}, ${path.relative(root, npmSbomOutput)} and ${path.relative(root, cargoInventoryOutput)}.`);
