import {test} from 'node:test';import assert from 'node:assert/strict';
import {createGalaxies,stepGalaxies,galaxySummary,validateGalaxies,enableGalaxyGravity} from '../src/simulation/cosmos/galaxies.ts';
import {ExperimentBook} from '../src/experiments/book.ts';
import {initializeWorld} from '../src/simulation/core/initialize.ts';
import {getScenario} from '../src/scenarios/catalog.ts';
import {sha256} from '../src/simulation/core/canonical.ts';

test('empty gas reservoirs cannot produce stars or remnants',async()=>{
  let s=await createGalaxies('empty',0);for(let i=0;i<30;i++)s=stepGalaxies(s);
  const m=galaxySummary(s);assert.equal(m.stars,0);assert.equal(m.remnants,0);assert.equal(m.galaxies,0);assert.equal(m.residual,0);
});
test('cold gas forms stars and stellar deaths recycle mass without changing the input',async()=>{
  const initial=await createGalaxies('formation'),before=structuredClone(initial);
  let s=stepGalaxies(initial);assert.deepEqual(initial,before);assert.equal(galaxySummary(s).galaxies,8);
  assert.ok(s.lastBornSolar>0);assert.equal(s.lastReturnedSolar,0);
  for(let i=0;i<4;i++)s=stepGalaxies(s);
  assert.ok(s.lastReturnedSolar>0);assert.ok(galaxySummary(s).remnants>0);
  assert.ok(s.halos.every(h=>!h.populations.some(p=>p.bin===3&&p.bornStep===1)));
  for(let i=0;i<100;i++)s=stepGalaxies(s);
  assert.ok(Math.abs(galaxySummary(s).residual)<1e-3);
  const starMass=galaxySummary(s).stars;assert.ok(starMass>0&&starMass<initial.halos.reduce((a,h)=>a+h.initialMassSolar,0));
});
test('stellar state persists with the experiment and resumes deterministically',async()=>{
  const book=await ExperimentBook.create(await initializeWorld(getScenario('empty-planet')));
  book.astronomy=await createGalaxies('same');assert.deepEqual(book.astronomy,await createGalaxies('same'));
  for(let i=0;i<12;i++)book.astronomy=stepGalaxies(book.astronomy);
  const restored=await ExperimentBook.import(await book.export());
  assert.deepEqual(stepGalaxies(restored.astronomy!),stepGalaxies(book.astronomy));
  assert.equal(restored.active.state.tick,0);
  const raw=JSON.parse(await book.export());raw.astronomy.halos[0].coldGasSolar=-1;
  const {checksum,...content}=raw;raw.checksum=await sha256(content);
  await assert.rejects(ExperimentBook.import(JSON.stringify(raw)));
});
test('older v1 experiments remain readable; malformed or exhausted stellar state fails atomically',async()=>{
  const b=await ExperimentBook.create(await initializeWorld(getScenario('empty-planet'))),raw=JSON.parse(await b.export());
  delete raw.astronomy;raw.version=1;
  // v2 export hashes only the 5 base fields (format / version / activeId /
  // branches / checksum), so re-signing a v1 file must use the same
  // shape, not the full envelope.
  const {checksum:_,...content}=raw;
  raw.checksum=await sha256({format:content.format,version:content.version,activeId:content.activeId,branches:content.branches});
  assert.equal((await ExperimentBook.import(JSON.stringify(raw))).astronomy,null);
  const s=await createGalaxies('limit',0);s.step=2000;s.dynamics!.timeMyr=10000;s.elapsedMyr=10000;const before=structuredClone(s);assert.throws(()=>stepGalaxies(s),/预算/);assert.deepEqual(s,before);
  s.step=-1;assert.throws(()=>validateGalaxies(s));
});

test('legacy stationary halos enable gravity explicitly without changing baryon state or time',async()=>{
  const modern=await createGalaxies('legacy'),{dynamics,...fields}=modern;
  const legacy={...fields,version:1 as const};legacy.step=4;legacy.elapsedMyr=20;
  const old=structuredClone(legacy),upgraded=enableGalaxyGravity(legacy);
  assert.deepEqual(legacy,old);assert.deepEqual(upgraded.halos,legacy.halos);assert.equal(upgraded.dynamics!.timeMyr,20);
  const b=await ExperimentBook.create(await initializeWorld(getScenario('empty-planet')));b.astronomy=legacy;
  const restored=await ExperimentBook.import(await b.export());assert.equal(restored.astronomy!.version,1);
  restored.astronomy=enableGalaxyGravity(restored.astronomy!);assert.equal(stepGalaxies(restored.astronomy).dynamics!.timeMyr,25);
});
