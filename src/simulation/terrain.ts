/**
 * Phase 11.2 — Terrain generation.
 *
 * The existing `WorldState` has `landFraction` and `temperatureK`
 * per cell but no explicit elevation. The surface view needs
 * a continuous heightmap so neighbouring cells share a believable
 * relief. This module synthesizes a heightmap from the existing
 * cell data (no schema change) plus a deterministic per-world
 * noise, then classifies each cell into a biome.
 *
 * The pipeline:
 *   1. `seededHash(x, y, seed)` — cheap integer hash for
 *      stable per-world RNG. Replaces a real Perlin / Simplex
 *      dependency (we can swap in simplex-noise later if the
 *      hand-rolled hash isn't smooth enough).
 *   2. `generateElevation(worldState, samples, seed)` —
 *      bilinear-interpolated 2D noise map, weighted by
 *      `landFraction` (oceans stay at 0). Returns a Float32Array
 *      of length `samples * samples` in row-major order
 *      (north → south, west → east).
 *   3. `classifyBiome(elev, tempK, landFrac, moisture)` —
 *      discrete biome label. Moisture is currently derived
 *      from temperature (proxy); future work can read a real
 *      moisture field from WorldState when the simulation
 *      grows one.
 *   4. `biomeColor(biome)` — RGB color for the surface
 *      shader / vertex color attribute.
 *
 * The output is deterministic for a given (worldState, samples,
 * seed) tuple, so the surface view can re-render on every
 * projection update without flicker.
 */

import type { WorldState } from './core/contracts.ts';
import type { Projection } from '../workers/controller.ts';

/**
 * Minimal shape the terrain pipeline needs from a world state.
 * Both the full `WorldState` and the lightweight `Projection`
 * (sent over the worker boundary) satisfy this — Projection
 * exposes `land` and `temperature` as flat Float64Arrays
 * alongside `worldId` / `tick` / `branchId`. The full
 * `WorldState` uses the nested `cells.landFraction` and
 * `cells.temperatureK`; the surface view normalizes both
 * into this common shape.
 */
export interface TerrainSource {
  land: Float64Array;
  temperature: Float64Array;
  /** A stable per-world seed. The full state has `branch.id` + `tick`; the projection has `branchId` + `tick`. */
  seedSalt: string;
  tick: number;
}

/** Discrete biome types the surface view can color + (later) populate. */
export type Biome =
  | 'deep-ocean' | 'shallow-ocean' | 'beach'
  | 'grass' | 'forest' | 'desert'
  | 'mountain' | 'snow';

export interface BiomeColor {
  r: number; g: number; b: number;
}

export const BIOME_COLORS: Record<Biome, BiomeColor> = {
  'deep-ocean':    { r: 0.07, g: 0.20, b: 0.36 },
  'shallow-ocean': { r: 0.10, g: 0.35, b: 0.50 },
  'beach':         { r: 0.85, g: 0.78, b: 0.55 },
  'grass':         { r: 0.45, g: 0.55, b: 0.30 },
  'forest':        { r: 0.18, g: 0.42, b: 0.22 },
  'desert':        { r: 0.78, g: 0.68, b: 0.40 },
  'mountain':      { r: 0.42, g: 0.36, b: 0.30 },
  'snow':          { r: 0.92, g: 0.94, b: 0.96 },
};

/**
 * Elevation thresholds for biome boundaries, in elevation units
 * (0 = deep ocean floor, 1 = mountain peak). Kept as named
 * constants so the transition band logic below can reference
 * them in one place.
 */
export const ELEV = {
  DEEP_OCEAN: 0.05,
  SHALLOW_OCEAN: 0.20,
  BEACH: 0.25,
  MOUNTAIN: 0.65,
  SNOW: 0.85,
} as const;

/**
 * Width of the smooth blend band on either side of each
 * biome boundary (in elevation units). 0.04 means a cell
 * that's 0.04 below the mountain line already shows a 50%
 * mountain tint; at 0.04 above the line it is fully mountain.
 *
 * The band is intentionally narrow so the broad-strokes biome
 * map still reads cleanly from a planetary view, but high-
 * enough to hide the obvious "step" between two adjacent
 * biomes in the close-up surface view.
 */
