import { cellAlbedos } from '../environment/albedo.ts';
import type { WorldState, Traits } from '../core/contracts.ts';
import { RandomStream } from '../core/random.ts';

export interface LifeFlux {
  births: number; deaths: number; migrants: number; mutations: number;
  harvestedJ: number; dissipatedJ: number;
}
interface Group { cell: number; lineage: number; count: number; reserve: number }

/** Exact binomial via geometric waiting; work proportional to the rarer outcome. */
export function binomial(n: number, p: number, rng: RandomStream): number {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('Invalid binomial parameters');
  if (p === 0 || n === 0) return 0; if (p === 1) return n;
  if (p > 0.5) return n-binomial(n,1-p,rng);
  const logFailure = Math.log1p(-p);
  let index = -1, hits = 0;
  while (true) {
    index += 1+Math.floor(Math.log1p(-rng.next())/logFailure);
    if (index >= n) return hits;
    hits++;
    if (hits > 1_000_000) throw new Error('Random sampling budget exceeded');
  }
}

export function temperatureMatch(temperature: number, traits: Traits): number {
  return Math.exp(-0.5*((temperature-traits.thermalOptimumK)/traits.thermalWidthK)**2);
}

/** Owned state only. Newborns migrate next tick; cohort age is intentionally absent. */
export function advanceLife(state: WorldState, seconds: number): LifeFlux {
  const flux: LifeFlux = { births: 0, deaths: 0, migrants: 0, mutations: 0, harvestedJ: 0, dissipatedJ: 0 };
  const rng = new RandomStream(state.rng), rules = state.rules.life, cells = state.cells;
  const albedos = cellAlbedos(state);
  const traitById = new Map(state.traits.map(t => [t.id,t]));
  const byCell: Group[][] = Array.from({ length: cells.areaM2.length }, () => []);
  for (let i=0;i<state.cohorts.ids.length;i++) byCell[state.cohorts.cellIndices[i]!]!.push({ cell: state.cohorts.cellIndices[i]!, lineage: state.cohorts.lineageIndices[i]!, count: state.cohorts.counts[i]!, reserve: state.cohorts.energyReserveJ[i]! });
  // Canonical lineage order removes dependence on storage/input ordering.
  const compare = (a: Group,b: Group): number => state.lineages[a.lineage]!.id < state.lineages[b.lineage]!.id ? -1 : state.lineages[a.lineage]!.id > state.lineages[b.lineage]!.id ? 1 : 0;
  const merged = new Map<string,Group>();
  const add = (g: Group): void => {
    if (!g.count) return;
    const key = `${g.cell}:${g.lineage}`, old = merged.get(key);
    if (old) { old.count+=g.count; old.reserve+=g.reserve; }
    else merged.set(key,{...g});
  };
  const dissipate = (cell: number, energy: number): void => {
    cells.temperatureK[cell]! += energy/(cells.areaM2[cell]!*state.rules.environment.heatCapacityJPerM2K);
    flux.dissipatedJ += energy;
  };
  for (let cell=0;cell<byCell.length;cell++) {
    const groups=byCell[cell]!.sort(compare); if (!groups.length) continue;
    const traits=groups.map(g=>traitById.get(state.lineages[g.lineage]!.traitId)!);
    const matches=traits.map(t=>temperatureMatch(cells.temperatureK[cell]!,t));
    const harvestDemand=groups.map((g,i)=>Math.min(Math.max(0,g.count*rules.birthEnergyJPerIndividual*4-g.reserve),g.count*rules.maxHarvestJPerIndividualSecond*matches[i]!*seconds));
    const totalHarvest=harvestDemand.reduce((a,b)=>a+b,0);
    // Only the first environmental half-step has supplied this energy so far.
    const sunlight=state.rules.environment.irradianceWPerM2*(1-albedos[cell]!)*cells.areaM2[cell]!*seconds/2;
    const harvestScale=totalHarvest ? Math.min(1,sunlight/totalHarvest) : 0;
    const demands: number[]=[];
    for (let i=0;i<groups.length;i++) {
      const g=groups[i]!, t=traits[i]!, match=matches[i]!;
      const harvested=harvestDemand[i]!*harvestScale;
      g.reserve+=harvested; flux.harvestedJ+=harvested;
      cells.temperatureK[cell]!-=harvested/(cells.areaM2[cell]!*state.rules.environment.heatCapacityJPerM2K);
      // Wider tolerance and faster uptake incur a declared maintenance cost.
      const costScale=1+(t.thermalWidthK/12)**2+(t.uptakeMuPerIndividualSecond*86400/0.1)**2;
      const due=g.count*t.maintenanceJPerIndividualSecond*costScale*seconds;
      const paid=Math.min(due,g.reserve); g.reserve-=paid; dissipate(cell,paid);
      const hunger=due>0 ? 1-paid/due : 0;
      const rate=rules.backgroundDeathPerSecond+rules.thermalDeathPerSecond*(1-match)+rules.starvationDeathPerSecond*hunger;
      const dead=binomial(g.count,-Math.expm1(-rate*seconds),rng);
      const deadEnergy=g.reserve*dead/g.count; g.reserve-=deadEnergy; dissipate(cell,deadEnergy);
      g.count-=dead; flux.deaths+=dead; cells.detritusMu[cell]!+=dead*rules.structureMuPerIndividual;
      const nutrient=cells.nutrientMu[cell]!;
      const physicalDemand=g.count*t.uptakeMuPerIndividualSecond*match*nutrient/(rules.halfSaturationMu+nutrient)*seconds;
      const energyLimit=Math.floor(g.reserve/rules.birthEnergyJPerIndividual)*rules.structureMuPerIndividual;
      demands.push(Math.min(physicalDemand,energyLimit));
    }
    const totalDemand=demands.reduce((a,b)=>a+b,0), available=cells.nutrientMu[cell]!;
    const scale=totalDemand ? Math.min(1,available/totalDemand) : 0;
    const exact=demands.map(d=>d*scale/rules.structureMuPerIndividual);
    const births=exact.map(Math.floor);
    // Stochastic fractional births, randomized contender order to avoid ID priority.
    let remaining=Math.floor(available/rules.structureMuPerIndividual)-births.reduce((a,b)=>a+b,0);
    const order=groups.map((_,i)=>i);
    for (let i=order.length-1;i>0;i--) { const j=Math.floor(rng.next()*(i+1)); [order[i],order[j]]=[order[j]!,order[i]!]; }
    for (const i of order) if (remaining>0 && rng.next()<exact[i]!-births[i]!) { births[i]!++; remaining--; }
    for (let i=0;i<groups.length;i++) {
      const g=groups[i]!, t=traits[i]!;
      const born=Math.min(births[i]!,Math.floor(g.reserve/rules.birthEnergyJPerIndividual));
      const cost=born*rules.birthEnergyJPerIndividual;
      g.reserve-=cost; dissipate(cell,cost); cells.nutrientMu[cell]!-=born*rules.structureMuPerIndividual;
      // Round-off only; all allocations were capped before spending.
      if (cells.nutrientMu[cell]! < -1e-8) throw new Error('Resource allocation overspent');
      if (cells.nutrientMu[cell]! < 0) cells.nutrientMu[cell]=0;
      flux.births+=born;
      const mutants=binomial(born,rules.mutationProbability,rng);
      flux.mutations+=mutants;
      if (mutants) {
        if (state.lineages.length>=100000) throw new Error('Lineage budget exceeded');
        const id=`m-${state.tick+1}-${cell}-${g.lineage}`;
        const mutate=(x:number,min:number,max:number):number=>Math.min(max,Math.max(min,x*(1+(rng.next()*2-1)*rules.mutationRelativeScale)));
        const child: Traits={ id, thermalOptimumK:mutate(t.thermalOptimumK,150,400),thermalWidthK:mutate(t.thermalWidthK,0.1,100),uptakeMuPerIndividualSecond:mutate(t.uptakeMuPerIndividualSecond,0,1),maintenanceJPerIndividualSecond:mutate(t.maintenanceJPerIndividualSecond,0,1e6),dispersalPerSecond:mutate(t.dispersalPerSecond,0,1) };
        const lineage=state.lineages.length;
        state.traits.push(child); state.lineages.push({id,parentId:state.lineages[g.lineage]!.id,originTick:state.tick+1,traitId:id,origin:'mutation'});
        add({cell,lineage,count:mutants,reserve:0});
      }
      const migrants=binomial(g.count,-Math.expm1(-t.dispersalPerSecond*seconds),rng);
      const start=cells.neighborOffsets[cell]!, end=cells.neighborOffsets[cell+1]!;
      const moving=end>start ? migrants : 0;
      const movingEnergy=g.count ? g.reserve*moving/g.count : 0;
      flux.migrants+=moving;
      // Equal-probability multinomial split using sequential conditional binomials.
      let left=moving;
      for (let edge=start;edge<end;edge++) {
        const count=edge===end-1 ? left : binomial(left,1/(end-edge),rng);
        const reserve=moving ? movingEnergy*count/moving : 0;
        left-=count;
        const travelCost=reserve*0.01; dissipate(cell,travelCost);
        add({cell:cells.neighborIndices[edge]!,lineage:g.lineage,count,reserve:reserve-travelCost});
      }
      add({cell,lineage:g.lineage,count:g.count-moving+born-mutants,reserve:g.reserve-movingEnergy});
    }
  }
  if (merged.size>state.rules.limits.maxCohorts) throw new Error(`种群队列达到计算上限（需要 ${merged.size.toLocaleString('zh-CN')}，上限 ${state.rules.limits.maxCohorts.toLocaleString('zh-CN')}）。本步未推进，完整世界已保留。请点击“扩充计算容量”创建可继续运行的分支。`);
  const out=Array.from(merged.values()).sort((a,b)=>a.cell-b.cell || compare(a,b));
  state.cohorts={ids:out.map(g=>`c-${g.cell}-${g.lineage}`),cellIndices:Uint32Array.from(out.map(g=>g.cell)),lineageIndices:Uint32Array.from(out.map(g=>g.lineage)),counts:Float64Array.from(out.map(g=>g.count)),energyReserveJ:Float64Array.from(out.map(g=>g.reserve))};
  state.rng=rng.snapshot();
  return flux;
}
