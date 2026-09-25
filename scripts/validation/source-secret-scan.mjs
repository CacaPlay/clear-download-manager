import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const textExtensions = new Set([
  '.bat', '.cmd', '.conf', '.css', '.env', '.example', '.html', '.ini', '.js',
  '.json', '.lock', '.md', '.mjs', '.ps1', '.py', '.rs', '.sh', '.toml', '.base64',
  '.txt', '.xml', '.yml', '.yaml',
]);
const detectors = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/],
  ['credential-url', /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/i],
  ['secret-assignment', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']([A-Za-z0-9/+_=.-]{20,})["']/i],
];
const ignoredValues = /^(?:example|dummy|test|changeme|your[_-]|redacted|placeholder|replace[_-]|<|\$\{|process\.env|os\.environ)/i;
const ignoredCredentialUrls = new Set(['user:pass', 'user:password', 'user:secret', 'example:example', 'test:test']);
const publicTestPrivateKeyFixture = 'src-tauri/tools/catalog-test-vectors/v1/test-private-key.base64';
const findings = [];

const fixtureReadmePath = path.join(root, 'src-tauri/tools/catalog-test-vectors/v1/README.md');
const fixtureReadme = fs.existsSync(fixtureReadmePath) ? fs.readFileSync(fixtureReadmePath, 'utf8').replace(/\s+/g, ' ') : '';
const publicTestFixtureDocumented = fixtureReadme.includes('public **TEST ONLY** Ed25519 vector')
  && fixtureReadme.includes('private seed is intentionally public')
  && fixtureReadme.includes('not a production secret')
  && fixtureReadme.includes('must never be bundled as an app');

function walk(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.superpowers', 'node_modules', 'target', 'dist', 'dist-store', 'extension-dist', 'output'].includes(entry.name)) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, childRelative);
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const normalizedPath = childRelative.replaceAll('\\', '/');
      const sensitiveName = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|client[-_]?secret(?:[-_.].*)?)$/i.test(entry.name)
        || /private[-_]?key/i.test(entry.name);
      if (sensitiveName && !(normalizedPath === publicTestPrivateKeyFixture && publicTestFixtureDocumented)) {
        findings.push({ file: childRelative, kind: 'sensitive-filename' });
      }
      const text = fs.readFileSync(absolute, 'utf8');
      for (const [kind, pattern] of detectors) {
        for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
          const candidate = kind === 'secret-assignment' ? match[1] : match[0];
          if (kind === 'secret-assignment' && ignoredValues.test(candidate)) continue;
          if (kind === 'credential-url') {
            const credentials = /^https?:\/\/([^/:@\s]+):([^@\s]+)@/i.exec(candidate);
            if (credentials && ignoredCredentialUrls.has(`${credentials[1]}:${credentials[2]}`.toLowerCase())) continue;
          }
          findings.push({ file: childRelative, kind });
        }
      }
    }
  }
}

walk(root);
if (findings.length) {
  console.error(`SOURCE SECRET SCAN BLOCKED: ${findings.length} high-confidence pattern(s); values are not printed.`);
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.kind}`);
  process.exit(1);
}
console.log(publicTestFixtureDocumented
  ? 'SOURCE SECRET SCAN PASSED: no high-confidence credentials found; one documented, public TEST ONLY signing-key fixture is retained and not used as a production secret. Values were never printed.'
  : 'SOURCE SECRET SCAN PASSED: no high-confidence credential patterns found (heuristic scan; values were never printed).');
