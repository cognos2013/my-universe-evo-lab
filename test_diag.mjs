import { getScenario } from './src/scenarios/catalog.ts';
import { serializeState, deserializeState } from './src/persistence/codec.ts';
import { initializeWorld } from './src/simulation/core/initialize.ts';
import { sha256 } from './src/simulation/core/canonical.ts';

const scenario = getScenario('two-lineages', 5120);
const original = await initializeWorld(scenario);
const raw = await serializeState(original);
const e = JSON.parse(raw);
console.log('original f64 data length:', e.payload.cells.areaM2.data.length);
const misaligned = e.payload.cells.areaM2.data.slice(4);
console.log('misaligned length:', misaligned.length);
const atobBytes = atob(misaligned).length;
console.log('atob decoded bytes:', atobBytes, '% 8:', atobBytes % 8);
e.payload.cells.areaM2.data = misaligned;
const { checksum: _, ...content } = e;
const resigned = JSON.stringify({ ...content, checksum: await sha256(content) });
try {
  await deserializeState(resigned);
  console.log('UNEXPECTED: deserialize succeeded');
} catch (err) {
  console.log('error message:', err.message);
}
