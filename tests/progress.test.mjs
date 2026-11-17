// Run with: node tests/progress.test.mjs
import assert from 'node:assert/strict';
import {
  weight, applyAnswer, drawSigns, isKnown, emptyProgress, fromLegacyCards, masteryOf, level,
  AGAIN, HARD, GOOD, START_MASTERY,
} from '../js/progress.js';
import { RandomSession, knownSigns, levelSplit } from '../js/study.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`✓ ${name}`); };

/** Deterministic random numbers in [0, 1). */
function seeded(seed = 1) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const answers = (...ratings) => ratings.reduce((p, r) => applyAnswer(p, r, 1), emptyProgress());
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

await test('score: starts at 0.3, Je sais +0.1, Difficile +0, À revoir −0.2, kept between 0 and 1', () => {
  assert.equal(masteryOf(emptyProgress()), START_MASTERY);
  assert.equal(masteryOf(answers(GOOD)), 0.4);
  assert.equal(masteryOf(answers(HARD)), 0.3);
  assert.equal(masteryOf(answers(AGAIN)), 0.1);
  assert.equal(masteryOf(answers(AGAIN, AGAIN, AGAIN)), 0);
  assert.equal(masteryOf(answers(...Array(12).fill(GOOD))), 1);
  // Example: 0.3 → 0.4 → 0.2 → 0.3 → 0.3 → 0.4
  assert.equal(masteryOf(answers(GOOD, AGAIN, GOOD, HARD, GOOD)), 0.4);
});

await test('connu from 0.8: five Je sais from new, not necessarily in a row', () => {
  assert.equal(isKnown(answers(GOOD, GOOD, GOOD, GOOD)), false);
  assert.equal(isKnown(answers(GOOD, GOOD, GOOD, GOOD, GOOD)), true);
  assert.equal(isKnown(answers(GOOD, GOOD, HARD, GOOD, GOOD, GOOD)), true);
  assert.equal(isKnown(applyAnswer(answers(GOOD, GOOD, GOOD, GOOD, GOOD), AGAIN)), false);
});

await test('weights: (1.1 − score)², never 0', () => {
  close(weight({ mastery: 0 }), 1.21);
  close(weight(emptyProgress()), 0.64);
  close(weight({ mastery: 0.8 }), 0.09);
  close(weight({ mastery: 1 }), 0.01);
});

await test('old progress is converted from the last answer', () => {
  assert.equal(masteryOf({ lastRating: null }), 0.3);
  assert.equal(masteryOf({ lastRating: HARD, streak: 0 }), 0.3);
  assert.equal(masteryOf({ lastRating: AGAIN, streak: 0 }), 0.2);
  assert.equal(masteryOf({ lastRating: GOOD, streak: 2 }), 0.5);
  assert.equal(masteryOf({ lastRating: GOOD, streak: 9 }), 0.8);
  // The next answer continues from the converted score.
  assert.equal(masteryOf(applyAnswer({ lastRating: GOOD, streak: 2, reviews: 2, lastReview: 1 }, GOOD)), 0.6);
});

await test('bar colour: known ≥ 0.8, weak < 0.3, in progress between, grey if never seen', () => {
  assert.equal(level(emptyProgress()), 'unseen');
  assert.equal(level(answers(AGAIN)), 'weak');
  assert.equal(level(answers(HARD)), 'learning');
  assert.equal(level(answers(GOOD)), 'learning');
  assert.equal(level(answers(GOOD, GOOD, GOOD, GOOD, GOOD)), 'known');
  const signs = [{}, {}, { progress: answers(AGAIN) }, { progress: answers(GOOD) }, { progress: answers(GOOD, GOOD, GOOD, GOOD, GOOD) }];
  assert.deepEqual(levelSplit(signs), { known: 1, learning: 1, weak: 1, unseen: 2 });
  assert.equal(knownSigns(signs), 1);
});

await test('draw: distinct signs, at most n, everything when n ≥ count', () => {
  const signs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
  const picked = drawSigns(signs, 20, seeded(7));
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked.map((s) => s.id)).size, 20);
  assert.equal(drawSigns(signs.slice(0, 5), 20, seeded(7)).length, 5);
});

await test('draw: probability follows the weights (mastered signs still get drawn)', () => {
  const signs = [
    { id: 'max', progress: { mastery: 1 } },     // 0.01
    { id: 'known', progress: { mastery: 0.8 } }, // 0.09
    { id: 'new' },                               // 0.64
    { id: 'weak', progress: { mastery: 0 } },    // 1.21
  ];
  const total = 0.01 + 0.09 + 0.64 + 1.21;
  const rng = seeded(42);
  const hits = Object.fromEntries(signs.map((s) => [s.id, 0]));
  const N = 60000;
  for (let i = 0; i < N; i++) hits[drawSigns(signs, 1, rng)[0].id]++;
  for (const [id, w] of [['max', 0.01], ['known', 0.09], ['new', 0.64], ['weak', 1.21]]) {
    assert.ok(Math.abs(hits[id] / N - w / total) < 0.012, `${id}: ${hits[id] / N} vs ${w / total}`);
  }
  assert.ok(hits.max > 0);
});

await test('random session: each sign once, wrong answers do not come back, score saved', async () => {
  const signs = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, deckId: 1, name: `S${i + 1}` }));
  const saved = [];
  const save = async (id, patch) => saved.push([id, patch]);
  const s = new RandomSession([{ id: 1, name: 'A' }], signs, 'both', 20, seeded(3));
  const seen = [];
  for (let item; (item = s.next()); ) {
    seen.push(item.signId);
    await s.answer(item, AGAIN, 1, save);
  }
  assert.equal(new Set(seen).size, 5);
  assert.equal(seen.length, 5);
  assert.equal(saved.length, 5);
  assert.ok(saved.every(([, p]) => p.progress.mastery === 0.1 && !('srs' in p)));
});

await test('random session: size limit, fixed direction, undo restores progress', async () => {
  const signs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, deckId: 1, name: `S${i + 1}` }));
  const s = new RandomSession([{ id: 1, name: 'A' }], signs, 'word2video', 3, seeded(5));
  assert.equal(s.queue.length, 3);
  assert.ok(s.queue.every((q) => q.mode === 'word2video'));
  const first = s.next();
  await s.answer(first, GOOD, 1, async () => {});
  assert.equal(s.signs.get(first.signId).progress.mastery, 0.4);
  assert.equal(await s.undo(async () => {}), first);
  assert.equal(s.signs.get(first.signId).progress, undefined);
  assert.equal(s.next(), first);
});

await test('migration from the old per-direction cards uses the most recent answer', () => {
  assert.deepEqual(fromLegacyCards([]), emptyProgress());
  const p = fromLegacyCards([
    { lastReview: 100, lastRating: 1, reps: 2 },
    { lastReview: 200, lastRating: 3, reps: 1 },
  ]);
  assert.deepEqual(p, { mastery: 0.4, lastRating: GOOD, streak: 1, reviews: 3, lastReview: 200 });
  assert.equal(fromLegacyCards([{ lastReview: 5, state: 'relearning', reps: 3 }]).lastRating, HARD);
  assert.equal(fromLegacyCards([{ lastReview: 5, lastRating: 4, reps: 1 }]).lastRating, GOOD);
});

console.log(`\n${passed} tests passed`);
