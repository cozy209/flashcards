// IndexedDB storage. Everything (decks, signs, progress, videos) lives on the device.
// Progress is stored on each sign (`sign.progress`). The `cards` store is from the old
// per-direction scheduler: it is only read once to migrate old progress.
import { emptyProgress, fromLegacyCards, DEFAULT_SESSION_SIZE } from './progress.js';

const DB_NAME = 'signcards';
const DB_VERSION = 1;
export const MODES = ['video2word', 'word2video'];

let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
        const signs = db.createObjectStore('signs', { keyPath: 'id', autoIncrement: true });
        signs.createIndex('deckId', 'deckId');
        const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
        cards.createIndex('deckId', 'deckId');
        cards.createIndex('signId', 'signId');
        db.createObjectStore('videos', { keyPath: 'signId' });   // { signId, data: ArrayBuffer, type, size }
        db.createObjectStore('pending', { keyPath: 'key' });     // imported progress waiting for its video
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('La base de données est ouverte dans un autre onglet. Fermez-le et réessayez.'));
    });
  }
  return dbPromise;
}

export const reqP = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Run `fn(stores)` inside one transaction; resolves with fn's result once committed. */
export async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const names = [].concat(storeNames);
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve()
      .then(() => fn(stores, t))
      .then((r) => { result = r; }, (err) => { try { t.abort(); } catch {} reject(err); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

const source = (s, store, index) => (index ? s[store].index(index) : s[store]);

export const get = (store, key) => tx(store, 'readonly', (s) => reqP(s[store].get(key)));
export const getAll = (store, index, query) =>
  tx(store, 'readonly', (s) => reqP(index ? source(s, store, index).getAll(query) : s[store].getAll()));
export const count = (store, index, query) =>
  tx(store, 'readonly', (s) => reqP(index ? source(s, store, index).count(query) : s[store].count()));
export const put = (store, value) => tx(store, 'readwrite', (s) => reqP(s[store].put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => reqP(s[store].delete(key)));

// ---------- meta / settings ----------

export async function getMeta(key, fallback) {
  const rec = await get('meta', key);
  return rec ? rec.value : fallback;
}
export const setMeta = (key, value) => put('meta', { key, value });

// ---------- decks ----------

export async function findDeckByName(name) {
  const n = name.trim().toLowerCase();
  return (await getAll('decks')).find((d) => d.name.toLowerCase() === n) || null;
}

export async function createDeck(name) {
  return put('decks', { name: name.trim(), createdAt: Date.now() });
}

// Number of signs drawn per study session (all decks together).
export const getSessionSize = () => getMeta('sessionSize', DEFAULT_SESSION_SIZE);
export const setSessionSize = (n) => setMeta('sessionSize', n);

export function deleteDeck(deckId) {
  return tx(['decks', 'signs', 'cards', 'videos'], 'readwrite', async (s) => {
    const signIds = await reqP(s.signs.index('deckId').getAllKeys(deckId));
    const cardIds = await reqP(s.cards.index('deckId').getAllKeys(deckId));
    for (const id of signIds) { s.signs.delete(id); s.videos.delete(id); }
    for (const id of cardIds) s.cards.delete(id);
    s.decks.delete(deckId);
  });
}

// ---------- signs ----------

export const pendingKey = (deckName, signName, mode) =>
  `${deckName.trim().toLowerCase()}|${signName.trim().toLowerCase()}|${mode}`;

/** Imported progress waiting for its video (old backups stored one entry per direction). */
const PENDING_KINDS = ['sign', ...MODES];

/** Adds a sign with its video. Applies any pending imported progress. */
export function addSign(deck, name, data, type) {
  return tx(['signs', 'videos', 'pending'], 'readwrite', async (s) => {
    let progress = emptyProgress();
    const legacy = [];
    for (const kind of PENDING_KINDS) {
      const key = pendingKey(deck.name, name, kind);
      const pending = await reqP(s.pending.get(key));
      if (!pending) continue;
      if (kind === 'sign') {
        const { deck: _d, sign: _s, ...fields } = pending.progress;
        progress = { ...progress, ...fields };
      }
      else legacy.push(pending.progress);
      s.pending.delete(key);
    }
    if (!progress.lastReview && legacy.length) progress = fromLegacyCards(legacy);
    const signId = await reqP(s.signs.add({ deckId: deck.id, name, createdAt: Date.now(), progress }));
    await reqP(s.videos.put({ signId, data, type, size: data.byteLength }));
    return signId;
  });
}

export function saveProgress(signId, progress) {
  return tx('signs', 'readwrite', async (s) => {
    const sign = await reqP(s.signs.get(signId));
    if (!sign) return;
    sign.progress = progress;
    await reqP(s.signs.put(sign));
  });
}

/** One-time move of progress from the old per-direction cards onto the signs. */
export function migrateProgress() {
  return tx(['signs', 'cards'], 'readwrite', async (s) => {
    const signs = await reqP(s.signs.getAll());
    for (const sign of signs) {
      if (sign.progress) continue;
      const cards = await reqP(s.cards.index('signId').getAll(sign.id));
      sign.progress = fromLegacyCards(cards);
      s.signs.put(sign);
    }
  });
}

export function renameSign(signId, name) {
  return tx('signs', 'readwrite', async (s) => {
    const sign = await reqP(s.signs.get(signId));
    if (!sign) throw new Error('Signe introuvable');
    sign.name = name;
    await reqP(s.signs.put(sign));
  });
}

export function deleteSign(signId) {
  return tx(['signs', 'cards', 'videos'], 'readwrite', async (s) => {
    const cardIds = await reqP(s.cards.index('signId').getAllKeys(signId));
    for (const id of cardIds) s.cards.delete(id);
    s.videos.delete(signId);
    s.signs.delete(signId);
  });
}

// ---------- maintenance ----------

export async function deleteEverything() {
  const db = await openDB();
  db.close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = resolve;
  });
}
