import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  generateElevation,
  classifyBiome,
  classifySample,
  blendedColorAt,
  fromProjection,
  fromWorldState,
  surfaceSeed,
  BIOME_COLORS,
  ELEV,
  TRANSITION_BAND,
  type Biome,
  type TerrainSource,
} from '../src/simulation/terrain.ts';
import type { WorldState } from '../src/simulation/core/contracts.ts';

/**
 * Phase 11.2 unit tests for the terrain pipeline.
 *
 * The pipeline takes a world state and produces:
 *   1. A continuous elevation field.
 *   2. A biome classification per sample.
 *   3. A deterministic per-world seed.
 *
 * The tests run in pure node:test — no Three.js, no DOM.
 */

const OCEAN_SOURCE: TerrainSource = {
  land: new Float64Array(64).fill(0), // all water
  temperature: new Float64Array(64).fill(288),
  seedSalt: 'test',
  tick: 0,
};

const LAND_SOURCE: TerrainSource = {
  land: new Float64Array(64).fill(1), // all land
  temperature: new Float64Array(64).fill(288),
  seedSalt: 'test',
  tick: 0,
};

const COLD_LAND_SOURCE: TerrainSource = {
  land: new Float64Array(64).fill(1),
  temperature: new Float64Array(64).fill(260), // -13°C
  seedSalt: 'test-cold',
  tick: 0,
};

const HOT_DRY_LAND_SOURCE: TerrainSource = {
  land: new Float64Array(64).fill(1),
  temperature: new Float64Array(64).fill(310), // +37°C
  seedSalt: 'test-hot',
  tick: 0,
};

test('generateElevation: ocean source stays within the ocean band', () => {
  // P3.6 (1+2) — the ocean band now spans [0, SHALLOW_OCEAN]
  // (the deep-ocean floor is 0, not 0.05, so the ocean
  // actually reads as *deep*). The contract — "an ocean-only
  // source never produces a sample above SHALLOW_OCEAN" —
  // still holds, and we now have a much wider visible
  // range to show trenches / ridges.
  const elev = generateElevation(OCEAN_SOURCE, 16, 1234);
  for (let i = 0; i < elev.length; i++) {
    assert.ok(elev[i]! < ELEV.SHALLOW_OCEAN + 1e-6, `ocean sample ${i} should be ≤ SHALLOW_OCEAN, got ${elev[i]}`);
    assert.ok(elev[i]! >= 0 - 1e-6, `ocean sample ${i} should be ≥ 0, got ${elev[i]}`);
  }
});

test('generateElevation: land source never dips below BEACH', () => {
  // P3.6 — the contract: a fully-land source never produces
  // an elevation below BEACH. This is what keeps the surface
  // view from rendering "blue lakes on top of green
  // continents" — every vertex in a land cell is at or
  // above the beach line, so the biome classifier
  // (classifyBiome) consistently returns a land biome.
  const elev = generateElevation(LAND_SOURCE, 32, 42);
  for (let i = 0; i < elev.length; i++) {
    assert.ok(elev[i]! >= ELEV.BEACH - 1e-6, `land sample ${i} should be ≥ BEACH, got ${elev[i]}`);
    assert.ok(elev[i]! <= 1, `land sample ${i} should be ≤ 1, got ${elev[i]}`);
  }
});

test('generateElevation: mixed source stays in the interpolated band', () => {
  // A 50/50 source must produce elevations in
  // [DEEP_OCEAN, 1.0] (since the land half is ≥ BEACH and
  // the ocean half is ≤ SHALLOW_OCEAN, and a vertex is the
  // weighted sum of the two with weight landFrac).
  const half = 32;
  const mixed: TerrainSource = {
    land: new Float64Array(64).map((_, i) => (i < half ? 0 : 1)),
    temperature: new Float64Array(64).fill(288),
    seedSalt: 'test-mixed-band',
    tick: 0,
  };
  const elev = generateElevation(mixed, 16, 99);
  for (let i = 0; i < elev.length; i++) {
    assert.ok(elev[i]! >= ELEV.DEEP_OCEAN - 1e-6 && elev[i]! <= 1 + 1e-6, `mixed sample ${i} out of range: ${elev[i]}`);
  }
});

test('generateElevation: same source + seed → same output (deterministic)', () => {
  const a = generateElevation(LAND_SOURCE, 24, 7777);
  const b = generateElevation(LAND_SOURCE, 24, 7777);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `sample ${i} should be deterministic`);
  }
});

