// Run with: node tests/srs.test.mjs
import assert from 'node:assert/strict';
import { schedule, newCardFields, dayStart, nextLabel, DAY, MIN } from '../js/srs.js';
import { AnkiSession, dueCount } from '../js/study.js';
import { masteryOf, START_MASTERY } from '../js/progress.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

const now = new Date(2026, 0, 10, 12, 0).getTime();
const fresh = () => ({ id: 1, deckId: 1, signId: 1, mode: 'video2word', ...newCardFields() });

test('new card: Again → 1 minute, still learning', () => {
  const c = schedule(fresh(), 1, now);
  assert.equal(c.state, 'learning');
  assert.equal(c.due, now + 1 * MIN);
  assert.equal(c.firstReview, now);
});

test('new card: Good twice → graduates to 1 day', () => {
  let c = schedule(fresh(), 3, now);
  assert.equal(c.state, 'learning');
  assert.equal(c.due, now + 10 * MIN);
  c = schedule(c, 3, now + 10 * MIN);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 1);
  assert.equal(c.due, dayStart(now) + DAY);
});

test('new card: Easy → 4 days', () => {
  const c = schedule(fresh(), 4, now);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 4);
});

test('review: Good multiplies by ease, Hard grows slower, Easy faster', () => {
  const r = { ...fresh(), state: 'review', interval: 10, ease: 2.5, due: now };
  assert.equal(schedule(r, 2, now).interval, 12);
  assert.equal(schedule(r, 3, now).interval, 25);
  assert.equal(schedule(r, 4, now).interval, 33);
  assert.ok(schedule(r, 4, now).ease > 2.5);
  assert.ok(schedule(r, 2, now).ease < 2.5);
});

test('review: Again → relearning, lapse counted, ease reduced, then back to review', () => {
  const r = { ...fresh(), state: 'review', interval: 10, ease: 2.5, due: now };
  const c = schedule(r, 1, now);
  assert.equal(c.state, 'relearning');
  assert.equal(c.lapses, 1);
  assert.equal(c.ease, 2.3);
  assert.equal(c.due, now + 10 * MIN);
  const back = schedule(c, 3, now + 10 * MIN);
  assert.equal(back.state, 'review');
  assert.equal(back.interval, 1);
});

test('ease never drops below 1.3', () => {
  let c = { ...fresh(), state: 'review', interval: 5, ease: 1.35, due: now };
  c = schedule(c, 1, now);
  assert.equal(c.ease, 1.3);
});

test('labels', () => {
  assert.deepEqual([1, 2, 3, 4].map((r) => nextLabel(fresh(), r, now)), ['1 min', '6 min', '10 min', '4 j']);
});

test('day starts at 4am', () => {
  const at3am = new Date(2026, 0, 10, 3, 0).getTime();
  assert.equal(dayStart(at3am), new Date(2026, 0, 9, 4, 0).getTime());
});

// ---------- Anki mode (per sign) ----------

const signs = (n, deckId = 1, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: deckId * 100 + i, deckId, name: `S${i}`, createdAt: i, ...extra }));
const noSave = async () => {};
const deck = (id) => ({ id, name: `D${id}` });

test('anki: new-per-day limit, shared by all decks', () => {
  const list = [...signs(5, 1), ...signs(5, 2)];
  assert.equal(new AnkiSession([deck(1), deck(2)], list, 'both', { newPerDay: 4 }, now).remaining(now), 4);
  assert.equal(new AnkiSession([deck(1), deck(2)], list, 'both', { newPerDay: 4, introducedToday: 3 }, now).remaining(now), 1);
});

test('anki: a missed sign comes back after its delay in the same session', async () => {
  const s = new AnkiSession([deck(1)], signs(1), 'video2word', { newPerDay: 10 }, now);
  const item = s.next(now);
  await s.answer(item, 1, now, noSave);
  // Nothing else to study: a learning sign due within 20 min may be shown early (like Anki).
  assert.equal(s.next(now).signId, item.signId);
  assert.equal(s.nextLearningDue(), now + 1 * MIN);
  assert.equal(s.next(now + 2 * MIN).signId, item.signId);
});

test('anki: answers also update the mastery score, undo restores both', async () => {
  const list = signs(1);
  const s = new AnkiSession([deck(1)], list, 'both', { newPerDay: 10 }, now);
  const item = s.next(now);
  await s.answer(item, 3, now, noSave);
  assert.equal(masteryOf(list[0].progress), 0.4);
  assert.equal(list[0].srs.state, 'learning');
  await s.undo(noSave);
  assert.equal(list[0].srs, undefined);
  assert.equal(masteryOf(list[0].progress), START_MASTERY);
});

test('anki: due count counts reviews due and learning signs, not new ones', () => {
  const list = [
    { id: 1, srs: { ...newCardFields(), state: 'review', due: now - 1 } },
    { id: 2, srs: { ...newCardFields(), state: 'review', due: now + 3 * DAY } },
    { id: 3, srs: { ...newCardFields(), state: 'learning', due: now + 5 * MIN } },
    { id: 4 },
  ];
  assert.equal(dueCount(list, now), 2);
});

console.log(`\n${passed} tests passed`);
