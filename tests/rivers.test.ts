import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRiverNetwork, type RiverNetwork } from '../src/simulation/rivers.ts';
import { generateElevation, fromProjection, type TerrainSource } from '../src/simulation/terrain.ts';

/**
 * Phase 11.2.1 unit tests for the river pipeline.
 *
 * The river builder is pure (no Three.js, no DOM). It takes a
 * heightmap + a seed and returns a list of line segments in
 * sphere coords. We test:
 *   - All-ocean source → no rivers
 *   - Land source with high elevation → some rivers
 *   - Determinism (same seed → same network)
 *   - Rivers flow downhill (start elevation > end elevation)
 */

const SAMPLES = 129; // matches the surface view's segments + 1

function makeLandSource(): TerrainSource {
  return {
    land: new Float64Array(SAMPLES * SAMPLES).fill(1),
    temperature: new Float64Array(SAMPLES * SAMPLES).fill(288),
    seedSalt: 'rivers-test',
    tick: 0,
  };
}

function makeOceanSource(): TerrainSource {
  return {
    land: new Float64Array(SAMPLES * SAMPLES).fill(0),
    temperature: new Float64Array(SAMPLES * SAMPLES).fill(288),
    seedSalt: 'rivers-test',
    tick: 0,
  };
}

test('all-ocean source produces no rivers', () => {
  const elev = generateElevation(makeOceanSource(), SAMPLES, 42);
  const net = buildRiverNetwork(makeOceanSource(), elev, SAMPLES, 42);
  assert.equal(net.pairCount, 0, 'no rivers should be drawn over the ocean');
  assert.equal(net.vertices.length, 0);
});

test('different seed → different river network (in expectation)', () => {
  const source = makeLandSource();
  const elev1 = generateElevation(source, SAMPLES, 1);
  const elev2 = generateElevation(source, SAMPLES, 2);
  let s = 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const a = buildRiverNetwork(source, elev1, SAMPLES, 1, rng);
  const b = buildRiverNetwork(source, elev2, SAMPLES, 2, rng);
  // We can't assert "different pair count" because both worlds
  // happen to have some rivers; but the vertices will diverge
  // because both the noise field and the source-pick RNG
  // change with the seed.
  let diffs = 0;
  for (let i = 0; i < Math.min(a.vertices.length, b.vertices.length); i++) {
    if (a.vertices[i] !== b.vertices[i]) diffs += 1;
  }
  assert.ok(diffs > 0, 'expected at least one differing vertex between the two networks');
});

test('land source with high elevation produces rivers', () => {
  const source = makeLandSource();
  const elev = generateElevation(source, SAMPLES, 1337);
  // Deterministic LCG so the test never depends on Math.random.
  let s = 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const net = buildRiverNetwork(source, elev, SAMPLES, 1337, rng);
  // We expect at least a few river segments (the picker tries
  // 400 random candidates and keeps any that land on
  // elevation > 0.45 + landFraction > 0.85).
  assert.ok(net.pairCount > 0, `expected at least one river segment, got ${net.pairCount}`);
  // Vertices are stored as 6 floats per pair (2 endpoints × xyz).
  assert.equal(net.vertices.length, net.pairCount * 6);
});

test('river endpoints all lie on the unit sphere', () => {
  const source = makeLandSource();
  const elev = generateElevation(source, SAMPLES, 99);
  // Deterministic LCG so the test never depends on Math.random.
  let s = 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const net = buildRiverNetwork(source, elev, SAMPLES, 99, rng);
  for (let i = 0; i < net.pairCount; i++) {
    const off = 6 * i;
    for (let j = 0; j < 6; j++) {
      const v = net.vertices[off + j]!;
      assert.ok(Math.abs(v) <= 1.001, `vertex ${i}.${j} should be on unit sphere, got ${v}`);
    }
  }
});

