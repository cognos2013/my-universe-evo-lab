import { getScenario } from '../src/scenarios/catalog.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { stepWorld } from '../src/simulation/core/step.ts';
import { matterTotal, energyTotal } from '../src/simulation/core/state.ts';
import { serializeState } from '../src/persistence/codec.ts';
import { writeFile } from 'node:fs/promises';

try {
  const [id = 'empty-planet', ticksArg = '100', output] = process.argv.slice(2);
  const ticks = Number(ticksArg);
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 100000) throw new Error('ticks must be integer 0..100000');
  let state = await initializeWorld(getScenario(id));
  const started = performance.now();
  for (let i = 0; i < ticks; i++) state = (await stepWorld(state)).state;
  const elapsedMs = performance.now()-started;
  console.log(JSON.stringify({ mode: 'ecology', scenario: id, tick: state.tick, cells: state.cells.areaM2.length, matterMu: matterTotal(state), meanTemperatureK: state.cells.temperatureK.reduce((a,b) => a+b,0)/state.cells.areaM2.length, energyJ: energyTotal(state), elapsedMs, ticksPerSecond: elapsedMs ? ticks*1000/elapsedMs : null },null,2));
  if (output) await writeFile(output,await serializeState(state),{flag:'wx'});
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
