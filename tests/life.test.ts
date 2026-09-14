import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { stepWorld } from '../src/simulation/core/step.ts';
import { matterTotal, validateState, energyTotal } from '../src/simulation/core/state.ts';
import { advanceLife, binomial } from '../src/simulation/life/advance.ts';
import { RandomStream, createRandomStream } from '../src/simulation/core/random.ts';
import { summarize } from '../src/simulation/metrics/summary.ts';
import { serializeState, deserializeState } from '../src/persistence/codec.ts';
import { cellAlbedos } from '../src/simulation/environment/albedo.ts';

test('binomial endpoints, population bounds and empirical expectation', async () => {
  const rng=await createRandomStream('sample','test','world',0);
  assert.equal(binomial(100,0,rng),0); assert.equal(binomial(100,1,rng),100);
  let total=0;
  for(let i=0;i<10000;i++) {const n=binomial(100,0.3,rng);assert.ok(n>=0&&n<=100);total+=n;}
  assert.ok(Math.abs(total/10000-30)<0.3);
});

test('life progresses for 40 ticks with conserved material and explicit mutations', async () => {
  let state=await initializeWorld(getScenario('two-lineages'));
  const initial=matterTotal(state); let births=0, deaths=0, mutations=0;
  for(let i=0;i<40;i++){const r=await stepWorld(state);state=r.state;births+=r.life.births;deaths+=r.life.deaths;mutations+=r.life.mutations;}
  assert.ok(births>0); assert.ok(deaths>0); assert.ok(mutations>0);
  assert.equal(summarize(state).population,2000+births-deaths);
  assert.ok(Math.abs(matterTotal(state)-initial)<1e-6);
  assert.ok(state.lineages.length>2);validateState(state);
});

test('disabled mutations create no new traits; empty world stays empty', async () => {
  let state=await initializeWorld(getScenario('closed-resources'));
  for(let i=0;i<10;i++)state=(await stepWorld(state)).state;
  assert.equal(state.traits.length,2);assert.equal(state.lineages.length,2);
  const empty=(await stepWorld(await initializeWorld(getScenario('empty-planet')))).state;
  assert.equal(summarize(empty).population,0);assert.equal(summarize(empty).diversity,0);
});

test('births require both material and energy; lost biomass returns to detritus', async () => {
  const scenario=getScenario('two-lineages'); scenario.planet.radiusM=1;
  const state=await initializeWorld(scenario);
  state.cells.nutrientMu.fill(0);state.cohorts.energyReserveJ.fill(0);
  state.ledger.initialMatterMu=matterTotal(state);state.ledger.initialEnergyJ=energyTotal(state);
  state.rules.life.maxHarvestJPerIndividualSecond=0;
  const flux=advanceLife(state,86400);
  assert.equal(flux.births,0);assert.ok(flux.deaths>0);assert.ok(flux.dissipatedJ===0);
  assert.equal(state.cells.detritusMu.reduce((a,b)=>a+b,0),flux.deaths);
  assert.equal(matterTotal(state),2000);
});

test('cool and warm environments select different initial thermal lineages across seeds', async () => {
  const experiment=async(temp:number)=>{
    let cool=0,warm=0;
    for(let seed=0;seed<4;seed++){
      const s=getScenario('two-lineages');s.seed=`selection-${seed}`;s.planet.initialTemperatureK=temp;s.rules.life.mutationProbability=0;
      let state=await initializeWorld(s);
      for(let i=0;i<10;i++)state=(await stepWorld(state)).state;
      for(let i=0;i<state.cohorts.ids.length;i++)if(state.cohorts.lineageIndices[i]===0)cool+=state.cohorts.counts[i]!;else warm+=state.cohorts.counts[i]!;
    }
    return cool-warm;
  };
  assert.ok(await experiment(283)>0); assert.ok(await experiment(298)<0);
});

test('state ordering and serialization do not change subsequent life outcomes', async () => {
  const a=await initializeWorld(getScenario('two-lineages'));
  const b=await deserializeState(await serializeState(a));
  b.cohorts.ids.reverse();b.cohorts.cellIndices.reverse();b.cohorts.lineageIndices.reverse();b.cohorts.counts.reverse();b.cohorts.energyReserveJ.reverse();
  const x=await stepWorld(a),y=await stepWorld(b);
  assert.deepEqual(x,y);
  assert.equal(a.tick,0);
});

test('cohort budget fails atomically, without removing rare lineages', async () => {
  const a=await initializeWorld(getScenario('two-lineages'));a.rules.limits.maxCohorts=a.cohorts.ids.length;
  a.rules.life.mutationProbability=1;
  const original=structuredClone(a);
  await assert.rejects(stepWorld(a),/计算上限/);assert.deepEqual(a,original);
});

test('small-planet energy transfers close independently of huge global rounding', async () => {
  const s=getScenario('two-lineages');s.planet.radiusM=1;
  const a=await initializeWorld(s);const before=energyTotal(a);
  const flux=advanceLife(a,86400);
  assert.ok(flux.harvestedJ>0);assert.ok(flux.dissipatedJ>0);
  assert.ok(Math.abs(energyTotal(a)-before)/before<1e-13);
  assert.ok(flux.harvestedJ<=340*0.7*4*Math.PI*86400/2);
});

test('migration conserves individuals and material, and life feeds back into albedo', async () => {
  const s=getScenario('two-lineages');
  s.rules.life.backgroundDeathPerSecond=0;s.rules.life.thermalDeathPerSecond=0;s.rules.life.starvationDeathPerSecond=0;
  s.traits.forEach(t=>{t.uptakeMuPerIndividualSecond=0;t.dispersalPerSecond=1/86400;});
  const state=await initializeWorld(s);const before=matterTotal(state);
  assert.ok(cellAlbedos(state).some(x=>x>s.rules.environment.albedo));
  const result=await stepWorld(state);
  assert.ok(result.life.migrants>0);assert.equal(result.life.births,0);assert.equal(result.life.deaths,0);
  assert.equal(summarize(result.state).population,2000);
  assert.ok(Math.abs(matterTotal(result.state)-before)<1e-6);
});
