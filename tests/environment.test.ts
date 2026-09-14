import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, fallbackCellCenters } from '../src/simulation/environment/grid.ts';
import { fbm3D, valueNoise3D } from '../src/simulation/environment/noise.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { matterTotal, energyTotal, validateState } from '../src/simulation/core/state.ts';
import { stepEnvironment, stepWorld } from '../src/simulation/core/step.ts';
import { advanceEnvironment } from '../src/simulation/environment/advance.ts';
import { serializeState, deserializeState } from '../src/persistence/codec.ts';

test('all sphere resolutions have closed topology, positive areas and total 4πr²', () => {
  for (const n of [320,1280,5120,20480]) {
    const grid = createGrid(n,6371000);
    assert.equal(grid.faces.length,n);
    assert.equal(grid.neighborIndices.length,3*n);
    assert.ok(grid.areaM2.every(a => a > 0));
    assert.ok(Math.abs(grid.areaM2.reduce((a,b) => a+b,0)/(4*Math.PI*6371000**2)-1)<1e-12);
    grid.centers.forEach(c => assert.ok(Math.abs(Math.hypot(...c)-1)<1e-14));
  }
});

// P3.6 — fallbackCellCenters is the safety net for state.cellCount
// values that `createGrid` rejects (e.g. 16280 from an older save).
// It must produce n unit-sphere points regardless of n, and the
// output must be deterministic (same n → same points) so the
// surface view's cellMap cache stays stable across re-renders.
test('fallbackCellCenters: produces n unit-sphere points for any n', () => {
  for (const n of [1, 100, 16280, 33333, 100000]) {
    const pts = fallbackCellCenters(n);
    assert.equal(pts.length, n);
    for (const p of pts) {
      assert.ok(Math.abs(Math.hypot(p[0], p[1], p[2]) - 1) < 1e-12, `point ${JSON.stringify(p)} not on unit sphere`);
    }
  }
});

test('fallbackCellCenters: deterministic — same n → same points', () => {
  const a = fallbackCellCenters(5120);
  const b = fallbackCellCenters(5120);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]![0]! - b[i]![0]!) < 1e-15);
    assert.ok(Math.abs(a[i]![1]! - b[i]![1]!) < 1e-15);
    assert.ok(Math.abs(a[i]![2]! - b[i]![2]!) < 1e-15);
  }
});

test('fallbackCellCenters: rejects non-positive / non-finite n', () => {
  assert.throws(() => fallbackCellCenters(0));
  assert.throws(() => fallbackCellCenters(-1));
  assert.throws(() => fallbackCellCenters(Number.NaN));
  assert.throws(() => fallbackCellCenters(Number.POSITIVE_INFINITY));
});

test('initialization reproducible; local seeding pays material, external seeding records input', async () => {
  const scenario = getScenario('two-lineages');
  const a = await initializeWorld(scenario), b = await initializeWorld(scenario);
  assert.deepEqual(a,b); validateState(a);
  assert.equal(a.cohorts.counts.reduce((x,y) => x+y,0),2000);
  assert.equal(matterTotal(a),320000);
  assert.equal(a.cells.nutrientMu.reduce((x,y) => x+y,0),318000);
  scenario.populations.forEach(p => { p.materialSource = 'external'; });
  const external = await initializeWorld(scenario);
  assert.equal(external.ledger.externalMatterInMu,2000); assert.equal(matterTotal(external),322000);
  scenario.populations.forEach(p => { p.materialSource = 'local'; }); scenario.planet.nutrientMuPerCell=0;
  await assert.rejects(initializeWorld(scenario),/Insufficient/);
});

test('empty planet remains lifeless; resource recycling and energy ledger close over 100 ticks', async () => {
  const scenario = getScenario('empty-planet'); scenario.planet.detritusMuPerCell=10;
  let state = await initializeWorld(scenario); const original = structuredClone(state);
  for (let i=0;i<100;i++) state=stepEnvironment(state);
  assert.equal(state.cohorts.ids.length,0); assert.equal(state.tick,100);
  assert.ok(Math.abs(matterTotal(state)-matterTotal(original))<1e-6);
  assert.ok(state.cells.detritusMu[0]!<10); assert.ok(state.cells.nutrientMu[0]!>1000);
  const expected=state.ledger.initialEnergyJ+state.ledger.externalEnergyInJ-state.ledger.externalEnergyOutJ;
  assert.ok(Math.abs(energyTotal(state)/expected-1)<1e-10);
  assert.equal(original.tick,0);
});