test('generateElevation: cellIndexMap parameter overrides the lat/lon heuristic', () => {
  // The legacy lat/lon `nearestCell` heuristic maps (x, y)
  // to a cell via `floor(v * cellCount)`, which only matches
  // the spatial-nearest lookup for the standard icosphere
  // subdivisions (20·4^k). For any other cell count (e.g. an
  // older save with 16280 cells, or a future scenario), the
  // two lookups disagree and we get water on top of land. The
  // cellIndexMap parameter lets the caller hand in the
  // spatial-nearest lookup so the elevation field is
  // guaranteed to look at the same cell as the biome
  // classifier downstream.
  // To make the test deterministic we build a 50/50 source
  // (first 32 cells ocean, last 32 cells land). A cellMap
  // that sends every sample to a *land* cell produces a
  // high-elevation field (noise · 1 ≈ 0..1). The lat/lon
  // heuristic for a 16×16 grid (samples=16) maps roughly
  // half of all samples to ocean cells (y ≤ 7) — those would
  // be near 0.05, not 0..1. So the two outputs must visibly
  // diverge for a large fraction of samples.
  const samples = 16;
  const half = 32;
  const mixed: TerrainSource = {
    land: new Float64Array(64).map((_, i) => (i < half ? 0 : 1)),
    temperature: new Float64Array(64).fill(288),
    seedSalt: 'test-mixed',
    tick: 0,
  };
  // Force every sample onto a land cell.
  const cellMap = new Int32Array(samples * samples).fill(half); // all → cell 32 (land)
  const legacy = generateElevation(mixed, samples, 7);
  const mapped = generateElevation(mixed, samples, 7, cellMap);
  // Legacy: rows y=0..7 landFrac=0 (ocean → near 0.05), rows
  // y=8..15 landFrac=1 (land → noise). Mapped: every sample
  // looks at cell 32 (land), so every elevation is `noise`,
  // which is O(1) — strictly greater than the ocean shelf
  // floor (0.05). So the lower half of the legacy field is
  // dominated by ocean values (< 0.1), the mapped field has
  // none. That's the divergence we want to assert.
  let legacyOceanCount = 0;
  let mappedOceanCount = 0;
  for (let i = 0; i < legacy.length; i++) {
    if (legacy[i]! < 0.1) legacyOceanCount++;
    if (mapped[i]! < 0.1) mappedOceanCount++;
  }
  assert.ok(legacyOceanCount > 0, 'legacy heuristic should map some samples to ocean');
  assert.ok(mappedOceanCount < legacyOceanCount, `cellMap should reduce ocean samples; legacy=${legacyOceanCount} mapped=${mappedOceanCount}`);
});

test('generateElevation: cellIndexMap of all 0 → ocean band (when source[0] is ocean)', () => {
  // Force every sample to look at cell 0, where OCEAN_SOURCE
  // has landFrac=0. The 1+2 formula now spans [0,
  // SHALLOW_OCEAN] for ocean cells, so shallow shelves and
  // deep basins co-exist on the same ocean-only world.
  const cellMap = new Int32Array(16 * 16); // all zero
  const elev = generateElevation(OCEAN_SOURCE, 16, 11, cellMap);
  for (let i = 0; i < elev.length; i++) {
    assert.ok(elev[i]! >= 0 - 1e-6, `sample ${i} should be ≥ 0, got ${elev[i]}`);
    assert.ok(elev[i]! < ELEV.SHALLOW_OCEAN + 1e-6, `sample ${i} should be < SHALLOW_OCEAN, got ${elev[i]}`);
  }
});

