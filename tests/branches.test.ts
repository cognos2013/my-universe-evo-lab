import {test}from'node:test';import assert from'node:assert/strict';
import{ExperimentBook}from'../src/experiments/book.ts';import{Timeline}from'../src/persistence/timeline.ts';
import{initializeWorld}from'../src/simulation/core/initialize.ts';import{getScenario}from'../src/scenarios/catalog.ts';
import{applyIntervention}from'../src/simulation/interventions/apply.ts';import{forcingField}from'../src/simulation/core/execution.ts';import{serializeState}from'../src/persistence/codec.ts';
import{stepWorld}from'../src/simulation/core/step.ts';import{summarize}from'../src/simulation/metrics/summary.ts';
import type{Intervention,WorldState}from'../src/simulation/core/contracts.ts';
import {sha256} from '../src/simulation/core/canonical.ts';
test('capacity expansion recovers a blocked world and preserves the parent archive',async()=>{
  const state=await initializeWorld(getScenario('two-lineages'));
  state.rules.limits.maxCohorts=state.cohorts.ids.length;state.rules.life.mutationProbability=1;
  state.manifest.rulesetHash=await sha256(state.rules);
  const book=await ExperimentBook.create(state),before=await serializeState(book.active.state);
  await assert.rejects(book.active.advance(),/计算上限/);assert.equal(await serializeState(book.active.state),before);
  await book.expandCapacity('expanded');
  assert.deepEqual(book.active.state.cohorts,state.cohorts);assert.deepEqual(book.active.state.rng,state.rng);
  assert.equal(book.active.state.rules.limits.maxCohorts,20000);await book.active.advance();
  assert.equal(book.active.state.tick,1);assert.equal(await serializeState(book.branches.get('main')!.timeline.state),before);
  const restored=await ExperimentBook.import(await book.export());assert.equal(restored.active.state.tick,1);
  assert.equal(restored.active.state.rules.limits.maxCohorts,20000);restored.switch('main');assert.equal(await serializeState(restored.active.state),before);
});
test('capacity expansion rejects unsupported growth without creating another branch',async()=>{
  const scenario=getScenario('empty-planet');scenario.rules.limits.maxCohorts=100000;
  const book=await ExperimentBook.create(await initializeWorld(scenario));
  await assert.rejects(book.expandCapacity('too-large'),/支持上限/);assert.equal(book.branches.size,1);
});
const physics=(s:WorldState)=>{const{branch,...rest}=s;return rest;};
test('unmodified sibling branches evolve identically and parent remains immutable',async()=>{
  const book=await ExperimentBook.create(await initializeWorld(getScenario('two-lineages')));const original=await serializeState(book.active.state);
  await book.fork('child','平行世界');for(let i=0;i<5;i++)await book.active.advance();
  assert.equal(await serializeState(book.branches.get('main')!.timeline.state),original);
  for(let i=0;i<5;i++)await book.branches.get('main')!.timeline.advance();
  assert.deepEqual(physics(book.active.state),physics(book.branches.get('main')!.timeline.state));
});
test('commands are idempotent, fail atomically, and matter changes equal explicit input',async()=>{
  const original=await initializeWorld(getScenario('two-lineages'));
  const cmd:Intervention={id:'add-1',branchId:'main',atTick:0,version:1,type:'addNutrient',payload:{cells:[0,1,2],totalMu:100}};
  const next=await applyIntervention(original,cmd),again=await applyIntervention(next,cmd);
  assert.deepEqual(next,again);assert.equal(next.ledger.externalMatterInMu,100);assert.equal(original.ledger.externalMatterInMu,0);
  await assert.rejects(applyIntervention(next,{...cmd,payload:{...cmd.payload,totalMu:200}}),/ID/);
  const before=await serializeState(original);
  await assert.rejects(applyIntervention(original,{...cmd,branchId:'wrong'}));assert.equal(await serializeState(original),before);
});
test('forcing lasts exactly its requested ticks and survives a mid-forcing save',async()=>{
  let s=await initializeWorld(getScenario('empty-planet'));
  s=await applyIntervention(s,{id:'heat',branchId:'main',atTick:0,version:1,type:'changeForcing',payload:{cells:[0],forcingWPerM2:100,durationTicks:2}});
  assert.equal(forcingField(s)[0],100);s=(await stepWorld(s)).state;assert.equal(forcingField(s)[0],100);
  const h=await Timeline.create(s),r=await Timeline.import(await h.export());
  assert.deepEqual((await stepWorld(s)).state,(await stepWorld(r.state)).state);
  s=(await stepWorld(s)).state;assert.equal(forcingField(s)[0],0);assert.equal(s.execution.forcings.length,0);
});
test('intervention history replays exactly from before the command',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('two-lineages')));
  for(let i=0;i<5;i++)await h.advance();
  await h.intervene({id:'impact',branchId:'main',atTick:5,version:1,type:'disturbArea',payload:{cells:[0,1,2,3],mortalityFraction:0.8}});
  for(let i=0;i<10;i++)await h.advance();const expected=await serializeState(h.state);
  await h.seek(0);for(let i=0;i<15;i++)await h.advance();assert.equal(await serializeState(h.state),expected);
});
test('seeding and trait editing are recorded as artificial lineage changes',async()=>{
  const s=await initializeWorld(getScenario('two-lineages'));
  const seeded=await applyIntervention(s,{id:'seed',branchId:'main',atTick:0,version:1,type:'seedLife',payload:{cells:[0],traitId:'cool',totalCount:2,materialSource:'external',reserveJPerIndividual:20}});
  assert.equal(summarize(seeded).population,2002);assert.equal(seeded.ledger.externalEnergyInJ,40);
  const edited=await applyIntervention(s,{id:'edit',branchId:'main',atTick:0,version:1,type:'editTraits',payload:{cohortId:s.cohorts.ids[0]!,count:1,traits:{...s.traits[0]!,id:'manual',thermalOptimumK:310}}});
  assert.equal(summarize(edited).population,2000);assert.equal(edited.lineages.at(-1)!.origin,'intervention');
});
test('book persists all branches; compare aligns time and detects a material intervention',async()=>{
  const b=await ExperimentBook.create(await initializeWorld(getScenario('two-lineages')));
  await b.forkAndIntervene('experiment','营养实验',{id:'feed',branchId:'experiment',atTick:0,version:1,type:'addNutrient',payload:{cells:[0],totalMu:500}});
  const result=await b.compare('main','experiment',5);assert.equal(result.first.tick,result.second.tick);assert.notEqual(result.delta.nutrientMu,0);
  const r=await ExperimentBook.import(await b.export());assert.equal(r.activeId,'experiment');assert.equal(r.branches.size,2);assert.deepEqual(r.active.state,b.active.state);
  const before=b.branches.size;
  await assert.rejects(b.forkAndIntervene('bad','bad',{id:'bad-cmd',branchId:'bad',atTick:5,version:1,type:'addNutrient',payload:{cells:[999],totalMu:1}}));assert.equal(b.branches.size,before);assert.equal(b.activeId,'experiment');
});
test('comparison cancellation retains only complete valid time steps',async()=>{
  const b=await ExperimentBook.create(await initializeWorld(getScenario('two-lineages')));await b.fork('child','child');let checks=0;
  await assert.rejects(b.compare('main','child',100,undefined,()=>++checks>3),/取消/);
  assert.equal(b.active.state.tick,3);assert.equal(b.branches.get('main')!.timeline.state.tick,3);
});
