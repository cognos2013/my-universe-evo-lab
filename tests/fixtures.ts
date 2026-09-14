import type { WorldState } from '../src/simulation/core/contracts.ts';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../src/simulation/core/contracts.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { createRandomStream } from '../src/simulation/core/random.ts';
import { sha256 } from '../src/simulation/core/canonical.ts';

/** Two-cell contract fixture, deliberately not an initialized spherical planet. */
export async function stateFixture(): Promise<WorldState> {
  const s = getScenario('two-lineages');
  return {
    manifest: {
      id: 'fixture', mode: 'free', schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION,
      scenarioId: s.id, seed: s.seed, rulesetHash: await sha256(s.rules),
      epoch: { label: s.epochLabel, tickDurationSeconds: s.rules.tickSeconds },
    },
    rules: s.rules,
    branch: { id: 'main', parentId: null, forkTick: 0, checkpointHash: null }, tick: 0,
    cells: {
      areaM2: new Float64Array([100, 150]), landFraction: new Float64Array([0, 0.5]),
      temperatureK: new Float64Array([280, 290]), nutrientMu: new Float64Array([90, 90]),
      detritusMu: new Float64Array([0, 0]),
      neighborOffsets: new Uint32Array([0, 1, 2]), neighborIndices: new Uint32Array([1, 0]),
    },
    cohorts: {
      ids: ['c1', 'c2'], cellIndices: new Uint32Array([0, 1]), lineageIndices: new Uint32Array([0, 1]),
      counts: new Float64Array([10, 10]), energyReserveJ: new Float64Array([200, 200]),
    },
    traits: s.traits,
    lineages: [
      { id: 'l1', parentId: null, originTick: 0, traitId: 'cool', origin: 'seeded' },
      { id: 'l2', parentId: null, originTick: 0, traitId: 'warm', origin: 'seeded' },
    ],
    rng: (await createRandomStream(s.seed, 'life', 'world', 0)).snapshot(),
    execution: { receipts: [], forcings: [] },
    ledger: { initialMatterMu: 200, externalMatterInMu: 0, externalMatterOutMu: 0, initialEnergyJ: (100*280+150*290)*s.rules.environment.heatCapacityJPerM2K+400, externalEnergyInJ: 0, externalEnergyOutJ: 0 },
  };
}
