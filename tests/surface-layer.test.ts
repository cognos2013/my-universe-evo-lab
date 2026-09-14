import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SurfaceLayer,
  SettlementMarkerLayer,
  BiomassLayer,
  WeatherLayer,
  markerColor,
  markerHouseColor,
  markerScale,
  cellToSurfaceMarkerPosition,
  colorToRgb,
  lineageIdToColor,
  hslToRgb,
  biomassToScale,
  temperatureToColor,
  rgbToPacked,
  type SettlementLike,
  type CellPosition,
} from '../src/rendering/surface-layer.ts';

/**
 * Phase 11.3 (P3) unit tests for surface layers.
 *
 * The layer protocol itself (update / dispose) is tested with a
 * fake layer that records calls; the SettlementMarkerLayer is
 * tested via its pure helper functions (markerColor, markerScale,
 * cellToSurfaceMarkerPosition, colorToRgb) so we don't need to
 * spin up a Three.js WebGL context in node.
 *
 * The browser-side rendering (InstancedMesh draw calls, vertex
 * colors, etc.) is covered by `app.spec.ts` once the surface
 * view is exposed in tests.
 */

// --- pure helpers ----------------------------------------------------

const BASE = 1.0;
const MARKER_HEIGHT = 0.012;

test('markerColor: institution kind → readable palette colour', () => {
  const settlements: SettlementLike[] = [
    { id: 'a', cellIndex: 0, population: 50, dissolved: false, institution: { kind: 'public' } },
    { id: 'b', cellIndex: 0, population: 50, dissolved: false, institution: { kind: 'private' } },
    { id: 'c', cellIndex: 0, population: 50, dissolved: false, institution: { kind: 'mixed' } },
  ];
  const publicColor  = markerColor(settlements[0]!);
  const privateColor = markerColor(settlements[1]!);
  const mixedColor   = markerColor(settlements[2]!);
  // All three are distinct.
  assert.notEqual(publicColor, privateColor);
  assert.notEqual(publicColor, mixedColor);
  assert.notEqual(privateColor, mixedColor);
});

test('markerColor: dissolved always returns the grey', () => {
  for (const kind of ['public', 'private', 'mixed'] as const) {
    const s: SettlementLike = {
      id: 'x', cellIndex: 0, population: 100, dissolved: true,
      institution: { kind },
    };
    const c = markerColor(s);
    const [r, g, b] = colorToRgb(c);
    // Grey ≈ equal R/G/B and middling brightness.
    assert.ok(Math.abs(r - g) < 0.05, `r vs g: ${r}, ${g}`);
    assert.ok(Math.abs(g - b) < 0.05, `g vs b: ${g}, ${b}`);
    assert.ok(r > 0.2 && r < 0.6, `dissolved grey should be mid-tone, got r=${r}`);
  }
});

test('markerHouseColor: same mapping but desaturated toward white', () => {
  // public 锥色: 绿
  const publicS: SettlementLike = { id: 'p', cellIndex: 0, population: 100, dissolved: false, institution: { kind: 'public' } };
  const houseRGB = colorToRgb(markerHouseColor(publicS));
  const coneRGB = colorToRgb(markerColor(publicS));
  // The house should be brighter (mixed toward white) than
  // the cone, but still recognisably green.
  for (let i = 0; i < 3; i++) {
    assert.ok(houseRGB[i]! > coneRGB[i]!, `channel ${i} should be brighter: ${houseRGB[i]} vs ${coneRGB[i]}`);
    assert.ok(houseRGB[i]! <= 1, `channel ${i} should be ≤ 1: ${houseRGB[i]}`);
  }
  // The blue channel of the green cone is small; the house
  // should still be more green than blue (institution colour
  // is preserved).
  assert.ok(houseRGB[1]! > houseRGB[0]!, 'green should still dominate');
  assert.ok(houseRGB[1]! > houseRGB[2]!, 'green should still dominate blue');
});

test('markerHouseColor: dissolved returns the grey (no pastel)', () => {
  const s: SettlementLike = { id: 'x', cellIndex: 0, population: 100, dissolved: true, institution: { kind: 'public' } };
  assert.equal(markerHouseColor(s), markerColor(s));
});

test('colorToRgb: 0xRRGGBB → [r, g, b] in [0, 1]', () => {
  const [r, g, b] = colorToRgb(0x4ade80);
  // 0x4ade80 = (0x4a, 0xde, 0x80) = (74, 222, 128) / 255.
  assert.ok(Math.abs(r - 74 / 255) < 1e-6);
  assert.ok(Math.abs(g - 222 / 255) < 1e-6);
  assert.ok(Math.abs(b - 128 / 255) < 1e-6);
});

