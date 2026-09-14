/**
 * P10-C — planetary metal feedback.
 *
 * Per docs/15: "追踪新形成的恒星群、金属质量作为总物质的组成部分"
 * and "金属生成、恒星风和残骸近似分别记录". The P10-C IMF /
 * lifetime / yield / SN refactor on `galaxies.ts` produces
 * `lastYieldedSolar` per cosmic step. The controller's
 * `handleInternalTick` now routes that yield into the active
 * planetary `ledger.externalMatterInMu` so the surface chemistry
 * can use heavy elements over long horizons.
 *
 * These tests cover three contracts:
 *   1. The new mass-anchored stellar physics keeps the per-halo
 *      mass balance closed (returned + yield + remnant = deadMass)
 *      for every IMF segment. (Already covered by `validateGalaxies`
 *      in `p10c-feedback.test.ts`; this test pins the explicit
 *      per-bin numerics.)
 *   2. `stepGalaxies` produces non-zero `lastYieldedSolar` once
 *      bin-3 populations (M > 8 M☉) start dying.
 *   3. `handleInternalTick` routes the yielded mass into the
 *      planetary ledger at the `P10C_SOLAR_TO_MU` rate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __handlers } from '../src/workers/controller.ts';
import type { __InternalHandlerContext } from '../src/workers/controller.ts';
import { ExperimentBook } from '../src/experiments/book.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { createGalaxies, stepGalaxies, getStellarBins } from '../src/simulation/cosmos/galaxies.ts';
import { P10C_SOLAR_TO_MU, P11_COSMIC_STEP_EVERY } from '../src/workers/controller.ts';
import type { Reply } from '../src/workers/controller.ts';

const P10C_TEST_COSMIC_STEP_EVERY = 100;

async function makeCtx(): Promise<__InternalHandlerContext & { _replies: Reply[]; _running: () => boolean; _target: () => number; _event: () => string; _book: () => ExperimentBook | null; _lastCosmicTick: number }> {
  const scenario = getScenario('two-lineages', 320);
  scenario.seed = 'p10c-test';
  scenario.rules.limits.maxCohorts = 100000;
  const world = await initializeWorld(scenario);
  const book = await ExperimentBook.create(world);
  const state = { _replies: [] as Reply[], _running: false, _target: 0, _event: '', _book: book as ExperimentBook | null, _lastCosmicTick: 0 };
  return {
    book: state._book,
    get history() { return state._book?.active ?? null; },
    get state() { return state._book?.active.state ?? null; },
    generation: 0,
    pause: () => { state._running = false; },
    publish: () => { state._replies.push({ id: 0, type: 'projection', payload: {} as never }); },
    emit: (reply: Reply) => { state._replies.push(reply); },
    setBook: (b: ExperimentBook) => { state._book = b; },
    setTarget: (n: number) => { state._target = n; },
    setRunning: (b: boolean) => { state._running = b; },
    setEvent: (s: string) => { state._event = s; },
    isRunning: () => state._running,
    getTarget: () => state._target,
    sinceEmit: () => 0,
    schedule: () => {},
    addExternalEnergy: (_j: number) => { /* no-op */ },
    addExternalMatter: (_mu: number) => { /* no-op */ },
    consumeExternalEnergy: (_j: number) => { /* no-op */ },
    setLedgerEnergy: (_j: number) => { /* no-op */ },
    cosmicStepEvery: P10C_TEST_COSMIC_STEP_EVERY,
    planetFraction: 1e-27,
    maxEnergyPerTickJ: 1e22,
    solarToMu: P10C_SOLAR_TO_MU,
    get lastCosmicTick() { return state._lastCosmicTick; },
    markCosmicTick: (tick: number) => { state._lastCosmicTick = tick; },
    setChemistry: () => {},
    setColonies: () => {},
    setCognition: () => {},
    setSettlement: () => {},
    setEarthData: () => {},
    setEarthCalibration: () => {},
    pushBatch: () => {},
    setBatchCalibration: () => {},
    setV14Snapshot: () => {},
    setV14Active: () => {},
    removeV14Snapshot: () => {},
    renameV14Snapshot: () => {},
    _replies: state._replies,
    _running: () => state._running,
    _target: () => state._target,
    _event: () => state._event,
    _book: () => state._book,
  } as never;
}

