import type { Scenario, Ruleset } from '../simulation/core/contracts.ts';
import { SCHEMA_VERSION } from '../simulation/core/contracts.ts';
import { validateScenario } from '../simulation/core/schema.ts';
import { validateModelCoverage } from '../knowledge/model-cards.ts';

const rules: Ruleset = {
  id: 'ecology-foundation', version: '2.0.0', tickSeconds: 86400,
  limits: { maxCells: 5120, maxCohorts: 10000 },
  environment: {
    heatCapacityJPerM2K: 4e8, emissivity: 0.61, albedo: 0.3, lifeAlbedoDelta: 0.04,
    irradianceWPerM2: 340, heatExchangeWPerM2K: 2, recyclingPerSecond: 0.01 / 86400,
  },
  life: {
    structureMuPerIndividual: 1, birthEnergyJPerIndividual: 10, halfSaturationMu: 100,
    backgroundDeathPerSecond: 0.001 / 86400, mutationProbability: 0.01, mutationRelativeScale: 0.05,
    maxHarvestJPerIndividualSecond: 2 / 86400, starvationDeathPerSecond: 0.5 / 86400, thermalDeathPerSecond: 0.05 / 86400,
  },
  modelCardIds: ['environment-energy-v1', 'matter-ledger-v1', 'cohort-evolution-v1', 'determinism-v1'],
};

const base: Scenario = {
  schemaVersion: SCHEMA_VERSION, id: 'two-lineages', title: '两种生命，同一颗星球',
  description: '两种温度偏好的人工队列；用于后续温度扰动与分支对照。已支持环境初始化与推进，生命演化在 P2 接入。',
  mode: 'free', evidence: 'authored', seed: 'my-universe-demo-v1', epochLabel: '生态实验第 0 日',
  planet: { cellCount: 320, radiusM: 6371000, oceanFraction: 0.7, initialTemperatureK: 288, nutrientMuPerCell: 1000, detritusMuPerCell: 0 },
  rules,
  traits: [
    { id: 'cool', thermalOptimumK: 283, thermalWidthK: 12, uptakeMuPerIndividualSecond: 0.1 / 86400, maintenanceJPerIndividualSecond: 0.01 / 86400, dispersalPerSecond: 0.01 / 86400 },
    { id: 'warm', thermalOptimumK: 298, thermalWidthK: 12, uptakeMuPerIndividualSecond: 0.1 / 86400, maintenanceJPerIndividualSecond: 0.01 / 86400, dispersalPerSecond: 0.01 / 86400 },
  ],
  populations: [
    { traitId: 'cool', count: 1000, reserveJPerIndividual: 20, habitat: 'ocean', materialSource: 'local' },
    { traitId: 'warm', count: 1000, reserveJPerIndividual: 20, habitat: 'ocean', materialSource: 'local' },
  ],
  modelCardIds: ['authored-scenario-v1'],
};

export const scenarioIds = ['empty-planet', 'two-lineages', 'closed-resources'] as const;

/** Return owned data: editing a scenario must not mutate templates or siblings. */
export function getScenario(id: string, resolution: 320 | 1280 | 5120 | 20480 = 320): Scenario {
  if (!(scenarioIds as readonly string[]).includes(id)) throw new Error(`Unknown scenario: ${id}`);
  const scenario = structuredClone(base);
  scenario.id = id;
  if(resolution>scenario.rules.limits.maxCells)scenario.rules.limits.maxCells=resolution;
  if (id === 'empty-planet') {
    scenario.title = '无生命星球';
    scenario.description = '无初始生物，用于验证模型不会无来源生成生命。';
    scenario.populations = [];
    // Keep the two authored genotype presets available for later artificial seeding.
  }
  if (id === 'closed-resources') {
    scenario.title = '有限资源，无回收';
    scenario.description = '关闭碎屑回收，验证后续增长受物质和能量约束；不是运行结果。';
    scenario.rules.environment.recyclingPerSecond = 0;
    scenario.rules.life.mutationProbability = 0;
    scenario.planet.nutrientMuPerCell = 20;
  }
  // Resolution changes the discretization, not the template's total material.
  const ratio=scenario.planet.cellCount/resolution;
  scenario.planet.cellCount=resolution;
  scenario.planet.nutrientMuPerCell*=ratio;
  scenario.planet.detritusMuPerCell*=ratio;
  // P3.5 fix: when scaling *up* resolution (more, smaller
  // cells), per-cell material may fall below 1, which
  // breaks the population-placement loop (cells can never
  // host a full individual — `Math.floor(<1) = 0` capacity)
  // and the matter ledger (debit > available would go
  // negative). Clamp the per-cell material to 1 (rounded
  // up) so a cell always has room for at least one
  // individual; total material is then slightly higher
  // than the authored value but the populations still fit.
  if (ratio < 1) {
    if (scenario.planet.nutrientMuPerCell > 0 && scenario.planet.nutrientMuPerCell < 1) {
      scenario.planet.nutrientMuPerCell = 1;
    }
    if (scenario.planet.detritusMuPerCell > 0 && scenario.planet.detritusMuPerCell < 1) {
      scenario.planet.detritusMuPerCell = 1;
    }
  }
  validateScenario(scenario);
  validateModelCoverage(scenario);
  return scenario;
}