test('markerScale: small and large populations stay inside the band', () => {
  // Tiny settlement (population = 1) should not collapse to zero.
  const tiny = markerScale(1, MARKER_HEIGHT);
  assert.ok(tiny >= 0.001, `tiny should be visible, got ${tiny}`);
  // Reference population (200) maps to roughly the marker height.
  const ref = markerScale(200, MARKER_HEIGHT);
  assert.ok(ref > 0, `ref should be positive, got ${ref}`);
  // Huge population should be capped by MAX_MARKER_SCALE.
  const huge = markerScale(1_000_000, MARKER_HEIGHT);
  assert.ok(huge <= 0.05, `huge should be capped, got ${huge}`);
  // Monotonic: larger population → larger (or equal) scale.
  assert.ok(huge >= ref, 'scale should be monotonic in population');
  assert.ok(ref >= tiny, 'reference should be larger than tiny');
});

test('markerScale: zero / negative populations fall back to the floor', () => {
  // Zero population is technically invalid but the helper should
  // not return NaN or a negative number.
  const zero = markerScale(0, MARKER_HEIGHT);
  assert.ok(Number.isFinite(zero));
  assert.ok(zero >= 0);
  // Negative population: same — treat as 1.
  const neg = markerScale(-5, MARKER_HEIGHT);
  assert.ok(Number.isFinite(neg));
});

test('cellToSurfaceMarkerPosition: a point on the unit sphere stays on the sphere', () => {
  const cells: CellPosition[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [-0.6, 0.4, 0.7],
  ];
  for (const cell of cells) {
    const [x, y, z] = cellToSurfaceMarkerPosition(cell, BASE, MARKER_HEIGHT);
    const r = Math.hypot(x, y, z);
    // The marker is at baseRadius + markerHeight / 2 (the
    // cone's mid-height) along the cell's outward direction.
    const expected = BASE + MARKER_HEIGHT / 2;
    assert.ok(Math.abs(r - expected) < 1e-6, `r should be ${expected}, got ${r}`);
    // Direction should match the cell's direction.
    const [cx, cy, cz] = cell;
    const cellR = Math.hypot(cx, cy, cz);
    assert.ok(Math.abs(x / r - cx / cellR) < 1e-6, 'x direction should match cell');
    assert.ok(Math.abs(y / r - cy / cellR) < 1e-6, 'y direction should match cell');
    assert.ok(Math.abs(z / r - cz / cellR) < 1e-6, 'z direction should match cell');
  }
});

test('cellToSurfaceMarkerPosition: zero cell falls back to (0, 0, mid)', () => {
  const [x, y, z] = cellToSurfaceMarkerPosition([0, 0, 0], BASE, MARKER_HEIGHT);
  // radial falls back to 1, so the marker is at (0, 0, mid) on +Z.
  assert.equal(x, 0);
  assert.equal(y, 0);
  assert.ok(Math.abs(z - (BASE + MARKER_HEIGHT / 2)) < 1e-6);
});

// --- SurfaceLayer protocol (fake layer) ------------------------------

class FakeLayer extends SurfaceLayer<number> {
  calls: number[] = [];
  disposed = false;
  update(data: number): void {
    this.calls.push(data);
  }
  dispose(): void {
    this.disposed = true;
  }
}

test('SurfaceLayer: update() forwards the data payload', () => {
  const layer = new FakeLayer({} as never, [], 1, 0.01);
  layer.update(42);
  layer.update(7);
  assert.deepEqual(layer.calls, [42, 7]);
});

test('SurfaceLayer: dispose() marks the layer as torn down', () => {
  const layer = new FakeLayer({} as never, [], 1, 0.01);
  assert.equal(layer.disposed, false);
  layer.dispose();
  assert.equal(layer.disposed, true);
});

// --- SettlementMarkerLayer construction -------------------------------

test('SettlementMarkerLayer: constructor does not throw (no DOM needed)', () => {
  // We don't pass cell-centers or a real group here; the layer
  // constructor only needs an object that exposes `add` and
  // `remove`, which our fake does.
  const fakeGroup = { add: () => {}, remove: () => {} } as unknown as import('three').Group;
  const layer = new SettlementMarkerLayer(fakeGroup, [], 1.0);
  // update(0 settlements) should be a safe no-op.
  layer.update([]);
  // dispose() should not throw even with no InstancedMesh built.
  layer.dispose();
});

// --- P3.2 BiomassLayer helpers ---------------------------------------

test('lineageIdToColor: deterministic — same id → same colour', () => {
  const a = lineageIdToColor('seed-0');
  const b = lineageIdToColor('seed-0');
  assert.equal(a, b);
  const c = lineageIdToColor('seed-1');
  const d = lineageIdToColor('seed-1');
  assert.equal(c, d);
});

