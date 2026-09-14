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

const { serializeState } = await import('./src/persistence/codec.ts');
const sizes = [320, 1280, 5120, 20480];
console.log('cells  | v2 ms   v2 KB   | v3 ms   v3 KB   | v2/v3 time   size saved');
for (const cells of sizes) {
  const scenario = getScenario('two-lineages', cells);
  const world = await initializeWorld(scenario);
  const t = new Timeline(world);
  for (let i = 0; i < 50; i++) await t.advance();
  const snap = t.state;
  const N = 5;
  let v2t=0, v3t=0, v2s=0, v3s=0;
  for (let i=0;i<N;i++) {
    let s=performance.now(); const r=await serializeStateV2(snap); v2t+=performance.now()-s; v2s=r.length;
    s=performance.now(); const r3=await serializeState(snap); v3t+=performance.now()-s; v3s=r3.length;
  }
  const tRatio = (v2t/v3t).toFixed(2);
  const sSaved = (((v2s-v3s)/v2s)*100).toFixed(1);
  console.log(`${String(cells).padStart(5)}  | ${(v2t/N).toFixed(1).padStart(5)}  ${(v2s/1024).toFixed(0).padStart(5)}   | ${(v3t/N).toFixed(1).padStart(5)}  ${(v3s/1024).toFixed(0).padStart(5)}   | ${tRatio}x      ${sSaved}%`);
}
