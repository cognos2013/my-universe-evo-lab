import { initializeWorld } from './src/simulation/core/initialize.ts';
import { getScenario } from './src/scenarios/catalog.ts';
import { Timeline } from './src/persistence/timeline.ts';
import { canonicalJson, sha256 } from './src/simulation/core/canonical.ts';

// v2-style pack: TypedArray → plain number array (mirrors the old behaviour).
function packV2(value) {
  if (value instanceof Float64Array || value instanceof Uint32Array) {
    return { $array: value instanceof Float64Array ? 'f64' : 'u32', data: Array.from(value) };
  }
  if (Array.isArray(value)) return value.map(packV2);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, packV2(v)]));
  }
  return value;
}

async function serializeStateV2(input) {
  const payload = packV2(input);
  const content = { format: 'my-universe-state', version: 2, kind: 'state', payload };
  return canonicalJson({ ...content, checksum: await sha256(content) });
}

const sizes = [320, 1280, 5120, 20480];
console.log('v2 (legacy Array.from)            |  v3 (new base64)');
console.log('cells | ms     | KB               | ms     | KB');

const { serializeState } = await import('./src/persistence/codec.ts');
for (const cells of sizes) {
  const scenario = getScenario('two-lineages', cells);
  const world = await initializeWorld(scenario);
  const t = new Timeline(world);
  for (let i = 0; i < 50; i++) await t.advance();
  const snapshot = t.state;
  const N = 5;
  let v2Time = 0, v3Time = 0, v2Size = 0, v3Size = 0;
  for (let i = 0; i < N; i++) {
    let s = performance.now(); const v2raw = await serializeStateV2(snapshot); v2Time += performance.now() - s; v2Size = v2raw.length;
    s = performance.now(); const v3raw = await serializeState(snapshot); v3Time += performance.now() - s; v3Size = v3raw.length;
  }
  console.log(`${cells.toString().padStart(5)} | ${(v2Time/N).toFixed(1).padStart(5)} | ${(v2Size/1024).toFixed(1).padStart(6)} KB         | ${(v3Time/N).toFixed(1).padStart(5)} | ${(v3Size/1024).toFixed(1).padStart(6)} KB`);
}
