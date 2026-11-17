// Study sessions. Two modes, chosen in Réglages:
//  - Aléatoire (RandomSession): signs drawn once at the start, weighted by mastery; each shown once.
//  - Anki (AnkiSession): spaced repetition with due dates, learning steps and a daily new-sign limit.
// Both work per sign (one record for both directions) and both update the sign's mastery score.
// Items handed to the screen: { signId, deckId, mode: 'video2word' | 'word2video' }.
import * as db from './db.js';
import { applyAnswer, drawSigns, isKnown, level, progressOf } from './progress.js';
import { schedule, newCardFields, dayStart, LEARN_AHEAD, DAY } from './srs.js';

const pickMode = (mode, rng) => (mode === 'both' ? (rng() < 0.5 ? 'video2word' : 'word2video') : mode);
const itemOf = (sign, mode, rng) => ({ signId: sign.id, deckId: sign.deckId, mode: pickMode(mode, rng) });

export class RandomSession {
  kind = 'random';

  /** mode: 'both' (random direction per sign), 'video2word' or 'word2video'. */
  constructor(decks, signs, mode = 'both', size = 20, rng = Math.random) {
    this.decks = new Map(decks.map((d) => [d.id, d]));
    this.signs = new Map(signs.map((s) => [s.id, s]));
    this.queue = drawSigns(signs, size, rng).map((s) => itemOf(s, mode, rng));
    this.pos = 0;
    this.history = [];
  }

  get answered() { return this.pos; }
  remaining() { return this.queue.length - this.pos; }
  next() { return this.queue[this.pos] || null; }

  /** `save` is injectable for tests. */
  async answer(item, rating, now = Date.now(), save = db.saveSign) {
    if (item !== this.queue[this.pos]) return;
    const sign = this.signs.get(item.signId);
    const before = sign.progress;
    sign.progress = applyAnswer(progressOf(sign), rating, now);
    this.history.push({ item, before });
    this.pos++;
    await save(sign.id, { progress: sign.progress });
  }

  async undo(save = db.saveSign) {
    const h = this.history.pop();
    if (!h) return null;
    const sign = this.signs.get(h.item.signId);
    sign.progress = h.before;
    this.pos--;
    await save(sign.id, { progress: sign.progress });
    return h.item;
  }
}

const srsOf = (sign) => sign.srs || newCardFields();
const isLearning = (c) => c.state === 'learning' || c.state === 'relearning';

export class AnkiSession {
  kind = 'anki';

  /**
   * opts.newPerDay: daily limit of new signs, shared by all decks.
   * opts.introducedToday: new signs already started today in any deck.
   */
  constructor(decks, signs, mode = 'both', opts = {}, now = Date.now(), rng = Math.random) {
    this.decks = new Map(decks.map((d) => [d.id, d]));
    this.signs = new Map(signs.map((s) => [s.id, s]));
    this.list = signs;
    this.mode = mode;
    this.rng = rng;
    this.today = dayStart(now);
    this.newPerDay = opts.newPerDay ?? 10;
    this.introducedToday = opts.introducedToday ?? signs.filter((s) => s.srs?.firstReview >= this.today).length;
    this.newQueue = this.buildNewQueue(decks);
    this.sinceNew = 0;
    this.history = [];
    this.answered = 0;
  }

