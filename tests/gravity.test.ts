import {test} from 'node:test';import assert from 'node:assert/strict';
import {G,createGravity,advanceGravity,gravityMetrics,validateGravity} from '../src/simulation/cosmos/gravity.ts';
import type {GravityBody,GravityState} from '../src/simulation/cosmos/gravity.ts';
import {createGalaxies,stepGalaxies,galaxySummary} from '../src/simulation/cosmos/galaxies.ts';
const body=(id:string,x:number,mass=1e10):GravityBody=>({id,massSolar:mass,positionKpc:[x,0,0],velocityKpcMyr:[0,0,0],spin:[0,0,0]});
const norm=(v:number[])=>Math.hypot(...v);
test('isolated particle follows inertial motion and failed steps leave it unchanged',()=>{
  const b=body('free',2);b.velocityKpcMyr=[.1,-.2,.3];const s=createGravity([b]),original=structuredClone(s),r=advanceGravity(s,10);
  r.bodies[0]!.positionKpc.forEach((p,k)=>assert.ok(Math.abs(p-(b.positionKpc[k]!+10*b.velocityKpcMyr[k]!))<1e-10));
  assert.deepEqual(s,original);assert.throws(()=>advanceGravity(s,-1));assert.deepEqual(s,original);
});
function binary(){const a=body('a',-1),b=body('b',1),omega=Math.sqrt(G*2e10/(4+.01**2)**1.5);a.velocityKpcMyr=[0,-omega,0];b.velocityKpcMyr=[0,omega,0];return {s:createGravity([a,b],.01,0),omega};}
test('binary circular orbit converges at second order with bounded energy and momentum error',()=>{
  const {s,omega}=binary(),duration=30;
  const error=(dt:number)=>{const r=advanceGravity(s,duration,dt),expected=[Math.cos(omega*duration),Math.sin(omega*duration),0];return{r,error:norm(r.bodies[1]!.positionKpc.map((x,k)=>x-expected[k]!))};};
  const coarse=error(.5),fine=error(.25);assert.ok(fine.error<coarse.error*.3,`${coarse.error}, ${fine.error}`);
  const r=advanceGravity(s,100,.05),m=gravityMetrics(r);assert.ok(Math.abs(m.energy/s.initialEnergy-1)<1e-5);assert.ok(norm(m.momentum)<1e-5);assert.ok(norm(m.angular.map((x,k)=>x-s.initialAngularMomentum[k]!))<1e-4);
});
test('symmetric cold pair collapses without center-of-mass drift',()=>{
  const s=createGravity([body('left',-5),body('right',5)],.5,0),r=advanceGravity(s,100);
  assert.ok(Math.abs(r.bodies[0]!.positionKpc[0])<5);
  assert.ok(Math.abs(r.bodies[0]!.positionKpc[0]+r.bodies[1]!.positionKpc[0])<1e-12);
  assert.ok(norm(gravityMetrics(r).momentum)<1e-5);
});
test('bound merger conserves mass, momentum, angular momentum and explicit energy ledger',()=>{
  const a=body('a',-.2),b=body('b',.2,2e10);a.velocityKpcMyr=[.01,.02,0];b.velocityKpcMyr=[-.01,-.01,0];
  const s=createGravity([a,b],.5,1),r=advanceGravity(s,.001,.001),m=gravityMetrics(r);
  assert.equal(r.bodies.length,1);assert.equal(r.mergers.length,1);assert.deepEqual(r.mergers[0]!.parents,['a','b']);
  assert.equal(m.mass,s.initialMassSolar);assert.ok(norm(m.momentum.map((x,k)=>x-s.initialMomentum[k]!))<1e-5);assert.ok(norm(m.angular.map((x,k)=>x-s.initialAngularMomentum[k]!))<1e-5);
  assert.ok(Math.abs(m.energy/s.initialEnergy-1)<1e-8);assert.notEqual(r.internalEnergy,0);
  const bad=structuredClone(r);bad.mergers[0]!.parents=['a','a'];assert.throws(()=>validateGravity(bad));
});
test('fast unbound encounters do not merge and reordered input stays deterministic',()=>{
  const a=body('a',-.2),b=body('b',.2);a.velocityKpcMyr=[10,0,0];b.velocityKpcMyr=[-10,0,0];
  const s=createGravity([a,b],.5,1);assert.equal(advanceGravity(s,.001,.001).bodies.length,2);
  const reversed:GravityState={...structuredClone(s),bodies:[...s.bodies].reverse()};assert.deepEqual(advanceGravity(s,.1),advanceGravity(reversed,.1));
});
test('gas and stellar inventories follow assemblies without losing baryons or restart consistency',async()=>{
  let s=await createGalaxies('assembly');const d=s.dynamics!;
  // Controlled close pair; rebuild the baseline, leaving gas reservoirs untouched.
  d.bodies[0]!.positionKpc=[-.2,0,0];d.bodies[1]!.positionKpc=[.2,0,0];
  for(let i=2;i<d.bodies.length;i++)d.bodies[i]!.positionKpc=[100*i,0,0];
  s.dynamics=createGravity(d.bodies);
  const mass=s.halos.reduce((a,h)=>a+h.initialMassSolar,0);s=stepGalaxies(s);
  assert.ok(s.dynamics!.mergers.length>0);assert.equal(s.halos.length,s.dynamics!.bodies.length);
  assert.ok(Math.abs(s.halos.reduce((a,h)=>a+h.initialMassSolar,0)-mass)<1e-5);
  assert.ok(Math.abs(galaxySummary(s).residual)<1e-4);assert.deepEqual(stepGalaxies(s),stepGalaxies(JSON.parse(JSON.stringify(s))));
});
