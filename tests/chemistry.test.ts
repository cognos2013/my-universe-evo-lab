/**
 * P12 — pre-life chemistry contract tests.
 *
 * Validates the three P12 exit-gate rules (per docs/15):
 *   1. Reaction rules must not contain a "spawn life on day N" special
 *      case — the reactor must be a pure mass-action simulator.
 *   2. Zero external energy → energy-driven reactions stall; the pool
 *      eventually goes extinct and `status === 'extinct'`.
 *   3. Multiple seeds must be runnable from the same chemistry and
 *      evolve independently (no hidden state).
 *
 * This file is contract-only; no real GARD/Markov chemistry is
 * implemented. A real reaction network plugs into `loadReactionNetwork`
 * and uses the same `stepReactor`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReactionNetwork, species } from '../src/simulation/chemistry/network.ts';
import { makeReactorState, stepReactor } from '../src/simulation/chemistry/reactor.ts';

const A = species('A');
const B = species('B');
const C = species('C');

// A 6-reaction network. `decayA` and `decayB` are sinks that consume
// the reactants even without energy, ensuring that zero-energy runs
// are doomed to extinction (per P12 rule 2).
//   1. A + B   → 2C       (rate 0.1, mildly exothermic)
//   2. C       → ∅        (rate 0.05, decay)
//   3. A       → ∅        (rate 0.02, slow sink — first-order in A)
//   4. B       → ∅        (rate 0.02, slow sink — first-order in B)
//   5. ∅       → A        (rate 1.0,  endothermic; needs energy)
//   6. ∅       → B        (rate 0.5,  endothermic; needs energy)
const NETWORK = loadReactionNetwork({
  species: ['A', 'B', 'C'],
  reactions: [
    { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1,  energyJPerMole: -100 },
    { id: 'decay',   reactants: ['C'],       products: [],        rate: 0.05, energyJPerMole: 0 },
    { id: 'decayA',  reactants: ['A'],       products: [],        rate: 0.02, energyJPerMole: 0 },
    { id: 'decayB',  reactants: ['B'],       products: [],        rate: 0.02, energyJPerMole: 0 },
    { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
    { id: 'pumpB',   reactants: [],          products: ['B'],    rate: 0.5,  energyJPerMole: 80 },
  ],
});

test('loadReactionNetwork accepts a valid network and stores species + reactions', () => {
  assert.equal(NETWORK.species.length, 3);
  assert.equal(NETWORK.reactions.length, 6);
  assert.equal(NETWORK.reactions[0]!.id, 'combine');
});

test('loadReactionNetwork rejects orphan species, duplicate ids, and bad rate / energy', () => {
  // Orphan species: 'D' is never referenced.
  assert.throws(() => loadReactionNetwork({
    species: ['A', 'B', 'C', 'D'],
    reactions: [
      { id: 'r1', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: 0 },
    ],
  }), /orphan/);
  // Duplicate reaction id.
  assert.throws(() => loadReactionNetwork({
    species: ['A', 'B', 'C'],
    reactions: [
      { id: 'r1', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: 0 },
      { id: 'r1', reactants: ['C'],     products: [],         rate: 0.1, energyJPerMole: 0 },
    ],
  }), /duplicate/);
  // Negative rate.
  assert.throws(() => loadReactionNetwork({
    species: ['A', 'B', 'C'],
    reactions: [
      { id: 'r1', reactants: ['A', 'B'], products: ['C', 'C'], rate: -1, energyJPerMole: 0 },
    ],
  }), /rate/);
  // Reactant that is not in the species list.
  assert.throws(() => loadReactionNetwork({
    species: ['A', 'B'],
    reactions: [
      { id: 'r1', reactants: ['A', 'X'], products: ['B'], rate: 0.1, energyJPerMole: 0 },
    ],
  }), /unknown species/);
});

test('P12 rule 1: reactor never injects life at a special time; outputs are deterministic from initial concentrations', () => {
  // Same initial conditions, same energy → same state at every step.
  function runOnce(energyIn: number) {
    const init = new Map([[A, 0.5], [B, 0.5], [C, 0]]);
    const s = makeReactorState(NETWORK, init, energyIn);
    const trace: number[] = [];
    for (let i = 0; i < 20; i++) {
      stepReactor(s, NETWORK);
      trace.push(s.concentrations.get(C) ?? 0);
    }
    return trace;
  }
  const a = runOnce(1e6);
  const b = runOnce(1e6);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `step ${i} should be deterministic`);
});

test('P12 rule 2: zero energy → energy-driven reactions stall → extinction after patience', () => {
  // Tight initial concentrations so the pool runs out in a tractable
  // number of steps (the `decay` reaction keeps eating whatever
  // `combine` produces, and the pumps cannot refill A / B because
  // energy is zero).
  const init = new Map([[A, 0.05], [B, 0.05], [C, 0]]);
  const s = makeReactorState(NETWORK, init, 0, { extinctionThreshold: 1e-12, failurePatience: 5 });
  let steps = 0;
  while (s.status === 'active' && steps < 2000) {
    stepReactor(s, NETWORK, { extinctionThreshold: 1e-12, failurePatience: 5 });
    steps++;
  }
  assert.equal(s.status, 'extinct', `expected extinction with zero energy, got ${s.status} at step ${steps}`);
  assert.ok(s.energyConsumedJ === 0, 'no endothermic reaction should have fired');
  assert.ok(steps > 0 && steps <= 2000, `should have reached extinction in finite steps, got ${steps}`);
});

test('P12 rule 2 (continued): abundant energy → pool stabilises without going extinct', () => {
  const init = new Map([[A, 1], [B, 1], [C, 0]]);
  const s = makeReactorState(NETWORK, init, 1e9);
  for (let i = 0; i < 50; i++) stepReactor(s, NETWORK);
  assert.equal(s.status, 'active');
  assert.ok((s.concentrations.get(C) ?? 0) > 0, 'C should accumulate under combined + decay');
  assert.ok(s.energyConsumedJ > 0, 'endothermic pumps should have consumed energy');
});

test('P12 rule 3: two seeds with the same chemistry evolve independently', () => {
  function runWith(seedA: number, seedB: number, energyIn: number) {
    const a = makeReactorState(NETWORK, new Map([[A, seedA], [B, seedB], [C, 0]]), energyIn);
    for (let i = 0; i < 20; i++) stepReactor(a, NETWORK);
    return {
      A: a.concentrations.get(A) ?? 0,
      B: a.concentrations.get(B) ?? 0,
      C: a.concentrations.get(C) ?? 0,
    };
  }
  const high = runWith(5, 5, 1e6);
  const low = runWith(0.01, 0.01, 1e6);
  // The two runs should NOT produce identical C-trajectories: mass-
  // action rates are linear in the reactants, so high-concentration
  // seeds will produce proportionally more C per step. This is the
  // "heritable variation" input that a downstream replication layer
  // would amplify.
  assert.notEqual(high.C, low.C);
  assert.ok(high.C > low.C, `high seed C=${high.C} should exceed low seed C=${low.C}`);
});

test('endothermic energy shortfall: reaction is silent that step, no negative concentrations', () => {
  // 1 unit of A + B + 0.5 C, but only 0.001 J of energy: pumpA needs
  // 1.0 * 50 = 50 J per "mole" (rate unit), and pumpB needs
  // 0.5 * 80 = 40 J, so both should record a shortfall. Combined
  // + decay should still fire.
  const init = new Map([[A, 1], [B, 1], [C, 0.5]]);
  const s = makeReactorState(NETWORK, init, 0.001);
  const r1 = stepReactor(s, NETWORK);
  // No endothermic reaction succeeded.
  assert.equal(r1.events.energyConsumedJ, 0, 'no energy available → no consumption');
  assert.ok(r1.events.energyShortfallJ > 0, `endothermic reactions should record a shortfall, got ${r1.events.energyShortfallJ}`);
  // Combined + decay + A-sink + B-sink should all have fired (none of
  // them require external energy; only the endothermic pumps are gated
  // by the 0.001 J budget).
  const firedIds = r1.events.fired.map(f => f.id).sort();
  assert.deepEqual(firedIds, ['combine', 'decay', 'decayA', 'decayB']);
  // C produced a bit, A and B depleted a bit.
  assert.ok((s.concentrations.get(C) ?? 0) >= 0, 'C must not go negative');
  assert.ok((s.concentrations.get(A) ?? 0) < 1, 'A should be consumed by combine');
  assert.ok((s.concentrations.get(A) ?? 0) >= 0, 'A must not go negative');
  assert.ok((s.concentrations.get(B) ?? 0) >= 0, 'B must not go negative');
});

test('P12 anti-cheat: the reactor has no clock-triggered life injection', () => {
  // We start with a deliberately tiny seed and zero energy; the pool
  // should never produce a species out of thin air at step 50, 100, or
  // any other "magic" step number. The only way concentrations rise is
  // via reactions that have a non-zero rate and (for endothermic ones)
  // available energy.
  const init = new Map([[A, 0], [B, 0], [C, 0]]);
  const s = makeReactorState(NETWORK, init, 0);
  for (let i = 0; i < 200; i++) stepReactor(s, NETWORK);
  // All concentrations should still be ~0 (the only way to spawn A or
  // B is via the endothermic pumps, which have no energy).
  for (const sp of NETWORK.species) {
    assert.ok((s.concentrations.get(sp) ?? 0) < 1e-9,
      `species ${sp} should not be auto-injected, got ${s.concentrations.get(sp)}`);
  }
});
