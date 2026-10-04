import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('release precompile audit accepts the official extension 1.0.0 and its published Chrome ID', () => {
  const result = spawnSync(process.execPath, ['scripts/validation/phase24_2_precompile_audit.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK: Extensión oficial e ID permanecen intactos/);
});
