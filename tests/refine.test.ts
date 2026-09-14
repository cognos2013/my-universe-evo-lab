import {test} from 'node:test';import assert from 'node:assert/strict';
import {ExperimentBook} from '../src/experiments/book.ts';
import {initializeWorld} from '../src/simulation/core/initialize.ts';
import {getScenario} from '../src/scenarios/catalog.ts';
import {matterTotal,energyTotal} from '../src/simulation/core/state.ts';
import {serializeState} from '../src/persistence/codec.ts';
import {applyIntervention} from '../src/simulation/interventions/apply.ts';

test('existing 1280-cell history refines without losing life, material, energy or forcing',async()=>{
  let state=await initializeWorld(getScenario('two-lineages',1280));
  state=await applyIntervention(state,{id:'heat',branchId:'main',atTick:0,version:1,type:'changeForcing',payload:{cells:[3],forcingWPerM2:20,durationTicks:8}});
  const book=await ExperimentBook.create(state);await book.active.advance();const before=await serializeState(book.active.state),old=book.active.state;
  await book.refine('fine');const next=book.active.state;
  assert.equal(next.cells.areaM2.length,5120);assert.equal(next.tick,old.tick);assert.deepEqual(next.rng,old.rng);
  assert.deepEqual(next.lineages,old.lineages);assert.equal(next.cohorts.counts.reduce((a,b)=>a+b,0),old.cohorts.counts.reduce((a,b)=>a+b,0));
  assert.ok(Math.abs(matterTotal(next)-matterTotal(old))<1e-7);assert.ok(Math.abs(energyTotal(next)/energyTotal(old)-1)<1e-12);
  assert.deepEqual(next.execution.forcings[0]!.cells,[12,13,14,15]);
  for(let i=0;i<1280;i++)assert.ok(Math.abs(next.cells.nutrientMu.slice(i*4,i*4+4).reduce((a,b)=>a+b,0)-old.cells.nutrientMu[i]!)<1e-10);
  assert.equal(await serializeState(book.branches.get('main')!.timeline.state),before);
  await book.active.advance();const restored=await ExperimentBook.import(await book.export());
  assert.equal(await serializeState(restored.active.state),await serializeState(book.active.state));
});
test('refinement beyond supported resolution fails without creating a branch',async()=>{
  const book=await ExperimentBook.create(await initializeWorld(getScenario('empty-planet',20480)));
  await assert.rejects(book.refine('invalid'),/上限/);assert.equal(book.branches.size,1);
});
