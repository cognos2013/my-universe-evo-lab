import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COSMOS,cosmicBackground,presentAgeGyr} from '../src/simulation/cosmos/background.ts';
test('cosmology present epoch matches its independently specified parameters',()=>{
  const s=cosmicBackground(presentAgeGyr);
  assert.ok(Math.abs(s.scaleFactor-1)<1e-12);assert.ok(Math.abs(s.hubbleKmPerSecondMpc-67.4)<1e-10);
  assert.ok(Math.abs(s.matterFraction-.315)<1e-12);assert.ok(presentAgeGyr>13.7&&presentAgeGyr<13.9);
});
test('background expansion satisfies Friedmann derivative and matter dilution',()=>{
  for(const t of [.2,1,5,13,29]){
    const s=cosmicBackground(t),epsilon=1e-5;
    const numericalH=(cosmicBackground(t+epsilon).scaleFactor-cosmicBackground(t-epsilon).scaleFactor)/(2*epsilon*s.scaleFactor);
    const h=s.hubbleKmPerSecondMpc/3.0856775814913673e19*(365.25*86400*1e9);
    assert.ok(Math.abs(numericalH/h-1)<1e-7);
    assert.ok(Math.abs(s.relativeMatterDensity*s.scaleFactor**3-1)<1e-12);
    assert.ok(Math.abs(s.matterFraction+s.lambdaFraction-1)<1e-12);
  }
  assert.ok(cosmicBackground(30).lambdaFraction>cosmicBackground(1).lambdaFraction);
  for(const t of [0,NaN,Infinity,COSMOS.maxAgeGyr+1])assert.throws(()=>cosmicBackground(t));
});
