/**
 * P10-C IMF-driven population tests.
 *
 * Three independent guarantees:
 * 1. The live `STELLAR_BINS` table is byte-identical to a direct
 *    `integrateImf` call over the same edges, so the controller cannot
 *    drift from the published IMF.
 * 2. After several stepGalaxies() calls the per-bin mass shares of the
 *    newest StellarPopulation batch (matched by `bornStep`) equal the
 *    IMF mass fractions, exactly the way the controller claims.
 * 3. A 100-step (~500 Myr) run passes `validateGalaxies` and the
 *    per-halo residual is tiny — the new IMF-driven partition does not
 *    break mass conservation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGalaxies, stepGalaxies, galaxySummary, galaxyMass, getStellarBins, getStellarBinCount, replaceStellarBins, validateGalaxies } from '../src/simulation/cosmos/galaxies.ts';
import { integrateImf, IMF_MODEL } from '../src/simulation/cosmos/imf.ts';

test('IMF mass fractions sum to 1 and are reflected in the live STELLAR_BINS', () => {
  const bins = getStellarBins();
  const total = bins.reduce((s, b) => s + b.massFraction, 0);
  assert.ok(Math.abs(total - 1) < 1e-14, `STELLAR_BINS mass fractions must sum to 1, got ${total}`);

  const direct = integrateImf([IMF_MODEL.minSolar, 0.5, 3, 8, IMF_MODEL.maxSolar]);
  for (let i = 0; i < bins.length; i++) {
    assert.equal(bins[i]!.minSolar, direct[i]!.minSolar);
    assert.equal(bins[i]!.maxSolar, direct[i]!.maxSolar);
    assert.equal(bins[i]!.meanSolar, direct[i]!.meanSolar);
    assert.equal(bins[i]!.massFraction, direct[i]!.massFraction);
  }
});

test('IMF partition drives a multi-step run: per-bin mass shares of fresh populations equal IMF mass fractions', async () => {
  // Step once: gas cooling + star formation may not produce any populations
  // on the very first step (initial hot gas has to cool to cold first).
  // After 30 steps of cooling, populations are born with consistent IMF
  // shares on each formation tick.
  let s = await createGalaxies('cold-only', 1);
  for (let i = 0; i < 30; i++) s = stepGalaxies(s);
  validateGalaxies(s);

  // Look at the populations born on the *current* step and confirm each
  // bin's mass equals its IMF massFraction (with last-bin absorbing
  // floating-point remainder).
  const fresh = s.halos.flatMap(h => h.populations.filter(p => p.bornStep === s.step));
  assert.ok(fresh.length > 0, 'expected at least one fresh population after 30 steps of cooling');
  const freshMass = fresh.reduce((a, p) => a + p.massSolar, 0);
  const bins = getStellarBins();
  for (let i = 0; i < bins.length; i++) {
    const binPop = fresh.filter(p => p.bin === i).reduce((a, p) => a + p.massSolar, 0);
    const expected = freshMass * bins[i]!.massFraction;
    if (i === bins.length - 1) {
      // Last bin absorbs the floating-point remainder, so the tolerance
      // can be loose.
      assert.ok(Math.abs(binPop - expected) < 1e-9 * freshMass,
        `last bin mismatch: got ${binPop}, expected ${expected}`);
    } else {
      assert.ok(Math.abs(binPop - expected) < 1e-12 * freshMass,
        `bin ${i} mismatch: got ${binPop}, expected ${expected}`);
    }
  }
});

test('zero-yield mass closure: a 100-step run does not create or destroy baryons', async () => {
  // 100 steps × 5 Myr = 500 Myr. validateGalaxies enforces the per-halo
  // ledger (1e-6 + 1e-10·initial); this is a smoke check that the new
  // IMF-driven partition does not break it.
  let s = await createGalaxies('closure-500myr', 0.5);
  for (let i = 0; i < 100; i++) s = stepGalaxies(s);
  validateGalaxies(s);
  // residuals are per-halo `galaxyMass - initialMassSolar`; they must
  // be tiny in absolute terms.
  const maxResidual = Math.max(...s.halos.map(h => Math.abs(galaxyMass(h) - h.initialMassSolar)));
  const maxInitial = Math.max(...s.halos.map(h => h.initialMassSolar));
  assert.ok(maxResidual < 1e-3 * maxInitial,
    `max per-halo residual ${maxResidual} should be tiny relative to ${maxInitial}`);
  galaxySummary(s); // exercise the summary path on the IMF-driven state
});

test('step-size convergence: dtMyr=1 / 0.5 / 0.2 produce the same stellar mass to within 1 %', async () => {
  // The IMF mass partition is identical per step; only the gas cooling
  // and star-formation rates depend on dtMyr, and both use the closed-
  // form -expm1(-dtMyr/τ). They converge as dtMyr → 0, so refining the
  // step should not move the long-run stellar mass materially.
  async function runTo(totalMyr: number, dt: number) {
    let s = await createGalaxies('convergence-seed', 0.5);
    const steps = Math.round(totalMyr / dt);
    for (let i = 0; i < steps; i++) s = stepGalaxies(s, dt);
    return {
      stars: s.halos.reduce((a, h) => a + h.populations.reduce((b, p) => b + p.massSolar, 0), 0),
      elapsedMyr: s.elapsedMyr,
    };
  }
  // Each run covers 80 Myr of wall-clock time. The coarser the dtMyr, the
  // more gas piles up before each formation tick (the -expm1 term
  // discretises an exponential), and population lifetimes are rescaled
  // by `5/dtMyr` so deaths also happen on different step counts. We
  // therefore only assert the *spread* across dtMyr values is small
  // relative to the mean — not monotonicity.
  const r1 = await runTo(80, 1);
  const r05 = await runTo(80, 0.5);
  const r02 = await runTo(80, 0.2);
  const r01 = await runTo(80, 0.1);
  for (const r of [r1, r05, r02, r01]) {
    assert.ok(Math.abs(r.elapsedMyr - 80) < 1e-9, `elapsedMyr=${r.elapsedMyr} should be 80`);
  }
  // Convergence: spread across the four dt values must be ≤ 1 % of the
  // mean. With MIST tracks this bound tightens; with the segment-midpoint
  // teaching proxies the bin-3 death cycle is the dominant term.
  const mean = (r1.stars + r05.stars + r02.stars + r01.stars) / 4;
  const spread = Math.max(r1.stars, r05.stars, r02.stars, r01.stars) - Math.min(r1.stars, r05.stars, r02.stars, r01.stars);
  assert.ok(spread < 1e-2 * mean,
    `convergence spread ${spread} (mean ${mean}) should be < 1 %`);
  // The 0.2 and 0.1 runs should agree very tightly (both fine enough
  // that the dt-induced rescaling of the bin-3 lifetime rounds to the
  // same step count for some deaths).
  const fine = Math.abs(r02.stars - r01.stars) / Math.max(r02.stars, r01.stars);
  assert.ok(fine < 1e-2,
    `dt=0.2 vs 0.1 should agree to < 1 %, got ${fine}`);
});

test('stepGalaxies rejects out-of-range dtMyr', async () => {
  const g = await createGalaxies('dt-validate');
  for (const bad of [0, -1, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => stepGalaxies(g, bad), /步长/);
  }
});
