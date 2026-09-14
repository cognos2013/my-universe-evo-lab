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
  loadBootChoice,
  saveBootChoice,
  clearBootChoice,
  STEP_META,
  STEP_COMPLETION,
  nextStepAfterCompletion,
  ALL_ONBOARDING_STEPS,
  ALL_ROLES,
  ROLE_META,
  BOOT_STORAGE_KEY,
  DEFAULT_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStep,
  type BootChoice,
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

// === PR-A: Boot choice (role / skipBasics) ===========================

test('loadBootChoice: cold start returns null', () => {
  installStorageShim();
  try {
    assert.equal(loadBootChoice(), null);
  } finally { restoreStorage(); }
});

test('saveBootChoice → loadBootChoice round-trip preserves all fields', () => {
  installStorageShim();
  try {
    const original: BootChoice = {
      role: 'middle',
      skipBasics: true,
      chosenAtMs: 1234.5,
    };
    saveBootChoice(original);
    const back = loadBootChoice();
    assert.ok(back, 'boot choice should round-trip');
    assert.equal(back!.role, 'middle');
    assert.equal(back!.skipBasics, true);
    assert.equal(back!.chosenAtMs, 1234.5);
  } finally { restoreStorage(); }
});

test('saveBootChoice uses the namespaced storage key', () => {
  installStorageShim();
  try {
    saveBootChoice({ role: 'high', skipBasics: false, chosenAtMs: 0 });
    assert.equal(shim.data.has(BOOT_STORAGE_KEY), true);
  } finally { restoreStorage(); }
});

test('loadBootChoice: unknown role falls back to null', () => {
  installStorageShim();
  try {
    shim.data.set(BOOT_STORAGE_KEY, JSON.stringify({
      role: 'principal', // not in the Role union
      skipBasics: false,
      chosenAtMs: 0,
    }));
    assert.equal(loadBootChoice(), null);
  } finally { restoreStorage(); }
});

test('loadBootChoice: non-boolean skipBasics falls back to null', () => {
  installStorageShim();
  try {
    shim.data.set(BOOT_STORAGE_KEY, JSON.stringify({
      role: 'elementary',
      skipBasics: 'yes', // wrong type
      chosenAtMs: 0,
    }));
    assert.equal(loadBootChoice(), null);
  } finally { restoreStorage(); }
});

test('loadBootChoice: missing chosenAtMs falls back to null', () => {
  installStorageShim();
  try {
    shim.data.set(BOOT_STORAGE_KEY, JSON.stringify({
      role: 'teacher',
      skipBasics: false,
      // chosenAtMs omitted
    }));
    assert.equal(loadBootChoice(), null);
  } finally { restoreStorage(); }
});

test('loadBootChoice: corrupt JSON falls back to null', () => {
  installStorageShim();
  try {
    shim.data.set(BOOT_STORAGE_KEY, '{not json');
    assert.equal(loadBootChoice(), null);
  } finally { restoreStorage(); }
});

test('clearBootChoice removes the persisted entry', () => {
  installStorageShim();
  try {
    saveBootChoice({ role: 'elementary', skipBasics: false, chosenAtMs: 1 });
    assert.ok(loadBootChoice());
    clearBootChoice();
    assert.equal(loadBootChoice(), null);
    assert.equal(shim.data.has(BOOT_STORAGE_KEY), false);
  } finally { restoreStorage(); }
});

test('ALL_ROLES lists all four roles in fixed order', () => {
  assert.deepEqual([...ALL_ROLES], ['elementary', 'middle', 'high', 'teacher']);
});

test('ROLE_META covers every role with non-empty fields', () => {
  for (const role of ALL_ROLES) {
    const meta = ROLE_META[role];
    assert.ok(meta, `role ${role} must have a meta entry`);
    assert.equal(typeof meta.label, 'string');
    assert.ok(meta.label.length > 0);
    assert.equal(typeof meta.tagline, 'string');
    assert.ok(meta.tagline.length > 0);
    assert.equal(typeof meta.audience, 'string');
    assert.ok(meta.audience.length > 0);
  }
});

// === PR-B: completion-criterion hooks ==============================

test('STEP_COMPLETION maps every step 1—5 to either a panel + next step or terminal', () => {
  for (const step of ALL_ONBOARDING_STEPS) {
    const entry = STEP_COMPLETION[step];
    assert.ok(entry, `step ${step} must have a completion entry`);
    if (step === 5) {
      assert.equal(entry.panel, null);
      assert.equal(entry.nextStep, null);
    } else {
      assert.equal(typeof entry.panel, 'string');
      assert.ok(entry.panel!.length > 0);
      assert.ok(entry.nextStep !== null, `step ${step} must auto-advance`);
      assert.ok((ALL_ONBOARDING_STEPS as readonly number[]).includes(entry.nextStep as number));
      // The completion step must move the user forward, not backward.
      assert.ok((entry.nextStep as number) > step);
    }
  }
});

test('nextStepAfterCompletion mirrors STEP_COMPLETION.nextStep', () => {
  for (const step of ALL_ONBOARDING_STEPS) {
    assert.equal(nextStepAfterCompletion(step), STEP_COMPLETION[step].nextStep);
  }
});

test('nextStepAfterCompletion returns null for the terminal step', () => {
  assert.equal(nextStepAfterCompletion(5), null);
});

test('nextStepAfterCompletion moves 1 → 2 → 3 → 4 → 5 in sequence', () => {
  // Walking through the wizard, each step should hand off to
  // the next one. This is the chain `maybeAdvanceFromExploreClose`
  // follows at runtime.
  const path: OnboardingStep[] = [1];
  let cur: OnboardingStep = 1;
  while (true) {
    const next = nextStepAfterCompletion(cur);
    if (next === null) break;
    path.push(next);
    cur = next;
  }
  assert.deepEqual(path, [1, 2, 3, 4, 5]);
});

test('advanceOnboardingState marks prior steps as completed when advancing', () => {
  // Simulate the user closing the cosmos panel after step 1.
  const after1 = advanceOnboardingState(DEFAULT_ONBOARDING_STATE, 2);
  assert.ok(after1.completedSteps.includes(1));
  assert.ok(after1.completedSteps.includes(2));
  assert.equal(after1.step, 2);
});

test('advanceOnboardingState preserves the prior finishedAtMs across subsequent steps', () => {
  // Reaching step 5 sets finishedAtMs. Jumping back to step 3
  // (e.g. via the progress bar) must not clear it.
  const reached5 = advanceOnboardingState(DEFAULT_ONBOARDING_STATE, 5);
  assert.ok(reached5.finishedAtMs !== null);
  const back = advanceOnboardingState(reached5, 3);
  assert.equal(back.finishedAtMs, reached5.finishedAtMs);
});
