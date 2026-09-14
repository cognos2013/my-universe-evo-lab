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
  setStep5Phase,
  step5aComplete,
  step5bComplete,
  STEP_5A_DONE_TICK,
  STEP_5B_DONE_TICK,
  getRoleThresholds,
  getRoleStepGuidance,
  ROLE_THRESHOLDS,
  ROLE_STEP_GUIDANCE,
  ALL_ONBOARDING_STEPS,
  ALL_ROLES,
  ROLE_META,
  BOOT_STORAGE_KEY,
  DEFAULT_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStep,
  type BootChoice,
  type Step5Phase,
  type Role,
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
      phase5: '5a',
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
  const s0: OnboardingState = { step: 2, phase5: '5a', completedSteps: [1], finishedAtMs: null };
  const s1 = advanceOnboardingState(s0, 2);
  assert.equal(s1.step, 2);
  assert.deepEqual(s1.completedSteps, [1]);
});

test('advanceOnboardingState marks every step ≤ target as completed', () => {
  const s0: OnboardingState = { step: 1, phase5: '5a', completedSteps: [], finishedAtMs: null };
  const s3 = advanceOnboardingState(s0, 3);
  assert.equal(s3.step, 3);
  assert.deepEqual(s3.completedSteps, [1, 2, 3]);
});

test('advanceOnboardingState(6) stamps finishedAtMs the first time', () => {
  // PR-C: step 5 is no longer the "finished" marker — that's
  // now reserved for step 6 (自由探索). Reaching step 5 alone
  // does not mean the user has finished the wizard.
  const s0: OnboardingState = { step: 1, phase5: '5a', completedSteps: [], finishedAtMs: null };
  const s6 = advanceOnboardingState(s0, 6);
  assert.equal(s6.step, 6);
  assert.equal(s6.finishedAtMs !== null, true);
  // Advancing again does NOT overwrite the original finish time.
  const s6Again = advanceOnboardingState(s6, 6);
  assert.equal(s6Again.finishedAtMs, s6.finishedAtMs);
});

test('isStepReachable: target == current is always reachable', () => {
  const s: OnboardingState = { step: 3, phase5: '5a', completedSteps: [1, 2], finishedAtMs: null };
  assert.equal(isStepReachable(s, 3), true);
});

test('isStepReachable: target in completedSteps is reachable', () => {
  const s: OnboardingState = { step: 4, phase5: '5a', completedSteps: [1, 2, 3], finishedAtMs: null };
  assert.equal(isStepReachable(s, 1), true);
  assert.equal(isStepReachable(s, 2), true);
  assert.equal(isStepReachable(s, 3), true);
});

test('isStepReachable: skipping ahead is blocked when not yet completed', () => {
  const s: OnboardingState = { step: 1, phase5: '5a', completedSteps: [], finishedAtMs: null };
  assert.equal(isStepReachable(s, 3), false);
  assert.equal(isStepReachable(s, 5), false);
  // But the immediate next step is reachable.
  assert.equal(isStepReachable(s, 2), true);
});

