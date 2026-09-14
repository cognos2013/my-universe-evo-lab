import {writeFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import {createGalaxies,stepGalaxies,galaxySummary} from '../src/simulation/cosmos/galaxies.ts';
import {gravityMetrics} from '../src/simulation/cosmos/gravity.ts';
let state=await createGalaxies('my-universe-demo-v1');
let maxRelativeEnergyError=0,maxRelativeMomentumError=0,maxBaryonResidual=0;
const started=performance.now();
for(let i=0;i<100;i++){
  state=stepGalaxies(state);const d=state.dynamics!,m=gravityMetrics(d);
  maxRelativeEnergyError=Math.max(maxRelativeEnergyError,Math.abs((m.energy-d.initialEnergy)/d.initialEnergy));
  const scale=Math.max(1,...d.bodies.map(b=>b.massSolar*Math.hypot(...b.velocityKpcMyr)));
  maxRelativeMomentumError=Math.max(maxRelativeMomentumError,Math.hypot(...m.momentum.map((p,k)=>p-d.initialMomentum[k]!))/scale);
  maxBaryonResidual=Math.max(maxBaryonResidual,Math.abs(galaxySummary(state).residual));
}
const passed=maxRelativeEnergyError<1e-3&&maxRelativeMomentumError<1e-9&&maxBaryonResidual<1e-3&&state.dynamics!.mergers.length>0;
const result={measuredAt:new Date().toISOString(),cpu:cpus()[0]?.model,node:process.version,elapsedMs:performance.now()-started,scenario:'my-universe-demo-v1',durationMyr:500,gravityStepMyr:.05,initialHalos:8,finalHalos:state.halos.length,mergers:state.dynamics!.mergers.length,maxRelativeEnergyError,maxRelativeMomentumError,maxBaryonResidualSolar:maxBaryonResidual,passed,limitations:'Isolated softened point halos with explicit merger internal-energy accounting; not a cosmological structure-formation calibration.'};
console.log(JSON.stringify(result,null,2));await writeFile('reports/P10B-dynamics.json',JSON.stringify(result,null,2)+'\n');if(!passed)process.exitCode=1;
