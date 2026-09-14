import type {WorldState,Intervention} from '../core/contracts.ts';
import {validateIntervention} from '../core/schema.ts';
import {validateState} from '../core/state.ts';
import {sha256} from '../core/canonical.ts';
import {RandomStream} from '../core/random.ts';
import {binomial} from '../life/advance.ts';

function compact(state:WorldState){
  const c=state.cohorts,keep=c.ids.map((_,i)=>i).filter(i=>c.counts[i]!>0);
  state.cohorts={ids:keep.map(i=>c.ids[i]!),cellIndices:Uint32Array.from(keep.map(i=>c.cellIndices[i]!)),lineageIndices:Uint32Array.from(keep.map(i=>c.lineageIndices[i]!)),counts:Float64Array.from(keep.map(i=>c.counts[i]!)),energyReserveJ:Float64Array.from(keep.map(i=>c.energyReserveJ[i]!))};
}
function append(state:WorldState,cell:number,lineage:number,count:number,reserve:number){
  if(!count)return;const c=state.cohorts;
  c.ids.push(`c-${cell}-${lineage}`);c.cellIndices=Uint32Array.from([...c.cellIndices,cell]);c.lineageIndices=Uint32Array.from([...c.lineageIndices,lineage]);c.counts=Float64Array.from([...c.counts,count]);c.energyReserveJ=Float64Array.from([...c.energyReserveJ,reserve]);
}

export async function applyIntervention(input:WorldState,command:Intervention):Promise<WorldState>{
  validateState(input);validateIntervention(command);
  const digest=await sha256(command),old=input.execution.receipts.find(r=>r.id===command.id);
  if(old){if(old.digest!==digest)throw new Error('同一命令 ID 的内容发生变化');return structuredClone(input);}
  validateIntervention(command,{cellCount:input.cells.areaM2.length,branchId:input.branch.id,tick:input.tick,traitIds:input.traits.map(t=>t.id),cohorts:Object.fromEntries(input.cohorts.ids.map((id,i)=>[id,input.cohorts.counts[i]!]))});
  if(command.atTick!==input.tick)throw new Error('命令必须应用于当前完整时刻');
  const s=structuredClone(input),c=s.cells,rng=new RandomStream(s.rng);
  const dissipate=(cell:number,j:number)=>{c.temperatureK[cell]!+=j/(c.areaM2[cell]!*s.rules.environment.heatCapacityJPerM2K);};
  if(command.type==='addNutrient'){
    const cells=[...command.payload.cells].sort((a,b)=>a-b);let remainder=command.payload.totalMu;
    cells.forEach((cell,i)=>{const amount=i===cells.length-1?remainder:command.payload.totalMu/cells.length;c.nutrientMu[cell]!+=amount;remainder-=amount;});s.ledger.externalMatterInMu+=command.payload.totalMu;
  }else if(command.type==='disturbArea'){
    const set=new Set(command.payload.cells);
    for(let i=0;i<s.cohorts.ids.length;i++)if(set.has(s.cohorts.cellIndices[i]!)){
      const cell=s.cohorts.cellIndices[i]!,count=s.cohorts.counts[i]!,dead=binomial(count,command.payload.mortalityFraction,rng),energy=s.cohorts.energyReserveJ[i]!*dead/count;
      s.cohorts.counts[i]!-=dead;s.cohorts.energyReserveJ[i]!-=energy;c.detritusMu[cell]!+=dead*s.rules.life.structureMuPerIndividual;dissipate(cell,energy);
    }compact(s);
  }else if(command.type==='changeForcing'){
    s.execution.forcings.push({id:command.id,cells:[...command.payload.cells].sort((a,b)=>a-b),startTick:s.tick,endTick:s.tick+command.payload.durationTicks,forcingWPerM2:command.payload.forcingWPerM2});
  }else if(command.type==='seedLife'){
    const p=command.payload,cells=[...p.cells].sort((a,b)=>a-b),lineage=s.lineages.length;
    s.lineages.push({id:`seed-${digest.slice(0,16)}`,parentId:null,originTick:s.tick,traitId:p.traitId,origin:'intervention'});
    cells.forEach((cell,i)=>{const count=Math.floor(p.totalCount/cells.length)+(i<p.totalCount%cells.length?1:0),mass=count*s.rules.life.structureMuPerIndividual,energy=count*p.reserveJPerIndividual;
      if(p.materialSource==='local'){if(c.nutrientMu[cell]!<mass)throw new Error(`区域 ${cell} 营养不足`);c.nutrientMu[cell]!-=mass;}else s.ledger.externalMatterInMu+=mass;
      // Artificially injected reserve is explicitly an external energy input.
      s.ledger.externalEnergyInJ+=energy;append(s,cell,lineage,count,energy);
    });
  }else{
    const p=command.payload,i=s.cohorts.ids.indexOf(p.cohortId),cell=s.cohorts.cellIndices[i]!,parent=s.cohorts.lineageIndices[i]!,lineage=s.lineages.length;
    if(s.traits.some(t=>t.id===p.traits.id))throw new Error('新性状 ID 已存在');
    const energy=s.cohorts.energyReserveJ[i]!*p.count/s.cohorts.counts[i]!;
    s.cohorts.counts[i]!-=p.count;s.cohorts.energyReserveJ[i]!-=energy;
    s.traits.push(structuredClone(p.traits));s.lineages.push({id:`edit-${digest.slice(0,16)}`,parentId:s.lineages[parent]!.id,originTick:s.tick,traitId:p.traits.id,origin:'intervention'});
    compact(s);append(s,cell,lineage,p.count,energy);
  }
  s.rng=rng.snapshot();s.execution.receipts.push({id:command.id,digest});validateState(s);return s;
}