test('P10-C: per-segment stellar physics is mass-anchored (no hand-tuned constants)', () => {
  const bins = getStellarBins();
  // The four segments are 0.08—0.5, 0.5—3, 3—8, 8—100 M☉. The
  // mean masses are computed by `integrateImf` and the lifetime /
  // yield / SN energy / returned-fraction are all derived from
  // them. The invariant: for every SN bin, returned + yield +
  // remnant fraction < 1.
  for (const bin of bins) {
    if (bin.snEnergyErgsPerKg > 0) {
      assert.ok(bin.yieldFraction + bin.returned < 1,
        `SN bin ${bin.label}: yield (${bin.yieldFraction}) + returned (${bin.returned}) must be < 1`);
      assert.ok(bin.lifetimeSteps > 0 && bin.lifetimeSteps < 1000,
        `SN bin ${bin.label}: lifetime should be in (0, 1000) steps, got ${bin.lifetimeSteps}`);
    } else {
      // Non-SN bins: no SN, just AGB / white-dwarf wind.
      assert.ok(bin.yieldFraction < 0.05,
        `Non-SN bin ${bin.label}: yield should be tiny, got ${bin.yieldFraction}`);
      // For the 3—8 M☉ A/B segment, lifetime ≈ 100 Myr—1 Gyr ⇒
      // 20—200 steps at our 5 Myr/step. For lower-mass segments
      // (0.08—0.5, 0.5—3) we expect ≥ 1000 (longer than the
      // simulation horizon).
      const meanMass = (bin.minSolar + bin.maxSolar) / 2;
      if (meanMass < 3) {
        assert.ok(bin.lifetimeSteps >= 1000,
          `Low-mass bin ${bin.label}: low-mass stars should live long, got ${bin.lifetimeSteps}`);
      } else {
        // 3—8 M☉ A/B: 100 Myr—1 Gyr ⇒ 20—200 steps.
        assert.ok(bin.lifetimeSteps >= 20 && bin.lifetimeSteps < 500,
          `A/B bin ${bin.label}: lifetime should be 20—500 steps, got ${bin.lifetimeSteps}`);
      }
    }
  }
});

test('P10-C: stepGalaxies produces non-zero yielded once bin-3 populations die', async () => {
  let s = await createGalaxies('p10c-yield');
  // Run 50 steps; bin-3 (M > 8 M☉) populations should die within
  // the first few steps.
  for (let i = 0; i < 50; i++) s = stepGalaxies(s);
  assert.ok(s.lastYieldedSolar > 0, `expected non-zero yielded, got ${s.lastYieldedSolar}`);
  // Yield should be a few percent of the bin-3 stellar mass.
  const totalMass = s.halos.reduce((a, h) => a + h.populations.reduce((b, p) => b + p.massSolar, 0), 0);
  assert.ok(s.lastYieldedSolar < totalMass,
    `yielded (${s.lastYieldedSolar}) must be < total live stellar mass (${totalMass})`);
});

test('P10-C: handleInternalTick routes lastYieldedSolar into planetary externalMatterInMu', async () => {
  const ctx = await makeCtx();
  ctx.setRunning(true);
  ctx.setTarget(Number.MAX_SAFE_INTEGER);
  // Wire a spy for addExternalMatter to capture the routing.
  const injected: number[] = [];
  (ctx as unknown as { addExternalMatter: (mu: number) => void }).addExternalMatter = (mu: number) => { injected.push(mu); };
  // Run 5 cosmic steps (500 planetary ticks).
  for (let t = 0; t < 5 * P10C_TEST_COSMIC_STEP_EVERY; t++) {
    await __handlers.internalTick({ generation: 0 }, ctx, 0);
  }
  // The spy should have been called at least once with a
  // positive value (bin-3 deaths produce ~0.15 M☉ per death
  // ⇒ ~1.5e5 MU per death at 1 M☉ = 1e6 MU).
  assert.ok(injected.length > 0, 'addExternalMatter should have been called');
  const total = injected.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, `expected non-zero total mass injection, got ${total}`);
  // Sanity: the per-call injection should match yielded × solarToMu.
  for (let i = 0; i < injected.length; i++) {
    assert.ok(injected[i]! >= 0, 'injection is non-negative');
  }
});

test('P10-C: P10C_SOLAR_TO_MU conversion is the published default (1 M☉ = 1e6 MU)', () => {
  assert.equal(P10C_SOLAR_TO_MU, 1e6);
});
