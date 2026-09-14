import { initializeWorld } from './src/simulation/core/initialize.ts';
import { getScenario } from './src/scenarios/catalog.ts';
import { Timeline } from './src/persistence/timeline.ts';
import { serializeState } from './src/persistence/codec.ts';

const scenario = getScenario('two-lineages', 5120);
const world = await initializeWorld(scenario);
const t = new Timeline(world);
for (let i = 0; i < 50; i++) await t.advance();
const snapshot = t.state;
const raw = await serializeState(snapshot);
const env = JSON.parse(raw);
console.log('cells.areaM2 data length:', env.payload.cells.areaM2.data.length, 'kind:', env.payload.cells.areaM2.$array);
console.log('cells.neighborIndices data length:', env.payload.cells.neighborIndices.data.length, 'kind:', env.payload.cells.neighborIndices.$array);
console.log('cohorts.counts data length:', env.payload.cohorts.counts.data.length, 'kind:', env.payload.cohorts.counts.$array);
console.log('cohorts.energyReserveJ data length:', env.payload.cohorts.energyReserveJ.data.length);
console.log('cohorts.ids count:', env.payload.cohorts.ids.length);
console.log('samples count:', env.payload.branches ? 'n/a' : 'unknown');
