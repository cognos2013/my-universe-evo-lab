/**
 * P10-2 — synthetic GARD / Markov chemistry loaders.
 *
 * Reference gate:
 *   - `loadChemistryBySource('gard', ...)` returns a network
 *     with 5 species (P, F, L, R, W) and 6 reactions; the
 *     replicator reaction `R + P → 2R + L` is present.
 *   - `loadChemistryBySource('markov', ...)` returns a network
 *     with 4 species (A, B, C, D) and 6 reactions.
 *   - `loadChemistryBySource('raw', payload)` falls through to
 *     `loadReactionNetwork` and validates the user payload.
 *   - Controller integration: `chemistryLoad` with `source: 'gard'`
 *     produces a `Projection.chemistry.networkSource === 'gard'`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticGardNetwork } from '../src/simulation/chemistry/gard.ts';
import { syntheticMarkovNetwork } from '../src/simulation/chemistry/markov.ts';
import { loadChemistryBySource } from '../src/simulation/chemistry/loaders.ts';
import { SimulationController, type Reply } from '../src/workers/controller.ts';

test('syntheticGardNetwork: 5 species + 6 reactions with replicator', () => {
  const net = syntheticGardNetwork();
  assert.equal(net.species.length, 5);
  assert.equal(net.reactions.length, 6);
  const replicator = net.reactions.find(r => r.id === 'replicate');
  assert.ok(replicator, 'GARD network should contain a replicator reaction');
  assert.deepEqual(replicator!.reactants.map(s => s as string), ['R', 'P']);
  assert.equal(replicator!.energyJPerMole, 30, 'replication should cost energy (P12 exit gate)');
  assert.ok(net.source?.startsWith('synthetic-GARD'), 'source must self-identify');
});

test('syntheticMarkovNetwork: 4 species + 6 reactions with predator-prey topology', () => {
  const net = syntheticMarkovNetwork();
  assert.equal(net.species.length, 4);
  assert.equal(net.reactions.length, 6);
  const predation = net.reactions.find(r => r.id === 'predation');
  assert.ok(predation, 'Markov network should contain a predation reaction');
  assert.ok(net.source?.startsWith('synthetic-Markov'));
});

test('loadChemistryBySource: raw falls through to loadReactionNetwork', () => {
  const raw = {
    species: ['X', 'Y'],
    reactions: [{ id: 'r', reactants: ['X'], products: ['Y'], rate: 0.5, energyJPerMole: 0 }],
  };
  const net = loadChemistryBySource('raw', raw);
  assert.equal(net.species.length, 2);
  assert.equal(net.reactions.length, 1);
  assert.equal(net.source, undefined, 'raw networks have no synthetic-source label');
});

test('loadChemistryBySource: gard / markov ignore the input payload', () => {
  const netGard = loadChemistryBySource('gard', null);
  assert.equal(netGard.species.length, 5);
  const netMarkov = loadChemistryBySource('markov', null);
  assert.equal(netMarkov.species.length, 4);
});

test('GARD reactor with energy: replicator should grow (P12-style survival test)', async () => {
  const net = syntheticGardNetwork();
  const { makeReactorState, stepReactor } = await import('../src/simulation/chemistry/reactor.ts');
  const initial = new Map(net.species.map(sp => [sp, sp === 'F' ? 100 : sp === 'P' ? 50 : sp === 'L' ? 0.1 : sp === 'R' ? 0.1 : 0]));
  const state = makeReactorState(net, initial, 1e6);
  for (let i = 0; i < 20; i++) {
    stepReactor(state, net);
  }
  // The replicator R should not have died in 20 steps.
  assert.ok((state.concentrations.get('R' as never) ?? 0) > 0, 'replicator should persist with energy');
});

test('controller: chemistryLoad with source="gard" populates Projection.chemistry.networkSource', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'chemistryLoad', payload: { source: 'gard', energyInJ: 1000 } });
  const proj = c.projection();
  assert.ok(proj.chemistry, 'chemistry should be present');
  assert.equal(proj.chemistry!.networkSource, 'gard', 'projection should report gard source');
  assert.equal(proj.chemistry!.concentrations['L'] !== undefined, true, 'GARD species should be exposed');
});

test('controller: chemistryLoad with source="markov" populates Projection.chemistry.networkSource', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'chemistryLoad', payload: { source: 'markov', energyInJ: 1000 } });
  const proj = c.projection();
  assert.ok(proj.chemistry);
  assert.equal(proj.chemistry!.networkSource, 'markov');
});

test('controller: chemistryLoad with source="raw" (default) keeps the original contract', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['X', 'Y'],
      reactions: [{ id: 'r', reactants: ['X'], products: ['Y'], rate: 0.5, energyJPerMole: 0 }],
    },
    energyInJ: 0,
  }});
  const proj = c.projection();
  assert.ok(proj.chemistry);
  assert.equal(proj.chemistry!.networkSource, 'raw', 'raw network must report raw source');
});

test('controller: chemistryLoad rejects unknown source', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'chemistryLoad', payload: { source: 'foo' } });
  const err = replies.filter(r => r.type === 'error').at(-1);
  assert.ok(err, 'unknown source should emit an error reply');
  if (err && err.type === 'error') assert.match(err.error, /未知 chemistry source/);
});
