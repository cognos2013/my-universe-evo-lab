import {test}from'node:test';import assert from'node:assert/strict';
import{SimulationController}from'../src/workers/controller.ts';
import{serializeState}from'../src/persistence/codec.ts';
test('projection and inspection cannot change state or consume random numbers',async()=>{
  const c=new SimulationController(()=>{});await c.handle({id:1,type:'create'});
  const before=await serializeState(c.snapshotState());
  for(let i=0;i<20;i++){c.projection();await c.handle({id:2,type:'inspect',payload:{cell:i}});}
  assert.equal(await serializeState(c.snapshotState()),before);
});
test('pause cancels scheduled continuation at a complete state boundary',async()=>{
  const c=new SimulationController(()=>{});await c.handle({id:1,type:'create'});
  await c.handle({id:2,type:'run',payload:{ticks:1000}});
  await c.handle({id:3,type:'pause'});const before=await serializeState(c.snapshotState());
  await new Promise(r=>setTimeout(r,20));assert.equal(await serializeState(c.snapshotState()),before);
});