test('heat exchange is conservative on unequal areas and converges with half steps', async () => {
  const s=getScenario('empty-planet'); s.planet.radiusM=100; s.rules.environment.heatCapacityJPerM2K=1e5;
  const state=await initializeWorld(s); state.cells.temperatureK[0]=300;
  state.ledger.initialEnergyJ=energyTotal(state);
  const a=structuredClone(state),b=structuredClone(state);
  advanceEnvironment(a,3600);
  advanceEnvironment(b,1800); advanceEnvironment(b,1800);
  validateState(a); validateState(b);
  assert.ok(Math.abs(a.cells.temperatureK[0]!-b.cells.temperatureK[0]!)<0.05);
  assert.ok(a.cells.temperatureK[0]!<300);
});

test('failed environment step leaves input unchanged; state can resume after roundtrip', async () => {
  let a=await initializeWorld(getScenario('empty-planet'));
  const b=await deserializeState(await serializeState(a));
  assert.deepEqual(stepEnvironment(a),stepEnvironment(b));
  a.rules.environment.heatCapacityJPerM2K=1;
  a.ledger.initialEnergyJ=energyTotal(a);
  const saved=structuredClone(a);
  assert.throws(() => stepEnvironment(a),/budget|range/);
  assert.deepEqual(a,saved);
});
test('template resolution changes do not create initial matter or population',async()=>{
  for(const resolution of [320,1280,5120,20480] as const){
    const state=await initializeWorld(getScenario('two-lineages',resolution));
    assert.equal(matterTotal(state),320000);assert.equal(state.cohorts.counts.reduce((a,b)=>a+b,0),2000);
  }
});

test('20480-cell living world preserves material and resumes exactly',async()=>{
  let state=await initializeWorld(getScenario('two-lineages',20480));
  for(let i=0;i<3;i++)state=(await stepWorld(state)).state;
  assert.ok(Math.abs(matterTotal(state)-320000)<1e-7);
  const restored=await deserializeState(await serializeState(state));
  assert.equal(await serializeState((await stepWorld(state)).state),await serializeState((await stepWorld(restored)).state));
});

// P3.6 — fbm3D is the spatial noise used to assign
// ocean/land to icosphere cells. Two contracts: it must
// produce a value in [0, 1] and nearby points must have
// similar values (so the ocean forms contiguous basins,
// not scattered cells).
test('fbm3D: range is [0, 1]', () => {
  for (let i = 0; i < 50; i++) {
    const x = (i * 0.13) - 3, y = (i * 0.27) - 2, z = (i * 0.41) - 1;
    const v = fbm3D(x, y, z, i * 7);
    assert.ok(v >= 0 && v <= 1, `fbm3D(${x},${y},${z},${i*7}) = ${v} out of [0,1]`);
  }
});

