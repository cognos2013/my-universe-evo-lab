import type { Scenario, WorldState } from './contracts.ts';
import { ENGINE_VERSION, SCHEMA_VERSION } from './contracts.ts';
import { validateScenario } from './schema.ts';
import { validateModelCoverage } from '../../knowledge/model-cards.ts';
import { createRandomStream } from './random.ts';
import { sha256 } from './canonical.ts';
import { createGrid } from '../environment/grid.ts';
import { validateState, energyTotal } from './state.ts';
import { fbm3D } from '../environment/noise.ts';

export async function initializeWorld(input: Scenario): Promise<WorldState> {
  validateScenario(input); validateModelCoverage(input);
  const s = structuredClone(input), grid = createGrid(s.planet.cellCount, s.planet.radiusM);
  const terrain = await createRandomStream(s.seed, 'terrain', 'world', 0);
  const n = s.planet.cellCount;
  // P3.6 — sample a 3D fractal Brownian motion (fBm) at every
  // icosphere cell centre, then rank by that noise. Adjacent
  // cells on the sphere have nearly-identical 3D positions
  // and therefore nearly-identical fBm values, so the lowest
  // n · oceanFraction cells form *contiguous* ocean basins
  // (one or two big seas) instead of the previous 1D random
  // stream's salt-and-pepper scatter. The seed is mixed into
  // the noise so the same scenario seed still produces the
  // same continents.
  const seedHash = await sha256(s.seed);
  const noiseSeed = parseInt(seedHash.slice(0, 8), 16);
  const noiseScale = 1.5; // controls continent size — larger = bigger landmasses
  const ranking = Array.from({ length: n }, (_, id) => {
    const c = grid.centers[id]!;
    const score = fbm3D(c[0] * noiseScale, c[1] * noiseScale, c[2] * noiseScale, noiseSeed);
    return { id, score };
  }).sort((a,b) => a.score-b.score || a.id-b.id);
  const landFraction = new Float64Array(n).fill(1);
  // Quantized by cell count, not presented as exact area-weighted ocean fraction.
  ranking.slice(0, Math.round(n*s.planet.oceanFraction)).forEach(({id}) => { landFraction[id] = 0; });
  const nutrientMu = new Float64Array(n).fill(s.planet.nutrientMuPerCell);
  const ids: string[] = [], cells: number[] = [], lineageIndices: number[] = [], counts: number[] = [], reserves: number[] = [];
  let externalMatterInMu = 0;
  const lineages: WorldState['lineages'] = [];
  for (const [pi, pop] of s.populations.entries()) {
    const eligible = Array.from({ length: n }, (_,i) => i).filter(i => pop.habitat === 'any' || (pop.habitat === 'land' ? landFraction[i] === 1 : landFraction[i] === 0));
    if (!eligible.length) throw new Error(`No cells for habitat ${pop.habitat}`);
    let remaining = pop.count;
    const allocation = new Map<number, number>();
    for (let i = 0; i < eligible.length; i++) {
      const cell = eligible[i]!;
      const capacity = pop.materialSource === 'external' ? remaining : Math.floor(nutrientMu[cell]! / s.rules.life.structureMuPerIndividual);
      const take = Math.min(capacity, Math.ceil(remaining/(eligible.length-i)));
      if (take > 0) {
        allocation.set(cell, take);
        // Debit the per-cell material for the placed
        // individuals. `materialSource === 'external'` skips
        // the debit and instead counts the import into
        // `externalMatterInMu` below.
        if (pop.materialSource === 'local') {
          nutrientMu[cell]! -= take * s.rules.life.structureMuPerIndividual;
        }
        remaining -= take;
      }
    }
    // Fill residual from earlier cells when later cells had insufficient material.
    if (remaining && pop.materialSource === 'local') for (const cell of eligible) {
      const current = allocation.get(cell) ?? 0;
      const room = Math.floor(nutrientMu[cell]! / s.rules.life.structureMuPerIndividual) - current;
      const take = Math.min(remaining, Math.max(0, room));
      if (take > 0) {
        allocation.set(cell, current + take);
        nutrientMu[cell]! -= take * s.rules.life.structureMuPerIndividual;
        remaining -= take;
      }
    }
    if (remaining) throw new Error(`Insufficient local material for population ${pi}`);
    lineages.push({ id: `seed-${pi}`, parentId: null, originTick: 0, traitId: pop.traitId, origin: 'seeded' });
    // P3.5 fix: the per-cell debit was already applied inside
    // the placement loop above, so this section no longer
    // debits nutrientMu again. We just record the
    // allocation into the cohort bookkeeping arrays.
    for (const [cell,count] of allocation) if (count) {
      if (pop.materialSource === 'external') {
        externalMatterInMu += count * s.rules.life.structureMuPerIndividual;
      }
      ids.push(`seed-${pi}-cell-${cell}`); cells.push(cell); lineageIndices.push(pi); counts.push(count); reserves.push(count*pop.reserveJPerIndividual);
    }
  }
  const state: WorldState = {
    manifest: { id: `world-${(await sha256(s)).slice(0,16)}`, mode: 'free', schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, scenarioId: s.id, seed: s.seed, rulesetHash: await sha256(s.rules), epoch: { label: s.epochLabel, tickDurationSeconds: s.rules.tickSeconds } },
    rules: s.rules, branch: { id: 'main', parentId: null, forkTick: 0, checkpointHash: null }, tick: 0,
    cells: { areaM2: grid.areaM2, landFraction, temperatureK: new Float64Array(n).fill(s.planet.initialTemperatureK), nutrientMu, detritusMu: new Float64Array(n).fill(s.planet.detritusMuPerCell), neighborOffsets: grid.neighborOffsets, neighborIndices: grid.neighborIndices },
    cohorts: { ids, cellIndices: Uint32Array.from(cells), lineageIndices: Uint32Array.from(lineageIndices), counts: Float64Array.from(counts), energyReserveJ: Float64Array.from(reserves) },
    traits: s.traits, lineages, rng: (await createRandomStream(s.seed,'life','world',0)).snapshot(),
    execution: { receipts: [], forcings: [] },
    ledger: { initialMatterMu: n*(s.planet.nutrientMuPerCell+s.planet.detritusMuPerCell), externalMatterInMu, externalMatterOutMu: 0, initialEnergyJ: 0, externalEnergyInJ: 0, externalEnergyOutJ: 0 },
  };
  // Initial reserves are part of the authored initial energy stock, not generated by biology.
  state.ledger.initialEnergyJ = energyTotal(state);
  validateState(state);
  return state;
}
