import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  CURRENT_IMAGE_DATABASE_NAME,
  LEGACY_IMAGE_DATABASE_NAME,
  migrateLegacyImagesDatabase,
} from "../../app-ui/modules/images/storage-migration.js";

function openSeedDatabase(factory, name, version = 2) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const images = db.createObjectStore("images", { keyPath: "id", autoIncrement: true });
      images.createIndex("createdAt", "createdAt");
      const projects = db.createObjectStore("projects", { keyPath: "id" });
      projects.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db, store, record) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readwrite").objectStore(store).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("moves legacy image and project records into the canonical database", async () => {
  const factory = new IDBFactory();
  const legacy = await openSeedDatabase(factory, LEGACY_IMAGE_DATABASE_NAME);
  await put(legacy, "images", { id: 7, name: "sketch.png", createdAt: 10, blob: new Blob(["pixels"]) });
  await put(legacy, "projects", { id: "project-1", name: "Proyecto", updatedAt: 11, layers: [] });
  legacy.close();

  const current = await migrateLegacyImagesDatabase(factory);

  assert.equal(current.name, CURRENT_IMAGE_DATABASE_NAME);
  assert.equal((await getAll(current, "images")).length, 1);
  assert.equal((await getAll(current, "images"))[0].blob.size, 6);
  assert.equal((await getAll(current, "projects"))[0].id, "project-1");
  assert.equal((await factory.databases()).some(({ name }) => name === LEGACY_IMAGE_DATABASE_NAME), false);
  current.close();
});

test("preserves canonical records on key conflicts, adds missing records, and is repeatable", async () => {
  const factory = new IDBFactory();
  const current = await openSeedDatabase(factory, CURRENT_IMAGE_DATABASE_NAME, 1);
  const legacy = await openSeedDatabase(factory, LEGACY_IMAGE_DATABASE_NAME);
  await put(current, "images", { id: 1, name: "current.png", createdAt: 20 });
  await put(legacy, "images", { id: 1, name: "legacy.png", createdAt: 10 });
  await put(legacy, "images", { id: 2, name: "extra.png", createdAt: 9 });
  await put(current, "projects", { id: "project", name: "Current", updatedAt: 20 });
  await put(legacy, "projects", { id: "project", name: "Legacy", updatedAt: 10 });
  await put(legacy, "projects", { id: "legacy-project", name: "Keep", updatedAt: 9 });
  current.close();
  legacy.close();

  const migrated = await migrateLegacyImagesDatabase(factory);
  const images = await getAll(migrated, "images");
  const projects = await getAll(migrated, "projects");
  assert.equal(images.length, 2);
  assert.equal(images.find(({ id }) => id === 1).name, "current.png");
  assert.equal(images.find(({ id }) => id === 2).name, "extra.png");
  assert.equal(projects.length, 2);
  assert.equal(projects.find(({ id }) => id === "project").name, "Current");
  assert.equal(projects.find(({ id }) => id === "legacy-project").name, "Keep");

  const secondStart = await migrateLegacyImagesDatabase(factory);
  assert.equal((await getAll(secondStart, "images")).length, 2);
  assert.equal((await getAll(secondStart, "projects")).length, 2);
  secondStart.close();
  migrated.close();
});
