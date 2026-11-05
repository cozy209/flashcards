// A study session: decides which card comes next and records answers.
import * as db from './db.js';
import { schedule, dayStart, nextLabel, LEARN_AHEAD, DAY } from './srs.js';

const isLearning = (c) => c.state === 'learning' || c.state === 'relearning';
const modeRank = (m) => (m === 'video2word' ? 0 : 1);

export class Session {
  static async load(deckIds, mode = 'both') {
    const decks = (await Promise.all(deckIds.map((id) => db.get('decks', id)))).filter(Boolean);
    const cards = [];
    const signs = new Map();
    for (const d of decks) {
      cards.push(...(await db.getAll('cards', 'deckId', d.id)));
      for (const s of await db.getAll('signs', 'deckId', d.id)) signs.set(s.id, s);
    }
    return new Session(decks, cards, signs, mode);
  }

  constructor(decks, cards, signs, mode = 'both', now = Date.now()) {
    this.decks = new Map(decks.map((d) => [d.id, d]));
    this.signs = signs;
    this.mode = mode;
    this.today = dayStart(now);
    this.allCards = cards;
    this.cards = cards.filter((c) => mode === 'both' || c.mode === mode);
    this.cardById = new Map(cards.map((c) => [c.id, c]));
    this.bySign = new Map();
    for (const c of cards) {
      if (!this.bySign.has(c.signId)) this.bySign.set(c.signId, []);
      this.bySign.get(c.signId).push(c);
    }
    this.newQueue = this.buildNewQueue(decks);
    this.sinceNew = 0;
    this.history = [];
    this.answered = 0;
  }

  /** The other card of the same sign was already studied today → keep this one for another day. */
  siblingSeenToday(card) {
    return (this.bySign.get(card.signId) || []).some((o) => o !== card && o.lastReview >= this.today);
  }

  buildNewQueue(decks) {
    const perDeck = decks.map((d) => {
      const introduced = this.allCards.filter((c) => c.deckId === d.id && c.firstReview >= this.today).length;
      let left = Math.max(0, (d.newPerDay ?? 10) - introduced);
      const fresh = this.cards
        .filter((c) => c.deckId === d.id && c.state === 'new')
        .sort((a, b) => a.signId - b.signId || modeRank(a.mode) - modeRank(b.mode));
      const usedSigns = new Set();
      const ids = [];
      for (const c of fresh) {
        if (left <= 0) break;
        if (usedSigns.has(c.signId) || this.siblingSeenToday(c)) continue;
        usedSigns.add(c.signId);
        ids.push(c.id);
        left--;
      }
      return ids;
    });
    // Round-robin across decks so "study all" mixes collections.
    const queue = [];
    for (let i = 0; perDeck.some((l) => i < l.length); i++) for (const l of perDeck) if (i < l.length) queue.push(l[i]);
    return queue;
  }

  learningCards() {
    return this.cards.filter(isLearning).sort((a, b) => a.due - b.due);
  }

  dueReviews(now = Date.now()) {
    return this.cards
      .filter((c) => c.state === 'review' && c.due <= now && !this.siblingSeenToday(c))
      .sort((a, b) => a.due - b.due);
  }

  pendingNew() {
    return this.newQueue
      .map((id) => this.cardById.get(id))
      .filter((c) => c && c.state === 'new' && !this.siblingSeenToday(c));
  }

  next(now = Date.now()) {
    const learning = this.learningCards();
    if (learning[0] && learning[0].due <= now) return learning[0];

    const reviews = this.dueReviews(now);
    const news = this.pendingNew();
    if (news.length && reviews.length) {
      // Spread new cards evenly between reviews.
      const gap = Math.max(1, Math.floor(reviews.length / news.length));
      return this.sinceNew >= gap ? news[0] : reviews[0];
    }
    if (reviews.length) return reviews[0];
    if (news.length) return news[0];

    if (learning[0] && learning[0].due - now <= LEARN_AHEAD) return learning[0];
    return null;
  }

  /** When the next learning card becomes due (if any remain today). */
  nextLearningDue() {
    const l = this.learningCards()[0];
    return l ? l.due : null;
  }

  counts(now = Date.now()) {
    return {
      newCount: this.pendingNew().length,
      learnCount: this.cards.filter((c) => isLearning(c) && c.due < this.today + DAY).length,
      reviewCount: this.dueReviews(now).length,
    };
  }

  preview(card, now = Date.now()) {
    return [1, 2, 3, 4].map((r) => nextLabel(card, r, now));
  }

  async answer(card, rating, now = Date.now()) {
    const before = { ...card };
    Object.assign(card, schedule(card, rating, now));
    if (before.state === 'new') this.sinceNew = 0;
    else if (before.state === 'review') this.sinceNew++;
    this.history.push({ card, before, sinceNew: this.sinceNew });
    this.answered++;
    await db.put('cards', card);
  }

  async undo() {
    const h = this.history.pop();
    if (!h) return null;
    for (const k of Object.keys(h.card)) if (!(k in h.before)) delete h.card[k];
    Object.assign(h.card, h.before);
    this.answered--;
    await db.put('cards', h.card);
    return h.card;
  }
}

/** New / learning / review counts for a deck (both modes). */
export async function deckCounts(deck) {
  const session = await Session.load([deck.id], 'both');
  return session.counts();
}
