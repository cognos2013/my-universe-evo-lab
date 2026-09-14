import type { WorldState } from './contracts.ts';
import { SCHEMA_VERSION, ENGINE_VERSION } from './contracts.ts';
import { validateRules, validateTraits } from './schema.ts';
import { validateRng } from './random.ts';
import * as v from './validation.ts';

function floats(x: unknown, path: string, length: number, min = 0, max = Number.MAX_VALUE): Float64Array {
  if (!(x instanceof Float64Array) || x.length !== length) v.fail(path, `expected Float64Array length ${length}`);
  x.forEach((n, i) => v.number(n, `${path}[${i}]`, min, max));
  return x;
}
function uints(x: unknown, path: string, length: number, max: number): Uint32Array {
  if (!(x instanceof Uint32Array) || x.length !== length) v.fail(path, `expected Uint32Array length ${length}`);
  x.forEach((n, i) => v.integer(n, `${path}[${i}]`, 0, max));
  return x;
}

export function matterTotal(state: WorldState): number {
  let total = 0;
  for (const n of state.cells.nutrientMu) total += n;
  for (const n of state.cells.detritusMu) total += n;
  for (const n of state.cohorts.counts) total += n * state.rules.life.structureMuPerIndividual;
  return total;
}

export function energyTotal(state: WorldState): number {
  let total = 0;
  for (let i = 0; i < state.cells.areaM2.length; i++) total += state.cells.areaM2[i]! * state.cells.temperatureK[i]! * state.rules.environment.heatCapacityJPerM2K;
  for (const energy of state.cohorts.energyReserveJ) total += energy;
  return total;
}

