import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const directoryIndex = args.indexOf('--directory');
const directory = directoryIndex >= 0 ? path.resolve(args[directoryIndex + 1] || '') : '';
const checksumName = 'SHA256SUMS.txt';

function fail(message) {
  console.error(`RELEASE ARTIFACT INTEGRITY FAILED: ${message}`);
  process.exit(1);
}

if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
  fail('pass an existing artifact directory with --directory <path>.');
}

const checksumPath = path.join(directory, checksumName);
if (!fs.existsSync(checksumPath) || !fs.statSync(checksumPath).isFile()) {
  fail(`${checksumName} is missing.`);
}

const expected = new Map();
const foldedNames = new Set();
const lines = fs.readFileSync(checksumPath, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
for (const [index, line] of lines.entries()) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/i.exec(line);
  if (!match) fail(`${checksumName} row ${index + 1} is malformed.`);
  const [, digest, name] = match;
  if (name === checksumName || name === '.' || name === '..' || foldedNames.has(name.toLowerCase())) {
    fail(`${checksumName} contains an unsafe or duplicate filename: ${name}`);
  }
  foldedNames.add(name.toLowerCase());
  expected.set(name, digest.toLowerCase());
}
if (expected.size === 0) fail(`${checksumName} contains no artifact entries.`);

const entries = fs.readdirSync(directory, { withFileTypes: true });
if (entries.some((entry) => entry.isSymbolicLink() || entry.isDirectory() || !entry.isFile())) {
  fail('artifact directory must contain regular files only, with no nested directories or links.');
}
const actualNames = new Set(entries.map((entry) => entry.name).filter((name) => name !== checksumName));
const missing = [...expected.keys()].filter((name) => !actualNames.has(name));
const unexpected = [...actualNames].filter((name) => !expected.has(name));
if (missing.length || unexpected.length) {
  fail(`artifact inventory differs from ${checksumName}; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}].`);
}

for (const [name, digest] of expected) {
  const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
  if (actualDigest !== digest) fail(`${name} SHA-256 does not match ${checksumName}.`);
}

console.log(`RELEASE ARTIFACT INTEGRITY PASS: ${expected.size} files match ${checksumName}.`);
