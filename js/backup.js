// Export / import study progress as JSON (videos are not included).
import * as db from './db.js';
import { fromLegacyCards, progressOf } from './progress.js';

export async function buildExport() {
  const [decks, signs, pending, sessionSize] = await Promise.all([
    db.getAll('decks'), db.getAll('signs'), db.getAll('pending'), db.getSessionSize(),
  ]);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  return {
    app: 'signcards',
    version: 2,
    exportedAt: new Date().toISOString(),
    sessionSize,
    decks: decks.map((d) => ({ name: d.name })),
    signs: [
      ...signs
        .filter((s) => deckById.has(s.deckId))
        .map((s) => ({ deck: deckById.get(s.deckId).name, sign: s.name, ...progressOf(s) })),
      // Keep progress that was imported earlier but whose video hasn't been re-added yet.
      ...pending.filter((p) => p.key.endsWith('|sign')).map((p) => p.progress),
    ],
  };
}

export async function shareOrDownload(data) {
  const name = `flashcards-progression-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Progression Flashcards' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const PROGRESS_FIELDS = ['lastRating', 'streak', 'reviews', 'lastReview'];
const pick = (o) => Object.fromEntries(PROGRESS_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Old backups (version 1) stored one entry per direction: merge them into one entry per sign. */
function signEntries(json) {
  if (Array.isArray(json.signs)) return json.signs;
  const bySign = new Map();
  for (const c of json.cards || []) {
    if (!c.deck || !c.sign) continue;
    const key = db.pendingKey(c.deck, c.sign, 'sign');
    if (!bySign.has(key)) bySign.set(key, { deck: c.deck, sign: c.sign, cards: [] });
    bySign.get(key).cards.push(c);
  }
  return [...bySign.values()].map((e) => ({ deck: e.deck, sign: e.sign, ...fromLegacyCards(e.cards) }));
}

/** Applies progress to matching signs; unmatched entries wait in `pending` until their video is imported. */
export async function importProgress(json) {
  if (json?.app !== 'signcards' || !(Array.isArray(json.signs) || Array.isArray(json.cards))) {
    throw new Error('Ce n\'est pas un fichier de sauvegarde Flashcards.');
  }

  for (const d of json.decks || []) {
    if (d.name && !(await db.findDeckByName(d.name))) await db.createDeck(d.name);
  }
  if (Number.isFinite(json.sessionSize)) await db.setSessionSize(json.sessionSize);

  const [decks, signs] = await Promise.all([db.getAll('decks'), db.getAll('signs')]);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const signByKey = new Map();
  for (const s of signs) {
    const deck = deckById.get(s.deckId);
    if (deck) signByKey.set(db.pendingKey(deck.name, s.name, 'sign'), s);
  }

  let updated = 0, waiting = 0;
  await db.tx(['signs', 'pending'], 'readwrite', (s) => {
    for (const e of signEntries(json)) {
      if (!e.deck || !e.sign) continue;
      const key = db.pendingKey(e.deck, e.sign, 'sign');
      const sign = signByKey.get(key);
      if (sign) {
        s.signs.put({ ...sign, progress: { ...progressOf(sign), ...pick(e) } });
        updated++;
      } else {
        s.pending.put({ key, progress: { deck: e.deck, sign: e.sign, ...pick(e) } });
        waiting++;
      }
    }
  });
  return { updated, waiting };
}