test('rivers flow downhill (start elevation > end elevation)', () => {
  const source = makeLandSource();
  const elev = generateElevation(source, SAMPLES, 2024);
  // Deterministic LCG so the test never depends on Math.random.
  let s = 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const net = buildRiverNetwork(source, elev, SAMPLES, 2024, rng);
  // For each pair, re-sample elevation at both endpoints via
  // bilinear interpolation. We allow a small (0.05) slack to
  // account for the noise field's local bumps; the river
  // algorithm walks the gradient, but step 0.012 in sample
  // space can briefly cross a noise ridge on the way down.
  for (let i = 0; i < net.pairCount; i++) {
    const off = 6 * i;
    const sx = net.vertices[off + 0]!, sy = net.vertices[off + 1]!, sz = net.vertices[off + 2]!;
    const ex = net.vertices[off + 3]!, ey = net.vertices[off + 4]!, ez = net.vertices[off + 5]!;
    const sLon = Math.atan2(sz, sx);
    const sLat = Math.asin(Math.max(-1, Math.min(1, sy)));
    const eLon = Math.atan2(ez, ex);
    const eLat = Math.asin(Math.max(-1, Math.min(1, ey)));
    const sU = (sLon + Math.PI) / (2 * Math.PI);
    const sV = (sLat + Math.PI / 2) / Math.PI;
    const eU = (eLon + Math.PI) / (2 * Math.PI);
    const eV = (eLat + Math.PI / 2) / Math.PI;
    const sElev = sampleElev(elev, sU * SAMPLES, sV * SAMPLES);
    const eElev = sampleElev(elev, eU * SAMPLES, eV * SAMPLES);
    // Every segment should at least weakly descend.
    assert.ok(
      sElev + 0.05 >= eElev,
      `river ${i} should flow downhill: start=${sElev.toFixed(3)} end=${eElev.toFixed(3)}`,
    );
  }
});

/** Bilinear elevation sample at a (x, y) in sample space. */
function sampleElev(elev: Float32Array, x: number, y: number): number {
  const x0 = Math.floor(x), x1 = x0 + 1;
  const y0 = Math.floor(y), y1 = y0 + 1;
  const tx = x - x0, ty = y - y0;
  const e00 = elev[y0 * SAMPLES + x0] ?? 0;
  const e10 = elev[y0 * SAMPLES + x1] ?? 0;
  const e01 = elev[y1 * SAMPLES + x0] ?? 0;
  const e11 = elev[y1 * SAMPLES + x1] ?? 0;
  return (1 - tx) * (1 - ty) * e00 + tx * (1 - ty) * e10 + (1 - tx) * ty * e01 + tx * ty * e11;
}

test('same seed → same river network (deterministic)', () => {
  const source = makeLandSource();
  const elev = generateElevation(source, SAMPLES, 7);
  // Deterministic LCG so the test never depends on Math.random.
  const makeRng = () => {
    let s = 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  const a = buildRiverNetwork(source, elev, SAMPLES, 7, makeRng());
  const b = buildRiverNetwork(source, elev, SAMPLES, 7, makeRng());
  assert.equal(a.pairCount, b.pairCount, 'pair count should match');
  assert.equal(a.vertices.length, b.vertices.length);
  for (let i = 0; i < a.vertices.length; i++) {
    assert.equal(a.vertices[i], b.vertices[i]);
  }
});

test('different seed → different river network (in expectation)', () => {
  const source = makeLandSource();
  const elev1 = generateElevation(source, SAMPLES, 1);
  const elev2 = generateElevation(source, SAMPLES, 2);
  const a = buildRiverNetwork(source, elev1, SAMPLES, 1);
  const b = buildRiverNetwork(source, elev2, SAMPLES, 2);
  // We can't assert "different pair count" because both worlds
  // happen to have some rivers; but the vertices will diverge
  // because both the noise field and the source-pick RNG
  // change with the seed.
  let diffs = 0;
  for (let i = 0; i < Math.min(a.vertices.length, b.vertices.length); i++) {
    if (a.vertices[i] !== b.vertices[i]) diffs += 1;
  }
  assert.ok(diffs > 0, 'expected at least one differing vertex between the two networks');
});

test('wrong sample count is rejected (returns empty network)', () => {
  const source = makeLandSource();
  const elev = generateElevation(source, 64, 42);
  const net = buildRiverNetwork(source, elev, 64, 42);
  assert.equal(net.pairCount, 0, 'river builder is pinned to 129 samples');
});
