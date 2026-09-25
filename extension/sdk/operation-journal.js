const KEY = 'qaOperationJournalV1';
const uncertain = { ok: false, uncertain: true, error: 'No se confirmó el resultado del envío anterior. Revisa las descargas en Clear Download Manager antes de reenviar.' };

export function createOperationJournal(storage, now = Date.now) {
  let queue = Promise.resolve();
  const active = new Map();
  const serialize = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  async function read() { return (await storage.get({[KEY]:{}}))[KEY] || {}; }
  async function save(records) { await storage.set({[KEY]:records}); }
  return {
    async run(id, fingerprint, operation, { allowUncertainRetry = false } = {}) {
      if (!/^[a-zA-Z0-9_-]{8,160}$/.test(id)) throw new Error('Identificador de envío inválido.');
      if (active.has(fingerprint)) return active.get(fingerprint);
      const task = (async () => {
        const existing = await serialize(async () => {
          const records = await read();
          if (records[id]) {
            if (records[id].fingerprint !== fingerprint) throw new Error('El identificador pertenece a otro envío.');
            return records[id].result || uncertain;
          }
          for (const [key, record] of Object.entries(records)) {
            if (record.fingerprint === fingerprint) {
              if (record.status === 'pending' || record.status === 'uncertain') {
                if (!allowUncertainRetry) return uncertain;
                records[key] = {...record,status:'superseded',result:uncertain};
              }
              if (record.status === 'accepted' && now() - record.at < 2000) return record.result;
            }
          }
          // Never discard an unresolved operation to make room for a retry.
          for (const [key, record] of Object.entries(records)) {
            if (!['pending','uncertain'].includes(record.status) && now() - record.at > 86400000) delete records[key];
          }
          if (Object.keys(records).length >= 500) throw new Error('El registro de envíos está lleno. Revisa las operaciones pendientes en Clear Download Manager.');
          records[id] = { fingerprint, at:now(), status:'pending' };
          await save(records);
          return null;
        });
        if (existing) return existing;
        let result;
        try {
          const response = await operation();
          result = response && typeof response.ok === 'boolean' ? response : uncertain;
        } catch { result = uncertain; }
        await serialize(async () => {
          const records = await read();
          records[id] = {fingerprint,at:now(),status:result.uncertain?'uncertain':result.ok?'accepted':'rejected',result};
          await save(records);
        });
        return result;
      })();
      active.set(fingerprint, task);
      try { return await task; }
      finally { if (active.get(fingerprint) === task) active.delete(fingerprint); }
    }
  };
}

export async function selectionFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
