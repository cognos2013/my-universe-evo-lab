import { applyIntervention } from '../simulation/interventions/apply.ts';
import { validateIntervention } from '../simulation/core/schema.ts';
import type {WorldState,Intervention} from '../simulation/core/contracts.ts';
import {serializeState,deserializeState} from './codec.ts';
import {stepWorld} from '../simulation/core/step.ts';
import {summarize} from '../simulation/metrics/summary.ts';
import {canonicalJson,sha256} from '../simulation/core/canonical.ts';
import * as v from '../simulation/core/validation.ts';

export const HISTORY_LIMITS = { checkpoints: 32, checkpointBytes: 16_000_000, samples: 2048 } as const;
// Remove the most densely spaced interior point. Endpoints remain recoverable.
function redundantIndex(ticks: number[], protectedTicks = new Set<number>()): number {
  let index=-1, gap=Infinity;
  for(let i=1;i<ticks.length-1;i++) if(!protectedTicks.has(ticks[i]!) && ticks[i+1]!-ticks[i-1]!<gap){index=i;gap=ticks[i+1]!-ticks[i-1]!;}
  return index;
}
export interface TimelineData {headTick:number;checkpoints:{tick:number;state:string}[];samples:ReturnType<typeof summarize>[];commands:Intervention[]}
export class Timeline {
  state:WorldState;
  headTick:number;
  #checkpoints=new Map<number,string>();
  #checkpointBytes=0;
  samples:ReturnType<typeof summarize>[]=[];
  commands:Intervention[]=[];
  private constructor(state:WorldState){this.state=state;this.headTick=state.tick;}
  static async create(state:WorldState):Promise<Timeline>{const h=new Timeline(structuredClone(state));await h.checkpoint();h.samples=[summarize(state)];return h;}
  storageStats(){
    return {checkpoints:this.#checkpoints.size, checkpointBytes:this.#checkpointBytes, samples:this.samples.length, sampled:this.samples.length<this.headTick-this.state.branch.forkTick+1};
  }
  #compactCheckpoints(){
    const entries=[...this.#checkpoints.entries()].sort(([a],[b])=>a-b);
    const sizes=new Map(entries.map(([tick,s])=>[tick,new TextEncoder().encode(s).byteLength]));
    let bytes=[...sizes.values()].reduce((a,b)=>a+b,0);
    while(entries.length>HISTORY_LIMITS.checkpoints||bytes>HISTORY_LIMITS.checkpointBytes){
      const index=redundantIndex(entries.map(([t])=>t),new Set([this.headTick,this.state.tick]));
      if(index<0)break; // Origin, head and viewed checkpoint are never discarded.
      const [removed]=entries.splice(index,1);bytes-=sizes.get(removed![0])!;this.#checkpoints.delete(removed![0]);
    }
    this.#checkpointBytes=bytes;
  }
  #compactSamples(){
    this.samples.sort((a,b)=>a.tick-b.tick);
    while(this.samples.length>HISTORY_LIMITS.samples){
      const index=redundantIndex(this.samples.map(s=>s.tick));if(index<0)break;this.samples.splice(index,1);
    }
  }
  async checkpoint(){this.#checkpoints.set(this.state.tick,await serializeState(this.state));this.#compactCheckpoints();}
  async advance(){
    const result=await stepWorld(this.state);
    let next=result.state;
    for(const c of this.commands.filter(c=>c.atTick===next.tick))next=await applyIntervention(next,c);
    result.state=next;
    this.state=next;this.headTick=Math.max(this.headTick,this.state.tick);
    if(!this.samples.some(s=>s.tick===this.state.tick))this.samples.push(summarize(this.state));
    this.#compactSamples();
    if(this.state.tick%100===0)await this.checkpoint();
    return result;
  }
  async seek(tick:number,options?:{cancelled?:()=>boolean;progress?:(tick:number,target:number)=>void}){
    v.integer(tick,'targetTick',0,this.headTick);
    const nearest=[...this.#checkpoints.keys()].filter(t=>t<=tick).sort((a,b)=>b-a)[0];
    if(nearest===undefined)throw new Error('目标时刻早于本分支起点');
    let state=await deserializeState(this.#checkpoints.get(nearest)!);
    for(let t=nearest;t<tick;t++){
      if(options?.cancelled?.())throw new Error('已取消历史恢复，原状态保留');
      state=(await stepWorld(state)).state;for(const c of this.commands.filter(c=>c.atTick===state.tick))state=await applyIntervention(state,c);
      if((t-nearest)%5===0){options?.progress?.(state.tick,tick);await new Promise(r=>setTimeout(r,0));}
    }
    if(options?.cancelled?.())throw new Error('已取消历史恢复，原状态保留');
    this.state=state;
  }
  async data():Promise<TimelineData>{await this.checkpoint();return{headTick:this.headTick,checkpoints:[...this.#checkpoints.entries()].sort(([a],[b])=>a-b).map(([tick,state])=>({tick,state})),samples:structuredClone(this.samples),commands:structuredClone(this.commands)};}
  static async restore(input:unknown,currentTick:number):Promise<Timeline>{
    const obj=v.object(input,['headTick','checkpoints','samples','commands'],'timeline');
    const head=v.integer(obj.headTick,'timeline.headTick');v.integer(currentTick,'timeline.currentTick',0,head);
    const raw=v.array(obj.checkpoints,'timeline.checkpoints',1000);
    if(!raw.length)throw new Error('存档没有检查点');
    const checkpoints=new Map<number,string>();let identity='';
    for(const item of raw){const c=v.object(item,['tick','state'],'checkpoint');const tick=v.integer(c.tick,'checkpoint.tick',0,head);const packed=v.text(c.state,'checkpoint.state',50_000_000);const state=await deserializeState(packed);
      if(tick!==state.tick||checkpoints.has(tick))throw new Error('检查点时间不一致或重复');
      const key=`${state.manifest.id}/${state.branch.id}/${state.manifest.rulesetHash}`;
      if(identity&&identity!==key)throw new Error('检查点来自不同世界或规则');identity=key;checkpoints.set(tick,packed);
    }
    if(!checkpoints.has(head))throw new Error('缺少历史末端检查点');
    const h=new Timeline(await deserializeState(checkpoints.get(head)!));h.#checkpoints=checkpoints;h.headTick=head;
    // Samples are a presentation cache; reconstruct and validate each known metric.
    h.samples=v.array(obj.samples,'timeline.samples',100001).map((item,i)=>{
      const keys=['tick','population','biomassMu','nutrientMu','detritusMu','temperatureK','activeLineages','diversity','cohorts','matterResidualMu'];
      const s=v.object(item,keys,`sample[${i}]`);for(const k of keys)v.number(s[k],`sample[${i}].${k}`,k==='matterResidualMu'?-Number.MAX_VALUE:0);
      v.integer(s.tick,`sample[${i}].tick`,0,head);return s as ReturnType<typeof summarize>;
    });
    v.unique(h.samples.map(s=>s.tick),'timeline.sampleTicks');
    h.commands=v.array(obj.commands,'timeline.commands',10000).map(c=>{validateIntervention(c);if(c.branchId!==h.state.branch.id||c.atTick>head)throw new Error('命令分支或时间错误');return c;});v.unique(h.commands.map(c=>c.id),'timeline.commandIds');
    await h.seek(currentTick);h.#compactCheckpoints();h.#compactSamples();return h;
  }
  async intervene(command:Intervention){
    if(this.state.tick!==this.headTick)throw new Error('先创建新分支，再干预过去');
    const next=await applyIntervention(this.state,command);
    if(!this.commands.some(c=>c.id===command.id))this.commands.push(structuredClone(command));
    this.state=next;this.samples=this.samples.filter(s=>s.tick!==next.tick);this.samples.push(summarize(next));await this.checkpoint();
  }
  async export():Promise<string>{
    // A rewind must retain the true head checkpoint before saving.
    if(!this.#checkpoints.has(this.headTick)){
      const current=this.state;try{await this.seek(this.headTick);await this.checkpoint();}finally{this.state=current;}
    }
    const data=await this.data();
    if(data.checkpoints.length>1000||data.samples.length>100001)throw new Error('历史存档超出检查点或样本预算；世界仍保留在内存中');
    const content={format:'universe-timeline',version:2,currentTick:this.state.tick,timeline:data};
    const encoded=canonicalJson({...content,checksum:await sha256(content)});
    if(new TextEncoder().encode(encoded).byteLength>100_000_000)throw new Error('历史文件超过 100 MB 导入上限，未生成不可恢复的文件');
    return encoded;
  }
  static async import(raw:string):Promise<Timeline>{
    v.text(raw,'file',100_000_000);
    const o=v.object(JSON.parse(raw),['format','version','currentTick','timeline','checksum'],'file');
    v.choice(o.format,['universe-timeline'],'file.format');v.choice(o.version,[2],'file.version');v.hash(o.checksum,'file.checksum');
    const current=v.integer(o.currentTick,'file.currentTick');
    // Restore validates nested shapes before hashing them.
    const h=await Timeline.restore(o.timeline,current);
    if(await sha256({format:o.format,version:o.version,currentTick:o.currentTick,timeline:o.timeline})!==o.checksum)throw new Error('存档校验和不一致');
    return h;
  }
}
