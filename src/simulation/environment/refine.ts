import type {WorldState} from '../core/contracts.ts';
import {createGrid} from './grid.ts';
import {validateState} from '../core/state.ts';
import {sha256} from '../core/canonical.ts';

/** Conservative authored subdivision; never inferred from camera zoom. */
export async function refineWorld(input:WorldState):Promise<WorldState>{
  validateState(input);const n=input.cells.areaM2.length,target=n*4;
  if(target>20480)throw new Error('已经达到 20,480 区域精度上限');
  const radius=Math.sqrt(input.cells.areaM2.reduce((a,b)=>a+b,0)/(4*Math.PI));
  const grid=createGrid(target,radius),s=structuredClone(input),old=input.cells;
  const area=new Float64Array(target),land=new Float64Array(target),temp=new Float64Array(target),nutrient=new Float64Array(target),detritus=new Float64Array(target);
  for(let i=0;i<n;i++){
    const sum=grid.areaM2.slice(i*4,i*4+4).reduce((a,b)=>a+b,0);
    let leftArea=old.areaM2[i]!,leftN=old.nutrientMu[i]!,leftD=old.detritusMu[i]!;
    for(let j=0;j<4;j++){
      const k=i*4+j,w=grid.areaM2[k]!/sum;
      area[k]=j===3?leftArea:old.areaM2[i]!*w;leftArea-=area[k]!;
      nutrient[k]=j===3?leftN:old.nutrientMu[i]!*w;leftN-=nutrient[k]!;
      detritus[k]=j===3?leftD:old.detritusMu[i]!*w;leftD-=detritus[k]!;
      land[k]=old.landFraction[i]!;temp[k]=old.temperatureK[i]!;
    }
  }
  const ids:string[]=[],cells:number[]=[],lineages:number[]=[],counts:number[]=[],energy:number[]=[];
  for(let i=0;i<input.cohorts.ids.length;i++){
    const count=input.cohorts.counts[i]!,reserve=input.cohorts.energyReserveJ[i]!;let remainder=reserve;
    const allocations=Array.from({length:4},(_,j)=>Math.floor(count/4)+(j<count%4?1:0));
    const last=allocations.findLastIndex(c=>c>0);
    for(let j=0;j<4;j++)if(allocations[j]!>0){const k=input.cohorts.cellIndices[i]!*4+j,c=allocations[j]!;
      ids.push(`${input.cohorts.ids[i]}-r${target}-${j}`);cells.push(k);lineages.push(input.cohorts.lineageIndices[i]!);counts.push(c);
      const e=j===last?remainder:reserve*c/count;energy.push(e);remainder-=e;
    }
  }
  if(ids.length>100000)throw new Error('细分后超过 100,000 队列支持上限，原世界保留');
  s.cells={areaM2:area,landFraction:land,temperatureK:temp,nutrientMu:nutrient,detritusMu:detritus,neighborOffsets:grid.neighborOffsets,neighborIndices:grid.neighborIndices};
  s.cohorts={ids,cellIndices:Uint32Array.from(cells),lineageIndices:Uint32Array.from(lineages),counts:Float64Array.from(counts),energyReserveJ:Float64Array.from(energy)};
  for(const f of s.execution.forcings)f.cells=f.cells.flatMap(c=>[c*4,c*4+1,c*4+2,c*4+3]);
  s.rules.limits.maxCells=Math.max(s.rules.limits.maxCells,target);
  s.rules.limits.maxCohorts=Math.min(100000,Math.max(s.rules.limits.maxCohorts,ids.length*2));
  s.manifest.rulesetHash=await sha256(s.rules);validateState(s);return s;
}
