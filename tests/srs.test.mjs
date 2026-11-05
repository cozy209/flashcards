// Run with: node tests/srs.test.mjs
import assert from 'node:assert/strict';
import { schedule, newCardFields, dayStart, nextLabel, DAY, MIN } from '../js/srs.js';
import { Session, knownSigns } from '../js/study.js';

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

test('session: respects new-per-day and shows only one card per sign per day', () => {
  const cards = [];
  let id = 1;
  for (let s = 1; s <= 5; s++) for (const mode of ['video2word', 'word2video']) cards.push({ id: id++, deckId: 1, signId: s, mode, ...newCardFields() });
  const session = new Session([{ id: 1, name: 'A' }], cards, new Map(), 'both', now, { newPerDay: 3 });
  assert.equal(session.counts(now).newCount, 3);
  const first = session.next(now);
  assert.equal(first.signId, 1);
  assert.equal(first.mode, 'video2word');
});

test('session: learning card comes back after its delay', async () => {
  const cards = [{ id: 1, deckId: 1, signId: 1, mode: 'video2word', ...newCardFields() }];
  const s = new Session([{ id: 1, name: 'A' }], cards, new Map(), 'both', now, { newPerDay: 10 });
  const c = s.next(now);
  Object.assign(c, schedule(c, 1, now)); // Again
  assert.equal(s.next(now + 2 * MIN), c);
});

test('session: new-per-day limit is shared by all decks', () => {
  const cards = [];
  let id = 1;
  for (const deckId of [1, 2]) for (let s = 1; s <= 5; s++) cards.push({ id: id++, deckId, signId: deckId * 10 + s, mode: 'video2word', ...newCardFields() });
  const decks = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  assert.equal(new Session(decks, cards, new Map(), 'both', now, { newPerDay: 4 }).counts(now).newCount, 4);
  assert.equal(new Session(decks, cards, new Map(), 'both', now, { newPerDay: 4, introducedToday: 3 }).counts(now).newCount, 1);
});

test('known signs: last answer "Je sais" on every card seen', () => {
  const card = (signId, rating) => {
    const c = { signId, ...newCardFields() };
    return rating ? schedule(c, rating, now) : c;
  };
  const cards = [
    card(1, 3), card(1, 3),       // both right → known
    card(2, 3), card(2),          // one right, other not seen yet → known
    card(3, 3), card(3, 2),       // one Difficile → not known
    card(4, 1),                   // À revoir → not known
    card(5), card(5),             // never studied → not known
  ];
  assert.equal(knownSigns(cards), 2);
  // Older cards without lastRating count once graduated.
  assert.equal(knownSigns([{ signId: 9, state: 'review' }, { signId: 8, state: 'learning' }]), 1);
});

console.log(`\n${passed} tests passed`);
