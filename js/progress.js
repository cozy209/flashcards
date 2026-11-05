// Per-sign progress and the weighted draw that picks the signs of a session.
//
// Each sign has one progress record (shared by both directions):
//   { lastRating: 1 | 2 | 3 | null, streak: number, reviews: number, lastReview: timestamp | null }
// Ratings: 1 = À revoir, 2 = Difficile, 3 = Je sais.

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;

/** A sign is known after more than this many "Je sais" in a row. */
export const KNOWN_STREAK = 5;
export const DEFAULT_SESSION_SIZE = 20;

export const emptyProgress = () => ({ lastRating: null, streak: 0, reviews: 0, lastReview: null });

export const progressOf = (sign) => sign.progress || emptyProgress();

export const isKnown = (p) => (p?.streak || 0) > KNOWN_STREAK;

/**
 * Chance of being drawn, relative to other signs:
 * known 1 · never shown or "Je sais" 2 · "Difficile" 3 · "À revoir" 4.
 */
export function weight(p) {
  if (isKnown(p)) return 1;
  if (p?.lastRating === AGAIN) return 4;
  if (p?.lastRating === HARD) return 3;
  return 2;
}

/** New progress after answering `rating`. Does not mutate `p`. */
export function applyAnswer(p, rating, now = Date.now()) {
  if (![AGAIN, HARD, GOOD].includes(rating)) throw new Error(`Invalid rating ${rating}`);
  const prev = p || emptyProgress();
  return {
    lastRating: rating,
    streak: rating === GOOD ? (prev.streak || 0) + 1 : 0,
    reviews: (prev.reviews || 0) + 1,
    lastReview: now,
  };
}

/**
 * Picks up to `n` distinct signs at random, each with probability proportional to its weight
 * (weighted sampling without replacement, Efraimidis–Spirakis). Returns them in draw order.
 */
export function drawSigns(signs, n, rng = Math.random) {
  return signs
    .map((sign) => ({ sign, key: Math.pow(rng() || Number.MIN_VALUE, 1 / weight(progressOf(sign))) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, Math.max(0, n))
    .map((x) => x.sign);
}

/**
 * Converts progress from the old per-card scheduler (one card per direction) into sign progress:
 * the most recently reviewed card gives the last answer.
 */
export function fromLegacyCards(cards) {
  const seen = (cards || []).filter((c) => c && c.lastReview);
  if (!seen.length) return emptyProgress();
  const last = seen.reduce((a, b) => (b.lastReview > a.lastReview ? b : a));
  const lastRating = last.lastRating != null ? Math.min(GOOD, last.lastRating) : last.state === 'review' ? GOOD : HARD;
  return {
    lastRating,
    streak: lastRating === GOOD ? 1 : 0,
    reviews: seen.reduce((s, c) => s + (c.reps || 0), 0),
    lastReview: last.lastReview,
  };
}
