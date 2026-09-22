// Local persistence (IndexedDB): settings, the working project, the imported Timeline columns and
// the video library. Everything stays on the device.
const DB_NAME = 'timelinerx';
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('library')) d.createObjectStore('library', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k)).catch(() => undefined);
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)).catch((e) => console.warn('kvSet', k, e));
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k)).catch(() => {});
export const libraryAll = () => tx('library', 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => y.created - x.created)).catch(() => []);
export const libraryPut = (item) => tx('library', 'readwrite', (s) => s.put(item));
export const libraryDel = (id) => tx('library', 'readwrite', (s) => s.delete(id));

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
export async function persistStorage() { try { return await navigator.storage.persist?.(); } catch { return false; } }
