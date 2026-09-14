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
const raw = await serializeStateV2(t.state);
const env = JSON.parse(raw);
console.log('cells.areaM2 data length:', env.payload.cells.areaM2.data.length, 'kind:', env.payload.cells.areaM2.$array);
console.log('cells.neighborIndices data length:', env.payload.cells.neighborIndices.data.length, 'kind:', env.payload.cells.neighborIndices.$array);
console.log('First 3 neighborIndices values:', env.payload.cells.neighborIndices.data.slice(0,3));
console.log('cohorts.counts data length:', env.payload.cohorts.counts.data.length);
console.log('cohorts.energyReserveJ data length:', env.payload.cohorts.energyReserveJ.data.length);
console.log('cohorts.ids count:', env.payload.cohorts.ids.length);
console.log('samples count:', env.payload.samples ? env.payload.samples.length : 'n/a');
