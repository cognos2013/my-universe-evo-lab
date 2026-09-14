/** Versioned interchange contract. Units are part of field names, not UI conventions. */
export const SCHEMA_VERSION = '4.0.0' as const;
export const ENGINE_VERSION = '0.5.0' as const;
export const RNG_ALGORITHM = 'xoshiro128ss-sha256-v1' as const;
export const UNITS = Object.freeze({
  time: 's', temperature: 'K', area: 'm²', energy: 'J',
  irradiance: 'W/m²', matter: 'MU (model matter, not real chemical mass)',
});

export interface Traits {
  id: string;
  thermalOptimumK: number;
  thermalWidthK: number;
  uptakeMuPerIndividualSecond: number;
  maintenanceJPerIndividualSecond: number;
  dispersalPerSecond: number;
}

export interface Ruleset {
  id: string;
  version: string;
  tickSeconds: number;
  limits: { maxCells: number; maxCohorts: number };
  environment: {
    heatCapacityJPerM2K: number;
    emissivity: number;
    albedo: number;
    lifeAlbedoDelta: number;
    irradianceWPerM2: number;
    heatExchangeWPerM2K: number;
    recyclingPerSecond: number;
  };
  life: {
    structureMuPerIndividual: number;
    birthEnergyJPerIndividual: number;
    halfSaturationMu: number;
    backgroundDeathPerSecond: number;
    mutationProbability: number;
    mutationRelativeScale: number;
    maxHarvestJPerIndividualSecond: number;
    starvationDeathPerSecond: number;
    thermalDeathPerSecond: number;
  };
  modelCardIds: string[];
}

export interface Scenario {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  mode: 'free'; // Ecological MVP only: do not pretend historical/future modes are implemented.
  evidence: 'authored';
  seed: string;
  epochLabel: string;
  planet: {
    cellCount: 320 | 1280 | 5120 | 20480;
    radiusM: number;
    oceanFraction: number;
    initialTemperatureK: number;
    nutrientMuPerCell: number;
    detritusMuPerCell: number;
  };
  rules: Ruleset;
  traits: Traits[];
  populations: Array<{
    traitId: string;
    count: number;
    reserveJPerIndividual: number;
    habitat: 'ocean' | 'land' | 'any';
    materialSource: 'local' | 'external';
  }>;
  modelCardIds: string[];
}

export interface RngSnapshot {
  algorithm: typeof RNG_ALGORITHM;
  state: [number, number, number, number];
}

export interface WorldManifest {
  id: string;
  mode: 'free';
  schemaVersion: typeof SCHEMA_VERSION;
  engineVersion: typeof ENGINE_VERSION;
  scenarioId: string;
  seed: string;
  rulesetHash: string;
  epoch: { label: string; tickDurationSeconds: number };
}

export interface Lineage {
  id: string;
  parentId: string | null;
  originTick: number;
  traitId: string;
  origin: 'seeded' | 'mutation' | 'intervention';
}

export interface WorldState {
  manifest: WorldManifest;
  rules: Ruleset;
  branch: { id: string; parentId: string | null; forkTick: number; checkpointHash: string | null };
  tick: number;
  cells: {
    areaM2: Float64Array;
    landFraction: Float64Array;
    temperatureK: Float64Array;
    nutrientMu: Float64Array;
    detritusMu: Float64Array;
    // CSR adjacency: neighbors of i = indices[offsets[i]..offsets[i+1]].
    neighborOffsets: Uint32Array;
    neighborIndices: Uint32Array;
  };
  cohorts: {
    ids: string[];
    cellIndices: Uint32Array;
    lineageIndices: Uint32Array;
    counts: Float64Array; // validated safe integers, not fractional individuals
    energyReserveJ: Float64Array;
  };
  traits: Traits[];
  lineages: Lineage[];
  rng: RngSnapshot;
  execution: {
    receipts: { id: string; digest: string }[];
    forcings: { id: string; cells: number[]; startTick: number; endTick: number; forcingWPerM2: number }[];
  };
  ledger: { initialMatterMu: number; externalMatterInMu: number; externalMatterOutMu: number; initialEnergyJ: number; externalEnergyInJ: number; externalEnergyOutJ: number };
}

export interface ModelCard {
  id: string;
  version: string;
  title: string;
  status: 'contract' | 'planned' | 'implemented';
  evidence: 'authored';
  assumptions: string[];
  validRange: string[];
  limitations: string[];
  sources: string[];
}

export type Intervention = {
  id: string;
  branchId: string;
  atTick: number;
  version: 1;
} & (
  | { type: 'addNutrient'; payload: { cells: number[]; totalMu: number } }
  | { type: 'disturbArea'; payload: { cells: number[]; mortalityFraction: number } }
  | { type: 'changeForcing'; payload: { cells: number[]; forcingWPerM2: number; durationTicks: number } }
  | { type: 'seedLife'; payload: { cells: number[]; traitId: string; totalCount: number; materialSource: 'local' | 'external'; reserveJPerIndividual: number } }
  | { type: 'editTraits'; payload: { cohortId: string; count: number; traits: Traits } }
);