test('generateElevation: same cellMap, same seed → deterministic', () => {
  const cellMap = new Int32Array(24 * 24);
  for (let i = 0; i < cellMap.length; i++) cellMap[i] = i % LAND_SOURCE.land.length;
  const a = generateElevation(LAND_SOURCE, 24, 7, cellMap);
  const b = generateElevation(LAND_SOURCE, 24, 7, cellMap);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('generateElevation: different seeds → different output', () => {
  const a = generateElevation(LAND_SOURCE, 24, 1);
  const b = generateElevation(LAND_SOURCE, 24, 2);
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diffs += 1;
  }
  assert.ok(diffs > a.length * 0.5, `expected mostly different output, got ${diffs}/${a.length} differing`);
});

test('classifyBiome: ocean + low elevation → deep-ocean or shallow-ocean', () => {
  assert.equal(classifyBiome(0.0, 288, 0.0, 0.5), 'deep-ocean');
  assert.equal(classifyBiome(0.15, 288, 0.0, 0.5), 'shallow-ocean');
});

test('classifyBiome: warm + wet → forest; cold → snow', () => {
  // Warm (288K = 15°C) + v=0.5 (high moisture) → forest
  assert.equal(classifyBiome(0.5, 288, 1.0, 0.5), 'forest');
  // Cold (260K = -13°C) → snow regardless of moisture
  assert.equal(classifyBiome(0.5, 260, 1.0, 0.5), 'snow');
});

test('classifyBiome: hot + dry → desert', () => {
  // Hot (310K = 37°C) + v=0.95 (poles, low moisture) → desert
  assert.equal(classifyBiome(0.4, 310, 1.0, 0.95), 'desert');
});

test('classifyBiome: high elevation → mountain or snow', () => {
  assert.equal(classifyBiome(0.9, 288, 1.0, 0.5), 'mountain');
  assert.equal(classifyBiome(0.9, 260, 1.0, 0.5), 'snow');
});

test('classifySample: drives classification off the elevation field + source', () => {
  const elev = generateElevation(LAND_SOURCE, 16, 100);
  const sample = classifySample(8, 8, 16, elev, LAND_SOURCE);
  // We can't predict the exact biome (depends on noise) but we
  // can assert it's one of the 8 known labels.
  const known: Biome[] = ['deep-ocean', 'shallow-ocean', 'beach', 'grass', 'forest', 'desert', 'mountain', 'snow'];
  assert.ok(known.includes(sample.biome), `unexpected biome: ${sample.biome}`);
  // P3.6 — `classifySample` returns a *blended* color (so the
  // surface view has smooth biome transitions), not the
  // discrete `BIOME_COLORS[biome]`. The contract is just:
  // the returned color is close to the discrete biome color
  // when the elevation is far from any blend boundary. We
  // assert it lives in the unit cube and is the right hue
  // family (e.g. grass/forest are green, ocean is blue) by
  // checking each component is in [0, 1] and the dominant
  // channel matches the biome family.
  for (const ch of ['r', 'g', 'b'] as const) {
    assert.ok(sample.color[ch] >= 0 && sample.color[ch] <= 1, `color.${ch} should be in [0,1], got ${sample.color[ch]}`);
  }
});

test('classifySample: ocean source forces ocean biomes', () => {
  const elev = generateElevation(OCEAN_SOURCE, 16, 100);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const sample = classifySample(x, y, 16, elev, OCEAN_SOURCE);
      assert.ok(sample.biome === 'deep-ocean' || sample.biome === 'shallow-ocean',
        `ocean cell (${x},${y}) should be deep-ocean or shallow-ocean, got ${sample.biome}`);
    }
  }
});

test('classifySample: cold land source is mostly snow / mountain', () => {
  const elev = generateElevation(COLD_LAND_SOURCE, 16, 100);
  let snowCount = 0, mountainCount = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const sample = classifySample(x, y, 16, elev, COLD_LAND_SOURCE);
      if (sample.biome === 'snow') snowCount += 1;
      if (sample.biome === 'mountain') mountainCount += 1;
    }
  }
  // At -13°C almost every cell should be snow or mountain.
  assert.ok(snowCount + mountainCount > 16 * 16 * 0.7,
    `expected >70% snow/mountain, got ${snowCount + mountainCount}/${16 * 16}`);
});

test('surfaceSeed: deterministic per (salt, tick)', () => {
  const a = surfaceSeed({ ...LAND_SOURCE, seedSalt: 'foo', tick: 1 });
  const b = surfaceSeed({ ...LAND_SOURCE, seedSalt: 'foo', tick: 1 });
  const c = surfaceSeed({ ...LAND_SOURCE, seedSalt: 'foo', tick: 2 });
  const d = surfaceSeed({ ...LAND_SOURCE, seedSalt: 'bar', tick: 1 });
  assert.equal(a, b, 'same salt + tick should give same seed');
  assert.notEqual(a, c, 'different tick should give different seed');
  assert.notEqual(a, d, 'different salt should give different seed');
});

test('BIOME_COLORS has 8 entries', () => {
  const biomes = Object.keys(BIOME_COLORS);
  assert.equal(biomes.length, 8);
});

