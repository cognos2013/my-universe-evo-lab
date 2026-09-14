// Flat pressureless matter + cosmological constant FLRW approximation.
// Planck 2018 VI: H0=67.4 km/s/Mpc, Omega_m=0.315. Radiation omitted.
export const COSMOS = Object.freeze({h0:67.4, matter:0.315, lambda:0.685, minAgeGyr:0.1, maxAgeGyr:30});
const secondsPerGyr=365.25*86400*1e9, kmPerMpc=3.0856775814913673e19;
const h0Gyr=COSMOS.h0/kmPerMpc*secondsPerGyr;
export const presentAgeGyr=2*Math.asinh(Math.sqrt(COSMOS.lambda/COSMOS.matter))/(3*h0Gyr*Math.sqrt(COSMOS.lambda));
export function cosmicBackground(ageGyr:number){
  if(!Number.isFinite(ageGyr)||ageGyr<COSMOS.minAgeGyr||ageGyr>COSMOS.maxAgeGyr)throw new Error('宇宙背景模型支持 0.1—30 十亿年');
  const a=Math.cbrt(COSMOS.matter/COSMOS.lambda)*Math.sinh(1.5*h0Gyr*Math.sqrt(COSMOS.lambda)*ageGyr)**(2/3);
  const relativeMatterDensity=1/a**3, matterTerm=COSMOS.matter*relativeMatterDensity;
  return {ageGyr,scaleFactor:a,hubbleKmPerSecondMpc:COSMOS.h0*Math.sqrt(matterTerm+COSMOS.lambda),relativeMatterDensity,matterFraction:matterTerm/(matterTerm+COSMOS.lambda),lambdaFraction:COSMOS.lambda/(matterTerm+COSMOS.lambda)};
}
