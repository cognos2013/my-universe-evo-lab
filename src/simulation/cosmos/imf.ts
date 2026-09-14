/** Galactic-field IMF, Kroupa (2001), equation 2; not a primordial-star IMF.
 * Masses are in solar masses. Brown dwarfs are excluded by the 0.08 lower bound.
 * Upper truncation at 100 is a model choice, not an observational universal limit.
 * Source: https://arxiv.org/html/astro-ph/0009005v2
 */
export const IMF_MODEL = Object.freeze({id:'kroupa2001-field-0.08-100-v1',minSolar:0.08,maxSolar:100,breakSolar:0.5});
export interface ImfBin {minSolar:number;maxSolar:number;massFraction:number;numberPerSolar:number;meanSolar:number}

// A continuous number density: m^-1.3 below 0.5, 0.5*m^-2.3 above it.
function integral(lo:number,hi:number,moment:0|1):number {
  let sum=0;
  for(const [a,b,alpha,amplitude] of [[0.08,0.5,1.3,1],[0.5,100,2.3,0.5]] as const){
    const lower=Math.max(a,lo),upper=Math.min(b,hi);
    if(upper>lower){const p=moment+1-alpha;sum+=amplitude*Math.pow(lower,p)*Math.expm1(p*Math.log(upper/lower))/p;}
  }
  return sum;
}
const totalMass=integral(IMF_MODEL.minSolar,IMF_MODEL.maxSolar,1);

/** Expected counts (not integer stars), normalized to one solar mass of births.
 * Every requested partition must cover the complete declared mass domain.
 */
export function integrateImf(edges:readonly number[]):ImfBin[]{
  if(edges.length<2||edges.length>257||edges[0]!==IMF_MODEL.minSolar||edges.at(-1)!==IMF_MODEL.maxSolar||edges.some((x,i)=>!Number.isFinite(x)||(i>0&&x<=edges[i-1]!)))throw new Error('IMF 质量边界须严格递增并覆盖 0.08—100 M☉');
  return edges.slice(0,-1).map((lo,i)=>{
    const hi=edges[i+1]!,mass=integral(lo,hi,1),number=integral(lo,hi,0);
    return {minSolar:lo,maxSolar:hi,massFraction:mass/totalMass,numberPerSolar:number/totalMass,meanSolar:mass/number};
  });
}
