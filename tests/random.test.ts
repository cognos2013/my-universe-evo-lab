import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RandomStream, createRandomStream } from '../src/simulation/core/random.ts';
import { RNG_ALGORITHM } from '../src/simulation/core/contracts.ts';
import { canonicalJson, sha256 } from '../src/simulation/core/canonical.ts';

test('xoshiro128** matches the reference transition vector for state 1,2,3,4', () => {
  const rng = new RandomStream({ algorithm: RNG_ALGORITHM, state: [1, 2, 3, 4] });
  assert.deepEqual(Array.from({ length: 5 }, () => rng.nextUint32()), [11520, 0, 5927040, 70819200, 2031721883]);
});

test('snapshot resumes exactly without sharing mutable state', async () => {
  const a = await createRandomStream('宇宙', 'birth', 'cohort-1', 5);
  for (let i = 0; i < 20; i++) a.next();
  const snapshot = a.snapshot();
  const b = new RandomStream(snapshot);
  snapshot.state[0] = 0;
  for (let i = 0; i < 100; i++) assert.equal(a.nextUint32(), b.nextUint32());
});

test('same coordinates reproduce; different channels do not consume each other', async () => {
  const a = await createRandomStream('seed', 'birth', 'c1', 1);
  const noise = await createRandomStream('seed', 'death', 'c1', 1);
  const b = await createRandomStream('seed', 'birth', 'c1', 1);
  assert.notDeepEqual(a.snapshot(), noise.snapshot());
  for (let i = 0; i < 100; i++) { noise.next(); assert.equal(a.next(), b.next()); }
  const c = await createRandomStream('other-seed', 'birth', 'c1', 1);
  assert.notDeepEqual(c.snapshot(), b.snapshot());
});

test('random samples remain in [0, 1), invalid states rejected', () => {
  const r = new RandomStream({ algorithm: RNG_ALGORITHM, state: [1, 2, 3, 4] });
  for (let i = 0; i < 10000; i++) { const x = r.next(); assert.ok(x >= 0 && x < 1); }
  for (const state of [[0, 0, 0, 0], [-1, 1, 1, 1], [0.5, 1, 1, 1], [2 ** 32, 1, 1, 1]]) {
    assert.throws(() => new RandomStream({ algorithm: RNG_ALGORITHM, state: state as [number, number, number, number] }));
  }
});

test('canonical hashes ignore key insertion order, reject lossy values', async () => {
  assert.equal(await sha256({ b: 2, a: 1 }), await sha256({ a: 1, b: 2 }));
  assert.notEqual(await sha256({ a: 1 }), await sha256({ a: 2 }));
  for (const invalid of [NaN, Infinity, undefined, { a: undefined }, new Float64Array([1]), Array(2)]) {
    assert.throws(() => canonicalJson(invalid));
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /cyclic/);
});
