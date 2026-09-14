import { initializeWorld } from './src/simulation/core/initialize.ts';
import { getScenario } from './src/scenarios/catalog.ts';
import { Timeline } from './src/persistence/timeline.ts';
import { canonicalJson, sha256 } from './src/simulation/core/canonical.ts';

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

const scenario = getScenario('two-lineages', 5120);
const world = await initializeWorld(scenario);
const t = new Timeline(world);
for (let i = 0; i < 50; i++) await t.advance();
const snapshot = t.state;

// Direct measurement of TypedArray sizes.
console.log('--- Direct TypedArray sizes ---');
console.log('cells.areaM2.length:', snapshot.cells.areaM2.length, 'byteLength:', snapshot.cells.areaM2.byteLength);
console.log('cells.neighborIndices.length:', snapshot.cells.neighborIndices.length, 'byteLength:', snapshot.cells.neighborIndices.byteLength);
console.log('cohorts.counts.length:', snapshot.cohorts.counts.length);
console.log('cohorts.energyReserveJ.length:', snapshot.cohorts.energyReserveJ.length);

const v2raw = await serializeStateV2(snapshot);
const v3raw = await (await import('./src/persistence/codec.ts')).serializeState(snapshot);
console.log('\n--- v2 envelope breakdown (char length of each TypedArray data) ---');
const v2 = JSON.parse(v2raw);
console.log('cells.areaM2.data length (raw chars):', v2.payload.cells.areaM2.data.length, 'array element count:', v2.payload.cells.areaM2.data.length);
console.log('cells.neighborIndices.data length:', v2.payload.cells.neighborIndices.data.length, 'array element count:', v2.payload.cells.neighborIndices.data.length);
console.log('cohorts.counts.data length:', v2.payload.cohorts.counts.data.length);
console.log('cohorts.energyReserveJ.data length:', v2.payload.cohorts.energyReserveJ.data.length);

console.log('\n--- v3 envelope breakdown (char length of base64 data) ---');
const v3 = JSON.parse(v3raw);
console.log('cells.areaM2.data length (base64 chars):', v3.payload.cells.areaM2.data.length);
console.log('cells.neighborIndices.data length (base64 chars):', v3.payload.cells.neighborIndices.data.length);
console.log('cohorts.counts.data length (base64 chars):', v3.payload.cohorts.counts.data.length);
console.log('cohorts.energyReserveJ.data length (base64 chars):', v3.payload.cohorts.energyReserveJ.data.length);