test('fbm3D: nearby points have similar values (spatial coherence)', () => {
  // Sample 50 pairs of points that are 0.01 apart on the unit
  // sphere. Adjacent samples should differ by at most ~0.1
  // (the fbm's octave-0 base scale). With 50 random pairs,
  // the *average* absolute difference between an adjacent
  // pair must be much smaller than between two random
  // unrelated points — otherwise the noise has no spatial
  // structure and the ocean assignment is back to salt-and-
  // pepper.
  let adjacentDiffSum = 0, randomDiffSum = 0;
  const seed = 42;
  for (let i = 0; i < 50; i++) {
    // Adjacent pair: tiny offset on a random unit vector.
    const theta = (i * 0.31) % (Math.PI * 2);
    const phi = ((i * 0.17) % Math.PI) - Math.PI / 2;
    const x = Math.cos(phi) * Math.cos(theta);
    const y = Math.cos(phi) * Math.sin(theta);
    const z = Math.sin(phi);
    const v0 = fbm3D(x, y, z, seed);
    const v1 = fbm3D(x + 0.01, y + 0.01, z + 0.01, seed);
    adjacentDiffSum += Math.abs(v1 - v0);
    // Random pair: an unrelated point on the sphere.
    const t2 = theta + 1.7, p2 = phi + 1.1;
    const x2 = Math.cos(p2) * Math.cos(t2);
    const y2 = Math.cos(p2) * Math.sin(t2);
    const z2 = Math.sin(p2);
    const v2 = fbm3D(x2, y2, z2, seed);
    randomDiffSum += Math.abs(v2 - v0);
  }
  assert.ok(adjacentDiffSum < randomDiffSum / 3, `fbm3D has no spatial coherence: adjacent=${adjacentDiffSum} random=${randomDiffSum}`);
});

test('fbm3D: deterministic — same inputs → same output', () => {
  for (let i = 0; i < 10; i++) {
    const x = i * 0.7, y = i * 1.1, z = i * 0.3;
    const a = fbm3D(x, y, z, 12345);
    const b = fbm3D(x, y, z, 12345);
    assert.equal(a, b, `fbm3D must be deterministic at (${x},${y},${z})`);
  }
});

test('valueNoise3D: range is [0, 1]', () => {
  for (let i = 0; i < 20; i++) {
    const v = valueNoise3D(i * 0.5, i * 0.7, i * 1.3, i * 11);
    assert.ok(v >= 0 && v <= 1, `valueNoise3D out of range: ${v}`);
  }
});

// P3.6 — `initializeWorld` must now produce an ocean
// distribution that has spatial coherence (a few large
// basins), not the 1D random stream's salt-and-pepper.
// We can't directly assert "spatial coherence" without
// rendering the planet, so we check the simpler proxy:
// the rank ordering must NOT be the same as the cell-id
// ordering (which is what the 1D random stream would
// produce by tie-breaking on id).
test('initializeWorld: ocean cells form a few contiguous basins, not 1D random scatter', () => {
  // Snapshot a 5120-cell world and inspect the ocean
  // distribution. The 1D random stream's signature is
  // "neighbours don't agree on ocean/land" because the
  // stream has no spatial coherence. fbm3D, sampled at
  // the cell-centre 3D positions, must produce a value
  // that's similar at adjacent cells, so the resulting
  // land/ocean split has long contiguous basins.
  //
  // We measure that with neighbour agreement: for each
  // pair of icosphere neighbours, do they share the same
  // landFrac (both land or both ocean)? Under the 1D
  // random stream this is close to the marginal
  // probability (~0.58 for the 70/30 split). Under
  // fbm3D the same-baseline agreement should be much
  // higher — we require ≥ 0.80.
  //
  // Note: the default 'two-lineages' scenario has
  // `oceanFraction: 0.7` — 70% of the planet is water.
  return initializeWorld(getScenario('two-lineages', 5120)).then((state) => {
    const land = state.cells.landFraction;
    const oceanCount = land.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
    // ~70% ocean (default scenario)
    assert.ok(oceanCount > 5120 * 0.65 && oceanCount < 5120 * 0.75, `expected ~70% ocean, got ${oceanCount}`);
    // Neighbour agreement: fbm3D should drive it well above
    // the random baseline of 0.58 (= 0.7² + 0.3²).
    let same = 0, total = 0;
    for (let i = 0; i < 5120; i++) {
      const off = state.cells.neighborOffsets[i]!;
      for (let k = 0; k < 3; k++) {
        const j = state.cells.neighborIndices[off + k]!;
        if (j <= i) continue; // count each pair once
        if ((land[i] === 0) === (land[j] === 0)) same++;
        total++;
      }
    }
    const agreement = same / total;
    assert.ok(agreement > 0.80, `neighbour agreement ${(agreement * 100).toFixed(1)}% — random baseline is ~58%, 1D-stream world; fbm3D should push it well above 0.80`);
  });
});
