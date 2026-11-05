// Run with: node tests/progress.test.mjs
import assert from 'node:assert/strict';
import { weight, applyAnswer, drawSigns, isKnown, emptyProgress, fromLegacyCards, AGAIN, HARD, GOOD } from '../js/progress.js';
import { Session, knownSigns } from '../js/study.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`✓ ${name}`); };

/** Deterministic random numbers in [0, 1). */
function seeded(seed = 1) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const answers = (...ratings) => ratings.reduce((p, r) => applyAnswer(p, r, 0), emptyProgress());

await test('weights: known 1, new or Je sais 2, Difficile 3, À revoir 4', () => {
  assert.equal(weight(emptyProgress()), 2);
  assert.equal(weight(undefined), 2);
  assert.equal(weight(answers(GOOD)), 2);
  assert.equal(weight(answers(HARD)), 3);
  assert.equal(weight(answers(AGAIN)), 4);
  assert.equal(weight(answers(GOOD, GOOD, GOOD, GOOD, GOOD)), 2); // 5 in a row: not yet known
  assert.equal(weight(answers(GOOD, GOOD, GOOD, GOOD, GOOD, GOOD)), 1); // 6th: known
});

await test('known needs more than 5 "Je sais" in a row; a mistake resets the count', () => {
  const six = answers(GOOD, GOOD, GOOD, GOOD, GOOD, GOOD);
  assert.equal(isKnown(six), true);
  assert.equal(isKnown(applyAnswer(six, HARD)), false);
  assert.equal(isKnown(answers(GOOD, GOOD, GOOD, AGAIN, GOOD, GOOD, GOOD)), false);
  assert.equal(answers(GOOD, AGAIN, GOOD).streak, 1);
  assert.equal(answers(GOOD, AGAIN, GOOD).reviews, 3);
});

await test('draw: distinct signs, at most n, everything when n ≥ count', () => {
  const signs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
  const picked = drawSigns(signs, 20, seeded(7));
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked.map((s) => s.id)).size, 20);
  assert.equal(drawSigns(signs.slice(0, 5), 20, seeded(7)).length, 5);
});

await test('draw: probability follows the weights (also known signs still get drawn)', () => {
  const signs = [
    { id: 'known', progress: answers(GOOD, GOOD, GOOD, GOOD, GOOD, GOOD) }, // 1
    { id: 'new' },                                                          // 2
    { id: 'hard', progress: answers(HARD) },                                // 3
    { id: 'again', progress: answers(AGAIN) },                              // 4
  ];
  const rng = seeded(42);
  const hits = Object.fromEntries(signs.map((s) => [s.id, 0]));
  const N = 40000;
  for (let i = 0; i < N; i++) hits[drawSigns(signs, 1, rng)[0].id]++;
  for (const [id, w] of [['known', 1], ['new', 2], ['hard', 3], ['again', 4]]) {
    assert.ok(Math.abs(hits[id] / N - w / 10) < 0.015, `${id}: ${hits[id] / N} vs ${w / 10}`);
  }
});

await test('session: each sign once, wrong answers do not come back, progress saved', async () => {
  const signs = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, deckId: 1, name: `S${i + 1}` }));
  const saved = [];
  const save = async (id, p) => saved.push([id, p]);
  const s = new Session([{ id: 1, name: 'A' }], signs, 'both', 20, seeded(3));
  assert.equal(s.remaining(), 5);
  const seen = [];
  for (let item; (item = s.next()); ) {
    seen.push(item.signId);
    assert.ok(['video2word', 'word2video'].includes(item.mode));
    await s.answer(item, AGAIN, 0, save);
  }
  assert.equal(new Set(seen).size, 5);
  assert.equal(seen.length, 5);
  assert.equal(s.remaining(), 0);
  assert.equal(saved.length, 5);
  assert.ok(saved.every(([, p]) => p.lastRating === AGAIN && weight(p) === 4));
});

await test('session: size limit, fixed direction, undo restores progress', async () => {
  const signs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, deckId: 1, name: `S${i + 1}` }));
  const s = new Session([{ id: 1, name: 'A' }], signs, 'word2video', 3, seeded(5));
  assert.equal(s.queue.length, 3);
  assert.ok(s.queue.every((q) => q.mode === 'word2video'));
  const first = s.next();
  await s.answer(first, GOOD, 0, async () => {});
  assert.equal(s.signs.get(first.signId).progress.streak, 1);
  assert.equal(await s.undo(async () => {}), first);
  assert.equal(s.signs.get(first.signId).progress, undefined);
  assert.equal(s.next(), first);
});

await test('known signs count', () => {
  const known = { progress: answers(GOOD, GOOD, GOOD, GOOD, GOOD, GOOD) };
  assert.equal(knownSigns([known, {}, { progress: answers(GOOD) }]), 1);
});

await test('migration from the old per-direction cards uses the most recent answer', () => {
  assert.deepEqual(fromLegacyCards([]), emptyProgress());
  assert.deepEqual(fromLegacyCards([{ state: 'new', reps: 0, lastReview: null }]), emptyProgress());
  const p = fromLegacyCards([
    { lastReview: 100, lastRating: 1, reps: 2 },
    { lastReview: 200, lastRating: 3, reps: 1 },
  ]);
  assert.deepEqual(p, { lastRating: GOOD, streak: 1, reviews: 3, lastReview: 200 });
  // Cards from before lastRating was stored.
  assert.equal(fromLegacyCards([{ lastReview: 5, state: 'review', reps: 3 }]).lastRating, GOOD);
  assert.equal(fromLegacyCards([{ lastReview: 5, state: 'relearning', reps: 3 }]).lastRating, HARD);
  // Old "Easy" (4) counts as Je sais.
  assert.equal(fromLegacyCards([{ lastReview: 5, lastRating: 4, reps: 1 }]).lastRating, GOOD);
});

console.log(`\n${passed} tests passed`);
