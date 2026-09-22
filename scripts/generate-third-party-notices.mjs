import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const licenses = path.join(root, 'src-tauri', 'resources', 'licenses');
const output = path.join(licenses, 'THIRD_PARTY_NOTICES.txt');
const groups = [
  ['yt-dlp', ['YT-DLP-NOTICE.txt', 'YT-DLP-LICENSE.txt', 'YT-DLP-THIRD-PARTY-LICENSES.txt']],
  ['Deno', ['DENO-NOTICE.txt', 'DENO-LICENSE.txt']],
  ['FFmpeg and FFprobe', ['FFMPEG-NOTICE.txt', 'FFMPEG-LICENSE.txt', 'FFMPEG-BUILD-README.txt']],
  ['aria2c', ['ARIA2-NOTICE.txt', 'ARIA2-COPYING.txt', 'ARIA2-OPENSSL-LICENSE.txt']]
];

const sections = [
  'Clear Download Manager — Third-party notices and license texts',
  'This file is generated for the Windows package from the versioned notice and license files in this folder.',
  'Keep the adjacent individual files with this aggregate. The exact binary versions and hashes are recorded in resources/bin/runtime-manifest.json.',
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
console.log(`OK: generated ${path.relative(root, output)} with the complete bundled notice set.`);
