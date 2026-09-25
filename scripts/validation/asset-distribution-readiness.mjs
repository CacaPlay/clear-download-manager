import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const audit = fs.readFileSync(path.join(root, 'docs/ASSET-MARKS-AUDIT.md'), 'utf8');
const rows = [...audit.matchAll(/^\| `([^`]+)` \|.*\| (REMOVE|REPLACE_WITH_CLEAR_ASSET|KEEP_WITH_DOCUMENTED_RIGHTS|KEEP_OUT_OF_DISTRIBUTION|MANUAL_REVIEW) \|$/gm)]
  .map(([, file, action]) => ({ file, action }));
const failures = [];
const requiredLegacyRemovals = [
  'src-tauri/icons/64x64.png',
  'src-tauri/icons/icon.icns',
  'src-tauri/icons/Square30x30Logo.png',
  'src-tauri/icons/Square310x310Logo.png',
  'src-tauri/icons/app-icon.svg',
  'src-tauri/icons/android/',
  'src-tauri/icons/ios/',
  'app-ui/favicon.svg',
  'app-ui/media-preview.svg',
  'src-tauri/icons/Square71x71Logo.png',
  'src-tauri/icons/Square89x89Logo.png',
  'src-tauri/icons/Square107x107Logo.png',
  'src-tauri/icons/Square142x142Logo.png',
  'src-tauri/icons/Square284x284Logo.png',
];
if (rows.length !== 42) failures.push(`Expected 42 asset/family dispositions; found ${rows.length}.`);
if (new Set(rows.map(({ file }) => file)).size !== rows.length) failures.push('The asset disposition register contains duplicate paths.');
for (const file of requiredLegacyRemovals) {
  if (!rows.some((row) => row.file === file && row.action === 'REMOVE')) failures.push(`${file}: the owner-marked obsolete asset/family must retain a REMOVE disposition.`);
}
for (const { file, action } of rows) {
  const absolute = path.resolve(root, file);
  const allowedRoot = ['app-ui/assets/', 'docs/assets/', 'app-ui/', 'src-tauri/icons/']
    .some((prefix) => file.startsWith(prefix));
  if (!allowedRoot) {
    failures.push(`${file}: path is outside the reviewed asset trees.`);
    continue;
  }
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    failures.push(`${file}: asset path escapes the repository.`);
    continue;
  }
  if (action === 'REMOVE' && fs.existsSync(absolute)) failures.push(`${file}: still physically present with REMOVE disposition; source snapshots could include it.`);
  if (action !== 'REMOVE') failures.push(`${file}: ${action} needs a reviewed, machine-checkable distribution disposition before release.`);
}

if (failures.length) {
  console.error('REMOVED-ASSET SOURCE-DISTRIBUTION CHECK BLOCKED.');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('This gate verifies the audited REMOVE paths/families only. It does not clear retained-image distribution rights; check:asset-provenance handles those separately.');
  process.exit(1);
}

console.log('PASS: all 42 audited REMOVE paths/families are absent from the source tree.');
console.log('Removal tally: 73 graphics and 2 Android XML support files; retained-image distribution rights remain tracked separately by check:asset-provenance.');