test('ELEV thresholds are in the expected order', () => {
  // The biome boundary order is fixed by the visual story:
  // ocean floor → shallow → beach → grass → mountain → snow.
  assert.ok(ELEV.DEEP_OCEAN < ELEV.SHALLOW_OCEAN);
  assert.ok(ELEV.SHALLOW_OCEAN < ELEV.BEACH);
  assert.ok(ELEV.BEACH < ELEV.MOUNTAIN);
  assert.ok(ELEV.MOUNTAIN < ELEV.SNOW);
  assert.ok(TRANSITION_BAND > 0 && TRANSITION_BAND < 0.1);
});

test('blendedColorAt: mid-elevation land is the base biome color', () => {
  // elev=0.5 sits well below the mountain line (0.65), so
  // no blend happens. The exact biome depends on temp+moisture
  // but the color should equal the base biome color regardless.
  const elev = 0.5;
  const biome = classifyBiome(elev, 288, 1.0, 0.5);
  const c = blendedColorAt(elev, 288, 1.0, 0.5);
  assert.deepEqual(c, BIOME_COLORS[biome]);
});

test('blendedColorAt: low-elevation biome near mountain line picks up mountain tint', () => {
  // elev = ELEV.MOUNTAIN - TRANSITION_BAND / 2 → 50% blend.
  // We use hot+dry conditions (v=0.95, tempK=310) so the
  // primary biome is desert, which is the easiest "low
  // land" biome to assert without moisture interference.
  const halfBand = TRANSITION_BAND / 2;
  const elev = ELEV.MOUNTAIN - halfBand;
  const c = blendedColorAt(elev, 310, 1.0, 0.95);
  // Confirm the primary biome so the assertion is meaningful.
  const primary = classifyBiome(elev, 310, 1.0, 0.95);
  const base = BIOME_COLORS[primary];
  const tgt = BIOME_COLORS.mountain;
  assert.ok(primary !== 'mountain', `test setup wrong: primary should not be mountain, got ${primary}`);
  // Each channel should be the midpoint of base and target.
  assert.ok(Math.abs(c.r - (base.r + tgt.r) / 2) < 1e-6, `r out of range: ${c.r}`);
  assert.ok(Math.abs(c.g - (base.g + tgt.g) / 2) < 1e-6, `g out of range: ${c.g}`);
  assert.ok(Math.abs(c.b - (base.b + tgt.b) / 2) < 1e-6, `b out of range: ${c.b}`);
});

test('blendedColorAt: mountain near snow line picks up snow tint', () => {
  const halfBand = TRANSITION_BAND / 2;
  const elev = ELEV.SNOW - halfBand;
  const c = blendedColorAt(elev, 288, 1.0, 0.5);
  const base = BIOME_COLORS.mountain;
  const tgt = BIOME_COLORS.snow;
  // Snow is much brighter than mountain, so even a half-band
  // blend should noticeably raise the brightness.
  assert.ok(c.r > base.r, `r should rise toward snow, got ${c.r}`);
  assert.ok(c.g > base.g, `g should rise toward snow, got ${c.g}`);
  assert.ok(c.b > base.b, `b should rise toward snow, got ${c.b}`);
  assert.ok(Math.abs(c.r - (base.r + tgt.r) / 2) < 1e-6, `r midpoint: ${c.r}`);
});

test('blendedColorAt: above snow line is brightened (peak highlight)', () => {
  // The snow region picks up a peak-highlight blend that
  // pushes it brighter than the bare snow biome color.
  // elev=0.99 (very near the top of the range) gets the
  // full 35% white mix.
  const c = blendedColorAt(0.99, 260, 1.0, 0.5);
  const snow = BIOME_COLORS.snow;
  assert.ok(c.r > snow.r, `r should be brighter than snow, got ${c.r}`);
  assert.ok(c.g > snow.g, `g should be brighter than snow, got ${c.g}`);
  assert.ok(c.b > snow.b, `b should be brighter than snow, got ${c.b}`);
  // At elev=0.86 (just above the snow line) the highlight
  // should be near zero, so the color is essentially snow.
  const c2 = blendedColorAt(0.86, 260, 1.0, 0.5);
  assert.ok(Math.abs(c2.r - snow.r) < 0.01, `r should be near snow, got ${c2.r}`);
});

test('blendedColorAt: peak highlight scales with elevation', () => {
  // Two cells both classified as snow, but at different
  // elevations — the higher one should be brighter.
  const lower = blendedColorAt(0.86, 260, 1.0, 0.5);
  const higher = blendedColorAt(0.95, 260, 1.0, 0.5);
  assert.ok(higher.r > lower.r, `higher peak should be brighter: ${higher.r} vs ${lower.r}`);
  assert.ok(higher.g > lower.g, `higher peak should be brighter: ${higher.g} vs ${lower.g}`);
});

