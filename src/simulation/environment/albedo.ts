import type { WorldState } from '../core/contracts.ts';

export function cellAlbedos(state: WorldState): Float64Array {
  const biomass=new Float64Array(state.cells.areaM2.length);
  for(let i=0;i<state.cohorts.ids.length;i++)biomass[state.cohorts.cellIndices[i]!]!+=state.cohorts.counts[i]!*state.rules.life.structureMuPerIndividual;
  return Float64Array.from(biomass,(mass,i)=>{
    const all=mass+state.cells.nutrientMu[i]!+state.cells.detritusMu[i]!;
    return state.rules.environment.albedo+(all?mass/all:0)*state.rules.environment.lifeAlbedoDelta;
  });
}
