import type { Scenario, Ruleset, Traits, Intervention } from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import * as v from './validation.ts';

export function validateTraits(input: unknown, path = 'traits'): asserts input is Traits {
  const t = v.object(input, ['id', 'thermalOptimumK', 'thermalWidthK', 'uptakeMuPerIndividualSecond', 'maintenanceJPerIndividualSecond', 'dispersalPerSecond'], path);
  v.id(t.id, `${path}.id`);
  v.number(t.thermalOptimumK, `${path}.thermalOptimumK`, 150, 400);
  v.number(t.thermalWidthK, `${path}.thermalWidthK`, 0.1, 100);
  v.number(t.uptakeMuPerIndividualSecond, `${path}.uptakeMuPerIndividualSecond`, 0, 1);
  v.number(t.maintenanceJPerIndividualSecond, `${path}.maintenanceJPerIndividualSecond`, 0, 1e6);
  v.number(t.dispersalPerSecond, `${path}.dispersalPerSecond`, 0, 1);
}

export function validateRules(input: unknown, path = 'rules'): asserts input is Ruleset {
  const r = v.object(input, ['id', 'version', 'tickSeconds', 'limits', 'environment', 'life', 'modelCardIds'], path);
  v.id(r.id, `${path}.id`); v.choice(r.version, ['2.0.0'], `${path}.version`);
  v.number(r.tickSeconds, `${path}.tickSeconds`, 1, 86400);
  const l = v.object(r.limits, ['maxCells', 'maxCohorts'], `${path}.limits`);
  v.integer(l.maxCells, `${path}.limits.maxCells`, 1, 20480);
  v.integer(l.maxCohorts, `${path}.limits.maxCohorts`, 1, 100000);
  const e = v.object(r.environment, ['heatCapacityJPerM2K', 'emissivity', 'albedo', 'lifeAlbedoDelta', 'irradianceWPerM2', 'heatExchangeWPerM2K', 'recyclingPerSecond'], `${path}.environment`);
  for (const [key, min, max] of [
    ['heatCapacityJPerM2K', 1, 1e12], ['emissivity', 0.01, 1], ['albedo', 0, 1], ['lifeAlbedoDelta', -0.2, 0.2],
    ['irradianceWPerM2', 0, 1e5], ['heatExchangeWPerM2K', 0, 1e6], ['recyclingPerSecond', 0, 1],
  ] as const) v.number(e[key], `${path}.environment.${key}`, min, max);
  v.number((e.albedo as number)+(e.lifeAlbedoDelta as number), `${path}.environment.coveredAlbedo`, 0, 1);
  const b = v.object(r.life, ['structureMuPerIndividual', 'birthEnergyJPerIndividual', 'halfSaturationMu', 'backgroundDeathPerSecond', 'mutationProbability', 'mutationRelativeScale', 'maxHarvestJPerIndividualSecond', 'starvationDeathPerSecond', 'thermalDeathPerSecond'], `${path}.life`);
  for (const [key, min, max] of [
    ['structureMuPerIndividual', 1e-12, 1e12], ['birthEnergyJPerIndividual', 1e-12, 1e12],
    ['halfSaturationMu', 1e-12, 1e12], ['backgroundDeathPerSecond', 0, 1],
    ['mutationProbability', 0, 1], ['mutationRelativeScale', 0, 1],
    ['maxHarvestJPerIndividualSecond', 0, 1e6], ['starvationDeathPerSecond', 0, 1], ['thermalDeathPerSecond', 0, 1],
  ] as const) v.number(b[key], `${path}.life.${key}`, min, max);
  if (!v.ids(r.modelCardIds, `${path}.modelCardIds`).length) v.fail(path, 'requires model cards');
}