  buildNewQueue(decks) {
    const left = Math.max(0, this.newPerDay - this.introducedToday);
    const perDeck = decks.map((d) => this.list
      .filter((s) => s.deckId === d.id && srsOf(s).state === 'new')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id - b.id)
      .map((s) => s.id));
    // Round-robin across decks so studying several decks mixes them.
    const queue = [];
    for (let i = 0; perDeck.some((l) => i < l.length); i++) for (const l of perDeck) if (i < l.length) queue.push(l[i]);
    return queue.slice(0, left);
  }

  learningSigns() {
    return this.list.filter((s) => isLearning(srsOf(s))).sort((a, b) => srsOf(a).due - srsOf(b).due);
  }

  dueReviews(now = Date.now()) {
    return this.list.filter((s) => srsOf(s).state === 'review' && srsOf(s).due <= now).sort((a, b) => srsOf(a).due - srsOf(b).due);
  }

  pendingNew() {
    return this.newQueue.map((id) => this.signs.get(id)).filter((s) => s && srsOf(s).state === 'new');
  }

  pick(now = Date.now()) {
    const learning = this.learningSigns();
    if (learning[0] && srsOf(learning[0]).due <= now) return learning[0];
    const reviews = this.dueReviews(now);
    const news = this.pendingNew();
    if (news.length && reviews.length) {
      // Spread new signs evenly between reviews.
      const gap = Math.max(1, Math.floor(reviews.length / news.length));
      return this.sinceNew >= gap ? news[0] : reviews[0];
    }
    if (reviews.length) return reviews[0];
    if (news.length) return news[0];
    if (learning[0] && srsOf(learning[0]).due - now <= LEARN_AHEAD) return learning[0];
    return null;
  }

  next(now = Date.now()) {
    const sign = this.pick(now);
    return sign ? itemOf(sign, this.mode, this.rng) : null;
  }

  /** When the next learning sign becomes due (if any remain). */
  nextLearningDue() {
    const l = this.learningSigns()[0];
    return l ? srsOf(l).due : null;
  }

  remaining(now = Date.now()) {
    const learning = this.learningSigns().filter((s) => srsOf(s).due < this.today + DAY).length;
    return this.pendingNew().length + learning + this.dueReviews(now).length;
  }

  async answer(item, rating, now = Date.now(), save = db.saveSign) {
    const sign = this.signs.get(item.signId);
    if (!sign) return;
    const before = { srs: sign.srs, progress: sign.progress, sinceNew: this.sinceNew };
    const prevState = srsOf(sign).state;
    sign.srs = schedule(srsOf(sign), rating, now);
    sign.progress = applyAnswer(progressOf(sign), rating, now);
    if (prevState === 'new') this.sinceNew = 0;
    else if (prevState === 'review') this.sinceNew++;
    this.history.push({ item, before });
    this.answered++;
    await save(sign.id, { srs: sign.srs, progress: sign.progress });
  }

  async undo(save = db.saveSign) {
    const h = this.history.pop();
    if (!h) return null;
    const sign = this.signs.get(h.item.signId);
    sign.srs = h.before.srs;
    sign.progress = h.before.progress;
    this.sinceNew = h.before.sinceNew;
    this.answered--;
    await save(sign.id, { srs: sign.srs, progress: sign.progress });
    return h.item;
  }
}

/** Number of signs due in Anki mode now (learning due today + reviews due). New signs not included. */
export function dueCount(signs, now = Date.now()) {
  const end = dayStart(now) + DAY;
  return signs.filter((s) => {
    const c = srsOf(s);
    return (c.state === 'review' && c.due <= now) || (isLearning(c) && c.due < end);
  }).length;
}

/** Loads the session for the study mode chosen in Réglages. */
export const Session = {
  async load(deckIds, mode = 'both') {
    const [decks, studyMode] = await Promise.all([
      Promise.all(deckIds.map((id) => db.get('decks', id))).then((l) => l.filter(Boolean)),
      db.getStudyMode(),
    ]);
    const ids = new Set(decks.map((d) => d.id));
    if (studyMode === 'anki') {
      const [all, newPerDay] = await Promise.all([db.getAll('signs'), db.getNewPerDay()]);
      // The daily limit is shared by all decks, so count what was started today in any deck.
      const today = dayStart();
      const introducedToday = all.filter((s) => s.srs?.firstReview >= today).length;
      return new AnkiSession(decks, all.filter((s) => ids.has(s.deckId)), mode, { newPerDay, introducedToday });
    }
    const signs = [];
    for (const d of decks) signs.push(...(await db.getAll('signs', 'deckId', d.id)));
    return new RandomSession(decks, signs, mode, await db.getSessionSize());
  },
};

/** Number of known signs (score ≥ 0.8). */
export const knownSigns = (signs) => signs.filter((s) => isKnown(progressOf(s))).length;

/** Signs per bar colour: { known, learning, weak, unseen }. */
export function levelSplit(signs) {
  const out = { known: 0, learning: 0, weak: 0, unseen: 0 };
  for (const s of signs) out[level(progressOf(s))]++;
  return out;
}

/** Everything the deck row needs: { known, total, split, due }. `due` only in Anki mode. */
export async function deckProgress(deckId, studyMode = 'random') {
  const signs = await db.getAll('signs', 'deckId', deckId);
  return {
    known: knownSigns(signs),
    total: signs.length,
    split: levelSplit(signs),
    due: studyMode === 'anki' ? dueCount(signs) : 0,
  };
}
