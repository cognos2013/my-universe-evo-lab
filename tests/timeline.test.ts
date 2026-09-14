import {test}from'node:test';import assert from'node:assert/strict';
import{Timeline,HISTORY_LIMITS}from'../src/persistence/timeline.ts';
import{initializeWorld}from'../src/simulation/core/initialize.ts';
import{getScenario}from'../src/scenarios/catalog.ts';
import{serializeState}from'../src/persistence/codec.ts';
test('history rewind and resimulation reproduce exact head; export preserves future when rewound',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('two-lineages')));
  for(let i=0;i<15;i++)await h.advance();const expected=await serializeState(h.state);
  await h.seek(5);assert.equal(h.state.tick,5);
  const restored=await Timeline.import(await h.export());assert.equal(restored.state.tick,5);assert.equal(restored.headTick,15);
  await restored.seek(15);assert.equal(await serializeState(restored.state),expected);
  await h.seek(0);for(let i=0;i<15;i++)await h.advance();assert.equal(await serializeState(h.state),expected);
});
test('corrupt timeline and invalid historical target cannot replace current state',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('two-lineages')));await h.advance();
  const before=await serializeState(h.state);
  await assert.rejects(h.seek(2));assert.equal(await serializeState(h.state),before);
  const raw=await h.export(),o=JSON.parse(raw);o.currentTick=0;
  await assert.rejects(Timeline.import(JSON.stringify(o)),/校验和/);
});
test('long history replay can be cancelled without altering current state',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('two-lineages')));for(let i=0;i<20;i++)await h.advance();
  const before=await serializeState(h.state);let checks=0;
  await assert.rejects(h.seek(15,{cancelled:()=>++checks>2}),/取消/);assert.equal(await serializeState(h.state),before);
});
test('oversized histories cannot be exported as apparently recoverable files',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('empty-planet')));
  const before=await serializeState(h.state);h.samples.length=100002;
  await assert.rejects(h.export(),/预算/);assert.equal(await serializeState(h.state),before);
});
test('compacted checkpoints replay removed history and preserve a rewound export',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('empty-planet')));
  const expected=new Map<number,string>();
  for(let i=0;i<75;i++){
    await h.advance();await h.checkpoint();expected.set(h.state.tick,await serializeState(h.state));
    if(i===20)await h.intervene({id:'resource-pulse',type:'addNutrient',branchId:h.state.branch.id,atTick:h.state.tick,version:1,payload:{cells:[0],totalMu:10}});
    expected.set(h.state.tick,await serializeState(h.state));
  }
  assert.ok(h.storageStats().checkpoints<=HISTORY_LIMITS.checkpoints);
  const data=await h.data();assert.equal(data.checkpoints[0]!.tick,0);
  const removed=[...expected.keys()].find(t=>t>21&&!data.checkpoints.some(c=>c.tick===t))!;
  assert.ok(removed);await h.seek(removed);assert.equal(await serializeState(h.state),expected.get(removed));
  const restored=await Timeline.import(await h.export());assert.equal(restored.state.tick,removed);
  await restored.seek(75);assert.equal(await serializeState(restored.state),expected.get(75));
  await restored.seek(0);assert.equal(restored.state.tick,0);
});
test('long histories bound chart samples without changing world state or replay',async()=>{
  const h=await Timeline.create(await initializeWorld(getScenario('empty-planet')));
  for(let i=0;i<HISTORY_LIMITS.samples+12;i++)await h.advance();
  const expected=await serializeState(h.state),head=h.headTick;
  assert.equal(h.samples.length,HISTORY_LIMITS.samples);assert.equal(h.samples[0]!.tick,0);assert.equal(h.samples.at(-1)!.tick,head);
  assert.equal(h.storageStats().sampled,true);
  await h.seek(head-7);await h.seek(head);assert.equal(await serializeState(h.state),expected);
});
