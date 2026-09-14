import{initializeWorld}from'../src/simulation/core/initialize.ts';import{getScenario}from'../src/scenarios/catalog.ts';
import{stepWorld}from'../src/simulation/core/step.ts';import{matterTotal,energyTotal,validateState}from'../src/simulation/core/state.ts';
import{sha256}from'../src/simulation/core/canonical.ts';import{cpus,platform,arch}from'node:os';
const cases=[];
for(const stressed of [false,true]){
  const scenario=getScenario('two-lineages',1280);
  let state=await initializeWorld(scenario);
  if(stressed){
    state.rules.life.mutationProbability=0;state.traits.forEach(t=>{t.dispersalPerSecond=0;});
    state.lineages=Array.from({length:10000},(_,i)=>({id:`bench-${i}`,parentId:null,originTick:0,traitId:'cool',origin:'seeded' as const}));
    state.cohorts={ids:Array.from({length:10000},(_,i)=>`cohort-${i}`),cellIndices:Uint32Array.from({length:10000},(_,i)=>i%1280),lineageIndices:Uint32Array.from({length:10000},(_,i)=>i),counts:new Float64Array(10000).fill(1),energyReserveJ:new Float64Array(10000).fill(20)};
    state.ledger.initialMatterMu=matterTotal(state);state.ledger.initialEnergyJ=energyTotal(state);state.manifest.rulesetHash=await sha256(state.rules);validateState(state);
  }
  const initialCohorts=state.cohorts.ids.length,started=performance.now();let peakRss=process.memoryUsage().rss;const steps=20;
  for(let i=0;i<steps;i++){state=(await stepWorld(state)).state;peakRss=Math.max(peakRss,process.memoryUsage().rss);}
  const milliseconds=performance.now()-started,ticksPerSecond=steps*1000/milliseconds;
  cases.push({case:stressed?'10000-cohort-stress-no-mutation-or-migration':'default-1280',cells:1280,initialCohorts,finalCohorts:state.cohorts.ids.length,steps,milliseconds,ticksPerSecond,peakNodeRssMB:peakRss/1024**2,pass:ticksPerSecond>=20&&peakRss/1024**2<500});
}
console.log(JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,cases,limits:'Node process RSS includes runtime; browser/GPU total memory is not measured by this benchmark.'},null,2));
if(cases.some(c=>!c.pass))process.exitCode=1;
