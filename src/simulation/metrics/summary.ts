import type { WorldState } from '../core/contracts.ts';
import { matterTotal } from '../core/state.ts';
export function summarize(state: WorldState) {
  const populations=new Map<number,number>();
  for(let i=0;i<state.cohorts.ids.length;i++) populations.set(state.cohorts.lineageIndices[i]!, (populations.get(state.cohorts.lineageIndices[i]!)??0)+state.cohorts.counts[i]!);
  const population=state.cohorts.counts.reduce((a,b)=>a+b,0);
  let diversity=0;
  if(population) for(const count of populations.values()) {const p=count/population;diversity-=p*Math.log(p);}
  const area=state.cells.areaM2.reduce((a,b)=>a+b,0);
  const temperatureK=state.cells.temperatureK.reduce((a,t,i)=>a+t*state.cells.areaM2[i]!,0)/area;
  return {tick:state.tick,population,biomassMu:population*state.rules.life.structureMuPerIndividual,nutrientMu:state.cells.nutrientMu.reduce((a,b)=>a+b,0),detritusMu:state.cells.detritusMu.reduce((a,b)=>a+b,0),temperatureK,activeLineages:populations.size,diversity,cohorts:state.cohorts.ids.length,matterResidualMu:matterTotal(state)-(state.ledger.initialMatterMu+state.ledger.externalMatterInMu-state.ledger.externalMatterOutMu)};
}
