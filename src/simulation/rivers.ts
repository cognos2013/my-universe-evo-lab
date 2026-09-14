/**
 * Phase 11.2.1 — River generation.
 *
 * Rivers are 3D polylines traced across the surface mesh from
 * high-elevation "source" cells down to the ocean. We don't
 * simulate erosion; we just follow the steepest descent on
 * the existing heightmap until the line either dips into
 * water (`landFraction[i] < 0.5`) or stops moving (a local
 * minimum).
 *
 * The output is a flat Float32Array of [x, y, z, x, y, z, ...]
 * points in surface-mesh coordinates (a unit sphere). The
 * SurfaceView consumes this and turns it into a
 * `THREE.LineSegments` with a slightly-emissive blue
 * material.
 *
 * The algorithm is deliberately cheap: a single Euler step
 * per source per frame would be overkill; we do a small
 * fixed number of steps (200) and stop early when the river
 * reaches a sink. Sources are picked from high-elevation land
 * cells with a random scatter so different worlds look
 * different.
 */

import type { TerrainSource } from './terrain.ts';

export interface RiverNetwork {
  /** Flat [x0, y0, z0, x1, y1, z1, ...] in surface-mesh coords (unit sphere). */
  vertices: Float32Array;
  /** Pair count (so renderers can do `drawRange(0, 2 * pairCount)`). */
  pairCount: number;
}

const SURFACE_SAMPLES = 129; // matches SurfaceView's segments+1
const SOURCE_MIN_ELEV = 0.45;
const MAX_STEPS = 200;
const STEP_SIZE = 0.012; // in grid units; ~0.9° on the sphere
const STOP_ELEV = 0.21;

/**
 * Build a river network for the given world.
 *
 * `seed` should match the elevation seed so rivers line up
 * with the same terrain the user is looking at.
 */
export function buildRiverNetwork(
  source: TerrainSource,
  elevation: Float32Array,
  samples: number,
  seed: number,
  rng: () => number = Math.random,
): RiverNetwork {
  if (samples !== SURFACE_SAMPLES) {
    // We baked the algorithm to SURFACE_SAMPLES (129) so river
    // math matches the mesh exactly. Other sample counts are
    // rejected to avoid subtle off-by-one drift.
    return { vertices: new Float32Array(0), pairCount: 0 };
  }
  // Pick a handful of source cells: high-elevation land with
  // a bit of randomness so different seeds paint different
  // river networks. `taken` only blocks the *source picker*
  // from re-picking the same cell — we deliberately do NOT
  // use it during tracing, because the trace loop's step size
  // (~0.012 in sample units) is smaller than the source jitter
  // range, so the first few traced cells can round back to the
  // source cell. Pre-marking traced cells as visited would
  // make every river stall at step 1.
  const sources: Array<{ x: number; y: number }> = [];
  const land = source.land;
  const taken = new Uint8Array(samples * samples);
  for (let attempt = 0; attempt < 400 && sources.length < 24; attempt++) {
    const x = Math.floor(rng() * samples);
    const y = Math.floor(rng() * samples);
    if (elevation[y * samples + x]! >= SOURCE_MIN_ELEV && land[cellAt(x, y, samples, land.length)]! >= 0.85 && !taken[y * samples + x]) {
      sources.push({ x, y });
      taken[y * samples + x] = 1;
    }
  }
  if (sources.length === 0) return { vertices: new Float32Array(0), pairCount: 0 };

  // Each source traces a single river. We share a vertex buffer.
  // Worst case: 24 sources × MAX_STEPS × 6 floats/segment
  // (two endpoints × xyz) = 28,800 floats.
  const buf = new Float32Array(sources.length * MAX_STEPS * 6);
  let pairCount = 0;
  for (const s of sources) {
    let x = s.x, y = s.y;
    let prevX = x, prevY = y;
    const seedJitter = (rng() - 0.5) * 0.4;
    x += seedJitter; y += seedJitter;
    let wrote = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 1 || ix >= samples - 1 || iy < 1 || iy >= samples - 1) break;
      // Bilinear sample of elevation at (x, y).
      const x0 = Math.floor(x), x1 = x0 + 1;
      const y0 = Math.floor(y), y1 = y0 + 1;
      const tx = x - x0, ty = y - y0;
      const e00 = elevation[y0 * samples + x0]!;
      const e10 = elevation[y0 * samples + x1]!;
      const e01 = elevation[y1 * samples + x0]!;
      const e11 = elevation[y1 * samples + x1]!;
      const elev = (1 - tx) * (1 - ty) * e00 + tx * (1 - ty) * e10 + (1 - tx) * ty * e01 + tx * ty * e11;
      if (elev < STOP_ELEV) break;
      if (land[cellAt(ix, iy, samples, land.length)]! < 0.5) break;
      // Numerical gradient on the heightmap.
      const gx = ((elevation[y0 * samples + Math.min(samples - 1, ix + 1)] ?? 0) - (elevation[y0 * samples + Math.max(0, ix - 1)] ?? 0)) * 0.5;
      const gy = ((elevation[Math.min(samples - 1, iy + 1) * samples + ix] ?? 0) - (elevation[Math.max(0, iy - 1) * samples + ix] ?? 0)) * 0.5;
      // Walk downhill (-gradient). If the gradient is tiny
      // (we're at a flat local minimum) break out.
      const gradMag = Math.hypot(gx, gy);
      if (gradMag < 1e-4) break;
      // Step in the negative-gradient direction.
      const dx = -gx / gradMag * STEP_SIZE;
      const dy = -gy / gradMag * STEP_SIZE;
      // Convert grid step back to a 3D surface-mesh point. We
      // project (x, y) in sample coords onto the unit sphere
      // via latitude / longitude.
      const [px, py, pz] = sampleToSphere(prevX, prevY, samples);
      buf[pairCount * 6 + 0] = px;
      buf[pairCount * 6 + 1] = py;
      buf[pairCount * 6 + 2] = pz;
      const [qx, qy, qz] = sampleToSphere(x, y, samples);
      buf[pairCount * 6 + 3] = qx;
      buf[pairCount * 6 + 4] = qy;
      buf[pairCount * 6 + 5] = qz;
      pairCount += 1;
      wrote += 1;
      prevX = x; prevY = y;
      x += dx; y += dy;
    }
    // If the river barely moved (sitting in a flat plateau),
    // drop the last few segments so we don't draw a single dot.
    if (wrote < 3 && pairCount > 0) {
      pairCount -= wrote;
    }
  }
  // Trim the buffer to the actually-used pairs.
  const usedFloats = pairCount * 6;
  return { vertices: buf.subarray(0, usedFloats), pairCount };
}

/** Pick the nearest cell index for a (x, y) sample. */
function cellAt(x: number, y: number, samples: number, cellCount: number): number {
  // v = y / samples maps to row index; cells are roughly
  // equal-area so row-major is a good-enough proxy.
  const row = Math.min(cellCount - 1, Math.max(0, Math.floor((y / samples) * cellCount)));
  return row;
}

/** Map (x, y) in sample space to (x, y, z) on the unit sphere. */
function sampleToSphere(x: number, y: number, samples: number): [number, number, number] {
  // SphereGeometry's vertex layout: longitude = atan2(z, x),
  // latitude = asin(y). Map u = (lon + π) / 2π, v = (lat + π/2) / π.
  const u = x / samples;
  const v = y / samples;
  const lon = u * 2 * Math.PI - Math.PI;
  const lat = v * Math.PI - Math.PI / 2;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon)];
}