/** Validate complete state at transaction boundaries. */
export function validateState(input: unknown): asserts input is WorldState {
  const s = v.object(input, ['manifest', 'rules', 'branch', 'tick', 'cells', 'cohorts', 'traits', 'lineages', 'rng', 'execution', 'ledger'], 'state');
  const m = v.object(s.manifest, ['id', 'mode', 'schemaVersion', 'engineVersion', 'scenarioId', 'seed', 'rulesetHash', 'epoch'], 'manifest');
  v.id(m.id, 'manifest.id'); v.choice(m.mode, ['free'], 'manifest.mode');
  v.choice(m.schemaVersion, [SCHEMA_VERSION], 'manifest.schemaVersion');
  v.choice(m.engineVersion, [ENGINE_VERSION], 'manifest.engineVersion');
  v.id(m.scenarioId, 'manifest.scenarioId'); v.text(m.seed, 'manifest.seed', 256); v.hash(m.rulesetHash, 'manifest.rulesetHash');
  validateRules(s.rules);
  const epoch = v.object(m.epoch, ['label', 'tickDurationSeconds'], 'manifest.epoch');
  v.text(epoch.label, 'manifest.epoch.label');
  if (epoch.tickDurationSeconds !== s.rules.tickSeconds) v.fail('manifest.epoch.tickDurationSeconds', 'must match rules');
  const tick = v.integer(s.tick, 'state.tick');
  const branch = v.object(s.branch, ['id', 'parentId', 'forkTick', 'checkpointHash'], 'branch');
  v.id(branch.id, 'branch.id'); v.integer(branch.forkTick, 'branch.forkTick', 0, tick);
  if (branch.parentId === null) {
    if (branch.checkpointHash !== null || branch.forkTick !== 0) v.fail('branch', 'root must have null checkpoint and forkTick 0');
  } else {
    v.id(branch.parentId, 'branch.parentId');
    if (branch.parentId === branch.id) v.fail('branch.parentId', 'self reference');
    v.hash(branch.checkpointHash, 'branch.checkpointHash');
  }

  const c = v.object(s.cells, ['areaM2', 'landFraction', 'temperatureK', 'nutrientMu', 'detritusMu', 'neighborOffsets', 'neighborIndices'], 'cells');
  if (!(c.areaM2 instanceof Float64Array)) v.fail('cells.areaM2', 'expected Float64Array');
  const n = v.integer(c.areaM2.length, 'cells.length', 1, s.rules.limits.maxCells);
  floats(c.areaM2, 'cells.areaM2', n, Number.MIN_VALUE);
  floats(c.landFraction, 'cells.landFraction', n, 0, 1);
  floats(c.temperatureK, 'cells.temperatureK', n, 150, 400);
  floats(c.nutrientMu, 'cells.nutrientMu', n, 0, 1e12);
  floats(c.detritusMu, 'cells.detritusMu', n, 0, 1e12);
  if (!(c.neighborIndices instanceof Uint32Array)) v.fail('cells.neighborIndices', 'expected Uint32Array');
  v.integer(c.neighborIndices.length, 'cells.neighborIndices.length', 0, n * 12);
  const offsets = uints(c.neighborOffsets, 'cells.neighborOffsets', n + 1, c.neighborIndices.length);
  const indices = uints(c.neighborIndices, 'cells.neighborIndices', c.neighborIndices.length, n - 1);
  if (offsets[0] !== 0 || offsets[n] !== indices.length) v.fail('cells.neighborOffsets', 'invalid CSR bounds');
  const adjacency: Set<number>[] = [];
  for (let i = 0; i < n; i++) {
    if (offsets[i]! > offsets[i + 1]!) v.fail('cells.neighborOffsets', 'not monotonic');
    const row = Array.from(indices.subarray(offsets[i], offsets[i + 1]));
    v.unique(row, `cells.neighbors[${i}]`);
    if (row.includes(i)) v.fail(`cells.neighbors[${i}]`, 'self edge');
    adjacency.push(new Set(row));
  }
  for (const [i, row] of adjacency.entries()) for (const j of row) {
    if (!adjacency[j]!.has(i)) v.fail('cells.neighbors', 'edge must be reciprocal');
  }

  const traits = v.array(s.traits, 'state.traits', 100000);
  const traitIds = traits.map((t, i) => { validateTraits(t, `state.traits[${i}]`); return t.id; });
  v.unique(traitIds, 'state.traits');
  const traitSet = new Set(traitIds);
  const lineages = v.array(s.lineages, 'state.lineages', 100000);
  const ancestors = new Map<string, number>();
  lineages.forEach((value, i) => {
    const path = `lineages[${i}]`;
    const l = v.object(value, ['id', 'parentId', 'originTick', 'traitId', 'origin'], path);
    const id = v.id(l.id, `${path}.id`);
    if (ancestors.has(id)) v.fail(path, 'duplicate lineage');
    const birth = v.integer(l.originTick, `${path}.originTick`, 0, tick);
    if (l.parentId !== null) {
      const parent = v.id(l.parentId, `${path}.parentId`);
      if (!ancestors.has(parent) || ancestors.get(parent)! > birth) v.fail(path, 'parent must precede child in time and array');
    }
    if (!traitSet.has(v.id(l.traitId, `${path}.traitId`))) v.fail(path, 'unknown trait');
    const origin = v.choice(l.origin, ['seeded', 'mutation', 'intervention'], `${path}.origin`);
    if (origin === 'mutation' && l.parentId === null) v.fail(path, 'mutation requires parent');
    ancestors.set(id, birth);
  });

  const cohorts = v.object(s.cohorts, ['ids', 'cellIndices', 'lineageIndices', 'counts', 'energyReserveJ'], 'cohorts');
  const ids = v.ids(cohorts.ids, 'cohorts.ids', s.rules.limits.maxCohorts);
  const k = v.integer(ids.length, 'cohorts.length', 0, s.rules.limits.maxCohorts);
  uints(cohorts.cellIndices, 'cohorts.cellIndices', k, n - 1);
  uints(cohorts.lineageIndices, 'cohorts.lineageIndices', k, lineages.length - 1);
  const counts = floats(cohorts.counts, 'cohorts.counts', k, 1, 1e9);
  let totalCount = 0;
  counts.forEach((x, i) => { v.integer(x, `cohorts.counts[${i}]`); totalCount += x; });
  v.integer(totalCount, 'cohorts.totalCount');
  floats(cohorts.energyReserveJ, 'cohorts.energyReserveJ', k, 0, 1e24);
  validateRng(s.rng);
  const execution = v.object(s.execution, ['receipts', 'forcings'], 'execution');
  const receipts=v.array(execution.receipts,'execution.receipts',10000).map((r,i)=>{
    const o=v.object(r,['id','digest'],`receipt[${i}]`);v.hash(o.digest,`receipt[${i}].digest`);return v.id(o.id,`receipt[${i}].id`);
  });v.unique(receipts,'execution.receipts');
  const forcingIds=v.array(execution.forcings,'execution.forcings',1000).map((f,i)=>{
    const o=v.object(f,['id','cells','startTick','endTick','forcingWPerM2'],`forcing[${i}]`);
    const id=v.id(o.id,`forcing[${i}].id`);if(!receipts.includes(id))v.fail('execution.forcings','missing command receipt');
    const start=v.integer(o.startTick,'forcing.startTick',0,tick);v.integer(o.endTick,'forcing.endTick',start+1);v.number(o.forcingWPerM2,'forcing.forcingWPerM2',-1e5,1e5);
    const cells=v.array(o.cells,'forcing.cells',n).map(x=>v.integer(x,'forcing.cell',0,n-1));if(!cells.length)v.fail('forcing.cells','empty');v.unique(cells,'forcing.cells');return id;
  });v.unique(forcingIds,'execution.forcings');
  const ledger = v.object(s.ledger, ['initialMatterMu', 'externalMatterInMu', 'externalMatterOutMu', 'initialEnergyJ', 'externalEnergyInJ', 'externalEnergyOutJ'], 'ledger');
  const expectedEnergy = v.number(ledger.initialEnergyJ, 'ledger.initialEnergyJ') + v.number(ledger.externalEnergyInJ, 'ledger.externalEnergyInJ') - v.number(ledger.externalEnergyOutJ, 'ledger.externalEnergyOutJ');
  v.number(expectedEnergy, 'ledger.expectedEnergy');
  const actualEnergy = v.number(energyTotal(input as WorldState), 'ledger.actualEnergy');
  if (Math.abs(expectedEnergy-actualEnergy) > 1e-6 + 1e-10*Math.max(expectedEnergy,actualEnergy)) v.fail('ledger', 'energy balance mismatch');
  const initial = v.number(ledger.initialMatterMu, 'ledger.initialMatterMu');
  const added = v.number(ledger.externalMatterInMu, 'ledger.externalMatterInMu');
  const removed = v.number(ledger.externalMatterOutMu, 'ledger.externalMatterOutMu');
  const expected = v.number(initial + added - removed, 'ledger.expectedMatter');
  const actual = v.number(matterTotal(input as WorldState), 'ledger.actualMatter');
  // Explicit static interchange tolerance, not a numerical-integrator error budget.
  if (Math.abs(expected - actual) > 1e-8 + 1e-10 * Math.max(expected, actual)) v.fail('ledger', 'matter balance mismatch');
}