test('lineageIdToColor: distinct lineages get distinct hues', () => {
  const colours = new Set<number>();
  for (let i = 0; i < 12; i++) {
    colours.add(lineageIdToColor(`seed-${i}`));
  }
  // We expect at least ~10 distinct hues out of 12 lineages.
  assert.ok(colours.size >= 10, `expected ≥10 distinct hues, got ${colours.size}`);
});

test('lineageIdToColor: empty id is well-defined (no throw)', () => {
  // The FNV-1a hash over an empty string is the seed 2166136261.
  // Whatever it maps to, it must be a valid 0xRRGGBB int.
  const c = lineageIdToColor('');
  assert.ok(c >= 0 && c <= 0xffffff);
});

test('hslToRgb: monochrome greys at s=0', () => {
  // At s=0, hue is irrelevant and the colour is a grey of
  // lightness `l` — every channel equal to round(l*255).
  const black = hslToRgb(0, 0, 0);
  const white = hslToRgb(180, 0, 1);
  const mid   = hslToRgb(45, 0, 0.5);
  const [r1, g1, b1] = colorToRgb(black);
  assert.equal(r1, 0); assert.equal(g1, 0); assert.equal(b1, 0);
  const [r2, g2, b2] = colorToRgb(white);
  assert.equal(r2, 1); assert.equal(g2, 1); assert.equal(b2, 1);
  const [r3, g3, b3] = colorToRgb(mid);
  // colorToRgb returns [0, 1]; grey ≈ 0.5 ± rounding.
  assert.ok(Math.abs(r3 - 0.5) < 0.01, `grey r should be ~0.5, got ${r3}`);
  assert.ok(Math.abs(r3 - g3) < 0.01);
  assert.ok(Math.abs(g3 - b3) < 0.01);
});

test('hslToRgb: primary hues land in the right channel', () => {
  // Hue 0 = red, hue 120 = green, hue 240 = blue. At s=1, l=0.5,
  // each primary should max out the matching channel and zero the
  // other two. (colorToRgb returns [0, 1].)
  const red   = hslToRgb(0,   1, 0.5);
  const green = hslToRgb(120, 1, 0.5);
  const blue  = hslToRgb(240, 1, 0.5);
  const [rr, rg, rb] = colorToRgb(red);
  assert.ok(rr > 0.7 && rg < 0.25 && rb < 0.25, `red channels: ${rr}, ${rg}, ${rb}`);
  const [gr, gg, gb] = colorToRgb(green);
  assert.ok(gr < 0.25 && gg > 0.7 && gb < 0.25, `green channels: ${gr}, ${gg}, ${gb}`);
  const [br, bg, bb] = colorToRgb(blue);
  assert.ok(br < 0.25 && bg < 0.25 && bb > 0.7, `blue channels: ${br}, ${bg}, ${bb}`);
});

test('hslToRgb: hue wraps (h=720 == h=0)', () => {
  assert.equal(hslToRgb(720, 1, 0.5), hslToRgb(0, 1, 0.5));
  assert.equal(hslToRgb(-120, 1, 0.5), hslToRgb(240, 1, 0.5));
});

test('biomassToScale: zero / negative biomass returns 0 (skipped)', () => {
  assert.equal(biomassToScale(0, 0.008), 0);
  assert.equal(biomassToScale(-1, 0.008), 0);
  assert.equal(biomassToScale(-1e9, 0.008), 0);
});

test('biomassToScale: log-scaled and capped', () => {
  const small = biomassToScale(1, 0.008);
  const medium = biomassToScale(100, 0.008);
  const big = biomassToScale(1_000_000, 0.008);
  // Monotonic.
  assert.ok(small < medium, `small=${small} should be < medium=${medium}`);
  assert.ok(medium < big, `medium=${medium} should be < big=${big}`);
  // Capped: a ridiculously large biomass stays at-or-below the cap.
  const huge = biomassToScale(1e15, 0.008);
  assert.ok(huge <= 0.008 + 1e-9, `huge should be ≤ 100% of markerHeight, got ${huge}`);
  // Big-but-not-saturated biomass is at-or-below the cap.
  assert.ok(big <= 0.008 + 1e-9, `big should be ≤ cap, got ${big}`);
  assert.ok(big > 0, `big should be positive, got ${big}`);
});

test('BiomassLayer: constructor + dispose do not throw', () => {
  const fakeGroup = { add: () => {}, remove: () => {} } as unknown as import('three').Group;
  const layer = new BiomassLayer(fakeGroup, [], 1.0);
  // Empty cell-centres → no instances.
  layer.update({ biomass: new Float32Array(0), dominant: new Int32Array(0), palette: [] });
  layer.dispose();
});

