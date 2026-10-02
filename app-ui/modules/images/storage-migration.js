export const LEGACY_IMAGE_DATABASE_NAME = 'cacatools-images-v3';
export const CURRENT_IMAGE_DATABASE_NAME = 'cdm-images-v1';
const IMAGE_DATABASE_VERSION = 1;
const IMAGE_STORES = ['images', 'projects'];

function openDatabase(factory, name, version, createSchema) {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => {
      if (!createSchema) return;
      const db = request.result;
      if (!db.objectStoreNames.contains('images')) {
        const images = db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        images.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('projects')) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Could not open IndexedDB ${name}`));
  });
}

async function legacyDatabaseExists(factory) {
  if (typeof factory.databases !== 'function') return true;
  try {
    const databases = await factory.databases();
    return databases.some(({ name }) => name === LEGACY_IMAGE_DATABASE_NAME);
  } catch {
    return true;
  }
}

function readStore(database, storeName) {
  if (!database.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error(`Could not read IndexedDB store ${storeName}`));
  });
}

async function copyMissingRecords(source, target) {
  const records = new Map();
  for (const storeName of IMAGE_STORES) records.set(storeName, await readStore(source, storeName));

  await new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = target.transaction(IMAGE_STORES, 'readwrite');
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB migration transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB migration transaction aborted'));

    for (const storeName of IMAGE_STORES) {
      const store = transaction.objectStore(storeName);
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        const existingKeys = new Set(keysRequest.result);
        for (const record of records.get(storeName)) {
          if (record?.id !== undefined && !existingKeys.has(record.id)) {
            store.put(record);
            existingKeys.add(record.id);
          }
        }
      };
      keysRequest.onerror = () => transaction.abort();
    }
  });
}

function deleteLegacyDatabase(factory) {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(LEGACY_IMAGE_DATABASE_NAME);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
  });
}

export async function migrateLegacyImagesDatabase(factory = globalThis.indexedDB) {
  if (!factory) return null;
  const hasLegacyDatabase = await legacyDatabaseExists(factory);
  let current;
  try {
    current = await openDatabase(factory, CURRENT_IMAGE_DATABASE_NAME, IMAGE_DATABASE_VERSION, true);
  } catch {
    if (!hasLegacyDatabase) return null;
    try {
      return await openDatabase(factory, LEGACY_IMAGE_DATABASE_NAME, undefined, false);
    } catch {
      return null;
    }
  }
  if (!hasLegacyDatabase) return current;

  let legacy;
  try {
    legacy = await openDatabase(factory, LEGACY_IMAGE_DATABASE_NAME, undefined, false);
    await copyMissingRecords(legacy, current);
  } catch {
    current.close();
    return legacy || null;
  }

  legacy.close();
  await deleteLegacyDatabase(factory);
  return current;
}
