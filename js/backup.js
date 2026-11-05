// Export / import study progress as JSON (videos are not included).
import * as db from './db.js';

export async function buildExport() {
  const [decks, signs, cards] = await Promise.all([db.getAll('decks'), db.getAll('signs'), db.getAll('cards')]);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const signById = new Map(signs.map((s) => [s.id, s]));
  const pending = await db.getAll('pending');
  return {
    app: 'signcards',
    version: 1,
    exportedAt: new Date().toISOString(),
    decks: decks.map((d) => ({ name: d.name, newPerDay: d.newPerDay })),
    cards: [
      ...cards
        .filter((c) => deckById.has(c.deckId) && signById.has(c.signId))
        .map((c) => ({ deck: deckById.get(c.deckId).name, sign: signById.get(c.signId).name, mode: c.mode, ...db.pickSrs(c) })),
      // Keep progress that was imported earlier but whose video hasn't been re-added yet.
      ...pending.map((p) => p.progress),
    ],
  };
}

export async function shareOrDownload(data) {
  const name = `sign-cards-progress-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sign Cards progress' });
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

/** Applies progress to matching cards; unmatched entries wait in `pending` until their video is imported. */
export async function importProgress(json) {
  if (json?.app !== 'signcards' || !Array.isArray(json.cards)) throw new Error('This is not a Sign Cards backup file.');

  for (const d of json.decks || []) {
    if (!d.name) continue;
    if (!(await db.findDeckByName(d.name))) {
      const id = await db.createDeck(d.name);
      if (d.newPerDay != null) await db.put('decks', { ...(await db.get('decks', id)), newPerDay: d.newPerDay });
    }
  }

  const [decks, signs, cards] = await Promise.all([db.getAll('decks'), db.getAll('signs'), db.getAll('cards')]);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const signById = new Map(signs.map((s) => [s.id, s]));
  const cardByKey = new Map();
  for (const c of cards) {
    const deck = deckById.get(c.deckId);
    const sign = signById.get(c.signId);
    if (deck && sign) cardByKey.set(db.pendingKey(deck.name, sign.name, c.mode), c);
  }

  let updated = 0, waiting = 0;
  await db.tx(['cards', 'pending'], 'readwrite', (s) => {
    for (const p of json.cards) {
      if (!p.deck || !p.sign || !p.mode) continue;
      const key = db.pendingKey(p.deck, p.sign, p.mode);
      const card = cardByKey.get(key);
      if (card) {
        s.cards.put({ ...card, ...db.pickSrs(p) });
        updated++;
      } else {
        s.pending.put({ key, progress: { deck: p.deck, sign: p.sign, mode: p.mode, ...db.pickSrs(p) } });
        waiting++;
      }
    }
  });
  return { updated, waiting };
}
