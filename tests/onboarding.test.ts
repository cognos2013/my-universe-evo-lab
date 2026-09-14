/**
 * Onboarding 5-step state machine tests.
 *
 * The state machine lives in `src/app/onboarding.ts` and is
 * shared between the main UI and the progress bar. The tests
 * cover:
 *
 *  - default state
 *  - `loadOnboardingState` / `saveOnboardingState` round-trip
 *    via `localStorage` (with an in-memory shim)
 *  - sanitising corrupt / unknown input
 *  - `advanceOnboardingState` is idempotent + monotonic
 *  - `advanceOnboardingState(5)` stamps `finishedAtMs`
 *  - `isStepReachable` enforces the "must complete the previous
 *    step" rule
 *  - `STEP_META` covers all 5 steps
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadOnboardingState,
  saveOnboardingState,
  advanceOnboardingState,
  isStepReachable,
  STEP_META,
  ALL_ONBOARDING_STEPS,
  DEFAULT_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStep,
} from '../src/app/onboarding.ts';

// === Storage shim ====================================================

/**
 * `localStorage` is a browser-only global. We replace it with an
 * in-memory shim so the unit tests run in plain Node. The shim
 * is restored after every test to keep parallel tests isolated.
 */
type StorageShim = { data: Map<string, string>; original: Storage | undefined };
const shim: StorageShim = { data: new Map(), original: undefined };
function installStorageShim() {
  shim.original = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => shim.data.get(k) ?? null,
    setItem: (k: string, v: string) => { shim.data.set(k, v); },
    removeItem: (k: string) => { shim.data.delete(k); },
    clear: () => { shim.data.clear(); },
    key: (i: number) => Array.from(shim.data.keys())[i] ?? null,
    get length() { return shim.data.size; },
  };
}
function restoreStorage() {
  (globalThis as { localStorage?: Storage | undefined }).localStorage = shim.original;
  shim.data.clear();
}

test('default state is step 1 with no completed steps and no finish time', () => {
  installStorageShim();
  try {
    const s = loadOnboardingState();
    assert.equal(s.step, 1);
    assert.equal(s.completedSteps.length, 0);
    assert.equal(s.finishedAtMs, null);
  } finally { restoreStorage(); }
});

test('save → load round-trip preserves all three fields', () => {
  installStorageShim();
  try {
    const original: OnboardingState = {
      step: 3,
      completedSteps: [1, 2],
      finishedAtMs: null,
    };
    saveOnboardingState(original);
    const back = loadOnboardingState();
    assert.equal(back.step, 3);
    assert.deepEqual(back.completedSteps, [1, 2]);
    assert.equal(back.finishedAtMs, null);
  } finally { restoreStorage(); }
});

test('corrupt JSON in localStorage falls back to default', () => {
  installStorageShim();
  try {
    shim.data.set('my-universe-onboarding-v1', '{not json');
    const s = loadOnboardingState();
    assert.deepEqual(s, DEFAULT_ONBOARDING_STATE);
  } finally { restoreStorage(); }
});

test('unknown fields in stored JSON are dropped', () => {
  installStorageShim();
  try {
    shim.data.set('my-universe-onboarding-v1', JSON.stringify({
      step: 4,
      completedSteps: [1, 2, 3, 9], // 9 is invalid
      finishedAtMs: 1234,
      extraneous: 'ignore me',
    }));
    const s = loadOnboardingState();
    assert.equal(s.step, 4);
    assert.deepEqual(s.completedSteps, [1, 2, 3], 'invalid completed steps are filtered out');
    assert.equal(s.finishedAtMs, 1234);
  } finally { restoreStorage(); }
});

test('advanceOnboardingState is idempotent on the same step', () => {
  const s0: OnboardingState = { step: 2, completedSteps: [1], finishedAtMs: null };
  const s1 = advanceOnboardingState(s0, 2);
  assert.equal(s1.step, 2);
  assert.deepEqual(s1.completedSteps, [1]);
});

test('advanceOnboardingState marks every step ≤ target as completed', () => {
  const s0: OnboardingState = { step: 1, completedSteps: [], finishedAtMs: null };
  const s3 = advanceOnboardingState(s0, 3);
  assert.equal(s3.step, 3);
  assert.deepEqual(s3.completedSteps, [1, 2, 3]);
});

test('advanceOnboardingState(5) stamps finishedAtMs the first time', () => {
  const s0: OnboardingState = { step: 1, completedSteps: [], finishedAtMs: null };
  const s5 = advanceOnboardingState(s0, 5);
  assert.equal(s5.step, 5);
  assert.equal(s5.finishedAtMs !== null, true);
  // Advancing again does NOT overwrite the original finish time.
  const s5Again = advanceOnboardingState(s5, 5);
  assert.equal(s5Again.finishedAtMs, s5.finishedAtMs);
});

test('isStepReachable: target == current is always reachable', () => {
  const s: OnboardingState = { step: 3, completedSteps: [1, 2], finishedAtMs: null };
  assert.equal(isStepReachable(s, 3), true);
});

test('isStepReachable: target in completedSteps is reachable', () => {
  const s: OnboardingState = { step: 4, completedSteps: [1, 2, 3], finishedAtMs: null };
  assert.equal(isStepReachable(s, 1), true);
  assert.equal(isStepReachable(s, 2), true);
  assert.equal(isStepReachable(s, 3), true);
});

test('isStepReachable: skipping ahead is blocked when not yet completed', () => {
  const s: OnboardingState = { step: 1, completedSteps: [], finishedAtMs: null };
  assert.equal(isStepReachable(s, 3), false);
  assert.equal(isStepReachable(s, 5), false);
  // But the immediate next step is reachable.
  assert.equal(isStepReachable(s, 2), true);
});

test('isStepReachable: a state with completedSteps 1—3 lets the user click 4 but not 5', () => {
  const s: OnboardingState = { step: 3, completedSteps: [1, 2, 3], finishedAtMs: null };
  assert.equal(isStepReachable(s, 4), true);
  assert.equal(isStepReachable(s, 5), false);
});

test('STEP_META covers all 5 steps with required fields', () => {
  for (const step of ALL_ONBOARDING_STEPS) {
    const meta = STEP_META[step];
    assert.ok(meta, `step ${step} must have a meta entry`);
    assert.equal(typeof meta.eyebrow, 'string');
    assert.ok(meta.eyebrow.length > 0);
    assert.equal(typeof meta.title, 'string');
    assert.ok(meta.title.length > 0);
    assert.equal(typeof meta.body, 'string');
    assert.ok(meta.body.length > 0);
    assert.ok(['cosmos', 'galaxies', 'create', 'play'].includes(meta.cta.action));
  }
});

test('ALL_ONBOARDING_STEPS lists 1—5 in order', () => {
  assert.deepEqual([...ALL_ONBOARDING_STEPS], [1, 2, 3, 4, 5]);
});