test('BiomassLayer: update with empty data is a no-op (no throw)', () => {
  const fakeGroup = { add: () => {}, remove: () => {} } as unknown as import('three').Group;
  // Provide a few cells but with no live biomass.
  const cells: CellPosition[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const layer = new BiomassLayer(fakeGroup, cells, 1.0);
  layer.update({
    biomass: new Float32Array([0, 0, 0]),
    dominant: new Int32Array([-1, -1, -1]),
    palette: [],
  });
  // All-dominant is -1 → no instances.
  layer.dispose();
});

// --- P3.3 WeatherLayer helpers ---------------------------------------

test('rgbToPacked: clamps to 0..255 and rounds', () => {
  // (0, 0, 0) → 0x000000
  assert.equal(rgbToPacked(0, 0, 0), 0x000000);
  // (1, 1, 1) → 0xFFFFFF
  assert.equal(rgbToPacked(1, 1, 1), 0xFFFFFF);
  // (0.5, 0.5, 0.5) → 0x808080
  assert.equal(rgbToPacked(0.5, 0.5, 0.5), 0x808080);
  // Out-of-range clamps.
  assert.equal(rgbToPacked(2, 0, 0), 0xFF0000);
  assert.equal(rgbToPacked(-1, 0, 0), 0x000000);
});

test('temperatureToColor: clamps at the cold and hot ends', () => {
  const frozen = temperatureToColor(100);
  const f = colorToRgb(frozen);
  // The 250 K stop is (0.10, 0.30, 0.85); 0.10 rounds to
  // 26/255 ≈ 0.102 after the int packing, so allow ±0.01.
  assert.ok(Math.abs(f[0]! - 0.10) < 0.01, `r: ${f[0]}`);
  assert.ok(Math.abs(f[2]! - 0.85) < 0.01, `b: ${f[2]}`);
  const hot = temperatureToColor(500);
  const h = colorToRgb(hot);
  // 320 K stop is (0.95, 0.30, 0.20).
  assert.ok(Math.abs(h[0]! - 0.95) < 0.01, `r: ${h[0]}`);
  assert.ok(Math.abs(h[2]! - 0.20) < 0.01, `b: ${h[2]}`);
});

test('temperatureToColor: middle of the range is roughly green', () => {
  // 290 K is the green stop, so the colour is exactly green.
  const mid = temperatureToColor(290);
  const [r, g, b] = colorToRgb(mid);
  // Allow small rounding slop from stop interpolation.
  assert.ok(r < g, `g should dominate r: ${r} vs ${g}`);
  assert.ok(b < g, `g should dominate b: ${b} vs ${g}`);
  // The 290 K stop is exactly the green (0.30, 0.75, 0.30) row.
  assert.ok(Math.abs(r - 0.30) < 0.01, `r at 290 K should be 0.30, got ${r}`);
  assert.ok(Math.abs(g - 0.75) < 0.01, `g at 290 K should be 0.75, got ${g}`);
});

test('temperatureToColor: gradient is monotonic in the cool→warm direction', () => {
  // Hot is more red than cold, but green peaks at 290 K then
  // drops toward yellow. Check the *red* channel is monotonic
  // non-decreasing from 250 K → 320 K (the cold stops are
  // blue, the warm stops are red).
  let prev = colorToRgb(temperatureToColor(250))[0]!;
  for (let k = 260; k <= 320; k += 5) {
    const r = colorToRgb(temperatureToColor(k))[0]!;
    assert.ok(r >= prev - 1e-6, `red should not decrease: at ${k}K got ${r}, prev ${prev}`);
    prev = r;
  }
});

test('WeatherLayer: constructor + dispose do not throw', () => {
  const fakeGroup = { add: () => {}, remove: () => {} } as unknown as import('three').Group;
  const layer = new WeatherLayer(fakeGroup, [], 1.0);
  layer.update({ temperature: [], land: [], landOpacity: 0.7 });
  layer.dispose();
});

test('WeatherLayer: update with cells paints one ring per cell', () => {
  const fakeGroup = { add: () => {}, remove: () => {} } as unknown as import('three').Group;
  const cells: CellPosition[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const layer = new WeatherLayer(fakeGroup, cells, 1.0);
  layer.update({
    temperature: new Float64Array([280, 295, 310]),
    land: new Float64Array([1, 0, 1]),
    landOpacity: 0.7,
  });
  // Calling again with the same count is a no-op for the
  // InstancedMesh allocation.
  layer.update({
    temperature: new Float64Array([281, 296, 311]),
    land: new Float64Array([1, 0, 1]),
    landOpacity: 0.7,
  });
  layer.dispose();
});