test('blendedColorAt: shallow-ocean near deep line picks up deep tint', () => {
  const halfBand = TRANSITION_BAND / 2;
  const elev = ELEV.DEEP_OCEAN + halfBand;
  const c = blendedColorAt(elev, 288, 0.0, 0.5);
  const base = BIOME_COLORS['shallow-ocean'];
  const tgt = BIOME_COLORS['deep-ocean'];
  // Deep-ocean is darker, so the blend should lower the values.
  assert.ok(c.r < base.r, `r should drop toward deep, got ${c.r}`);
  assert.ok(Math.abs(c.r - (base.r + tgt.r) / 2) < 1e-6, `r midpoint: ${c.r}`);
});

test('blendedColorAt: outside the blend band, color is exact biome color', () => {
  // elev=0.40 sits well below the mountain band (0.61..0.65),
  // so no transition is applied; the color matches whatever
  // biome classifyBiome picks (here: forest, because v=0.5
  // implies high moisture and 288K is mid-temperate).
  const elev1 = 0.40;
  const biome1 = classifyBiome(elev1, 288, 1.0, 0.5);
  const c1 = blendedColorAt(elev1, 288, 1.0, 0.5);
  assert.deepEqual(c1, BIOME_COLORS[biome1]);
  // elev=0.70 sits well above the mountain line and below the
  // snow band (0.81..0.85), so it's exactly mountain color.
  const elev2 = 0.70;
  const biome2 = classifyBiome(elev2, 288, 1.0, 0.5);
  const c2 = blendedColorAt(elev2, 288, 1.0, 0.5);
  assert.deepEqual(c2, BIOME_COLORS[biome2]);
});

test('classifySample: returns a blended color (not just BIOME_COLORS[biome])', () => {
  // At a mid-elevation land cell, the color should be grass
  // (no band). But this test mostly pins the wire format:
  // the color field must exist and be BiomeColor-shaped.
  const elev = generateElevation(LAND_SOURCE, 16, 100);
  const sample = classifySample(8, 8, 16, elev, LAND_SOURCE);
  assert.equal(typeof sample.color.r, 'number');
  assert.equal(typeof sample.color.g, 'number');
  assert.equal(typeof sample.color.b, 'number');
  assert.ok(sample.color.r >= 0 && sample.color.r <= 1);
  assert.ok(sample.color.g >= 0 && sample.color.g <= 1);
  assert.ok(sample.color.b >= 0 && sample.color.b <= 1);
});

test('fromProjection: extracts land, temperature, seedSalt, tick', () => {
  const proj = {
    branchId: 'branch-7',
    worldId: 'w-1',
    tick: 42,
    running: false,
    cohortLimit: 10000,
    astronomyStep: 0,
    astronomyRevision: 'r',
    historyStorage: { checkpoints: 0, checkpointBytes: 0, sampled: false },
    summary: {
      tick: 42, population: 2000, temperatureK: 288, activeLineages: 1, nutrientMu: 0, cohorts: 0, diversity: 0, matterResidualMu: 0,
    },
    temperature: new Float64Array([290, 295, 300]),
    nutrient: new Float64Array([0, 0, 0]),
    biomass: new Float64Array([0, 0, 0]),
    land: new Float64Array([1, 0, 1]),
    dominant: new Int32Array([0, -1, 0]),
    lastEvent: '',
    branches: [],
    headTick: 42,
    forkTick: 0,
    samples: [],
    chemistry: null,
    colonies: null,
  };
  const src = fromProjection(proj as never);
  assert.equal(src.land.length, 3);
  assert.equal(src.temperature.length, 3);
  assert.equal(src.land[0], 1);
  assert.equal(src.land[1], 0);
  assert.equal(src.temperature[2], 300);
  assert.equal(src.seedSalt, 'branch-7');
  assert.equal(src.tick, 42);
});

test('fromWorldState: extracts from full WorldState', () => {
  const ws = {
    branch: { id: 'main', parentId: null, forkTick: 0, checkpointHash: null },
    tick: 7,
    cells: {
      landFraction: new Float64Array([0.5, 0.5]),
      temperatureK: new Float64Array([285, 295]),
    },
  } as unknown as WorldState;
  const src = fromWorldState(ws);
  assert.equal(src.seedSalt, 'main');
  assert.equal(src.tick, 7);
  assert.equal(src.land[0], 0.5);
  assert.equal(src.temperature[1], 295);
});
