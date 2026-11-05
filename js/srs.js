// Spaced repetition scheduling (SM-2 / Anki-style).
// Ratings: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const LEARN_STEPS = [1, 10];   // minutes, for new cards
export const RELEARN_STEPS = [10];    // minutes, after forgetting a review card
export const GRADUATING_INTERVAL = 1; // days
export const EASY_INTERVAL = 4;       // days
export const START_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_INTERVAL = 36500;    // days
export const LEARN_AHEAD = 20 * MIN;  // show learning cards early when nothing else is left
export const DAY_START_HOUR = 4;      // a "day" rolls over at 4am, like Anki

export const SRS_FIELDS = ['state', 'step', 'ease', 'interval', 'due', 'reps', 'lapses', 'lastReview', 'firstReview', 'lastRating'];

export function newCardFields() {
  return { state: 'new', step: 0, ease: START_EASE, interval: 0, due: 0, reps: 0, lapses: 0, lastReview: null, firstReview: null };
}

/** Timestamp of the start of the study day containing `ts` (4am local time). */
export function dayStart(ts = Date.now()) {
  const d = new Date(ts - DAY_START_HOUR * HOUR);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  return d.getTime();
}

const clampIvl = (d) => Math.min(MAX_INTERVAL, Math.max(1, Math.round(d)));

function graduate(c, interval, now) {
  c.state = 'review';
  c.step = 0;
  c.interval = clampIvl(interval);
  c.due = dayStart(now) + c.interval * DAY;
}

/** Returns a new card object with scheduling updated for `rating`. Does not mutate `card`. */
export function schedule(card, rating, now = Date.now()) {
  const c = { ...card };
  c.reps = (c.reps || 0) + 1;
  c.lastReview = now;
  c.lastRating = rating;
  if (!c.firstReview) c.firstReview = now;
  if (!c.ease) c.ease = START_EASE;

  if (c.state === 'new') {
    c.state = 'learning';
    c.step = 0;
  }

  if (c.state === 'learning' || c.state === 'relearning') {
    const steps = c.state === 'learning' ? LEARN_STEPS : RELEARN_STEPS;
    const step = Math.min(c.step || 0, steps.length - 1);
    switch (rating) {
      case 1:
        c.step = 0;
        c.due = now + steps[0] * MIN;
        break;
      case 2: {
        // Hard: repeat the current step (first step: halfway between first and second step).
        const delay = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[step];
        c.due = now + delay * MIN;
        break;
      }
      case 3:
        c.step = step + 1;
        if (c.step >= steps.length) {
          graduate(c, c.state === 'learning' ? GRADUATING_INTERVAL : c.interval, now);
        } else {
          c.due = now + steps[c.step] * MIN;
        }
        break;
      case 4:
        graduate(c, c.state === 'learning' ? EASY_INTERVAL : c.interval + 1, now);
        break;
      default:
        throw new Error(`Invalid rating ${rating}`);
    }
    return c;
  }

  // Review card
  const ivl = c.interval || 1;
  const daysLate = Math.max(0, Math.floor((now - (c.due || now)) / DAY));
  switch (rating) {
    case 1:
      c.lapses = (c.lapses || 0) + 1;
      c.ease = Math.max(MIN_EASE, c.ease - 0.2);
      c.interval = 1;
      c.state = 'relearning';
      c.step = 0;
      c.due = now + RELEARN_STEPS[0] * MIN;
      return c;
    case 2:
      c.ease = Math.max(MIN_EASE, c.ease - 0.15);
      c.interval = clampIvl(Math.max(ivl + 1, ivl * 1.2));
      break;
    case 3:
      c.interval = clampIvl(Math.max(ivl + 1, (ivl + daysLate / 2) * c.ease));
      break;
    case 4:
      c.interval = clampIvl(Math.max(ivl + 2, (ivl + daysLate) * c.ease * 1.3));
      c.ease += 0.15;
      break;
    default:
      throw new Error(`Invalid rating ${rating}`);
  }
  c.due = dayStart(now) + c.interval * DAY;
  return c;
}

export function formatDuration(ms) {
  const m = ms / MIN;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  const h = ms / HOUR;
  if (h < 24) return `${Math.round(h)} h`;
  return formatDays(Math.round(ms / DAY));
}

export function formatDays(d) {
  if (d < 30) return `${d} j`;
  if (d < 365) return `${trim1(d / 30)} mois`;
  const y = trim1(d / 365);
  return `${y} ${y === '1' ? 'an' : 'ans'}`;
}

const trim1 = (n) => n.toFixed(1).replace(/\.0$/, '').replace('.', ',');

/** Short label for when a card would next be shown after a rating ("10m", "3d"…). */
export function nextLabel(card, rating, now = Date.now()) {
  const c = schedule(card, rating, now);
  return c.state === 'review' ? formatDays(c.interval) : formatDuration(c.due - now);
}
