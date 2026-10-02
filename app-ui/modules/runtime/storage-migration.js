const LEGACY_STORAGE_PREFIX = 'cacatools.';
const CURRENT_STORAGE_PREFIX = 'cdm.';
const LEGACY_STORAGE_KEYS = new Map([['cacatools-theme', 'cdm-theme']]);

export function migrateLegacyStorageNamespace(storage) {
  let target = storage;
  if (target === undefined) {
    try {
      target = globalThis.localStorage;
    } catch {
      return { migrated: 0, preserved: 0 };
    }
  }
  if (!target) return { migrated: 0, preserved: 0 };

  let keys;
  try {
    keys = Array.from({ length: target.length }, (_, index) => target.key(index))
      .filter((key) => typeof key === 'string'
        && (key.startsWith(LEGACY_STORAGE_PREFIX) || LEGACY_STORAGE_KEYS.has(key)));
  } catch {
    return { migrated: 0, preserved: 0 };
  }

  let migrated = 0;
  let preserved = 0;
  for (const legacyKey of keys) {
    const currentKey = LEGACY_STORAGE_KEYS.get(legacyKey)
      || `${CURRENT_STORAGE_PREFIX}${legacyKey.slice(LEGACY_STORAGE_PREFIX.length)}`;
    try {
      const legacyValue = target.getItem(legacyKey);
      if (legacyValue === null) continue;
      if (target.getItem(currentKey) === null) target.setItem(currentKey, legacyValue);
      if (target.getItem(currentKey) === legacyValue) {
        target.removeItem(legacyKey);
        migrated += 1;
      } else {
        preserved += 1;
      }
    } catch {
      preserved += 1;
    }
  }
  return { migrated, preserved };
}