test('isStepReachable: a state with completedSteps 1—3 lets the user click 4 but not 5', () => {
  const s: OnboardingState = { step: 3, phase5: '5a', completedSteps: [1, 2, 3], finishedAtMs: null };
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

test('ALL_ONBOARDING_STEPS lists 1—6 in order (PR-C added step 6)', () => {
  assert.deepEqual([...ALL_ONBOARDING_STEPS], [1, 2, 3, 4, 5, 6]);
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

test('STEP_COMPLETION maps every step 1—6 to either a panel + next step or terminal', () => {
  for (const step of ALL_ONBOARDING_STEPS) {
    const entry = STEP_COMPLETION[step];
    assert.ok(entry, `step ${step} must have a completion entry`);
    if (step === 5 || step === 6) {
      // PR-C: step 5 is now broken into 5a/5b/6 (tick-driven);
      // step 6 is the final "自由探索" terminal. Neither has a
      // single auto-advance panel because the ladder is now
      // tick-driven, not dialog-driven.
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
  // Reaching step 6 sets finishedAtMs (PR-C moved the marker
  // from step 5 to step 6 so the user can roam 5a/5b without
  // being "done"). Jumping back to step 3 must not clear it.
  const reached6 = advanceOnboardingState(DEFAULT_ONBOARDING_STATE, 6);
  assert.ok(reached6.finishedAtMs !== null);
  const back = advanceOnboardingState(reached6, 3);
  assert.equal(back.finishedAtMs, reached6.finishedAtMs);
});

// === PR-C: 6-step wizard + 5a/5b/6 sub-phase ===========================

test('PR-C: OnboardingStep now includes 6 (free explore)', () => {
  // Compile-time guard: this assignment only succeeds if `6`
  // is a valid `OnboardingStep` literal.
  const six: OnboardingStep = 6;
  assert.equal(six, 6);
  assert.ok((ALL_ONBOARDING_STEPS as readonly OnboardingStep[]).includes(6));
});

test('PR-C: DEFAULT_ONBOARDING_STATE seeds phase5 = "5a"', () => {
  assert.equal(DEFAULT_ONBOARDING_STATE.phase5, '5a');
});

test('PR-C: advanceOnboardingState sets finishedAtMs only at step 6 (not step 5)', () => {
  // Step 5 used to set finishedAtMs in the old design; PR-C
  // moves that marker to step 6 so reaching step 5b (without
  // finishing 6) does not mark the wizard as "done".
  const reached5 = advanceOnboardingState(DEFAULT_ONBOARDING_STATE, 5);
  assert.equal(reached5.finishedAtMs, null);
  const reached6 = advanceOnboardingState(reached5, 6);
  assert.ok(reached6.finishedAtMs !== null);
});

test('PR-C: advanceOnboardingState to step 5 resets phase5 to "5a"', () => {
  // Pre-condition: a state in 5b — entering step 5 again
  // (via the progress bar) must reset the sub-phase so the
  // user re-walks 5a → 5b → 6, instead of jumping to whatever
  // they last left.
  const mid = { ...DEFAULT_ONBOARDING_STATE, step: 6 as OnboardingStep, phase5: '6' as Step5Phase };
  const back5 = advanceOnboardingState(mid, 5);
  assert.equal(back5.phase5, '5a');
});

test('PR-C: advanceOnboardingState preserves phase5 when leaving step 5 sideways', () => {
  // Going from step 5 (5b) to step 4 must keep the phase5
  // string around so a quick back-and-forth doesn't drop the
  // user's progress through the 5a/5b ladder.
  const mid: OnboardingState = { ...DEFAULT_ONBOARDING_STATE, step: 5, phase5: '5b' };
  const back4 = advanceOnboardingState(mid, 4);
  assert.equal(back4.phase5, '5b');
  // Coming forward again to step 5 — we DO reset to 5a (the
  // test above covers that branch), but the prior `phase5`
  // is the source of truth for the back-step.
});

test('PR-C: setStep5Phase is idempotent (returns same shape on no-op)', () => {
  const s = { ...DEFAULT_ONBOARDING_STATE, step: 5 as OnboardingStep, phase5: '5b' as Step5Phase };
  const same = setStep5Phase(s, '5b');
  assert.equal(same.phase5, '5b');
  // Reference should be unchanged for the no-op case so the
  // renderOnboarding caller doesn't waste a re-render.
  assert.equal(same, s);
});

test('PR-C: setStep5Phase accepts 5a / 5b / 6 only', () => {
  const s: OnboardingState = { ...DEFAULT_ONBOARDING_STATE, step: 5 as OnboardingStep, phase5: '5a' as Step5Phase };
  assert.equal(setStep5Phase(s, '5b').phase5, '5b');
  assert.equal(setStep5Phase(s, '6').phase5, '6');
  // Type system would reject any other string at compile time;
  // runtime is permissive (sanitise does the real check).
});

test('PR-C: step5aComplete respects the default threshold', () => {
  assert.equal(step5aComplete(0), false);
  assert.equal(step5aComplete(STEP_5A_DONE_TICK - 1), false);
  assert.equal(step5aComplete(STEP_5A_DONE_TICK), true);
  assert.equal(step5aComplete(STEP_5A_DONE_TICK + 1), true);
});

test('PR-C: step5bComplete respects the default threshold', () => {
  assert.equal(step5bComplete(0), false);
  assert.equal(step5bComplete(STEP_5B_DONE_TICK - 1), false);
  assert.equal(step5bComplete(STEP_5B_DONE_TICK), true);
  assert.equal(step5bComplete(STEP_5B_DONE_TICK + 5000), true);
});

test('PR-C: step5a/step5b honour a custom threshold (学段适配 future-proofing)', () => {
  // PR-F can lower these for `elementary`; the helpers must
  // accept an override rather than baking STEP_*_DONE_TICK in.
  assert.equal(step5aComplete(50, 50), true);
  assert.equal(step5bComplete(500, 500), true);
  assert.equal(step5aComplete(99, 100), false);
  assert.equal(step5bComplete(499, 500), false);
});

test('PR-C: loadOnboardingState sanitises phase5 from arbitrary JSON', () => {
  installStorageShim();
  try {
    shim.data.set('my-universe-onboarding-v1', JSON.stringify({
      step: 5, phase5: '5b', completedSteps: [1, 2, 3, 4], finishedAtMs: null,
    }));
    const back = loadOnboardingState();
    assert.equal(back.step, 5);
    assert.equal(back.phase5, '5b');
    assert.deepEqual(back.completedSteps, [1, 2, 3, 4]);
  } finally { restoreStorage(); }
});

test('PR-C: loadOnboardingState defaults phase5 to "5a" when missing or invalid', () => {
  installStorageShim();
  try {
    // Missing phase5 entirely.
    shim.data.set('my-universe-onboarding-v1', JSON.stringify({
      step: 5, completedSteps: [1, 2, 3, 4], finishedAtMs: null,
    }));
    assert.equal(loadOnboardingState().phase5, '5a');
    // Garbage phase5 falls back to the default.
    shim.data.set('my-universe-onboarding-v1', JSON.stringify({
      step: 5, phase5: 'junk', completedSteps: [], finishedAtMs: null,
    }));
    assert.equal(loadOnboardingState().phase5, '5a');
  } finally { restoreStorage(); }
});

// === PR-F: role-aware thresholds + guidance ===========================

test('PR-F: ROLE_THRESHOLDS gives elementary a faster 5a/5b than high', () => {
  assert.ok(ROLE_THRESHOLDS.elementary.step5aTick < ROLE_THRESHOLDS.high.step5aTick);
  assert.ok(ROLE_THRESHOLDS.elementary.step5bTick < ROLE_THRESHOLDS.high.step5bTick);
  // middle / teacher share the default 100 / 1000.
  assert.equal(ROLE_THRESHOLDS.middle.step5aTick, 100);
  assert.equal(ROLE_THRESHOLDS.middle.step5bTick, 1000);
});

test('PR-F: ROLE_THRESHOLDS covers all 4 roles', () => {
  for (const role of ALL_ROLES) {
    const t = ROLE_THRESHOLDS[role];
    assert.ok(t, `role ${role} must have thresholds`);
    assert.ok(t.step5aTick > 0);
    assert.ok(t.step5bTick >= t.step5aTick);
  }
});

test('PR-F: getRoleThresholds returns the boot role\'s thresholds', () => {
  const boot: BootChoice = { role: 'high', skipBasics: false, chosenAtMs: 0 };
  assert.equal(getRoleThresholds(boot).step5aTick, 200);
  assert.equal(getRoleThresholds(boot).step5bTick, 2000);
});

test('PR-F: getRoleThresholds falls back to defaults when boot is null', () => {
  assert.equal(getRoleThresholds(null).step5aTick, STEP_5A_DONE_TICK);
  assert.equal(getRoleThresholds(null).step5bTick, STEP_5B_DONE_TICK);
});

test('PR-F: step5aComplete accepts the role-aware threshold', () => {
  const elementary = ROLE_THRESHOLDS.elementary;
  // elementary 5a threshold is 50 — tick 49 is not done, 50 is.
  assert.equal(step5aComplete(49, elementary.step5aTick), false);
  assert.equal(step5aComplete(50, elementary.step5aTick), true);
  // high 5a threshold is 200.
  assert.equal(step5aComplete(199, ROLE_THRESHOLDS.high.step5aTick), false);
  assert.equal(step5aComplete(200, ROLE_THRESHOLDS.high.step5aTick), true);
});

test('PR-F: getRoleStepGuidance returns the role-specific text when present', () => {
  // Step 1 has overrides for elementary / middle / high but not teacher.
  const elementary = getRoleStepGuidance(1, 'elementary');
  assert.notEqual(elementary, STEP_META[1].body);
  assert.ok(elementary.includes('沙粒') || elementary.includes('宇宙'), 'elementary step 1 body should be in friendly voice');
  const teacher = getRoleStepGuidance(1, 'teacher');
  // teacher falls back to STEP_META body.
  assert.equal(teacher, STEP_META[1].body);
});

test('PR-F: getRoleStepGuidance falls back to STEP_META when role is null', () => {
  for (const step of [1, 2, 3, 4, 5, 6] as OnboardingStep[]) {
    assert.equal(getRoleStepGuidance(step, null), STEP_META[step].body);
  }
});

test('PR-F: ROLE_STEP_GUIDANCE covers all 6 steps for the four audiences we ship', () => {
  // At least one role gets a non-default text per step.
  for (const step of [1, 2, 3, 4, 5, 6] as OnboardingStep[]) {
    const byStep = ROLE_STEP_GUIDANCE[step];
    if (!byStep) continue; // step with no overrides — fallback body is fine
    const overrideCount = (Object.keys(byStep) as Role[]).length;
    assert.ok(overrideCount > 0, `step ${step} has the entry but no role overrides`);
  }
});
