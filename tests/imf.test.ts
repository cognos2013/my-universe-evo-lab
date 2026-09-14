import {test} from 'node:test';
import assert from 'node:assert/strict';
import {integrateImf} from '../src/simulation/cosmos/imf.ts';

test('IMF normalization is additive under refinement and preserves mass and expected counts',()=>{
  const coarse=integrateImf([0.08,0.5,8,100]),fine=integrateImf([0.08,0.2,0.5,1,3,8,20,100]);
  assert.ok(Math.abs(coarse.reduce((s,b)=>s+b.massFraction,0)-1)<1e-14);
  for(const c of coarse){const bins=fine.filter(b=>b.minSolar>=c.minSolar&&b.maxSolar<=c.maxSolar);
    assert.ok(Math.abs(bins.reduce((s,b)=>s+b.massFraction,0)-c.massFraction)<1e-14);
    assert.ok(Math.abs(bins.reduce((s,b)=>s+b.numberPerSolar,0)-c.numberPerSolar)<1e-14);
    assert.ok(c.meanSolar>c.minSolar&&c.meanSolar<c.maxSolar);
    assert.ok(Math.abs(c.meanSolar*c.numberPerSolar-c.massFraction)<1e-14);
  }
});
test('IMF moments agree with independent logarithmic midpoint quadrature across slope break',()=>{
  const n=100000,dx=Math.log(100/0.08)/n;let mass=0,count=0,highMass=0;
  for(let i=0;i<n;i++){const m=0.08*Math.exp((i+0.5)*dx),density=m<0.5?m**-1.3:0.5*m**-2.3;
    count+=density*m*dx;mass+=density*m*m*dx;if(m>=8)highMass+=density*m*m*dx;
  }
  const all=integrateImf([0.08,8,100]);
  assert.ok(Math.abs(all.reduce((s,b)=>s+b.numberPerSolar,0)-count/mass)<1e-8);
  assert.ok(Math.abs(all[1]!.massFraction-highMass/mass)<1e-5);
});
test('IMF rejects incomplete, unsorted, duplicate and nonfinite domains',()=>{
  for(const edges of [[],[0.08],[0.1,100],[0.08,101],[0.08,1,0.5,100],[0.08,0.5,0.5,100],[0.08,NaN,100],[0.08,Infinity,100]])assert.throws(()=>integrateImf(edges));
});
