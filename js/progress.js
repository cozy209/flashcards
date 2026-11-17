// Per-sign mastery score and the weighted draw that picks the signs of a random session.
//
// Each sign has one progress record (shared by both directions and both study modes):
//   { mastery: 0..1, lastRating: 1 | 2 | 3 | null, streak, reviews, lastReview }
// Ratings: 1 = À revoir, 2 = Difficile, 3 = Je sais.

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;

/** Score of a sign that was never shown. */
export const START_MASTERY = 0.3;
/** A sign is "connu" from this score. */
export const KNOWN_MASTERY = 0.8;
/** Score change per answer. */
export const MASTERY_DELTA = { [AGAIN]: -0.2, [HARD]: 0, [GOOD]: 0.1 };
export const DEFAULT_SESSION_SIZE = 20;

const round2 = (x) => Math.round(x * 100) / 100;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export const emptyProgress = () => ({ mastery: START_MASTERY, lastRating: null, streak: 0, reviews: 0, lastReview: null });

export const progressOf = (sign) => sign.progress || emptyProgress();

export const isSeen = (p) => !!(p?.lastReview || p?.reviews);

/** Score of a progress record. Records from before the score existed are converted from their last answer. */
export function masteryOf(p) {
  if (typeof p?.mastery === 'number') return p.mastery;
  if (!p || p.lastRating == null) return START_MASTERY;
  if (p.lastRating === GOOD) return Math.min(KNOWN_MASTERY, round2(START_MASTERY + 0.1 * (p.streak || 1)));
  if (p.lastRating === AGAIN) return round2(START_MASTERY + MASTERY_DELTA[AGAIN] / 2); // 0.2
  return START_MASTERY;
}

export const isKnown = (p) => masteryOf(p) >= KNOWN_MASTERY;

/**
 * Chance of being drawn, relative to other signs: (1.1 − score)².
 * Missed a lot (0) 1.21 · new (0.3) 0.64 · known (0.8) 0.09 · max (1) 0.01 — never 0.
 */
export const weight = (p) => (1.1 - masteryOf(p)) ** 2;

/** Bar colour of a sign: never seen (grey), weak < 0.3 (orange), learning (blue), known ≥ 0.8 (green). */
export function level(p) {
  if (!isSeen(p)) return 'unseen';
  const m = masteryOf(p);
  if (m >= KNOWN_MASTERY) return 'known';
  if (m < START_MASTERY) return 'weak';
  return 'learning';
}

/** New progress after answering `rating`. Does not mutate `p`. */
export function applyAnswer(p, rating, now = Date.now()) {
  if (![AGAIN, HARD, GOOD].includes(rating)) throw new Error(`Invalid rating ${rating}`);
  const prev = p || emptyProgress();
  return {
    mastery: round2(clamp01(masteryOf(prev) + MASTERY_DELTA[rating])),
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
  const p = {
    lastRating,
    streak: lastRating === GOOD ? 1 : 0,
    reviews: seen.reduce((s, c) => s + (c.reps || 0), 0),
    lastReview: last.lastReview,
  };
  return { mastery: masteryOf(p), ...p };
}
