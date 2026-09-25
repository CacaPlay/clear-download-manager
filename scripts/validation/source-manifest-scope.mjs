import fs from 'node:fs';

const root = process.cwd();
const manifest = fs.readFileSync(`${root}/MANIFEST.sha256`, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(66));
const generator = fs.readFileSync(`${root}/scripts/generate-source-manifest.mjs`, 'utf8');
const issues = [];

for (const rootFile of fs.readdirSync(root)) {
  if (rootFile.toLowerCase().endsWith('.pdf') && manifest.includes(rootFile)) {
    issues.push('root-level PDF is included in MANIFEST.sha256');
  }
}

for (const prefix of ['dist-store/', '.superpowers/', 'docs/superpowers/']) {
  if (manifest.some((entry) => entry.startsWith(prefix))) {
    issues.push(`generated/local directory appears in MANIFEST.sha256: ${prefix}`);
  }
}

for (const segment of ['extension/native-host/target/']) {
  if (manifest.some((entry) => entry.startsWith(segment))) {
    issues.push(`Cargo build output appears in MANIFEST.sha256: ${segment}`);
  }
}

if (!generator.includes("/^[^/]+\\.pdf$/i")) {
  issues.push('source manifest generator must exclude root-level PDF attachments');
}
for (const directory of ['dist-store', '.superpowers']) {
  if (!generator.includes(`'${directory}'`)) {
    issues.push(`source manifest generator must exclude ${directory}`);
  }
}
if (!generator.includes("'docs/superpowers/'")) {
  issues.push('source manifest generator must exclude internal plan artifacts');
}

if (!manifest.includes('evidence/official-public-key.json')) {
  issues.push('source manifest must retain the public extension identity input');
}
if (!manifest.includes('.cdm/workspace.json')) {
  issues.push('source manifest must retain the tracked project workspace metadata');
}
if (!manifest.includes('src-tauri/resources/bin/runtime-manifest.json')) {
  issues.push('source manifest must retain the non-secret runtime inventory used by source builds');
}
for (const runtime of ['aria2c.exe', 'deno.exe', 'ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
  if (manifest.some((entry) => entry.toLowerCase() === `src-tauri/resources/bin/${runtime}`)) {
    issues.push(`source manifest must exclude staged runtime executable: ${runtime}`);
  }
}
if (!generator.includes("normalized !== 'src-tauri/resources/bin/runtime-manifest.json'")) {
  issues.push('source manifest generator must retain only the runtime inventory from resources/bin');
}

if (issues.length) {
  console.error('SOURCE MANIFEST SCOPE CHECK FAILED');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log('OK: source manifest excludes local PDFs/build scratch and retains required project inputs.');
