import { initializeWorld } from './src/simulation/core/initialize.ts';
import { getScenario } from './src/scenarios/catalog.ts';
import { serializeState } from './src/persistence/codec.ts';
import { Timeline } from './src/persistence/timeline.ts';

const sizes = [320, 1280, 5120, 20480];
for (const cells of sizes) {
  const scenario = getScenario('two-lineages', cells);
  const world = await initializeWorld(scenario);
  const t = new Timeline(world);
  for (let i = 0; i < 50; i++) await t.advance();
  const snapshot = t.state;
  const N = 5;
  let total = 0;
  let totalSize = 0;
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    const raw = await serializeState(snapshot);
    total += performance.now() - start;
    totalSize = raw.length;
  }
  console.log(`${cells.toString().padStart(5)} cells: ${(total/N).toFixed(2)} ms (avg of ${N}), ${(totalSize/1024).toFixed(1)} KB`);
}