export const TRANSITION_BAND = 0.04;

/**
 * Stable, deterministic integer hash → [0, 1). Cheap and good
 * enough for low-frequency heightmap noise. The lattice uses
 * integer (x, y) pairs so neighbouring samples vary smoothly.
 */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smoothstep — used to interpolate the lattice noise smoothly. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 2D value noise on an integer lattice, bilinearly smoothed.
 * Range: 0..1, smoothly varying.
 */
function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const tx = smoothstep(x - x0), ty = smoothstep(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed);
  const v11 = hash2(x1, y1, seed);
  return (1 - tx) * (1 - ty) * v00 + tx * (1 - ty) * v10 + (1 - tx) * ty * v01 + tx * ty * v11;
}

/**
 * Fractal sum of value-noise octaves. 4 octaves at
 * (1, 0.5, 0.25, 0.125) amplitudes gives a believable
 * mountain + hill + dune composition.
 */
function fbm2D(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Generate a continuous elevation field.
 *
 * The output is `samples × samples` floats in [0, 1]:
 *   - 0 = deep ocean floor
 *   - < 0.2 = shallow water
 *   - 0.2 = sea level
 *   - 0.4 = mid-elevation land
 *   - 1 = mountain peak
 *
 * Oceans are forced to 0 (or near 0 for shallow shelves) by
 * multiplying the noise by `landFraction`. Continents get
 * the full noise range.
 */
export function generateElevation(
  worldState: TerrainSource,
  samples: number,
  seed: number,
  cellIndexMap?: Int32Array,
): Float32Array {
  const out = new Float32Array(samples * samples);
  const land = worldState.land;
  const cellCount = land.length;
  // Heuristic: noise is sampled at a frequency proportional
  // to the cell count so the surface looks roughly the same
  // regardless of resolution.
  const noiseScale = Math.max(2, Math.log2(cellCount)) * 1.5;
  for (let y = 0; y < samples; y++) {
    for (let x = 0; x < samples; x++) {
      // P3.6 — when the host passes a precomputed cellMap
      // (built by spatial-nearest search over the icosphere
      // cell centres, or the Fibonacci fallback for
      // non-standard counts), use it so the elevation field
      // and the biome classification in `classifySample` look
      // at the *same* cell for a given surface vertex. The
      // legacy lat/lon `nearestCell` heuristic only works for
      // standard icosphere subdivisions (20·4^k) and would
      // dump water on top of land whenever the cell count
      // doesn't match a subdivision. When the host has no
      // cellMap yet (early call from the legacy code path)
      // we still fall back to the lat/lon heuristic so this
      // helper is usable on its own.
      const cellIdx = cellIndexMap !== undefined
        ? cellIndexMap[y * samples + x] ?? 0
        : nearestCell(x, y, samples, cellCount);
      const landFrac = land[cellIdx] ?? 0;
      const nx = x / samples, ny = y / samples;
      const noise = fbm2D(nx * noiseScale, ny * noiseScale, seed);
      // P3.6 (1+2) — pin land to [BEACH, 1.0] so a continent
      // cell can never be classified as water, and pin ocean
      // to [0, SHALLOW_OCEAN] (with the deep-ocean floor at
      // 0, not 0.05) so the ocean reads as *deep* in the
      // surface view. The wider ocean band also gives the
      // mid-ocean a real trench/ridge feel instead of the
      // previous pancake-flat look. The transition band
      // [SHALLOW_OCEAN, BEACH] = [0.20, 0.25] is owned by
      // `classifyBiome` / `blendedColorAt` and renders as
      // beach, so the coastline now reads as a thin sandy
      // strip rather than a cliff.
      const landElev = ELEV.BEACH + (1 - ELEV.BEACH) * noise;
      const oceanElev = 0 + (ELEV.SHALLOW_OCEAN - 0) * noise;
      out[y * samples + x] = landFrac * landElev + (1 - landFrac) * oceanElev;
    }
  }
  return out;
}

/** Cheap nearest-cell heuristic. Cells are roughly equal-area
 *  icosphere triangles; for visual purposes the linear
 *  row-major index is a good-enough proxy. */
function nearestCell(x: number, y: number, samples: number, cellCount: number): number {
  const u = x / samples;
  const v = y / samples;
  // Snake rows from north to south so v=0 → first row, v=1 → last.
  return Math.min(cellCount - 1, Math.max(0, Math.floor(v * cellCount)));
}

/**
 * Classify a cell into a biome from elevation + temperature.
 * Moisture is currently a function of latitude (`abs(0.5 - v)
 * * 2`) as a placeholder; the simulation will gain a real
 * moisture field later.
 */
export function classifyBiome(
  elev: number,
  tempK: number,
  landFrac: number,
  v: number,
): Biome {
  // Water cells: based on elevation only.
  if (landFrac < 0.5 || elev < ELEV.SHALLOW_OCEAN) {
    return elev < ELEV.DEEP_OCEAN ? 'deep-ocean' : 'shallow-ocean';
  }
  // Land cells: temperature in Celsius.
  const tempC = tempK - 273.15;
  const moisture = 1 - Math.abs(0.5 - v) * 2; // 1 at equator, 0 at poles
  if (elev > ELEV.SNOW) return tempC < -5 ? 'snow' : 'mountain';
  if (elev > ELEV.MOUNTAIN) return 'mountain';
  if (tempC < -5) return 'snow';
  if (tempC > 30 && moisture < 0.4) return 'desert';
  if (moisture > 0.6 && tempC > 5 && tempC < 25) return 'forest';
  if (elev < ELEV.BEACH) return 'beach';
  return 'grass';
}

/**
 * Mixed biome color at a (elev, tempK, landFrac, v) point.
 *
 * The discrete `classifyBiome` labels each cell with a single
 * biome, but the rendering path wants a continuous color
 * function so the surface view doesn't show hard color steps
 * at every boundary. This function:
 *
 *   1. Picks the primary biome via `classifyBiome`.
 *   2. Checks the elevation against each boundary in
 *      `TRANSITION_BAND` proximity. If we're inside the
 *      band on the lower side of a higher-elevation biome,
 *      we blend the primary color toward that biome's color
 *      (e.g. grass at elev=0.63 picks up a 50% mountain
 *      tint; mountain at elev=0.83 picks up a 50% snow
 *      tint). On the upper side of a lower-elevation biome,
 *      we blend toward it.
 *
 * The result is a per-cell color that's continuous across
 * boundaries, so the surface mesh blends naturally between
 * grass and mountains, mountains and snow, etc.
 */
export function blendedColorAt(
  elev: number, tempK: number, landFrac: number, v: number,
): BiomeColor {
  const primary = classifyBiome(elev, tempK, landFrac, v);
  let color = BIOME_COLORS[primary];
  // Land-up blends: low-elevation land biomes → mountain,
  // mountain → snow. The boundary is the *higher* biome's
  // threshold; we blend in the band just below it.
  const lowLand = primary === 'grass' || primary === 'forest'
    || primary === 'desert' || primary === 'beach';
  if (lowLand) {
    const t = blendFactor(elev, ELEV.MOUNTAIN);
    if (t > 0) color = mixColor(color, BIOME_COLORS.mountain, t);
  }
  if (primary === 'mountain') {
    const t = blendFactor(elev, ELEV.SNOW);
    if (t > 0) color = mixColor(color, BIOME_COLORS.snow, t);
  }
  // Water-down blends: shallow-ocean → deep-ocean, beach → shallow-ocean.
  // The boundary is the *lower* biome's threshold; we blend in
  // the band just above it.
  if (primary === 'shallow-ocean') {
    const t = blendAbove(elev, ELEV.DEEP_OCEAN);
    if (t > 0) color = mixColor(color, BIOME_COLORS['deep-ocean'], t);
  }
  if (primary === 'beach') {
    const t = blendAbove(elev, ELEV.SHALLOW_OCEAN);
    if (t > 0) color = mixColor(color, BIOME_COLORS['shallow-ocean'], t);
  }
  // Peak highlight: above the snow line we mix an extra
  // amount toward white, so mountain peaks stand out as
  // "snow-capped" from orbital view. The blend scales with
  // elevation: 0 at the snow line, 0.35 at the highest peaks.
  if (elev > ELEV.SNOW) {
    const peakT = Math.min(0.35, (elev - ELEV.SNOW) / (1 - ELEV.SNOW) * 0.35);
    color = mixColor(color, { r: 1, g: 1, b: 1 }, peakT);
  }
  return color;
}

/**
 * Returns a blend factor in [0, 1] for how much we should mix
 * toward the *higher* biome at `boundary`, given the current
 * `elev`. `t = 0` means we're at or below `boundary - band`
 * (no blend), `t = 1` means we're at `boundary` (full blend).
 * Returns 0 outside the band.
 */
function blendFactor(elev: number, boundary: number): number {
  const lower = boundary - TRANSITION_BAND;
  if (elev <= lower || elev >= boundary) return 0;
  return (elev - lower) / TRANSITION_BAND;
}

/**
 * Symmetric to `blendFactor` but for the *lower* biome:
 * returns 1 at `boundary` and 0 at `boundary + band`. Used for
 * water blends where the upper biome (e.g. shallow-ocean)
 * picks up tint from the lower biome (deep-ocean) as
 * elevation drops toward the floor.
 */
function blendAbove(elev: number, boundary: number): number {
  const upper = boundary + TRANSITION_BAND;
  if (elev <= boundary || elev >= upper) return 0;
  return (upper - elev) / TRANSITION_BAND;
}

function mixColor(a: BiomeColor, b: BiomeColor, t: number): BiomeColor {
  return {
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t,
  };
}

/**
 * Map a sample (x, y) to its biome + color, using the
 * precomputed elevation field and the worldState's temperature
 * + landFraction. Returns the same data the surface shader
 * would consume.
 */
export interface SampleBiome {
  biome: Biome;
  color: BiomeColor;
  elev: number;
  tempK: number;
}

export function classifySample(
  x: number, y: number, samples: number,
  elevation: Float32Array,
  worldState: TerrainSource,
  cellIndexOverride?: number,
): SampleBiome {
  const idx = y * samples + x;
  const elev = elevation[idx] ?? 0;
  const v = y / samples;
  // P3.6 — when the host provides a `cellIndexOverride`,
  // skip the legacy lat/lon-mapped `nearestCell` and use
  // the spatial-nearest icosphere cell instead. The surface
  // view passes in the value from its pre-computed cellMap
  // so the landFraction it reads lines up with the biome
  // the user actually sees.
  const cellIdx = cellIndexOverride ?? nearestCell(x, y, samples, worldState.land.length);
  const landFrac = worldState.land[cellIdx] ?? 0;
  const tempK = worldState.temperature[cellIdx] ?? 288;
  const biome = classifyBiome(elev, tempK, landFrac, v);
  // The surface view wants continuous color across biome
  // boundaries, so the sample carries a *blended* color rather
  // than the discrete `BIOME_COLORS[biome]`. The discrete
  // biome is still the entity-placement key.
  const color = blendedColorAt(elev, tempK, landFrac, v);
  return { biome, color, elev, tempK };
}

/**
 * Deterministic per-world seed for the surface view. Pulls
 * the world's tick and branch id so the terrain is stable
 * across re-renders but changes when the user resets the
 * experiment.
 */
export function surfaceSeed(worldState: TerrainSource): number {
  const tick = worldState.tick;
  const salt = worldState.seedSalt ?? 'main';
  let h = 2166136261;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h ^ tick) >>> 0;
}

/**
 * Adapter: build a `TerrainSource` from the lightweight
 * `Projection` (the wire format the worker emits).
 */
export function fromProjection(p: Projection): TerrainSource {
  return {
    land: p.land,
    temperature: p.temperature,
    seedSalt: p.branchId ?? p.worldId ?? 'main',
    tick: p.tick,
  };
}

/**
 * Adapter: build a `TerrainSource` from the full
 * `WorldState` (for tests and for the rare case where the
 * surface view is rendered from the canonical state, not
 * the projection).
 */
export function fromWorldState(s: WorldState): TerrainSource {
  return {
    land: s.cells.landFraction,
    temperature: s.cells.temperatureK,
    seedSalt: s.branch.id,
    tick: s.tick,
  };
}
