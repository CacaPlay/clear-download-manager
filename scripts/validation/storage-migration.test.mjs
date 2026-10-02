import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacyStorageNamespace } from "../../app-ui/modules/runtime/storage-migration.js";

class MemoryStorage {
  #entries = new Map();

  get length() { return this.#entries.size; }
  key(index) { return [...this.#entries.keys()][index] ?? null; }
  getItem(key) { return this.#entries.get(String(key)) ?? null; }
  setItem(key, value) { this.#entries.set(String(key), String(value)); }
  removeItem(key) { this.#entries.delete(String(key)); }
  entries() { return [...this.#entries.entries()]; }
}

test("copies and verifies legacy identity values before removing aliases", () => {
  const storage = new MemoryStorage();
  storage.setItem("cacatools.desktop.appearance.v2", "{\"theme\":\"dark\"}");
  storage.setItem("unrelated.key", "keep");

  const result = migrateLegacyStorageNamespace(storage);

  assert.equal(storage.getItem("cdm.desktop.appearance.v2"), "{\"theme\":\"dark\"}");
  assert.equal(storage.getItem("cacatools.desktop.appearance.v2"), null);
  assert.equal(storage.getItem("unrelated.key"), "keep");
  assert.equal(result.migrated, 1);
});

test("migrates the image-editor theme key outside the standard prefix", () => {
  const storage = new MemoryStorage();
  storage.setItem("cacatools-theme", "dark");

  migrateLegacyStorageNamespace(storage);

  assert.equal(storage.getItem("cdm-theme"), "dark");
  assert.equal(storage.getItem("cacatools-theme"), null);
});

test("is idempotent", () => {
  const storage = new MemoryStorage();
  storage.setItem("cacatools.media-preferences", "audio");
  migrateLegacyStorageNamespace(storage);
  const result = migrateLegacyStorageNamespace(storage);

  assert.deepEqual(storage.entries(), [["cdm.media-preferences", "audio"]]);
  assert.equal(result.migrated, 0);
});

test("keeps legacy data when the canonical key already contains a different value", () => {
  const storage = new MemoryStorage();
  storage.setItem("cacatools.desktop.appearance.v2", "old");
  storage.setItem("cdm.desktop.appearance.v2", "new");

  const result = migrateLegacyStorageNamespace(storage);

  assert.equal(storage.getItem("cacatools.desktop.appearance.v2"), "old");
  assert.equal(storage.getItem("cdm.desktop.appearance.v2"), "new");
  assert.equal(result.preserved, 1);
});
