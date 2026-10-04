import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('catalog component install is async and runs on the blocking pool', async () => {
  const source = await readFile(path.join(repositoryRoot, 'src-tauri/src/commands/components.rs'), 'utf8');
  const command = source.match(/#\[tauri::command\]\s*pub\(crate\)\s+async\s+fn\s+install_component_from_catalog\b[\s\S]*?(?=\n#\[tauri::command\]|$)/)?.[0] || '';

  assert.notEqual(command, '', 'install_component_from_catalog must be an async Tauri command');
  assert.match(command, /tauri::async_runtime::spawn_blocking\s*\(/);
  assert.match(command, /\.await/);
  assert.match(command, /\.install_component_from_catalog\s*\(/);
  assert.match(command, /app\.emit\("component-download-progress"/);
  assert.match(command, /refresh_component_runtime_slots\(\)/);
});