export function validateScenario(input: unknown): asserts input is Scenario {
  const s = v.object(input, ['schemaVersion', 'id', 'title', 'description', 'mode', 'evidence', 'seed', 'epochLabel', 'planet', 'rules', 'traits', 'populations', 'modelCardIds'], 'scenario');
  v.choice(s.schemaVersion, [SCHEMA_VERSION], 'scenario.schemaVersion');
  v.id(s.id, 'scenario.id'); v.text(s.title, 'scenario.title'); v.text(s.description, 'scenario.description');
  v.choice(s.mode, ['free'], 'scenario.mode'); v.choice(s.evidence, ['authored'], 'scenario.evidence');
  v.text(s.seed, 'scenario.seed', 256); v.text(s.epochLabel, 'scenario.epochLabel', 256);
  validateRules(s.rules);
  const p = v.object(s.planet, ['cellCount', 'radiusM', 'oceanFraction', 'initialTemperatureK', 'nutrientMuPerCell', 'detritusMuPerCell'], 'planet');
  const count = v.choice(p.cellCount, [320, 1280, 5120, 20480], 'planet.cellCount');
  if (count > s.rules.limits.maxCells) v.fail('planet.cellCount', 'exceeds rules cell budget');
  v.number(p.radiusM, 'planet.radiusM', 1, 1e9);
  const ocean = v.number(p.oceanFraction, 'planet.oceanFraction', 0, 1);
  v.number(p.initialTemperatureK, 'planet.initialTemperatureK', 150, 400);
  v.number(p.nutrientMuPerCell, 'planet.nutrientMuPerCell', 0, 1e12);
  v.number(p.detritusMuPerCell, 'planet.detritusMuPerCell', 0, 1e12);
  const traits = v.array(s.traits, 'traits', 1000);
  const traitIds = traits.map((t, i) => { validateTraits(t, `traits[${i}]`); return t.id; });
  v.unique(traitIds, 'traits');
  let totalCount = 0;
  for (const [i, value] of v.array(s.populations, 'populations', 1000).entries()) {
    const path = `populations[${i}]`;
    const pop = v.object(value, ['traitId', 'count', 'reserveJPerIndividual', 'habitat', 'materialSource'], path);
    if (!traitIds.includes(v.id(pop.traitId, `${path}.traitId`))) v.fail(path, 'unknown trait reference');
    totalCount += v.integer(pop.count, `${path}.count`, 1, 1e9);
    v.number(pop.reserveJPerIndividual, `${path}.reserveJPerIndividual`, 0, 1e12);
    const habitat = v.choice(pop.habitat, ['ocean', 'land', 'any'], `${path}.habitat`);
    if ((habitat === 'ocean' && ocean === 0) || (habitat === 'land' && ocean === 1)) v.fail(path, 'habitat unavailable');
    v.choice(pop.materialSource, ['local', 'external'], `${path}.materialSource`);
  }
  v.integer(totalCount, 'populations.totalCount');
  if (!v.ids(s.modelCardIds, 'scenario.modelCardIds').length) v.fail('scenario.modelCardIds', 'required');
}

/** Validate shape and optional current-world targets; this does not execute commands. */
export function validateIntervention(input: unknown, context?: { cellCount: number; branchId: string; tick: number; traitIds: string[]; cohorts: Record<string, number> }): asserts input is Intervention {
  const c = v.object(input, ['id', 'branchId', 'atTick', 'version', 'type', 'payload'], 'command');
  v.id(c.id, 'command.id'); v.id(c.branchId, 'command.branchId');
  const tick = v.integer(c.atTick, 'command.atTick'); v.choice(c.version, [1], 'command.version');
  const type = v.choice(c.type, ['addNutrient', 'disturbArea', 'changeForcing', 'seedLife', 'editTraits'], 'command.type');
  if (context && (c.branchId !== context.branchId || tick < context.tick)) v.fail('command', 'stale branch or tick');
  const fields = {
    addNutrient: ['cells', 'totalMu'], disturbArea: ['cells', 'mortalityFraction'],
    changeForcing: ['cells', 'forcingWPerM2', 'durationTicks'],
    seedLife: ['cells', 'traitId', 'totalCount', 'materialSource', 'reserveJPerIndividual'],
    editTraits: ['cohortId', 'count', 'traits'],
  }[type];
  const p = v.object(c.payload, fields, 'command.payload');
  if (type !== 'editTraits') {
    const cells = v.array(p.cells, 'command.payload.cells', 20480).map((x, i) => v.integer(x, `command.payload.cells[${i}]`, 0, (context?.cellCount ?? 20480) - 1));
    if (!cells.length) v.fail('command.payload.cells', 'cannot be empty');
    v.unique(cells, 'command.payload.cells');
  }
  if (type === 'addNutrient') v.number(p.totalMu, 'command.payload.totalMu', 1e-12, 1e12);
  if (type === 'disturbArea') v.number(p.mortalityFraction, 'command.payload.mortalityFraction', 0, 1);
  if (type === 'changeForcing') {
    v.number(p.forcingWPerM2, 'command.payload.forcingWPerM2', -1e5, 1e5);
    const duration = v.integer(p.durationTicks, 'command.payload.durationTicks', 1);
    v.integer(tick + duration, 'command.endTick');
  }
  if (type === 'seedLife') {
    const trait = v.id(p.traitId, 'command.payload.traitId');
    if (context && !context.traitIds.includes(trait)) v.fail('command.payload.traitId', 'unknown trait');
    v.integer(p.totalCount, 'command.payload.totalCount', 1, 1e9);
    v.number(p.reserveJPerIndividual, 'command.payload.reserveJPerIndividual', 0, 1e12);
    v.choice(p.materialSource, ['local', 'external'], 'command.payload.materialSource');
  }
  if (type === 'editTraits') {
    const cohort = v.id(p.cohortId, 'command.payload.cohortId');
    const count = v.integer(p.count, 'command.payload.count', 1, 1e9);
    validateTraits(p.traits, 'command.payload.traits');
    if (context && (!Object.hasOwn(context.cohorts, cohort) || count > context.cohorts[cohort]!)) v.fail('command.payload', 'unknown cohort or insufficient count');
  }
}
