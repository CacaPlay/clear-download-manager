import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorrespondingSourceRegistry } from './corresponding-source-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
const manifest = readJson('third-party-source/corresponding-source.json');
const runtime = readJson('src-tauri/resources/bin/runtime-manifest.json');
const issues = validateCorrespondingSourceRegistry(manifest, runtime, root);

if (issues.failures.length || issues.pending.length) {
  console.error('GPL SOURCE READINESS BLOCKED: do not distribute GPL runtime binaries.');
  for (const item of issues.failures) console.error(`FAIL: ${item}`);
  for (const item of issues.pending) console.error(`PENDING: ${item}`);
  console.error('This gate verifies the evidence inventory and file hashes only; it does not make a legal determination.');
  process.exit(issues.failures.length ? 1 : 2);
}

console.log('GPL corresponding-source inventory is structurally complete and hash-matched. Human and distribution/legal review remain release prerequisites.');
