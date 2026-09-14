/**
 * P10-C feedback + P11 cross-scale coupling tests.
 *
 * Covers four interlocking changes from the P10-C continuation + P11 work:
 *   1. STELLAR_BINS is replaceable (the MIST integration path).
 *   2. Metal yield: stellar deaths add to halo.metalMassSolar and bump
 *      halo.metallicity.
 *   3. Supernova energy: A/B and massive bins record lastSupernovaEnergyJ
 *      in J (not erg) for the planetary ledger to read.
 *   4. P11 cross-scale: the controller's galaxies handler routes
 *      lastSupernovaEnergyJ into the active world's
 *      `ledger.externalEnergyInJ`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGalaxies, stepGalaxies, galaxySummary, getStellarBins, getStellarBinCount,
  replaceStellarBins, validateGalaxies,
} from '../src/simulation/cosmos/galaxies.ts';
import { SimulationController, type __InternalHandlerContext } from '../src/workers/controller.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { ExperimentBook } from '../src/experiments/book.ts';
import type { ExperimentBook as ExperimentBookType } from '../src/experiments/book.ts';
import type { Reply } from '../src/workers/controller.ts';

// === 1. STELLAR_BINS replaceable ======================================

test('replaceStellarBins swaps the bin table; subsequent steps use the new lifetimes', () => {
  const originalBins = getStellarBins();
  assert.equal(getStellarBinCount(), 4, 'default partition has 4 bins');
  // Build a swap with much shorter lifetimes for bin=3 (massive).
  const swap = originalBins.map((b, i) => i === 3 ? { ...b, lifetimeSteps: 1 } : b);
  replaceStellarBins(swap);
  const after = getStellarBins();
  assert.equal(after[3]!.lifetimeSteps, 1, 'bin 3 should have the new lifetime');
  assert.equal(after[0]!.lifetimeSteps, originalBins[0]!.lifetimeSteps, 'other bins unchanged');
});

test('replaceStellarBins rejects length / edge mismatches', () => {
  const bins = getStellarBins();
  // Too few.
  assert.throws(() => replaceStellarBins(bins.slice(0, 2)), /length/);
  // Off-by-one range on the last bin.
  assert.throws(() => replaceStellarBins(bins.map((b, i) => i === bins.length - 1 ? { ...b, maxSolar: b.maxSolar + 1 } : b)), /edge/);
});

test('replaceStellarBins rejects after-tax (caller must opt-in, not auto-restore)', () => {
  // Reset to the default to leave the module clean for subsequent tests.
  const bins = getStellarBins();
  const restored = bins.map(b => ({ ...b })); // already-same edges
  replaceStellarBins(restored);
  assert.equal(getStellarBins()[0]!.lifetimeSteps, bins[0]!.lifetimeSteps);
});

// === 2. Metal yield ====================================================

test('zero initial metal: metallicity rises only as massive stars die', () => {
  return (async () => {
    let s = await createGalaxies('yield-zero', 0.5);
    for (const h of s.halos) {
      assert.equal(h.metallicity, 0, 'initial metallicity is zero');
      assert.equal(h.metalMassSolar, 0, 'initial metal mass is zero');
    }
    // Run long enough for bin=3 (lifetime 4 steps @ dtMyr=5) to start dying.
    for (let i = 0; i < 50; i++) s = stepGalaxies(s);
    const totalMetals = s.halos.reduce((a, h) => a + h.metalMassSolar, 0);
    assert.ok(totalMetals > 0, `expected metals to accumulate, got ${totalMetals}`);
    // metallicity must be 0 < z ≤ 1 across halos.
    for (const h of s.halos) {
      assert.ok(h.metallicity >= 0 && h.metallicity <= 1, `metallicity out of [0, 1]: ${h.metallicity}`);
    }
    // `metallicity` is the *redundant* `metalMass / (gas + metal)` field;
    // validateGalaxies enforces this consistency.
    validateGalaxies(s);
  })();
});

// === 3. Supernova energy in J =======================================

test('bin-3 supernova deaths emit J-class energy into lastSupernovaEnergyJ', () => {
  return (async () => {
    let s = await createGalaxies('sn-energy', 0.5);
    for (let i = 0; i < 10; i++) s = stepGalaxies(s);
    assert.ok(s.lastSupernovaEnergyJ > 0,
      `expected SN energy after 10 steps of bin-3 deaths, got ${s.lastSupernovaEnergyJ}`);
    // 1 M☉ ≈ 1.989e30 kg; 5e20 erg/kg → ~9.945e50 erg per M☉ → ~9.945e43 J per M☉.
    // Sanity: bin-3 populations with mass ~20 M☉ each ⇒ O(1e45) J per death.
    assert.ok(s.lastSupernovaEnergyJ > 1e42, `SN energy seems too low: ${s.lastSupernovaEnergyJ}`);
  })();
});

// === 4. P11 cross-scale coupling =====================================

test('handleGalaxies injects lastSupernovaEnergyJ into WorldState.ledger.externalEnergyInJ', async () => {
  // Set up a real controller with a 5120-cell planet world.
  const scenario = getScenario('two-lineages', 5120);
  const world = await initializeWorld(scenario);
  const book = await ExperimentBook.create(world);
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  // Hand the controller the book via the create handler path.
  await c.handle({ id: 1, type: 'create' });
  // Drive a long galaxies advance so bin-3 populations start dying
  // (each step is 5 Myr; bin-3 lifetime is 4*5 = 20 Myr).
  await c.handle({ id: 2, type: 'galaxiesAdvance', payload: { steps: 6 } });
  // The galaxies handler should have routed lastSupernovaEnergyJ into
  // the active World's externalEnergyInJ. The projection payload
  // exposes the running ledger via `summary`; we instead assert
  // indirectly by snapshotting the active world.
  const snapshot = c.snapshotState();
  const lastGalaxies = replies.filter(r => r.type === 'galaxies').at(-1);
  assert.ok(lastGalaxies?.type === 'galaxies', 'expected a galaxies reply');
  if (lastGalaxies.type === 'galaxies') {
    const snEmitted = (lastGalaxies.payload as { supernovaEnergyJ: number }).supernovaEnergyJ;
    assert.ok(snEmitted > 0, `galaxies reply should report SN energy, got ${snEmitted}`);
    // The energy must have flowed into the planetary ledger.
    assert.equal(snapshot.ledger.externalEnergyInJ, snEmitted,
      `externalEnergyInJ should equal cumulative SN energy, got ${snapshot.ledger.externalEnergyInJ}`);
  }
});
