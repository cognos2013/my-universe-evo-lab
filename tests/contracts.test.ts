import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScenario, scenarioIds } from '../src/scenarios/catalog.ts';
import { validateScenario, validateIntervention } from '../src/simulation/core/schema.ts';
import { validateState, matterTotal } from '../src/simulation/core/state.ts';
import { validateModelCoverage, validateModelCard, modelCards } from '../src/knowledge/model-cards.ts';
import { stateFixture } from './fixtures.ts';

test('all templates have explicit evidence, supported rules and model coverage', () => {
  for (const id of scenarioIds) {
    const s = getScenario(id);
    validateScenario(s); validateModelCoverage(s);
    assert.equal(s.evidence, 'authored'); assert.equal(s.mode, 'free');
  }
  modelCards.forEach(validateModelCard);
});

test('templates are isolated from caller mutations and other scenarios', () => {
  const a = getScenario('two-lineages');
  a.rules.life.mutationProbability = 0;
  a.traits[0]!.thermalOptimumK = 350;
  assert.equal(getScenario('two-lineages').rules.life.mutationProbability, 0.01);
  assert.equal(getScenario('two-lineages').traits[0]!.thermalOptimumK, 283);
  assert.equal(getScenario('closed-resources').rules.environment.recyclingPerSecond, 0);
  assert.equal(getScenario('empty-planet').populations.length, 0);
});

for (const [label, mutate] of [
  ['unknown units/field', (s: any) => { s.planet.temperatureC = 20; }],
  ['missing field', (s: any) => { delete s.seed; }],
  ['unsupported version', (s: any) => { s.schemaVersion = '99'; }],
  ['nonfinite', (s: any) => { s.rules.environment.emissivity = NaN; }],
  ['unsafe population', (s: any) => { s.populations[0].count = Number.MAX_SAFE_INTEGER + 1; }],
  ['fractional population', (s: any) => { s.populations[0].count = 2.5; }],
  ['negative resource', (s: any) => { s.planet.nutrientMuPerCell = -1; }],
  ['zero thermal width', (s: any) => { s.traits[0].thermalWidthK = 0; }],
  ['missing trait', (s: any) => { s.populations[0].traitId = 'missing'; }],
  ['duplicate trait', (s: any) => { s.traits[1].id = s.traits[0].id; }],
  ['unavailable habitat', (s: any) => { s.planet.oceanFraction = 0; }],
  ['grid budget', (s: any) => { s.rules.limits.maxCells = 10; }],
] as const) test(`scenario rejects ${label}`, () => {
  const s = getScenario('two-lineages'); mutate(s);
  assert.throws(() => validateScenario(s));
});

test('unknown and missing model cards cannot pass coverage', () => {
  const s = getScenario('two-lineages');
  s.modelCardIds.push('unknown');
  assert.throws(() => validateModelCoverage(s), /unknown model card/);
  s.modelCardIds = [];
  assert.throws(() => validateModelCoverage(s), /missing model card/);
});

test('state checks references, counts, reciprocal adjacency and static matter', async () => {
  const good = await stateFixture();
  validateState(good); assert.equal(matterTotal(good), 200);
  for (const mutate of [
    (s: typeof good) => { s.cohorts.counts[0] = 0.5; },
    (s: typeof good) => { s.cohorts.cellIndices[0] = 10; },
    (s: typeof good) => { s.cohorts.lineageIndices[0] = 10; },
    (s: typeof good) => { s.lineages[0]!.parentId = 'l2'; },
    (s: typeof good) => { s.lineages[1]!.id = 'l1'; },
    (s: typeof good) => { s.lineages[1]!.traitId = 'missing'; },
    (s: typeof good) => { s.cells.nutrientMu[0] = 91; },
    (s: typeof good) => { s.cells.temperatureK[0] = Infinity; },
    (s: typeof good) => { s.cells.neighborOffsets = new Uint32Array([0, 1, 1]); s.cells.neighborIndices = new Uint32Array([1]); },
    (s: typeof good) => { s.cells.neighborIndices[0] = 0; },
    (s: typeof good) => { s.branch.forkTick = 1; },
    (s: typeof good) => { s.tick = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const copy = structuredClone(good); mutate(copy);
    assert.throws(() => validateState(copy));
  }
});

test('explicit external input balances the matter ledger', async () => {
  const state = await stateFixture();
  state.cells.nutrientMu[0]! += 25;
  state.ledger.externalMatterInMu += 25;
  validateState(state);
  assert.equal(matterTotal(state), 225);
});

test('all five command payloads validate; stale and malformed targets fail', () => {
  const context = { cellCount: 2, branchId: 'main', tick: 2, traitIds: ['cool'], cohorts: { c1: 10 } };
  const base = { id: 'cmd', branchId: 'main', atTick: 2, version: 1 };
  const commands = [
    { ...base, type: 'addNutrient', payload: { cells: [0], totalMu: 10 } },
    { ...base, type: 'disturbArea', payload: { cells: [0, 1], mortalityFraction: 0.5 } },
    { ...base, type: 'changeForcing', payload: { cells: [1], forcingWPerM2: -10, durationTicks: 3 } },
    { ...base, type: 'seedLife', payload: { cells: [0], traitId: 'cool', totalCount: 1, materialSource: 'local', reserveJPerIndividual: 1 } },
    { ...base, type: 'editTraits', payload: { cohortId: 'c1', count: 2, traits: getScenario('two-lineages').traits[0] } },
  ];
  commands.forEach(c => validateIntervention(c, context));
  for (const invalid of [
    { ...commands[0], branchId: 'wrong' }, { ...commands[0], atTick: 1 },
    { ...commands[0], payload: { cells: [0, 0], totalMu: 1 } },
    { ...commands[0], payload: { cells: [2], totalMu: 1 } },
    { ...commands[0], payload: { cells: [], totalMu: 1 } },
    { ...commands[0], payload: { cells: [0], totalMu: -1 } },
    { ...commands[4], payload: { cohortId: 'c1', count: 11, traits: getScenario('two-lineages').traits[0] } },
    { ...commands[2], atTick: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => validateIntervention(invalid, context));
});
