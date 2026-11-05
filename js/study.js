// A study session: the signs are drawn once at the start (weighted by progress),
// each sign is shown once, and answers update the sign's progress for next time.
import * as db from './db.js';
import { applyAnswer, drawSigns, isKnown, progressOf } from './progress.js';

export class Session {
  static async load(deckIds, mode = 'both') {
    const [decks, size] = await Promise.all([
      Promise.all(deckIds.map((id) => db.get('decks', id))).then((l) => l.filter(Boolean)),
      db.getSessionSize(),
    ]);
    const signs = [];
    for (const d of decks) signs.push(...(await db.getAll('signs', 'deckId', d.id)));
    return new Session(decks, signs, mode, size);
  }

  /** mode: 'both' (random direction per sign), 'video2word' or 'word2video'. */
  constructor(decks, signs, mode = 'both', size = 20, rng = Math.random) {
    this.decks = new Map(decks.map((d) => [d.id, d]));
    this.signs = new Map(signs.map((s) => [s.id, s]));
    this.queue = drawSigns(signs, size, rng).map((s) => ({
      signId: s.id,
      deckId: s.deckId,
      mode: mode === 'both' ? (rng() < 0.5 ? 'video2word' : 'word2video') : mode,
    }));
    this.pos = 0;
    this.history = [];
  }

  get answered() { return this.pos; }
  remaining() { return this.queue.length - this.pos; }
  next() { return this.queue[this.pos] || null; }

  /** `save` is injectable for tests. */
  async answer(item, rating, now = Date.now(), save = db.saveProgress) {
    if (item !== this.queue[this.pos]) return;
    const sign = this.signs.get(item.signId);
    const before = sign.progress;
    sign.progress = applyAnswer(progressOf(sign), rating, now);
    this.history.push({ item, before });
    this.pos++;
    await save(sign.id, sign.progress);
  }

  async undo(save = db.saveProgress) {
    const h = this.history.pop();
    if (!h) return null;
    const sign = this.signs.get(h.item.signId);
    sign.progress = h.before;
    this.pos--;
    await save(sign.id, sign.progress);
    return h.item;
  }
}

/** Number of known signs (more than 5 "Je sais" in a row). */
export const knownSigns = (signs) => signs.filter((s) => isKnown(progressOf(s))).length;

/** { known, total } signs for a deck. */
export async function deckProgress(deckId) {
  const signs = await db.getAll('signs', 'deckId', deckId);
  return { known: knownSigns(signs), total: signs.length };
}
