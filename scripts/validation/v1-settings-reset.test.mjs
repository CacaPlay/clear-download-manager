import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainPath = path.join(root, 'app-ui/main.js');
const rustPath = path.join(root, 'src-tauri/src/commands/settings.rs');

test('v1 settings reset runs once and marks completion only after SQLite succeeds', async () => {
  const main = await readFile(mainPath, 'utf8');
  assert.ok(main.includes("clear-download-manager/settings-defaults-reset-v1.0.0"));
  const migration = main.match(/async function applyV1SettingsResetMigration\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(migration.includes("localStorage.getItem(V1_SETTINGS_RESET_MIGRATION_KEY) === '1'"));
  assert.ok(migration.includes("await invoke('reset_application_preferences')"));
  assert.ok(migration.indexOf("await invoke('reset_application_preferences')") < migration.indexOf("localStorage.setItem(V1_SETTINGS_RESET_MIGRATION_KEY, '1')"));
  assert.ok(migration.includes('window.location.reload()'));
});

test('preference reset removes only known setting rows and preserves downloads/history tables', async () => {
  const [main, rust] = await Promise.all([readFile(mainPath, 'utf8'), readFile(rustPath, 'utf8')]);
  const keys = main.match(/const LOCAL_APPLICATION_PREFERENCE_KEYS = \[([\s\S]*?)\n\];/)?.[1] || '';
  assert.ok(keys.includes('appearance'));
  assert.ok(!/download(?:s)?_?(?:records|history|jobs)|history_?(?:rows|records)/i.test(keys));
  assert.ok(rust.includes('DELETE FROM settings WHERE key=?1'));
  assert.ok(!/DELETE\s+FROM\s+(?:downloads|jobs|history|queue)/i.test(rust));
  assert.ok(rust.includes('reset_removes_only_preference_rows_and_preserves_download_records'));
});
