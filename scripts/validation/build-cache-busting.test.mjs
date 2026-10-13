import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function textFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...textFiles(target));
    else if (/\.(?:html|js|css)$/i.test(entry.name)) result.push(target);
  }
  return result;
}

test('built frontend gives every local HTML, JS, and CSS reference a shared content cache key', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cdm-build-cache-busting-'));
  const outputRoot = path.join(tempRoot, 'dist');
  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, CDM_WEB_DIST_DIR: outputRoot, CDM_BUILD_DISTRIBUTION: 'github' },
      stdio: 'pipe'
    });

    const files = [path.join(outputRoot, 'index.html'), ...textFiles(path.join(outputRoot, 'app-ui'))];
    const references = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/(['"])(\.\.?\/[^'"]+?\.(?:m?js|css)(?:\?[^'"]*)?)\1/g)]
        .map((match) => ({ file: path.relative(outputRoot, file), specifier: match[2] }));
    });
    const keys = new Set(references.map(({ specifier }) => specifier.match(/\?v=([a-f0-9]{16})$/)?.[1] || 'missing'));

    assert.ok(references.length > 0, 'expected local frontend asset references');
    assert.equal(keys.size, 1, `expected one cache key for all frontend references, got ${[...keys].join(', ')}`);
    assert.notEqual(keys.values().next().value, 'missing', 'every local asset reference must carry the cache key');
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    assert.ok(resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary build output must stay inside its dedicated temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
