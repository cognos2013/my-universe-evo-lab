import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tsCore, type SimCore } from '../src/simulation/core-adapter.ts';

/**
 * The core-adapter is a thin seam for a future WASM build. Today
 * it just re-exports the TS functions. These tests confirm the
 * surface stays consistent (functions are present, types match)
 * so a future Rust implementation can drop in without changing
 * the worker.
 */
test('tsCore exposes the three SimCore methods', () => {
  const methods: (keyof SimCore)[] = ['stepWorld', 'stepGalaxies', 'stepReactor'];
  for (const m of methods) {
    assert.equal(typeof tsCore[m], 'function', `tsCore.${m} should be a function`);
  }
});

test('SimCore is a structural interface, not a class', () => {
  // A plain object literal should satisfy SimCore at the type
  // level. The actual runtime conformance is enforced by the
  // unit tests of each underlying function.
  const fake: SimCore = {
    stepWorld: async () => { throw new Error('not implemented'); },
    stepGalaxies: () => { throw new Error('not implemented'); },
    stepReactor: () => { throw new Error('not implemented'); },
  };
  assert.equal(typeof fake.stepWorld, 'function');
  assert.equal(typeof fake.stepGalaxies, 'function');
  assert.equal(typeof fake.stepReactor, 'function');
});
