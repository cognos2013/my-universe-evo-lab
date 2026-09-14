import {validateGalaxies} from '../simulation/cosmos/galaxies.ts';
import type {GalaxyState} from '../simulation/cosmos/galaxies.ts';
import {refineWorld} from '../simulation/environment/refine.ts';
import {Timeline} from '../persistence/timeline.ts';
import type {WorldState,Intervention} from '../simulation/core/contracts.ts';
import {serializeState} from '../persistence/codec.ts';
import {sha256,canonicalJson} from '../simulation/core/canonical.ts';
import {summarize} from '../simulation/metrics/summary.ts';
import * as v from '../simulation/core/validation.ts';
import type { ReactionNetwork } from '../simulation/chemistry/network.ts';
import type { ReactorState } from '../simulation/chemistry/reactor.ts';
import type { ColonialRegistry } from '../simulation/colonial/agent.ts';
import type { CognitiveRegistry } from '../simulation/cognition/agent.ts';
import type { SettlementRegistry } from '../simulation/settlement/types.ts';
import type { EarthDataSeries } from '../simulation/earth/types.ts';
import type { BatchReport } from '../simulation/batch/types.ts';
import type { V14Backend, V14Snapshot, V14SnapshotSummary, V14WorldResult, V14WorldSpec } from '../simulation/visual/types.ts';
import { summariseV14Snapshot } from '../simulation/visual/types.ts';

export class ExperimentBook {
  branches=new Map<string,{label:string;timeline:Timeline}>();
  activeId='main';
  astronomy:GalaxyState|null=null;
  /**
   * P12 pre-life chemistry subsystem. Lives on the book (not on the
   * WorldState) so the planetary energy / matter ledger remains
   * closed: the reactor's concentrations are an independent pool
   * that the chemistry handlers read / write.
   */
  chemistry:{network:ReactionNetwork;state:ReactorState}|null=null;
  /**
   * P13 colonial-organism registry. Independent of WorldState so a
   * dissolved colony leaves the underlying cohorts untouched — the
   * "two units of selection" rule from docs/15.
   */
  colonies:ColonialRegistry|null=null;
  /**
   * P14 cognitive-agent registry. Each agent is a learning policy
   * anchored to a (cell, lineage) pair; the registry tracks the
   * Q-tables, ε values, and per-agent state. Lives outside
   * WorldState for the same reason colonies / chemistry do: the
   * planetary ledger stays closed and the cognitive layer is
   * inspectable in isolation.
   */
  cognition:CognitiveRegistry|null=null;
  /**
   * P15 settlement registry. Independent of `ColonialRegistry`
   * (P13) — settlements are a *new* selection layer with their own
   * lifecycle (production / consumption / knowledge / dissolution).
   * Seeded from a template by `settlementLoad`, per the docs/15
   * P15 rule that the civilisation layer must be marked as an
   * independent initialisation, not a P12-derived outcome.
   */
  settlement:SettlementRegistry|null=null;
  /**
   * P16 Earth-data reference series. Optional; loaded by
   * `earthDataLoad`. Carries the citation string in the file so
   * the UI can show "this is calibrated against X". Lives on
   * the book (not on `WorldState`) so it's orthogonal to the
   * planetary state machine.
   */
  earthData:EarthDataSeries|null=null;
  /**
   * P17 batch reports. Multiple reports can be stored (one per
   * scenario × seed range). Each report includes the per-seed
   * outcomes + a summary of population / temperature / lineage
   * distributions.
   */
  batches:BatchReport[]=[];
  /**
   * V14 visual route — persistent list of generated snapshots.
   * The user can have any number of these; the UI shows the list
   * and lets the user switch the "active" one to render or compare
   * two side by side. `v14ActiveId` points at the snapshot the
   * projection's `v14` summary is built from; `null` means no
   * snapshot has been generated yet.
   */
  v14Snapshots:V14Snapshot[]=[];
  v14ActiveId:string|null=null;
  /**
   * Convenience fields for backwards compatibility with v14-1
   * code paths / exports. They mirror the active snapshot (or
   * stay `null` when no snapshot exists). The projection
   * channel can read these without traversing the snapshot
   * list.
   */
  get v14Spec():V14WorldSpec|null{const a=this.activeV14();return a?a.spec:null;}
  set v14Spec(s:V14WorldSpec|null){if(s===null){this.v14Snapshots=[];this.v14ActiveId=null;}}
  get v14Backend():V14Backend|null{const a=this.activeV14();return a?a.backend:null;}
  set v14Backend(_b:V14Backend|null){/* no-op; backend is set via pushSnapshot */ }
  get v14Result():V14WorldResult|null{
    const a=this.activeV14();
    return a?{backend:a.backend,sourceLabel:a.sourceLabel,vertices:a.vertices,colors:a.colors,indices:a.indices,boundingRadius:a.boundingRadius,durationMs:a.durationMs}:null;
  }
  set v14Result(_r:V14WorldResult|null){/* no-op; full result is set via pushSnapshot */ }
  /** Return the currently active snapshot, or `null`. */
  activeV14():V14Snapshot|null{
    if(this.v14ActiveId===null)return null;
    return this.v14Snapshots.find(s=>s.id===this.v14ActiveId)??null;
  }
  /** Append a snapshot and return the new id. If `makeActive` is
   *  true (default), the new snapshot becomes active. */
  pushSnapshot(snap:V14Snapshot,makeActive=true):void{
    this.v14Snapshots.push(snap);
    if(makeActive)this.v14ActiveId=snap.id;
  }
  /** Switch the active snapshot by id. Throws if not found. */
  selectSnapshot(id:string):void{
    if(!this.v14Snapshots.some(s=>s.id===id))throw new Error(`V14 snapshot 不存在：${id}`);
    this.v14ActiveId=id;
  }
  /** Remove a snapshot by id. Clears the active pointer if it
   *  pointed at the removed entry. */
  removeSnapshot(id:string):void{
    const idx=this.v14Snapshots.findIndex(s=>s.id===id);
    if(idx<0)throw new Error(`V14 snapshot 不存在：${id}`);
    this.v14Snapshots.splice(idx,1);
    if(this.v14ActiveId===id){
      this.v14ActiveId=this.v14Snapshots.at(-1)?.id??null;
    }
  }
  /** Rename a snapshot in place. */
  renameSnapshot(id:string,label:string):void{
    const s=this.v14Snapshots.find(s=>s.id===id);
    if(!s)throw new Error(`V14 snapshot 不存在：${id}`);
    s.label=label;
  }
  /** Lightweight summaries for the projection channel. */
  v14Summaries():V14SnapshotSummary[]{
    return this.v14Snapshots.map(summariseV14Snapshot);
  }
  get active(){const b=this.branches.get(this.activeId);if(!b)throw new Error('没有活动分支');return b.timeline;}
  static async create(state:WorldState){const b=new ExperimentBook();b.activeId=state.branch.id;b.branches.set(b.activeId,{label:'主时间线',timeline:await Timeline.create(state)});return b;}
  list(){return[...this.branches.entries()].map(([id,b])=>({id,label:b.label,parentId:b.timeline.state.branch.parentId,forkTick:b.timeline.state.branch.forkTick,tick:b.timeline.state.tick,headTick:b.timeline.headTick,population:summarize(b.timeline.state).population}));}
  async fork(id:string,label:string){
    v.id(id,'branch.id');v.text(label,'branch.label',80);
    if(this.branches.has(id))throw new Error('分支 ID 已存在');if(this.branches.size>=20)throw new Error('当前实验最多保留 20 条分支，请导出备份后另建实验');
    const parent=this.active,state=structuredClone(parent.state);
    state.branch={id,parentId:parent.state.branch.id,forkTick:state.tick,checkpointHash:await sha256(await serializeState(parent.state))};
    const timeline=await Timeline.create(state);this.branches.set(id,{label,timeline});this.activeId=id;
  }
  async refine(id:string){
    const refined=await refineWorld(this.active.state),previous=this.activeId;
    await this.fork(id,`细分至 ${refined.cells.areaM2.length.toLocaleString('zh-CN')} 区域`);
    try{refined.branch=structuredClone(this.active.state.branch);this.branches.get(id)!.timeline=await Timeline.create(refined);}
    catch(error){this.branches.delete(id);this.activeId=previous;throw error;}
  }
  async expandCapacity(id:string){
    const limit=this.active.state.rules.limits.maxCohorts;
    if(limit>=100000)throw new Error('已达到 100,000 队列的支持上限。请保存或导出当前实验；暂不能继续扩容。');
    const previous=this.activeId;
    const nextLimit=Math.min(100000,Math.max(20000,limit*2));
    await this.fork(id,`扩容至 ${nextLimit.toLocaleString('zh-CN')} 队列`);
    try{
      const state=structuredClone(this.active.state);
      state.rules.limits.maxCohorts=nextLimit;state.manifest.rulesetHash=await sha256(state.rules);
      this.branches.get(id)!.timeline=await Timeline.create(state);
    }catch(error){this.branches.delete(id);this.activeId=previous;throw error;}
  }
  switch(id:string){if(!this.branches.has(id))throw new Error('找不到分支');this.activeId=id;}
  async forkAndIntervene(id:string,label:string,command:Intervention){
    const previous=this.activeId;await this.fork(id,label);
    try{await this.active.intervene(command);}catch(error){this.branches.delete(id);this.activeId=previous;throw error;}
  }
  async compare(a:string,b:string,ticks:number,progress?:(tick:number,target:number)=>void,cancelled?:()=>boolean){
    if(a===b)throw new Error('请选择两条不同分支');v.integer(ticks,'ticks',1,1000);
    const x=this.branches.get(a)?.timeline,y=this.branches.get(b)?.timeline;if(!x||!y)throw new Error('找不到对照分支');
    if(x.state.cells.areaM2.length!==y.state.cells.areaM2.length)throw new Error('不同网格精度的分支不能直接做同条件对照');
    if(x.state.manifest.id!==y.state.manifest.id||x.state.manifest.rulesetHash!==y.state.manifest.rulesetHash)throw new Error('对照需要同一世界和规则');
    const start=Math.max(x.state.tick,y.state.tick),target=start+ticks;v.integer(target,'target');
    while(x.state.tick<target||y.state.tick<target){
      if(cancelled?.())throw new Error('对照已取消，保留最后完成的时间步');
      if(x.state.tick<target)await x.advance();if(y.state.tick<target)await y.advance();
      if(Math.min(x.state.tick,y.state.tick)%10===0){progress?.(Math.min(x.state.tick,y.state.tick),target);await new Promise(r=>setTimeout(r,0));}
    }
    const first=summarize(x.state),second=summarize(y.state);
    return{a,b,tick:target,first,second,delta:{population:second.population-first.population,temperatureK:second.temperatureK-first.temperatureK,nutrientMu:second.nutrientMu-first.nutrientMu,activeLineages:second.activeLineages-first.activeLineages}};
  }
  async export(){
    const branches=[];for(const[id,b]of this.branches)branches.push({id,label:b.label,content:await b.timeline.export()});
    // chemistry and colonies are optional subsystems (P12, P13) — they
    // travel with the experiment file when present, and are simply
    // omitted on first import before they have been loaded.
    //
    // Checksum covers the 5 base fields only; v2-only subsystems
    // (astronomy / chemistry / colonies) are *not* part of the digest
    // so a v1 file round-trips with the same checksum, and a v2 file
    // edited only in subsystems still verifies.
    const checksumContent={format:'universe-experiment',version:2,activeId:this.activeId,branches};
    // V14 visual route snapshots carry Float32Array / Uint32Array meshes;
    // `canonicalJson` rejects non-plain prototypes, so we materialise
    // the typed arrays to plain `number[]` here and re-instantiate the
    // typed arrays on the import side. The conversion is O(N) in the
    // mesh size and only runs when v14 snapshots are present.
    const v14SnapshotsExport = this.v14Snapshots.map((s) => ({
      id: s.id,
      label: s.label,
      createdAtTick: s.createdAtTick,
      createdAtBranch: s.createdAtBranch,
      spec: s.spec,
      backend: s.backend,
      sourceLabel: s.sourceLabel,
      vertices: Array.from(s.vertices),
      colors: Array.from(s.colors),
      indices: Array.from(s.indices),
      boundingRadius: s.boundingRadius,
      durationMs: s.durationMs,
      createdAtMs: s.createdAtMs,
    }));
    const encoded=canonicalJson({...checksumContent,astronomy:this.astronomy,chemistry:this.chemistry,colonies:this.colonies,cognition:this.cognition,settlement:this.settlement,earthData:this.earthData,batches:this.batches,v14Snapshots:v14SnapshotsExport,v14ActiveId:this.v14ActiveId,checksum:await sha256(checksumContent)});
    if(new TextEncoder().encode(encoded).byteLength>100_000_000)throw new Error('完整实验超过 100 MB 文件预算；世界仍保留在内存中');
    return encoded;
  }
  static async import(raw:string){
    v.text(raw,'file',100_000_000);const parsed=JSON.parse(raw);
    // P4 single timelines remain loadable when their engine/schema is compatible.
    if(parsed?.format==='universe-timeline'){const timeline=await Timeline.import(raw);const book=new ExperimentBook();book.activeId=timeline.state.branch.id;book.branches.set(book.activeId,{label:'恢复的时间线',timeline});return book;}
    // The v1/v2 union requires the four base fields plus checksum; the
    // v2-only subsystems (astronomy, chemistry, colonies) are allowed
    // but not required. Custom lenient check: only complain about
    // *truly* unknown fields.
    const isV2 = parsed?.version === 2;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) v.fail('experiment', 'expected object');
    const proto = Object.getPrototypeOf(parsed);
    if (proto !== Object.prototype && proto !== null) v.fail('experiment', 'expected plain object');
    const obj = parsed as Record<string, unknown>;
    const required = isV2
      ? ['format','version','activeId','branches','checksum'] // astronomy/chemistry/colonies are optional
      : ['format','version','activeId','branches','checksum'];
    const known = new Set(['format','version','activeId','branches','checksum','astronomy','chemistry','colonies','cognition','settlement','earthData','batches','v14Spec','v14Backend','v14Result','v14Snapshots','v14ActiveId']);
    for (const key of Object.keys(obj)) if (!known.has(key)) v.fail(`experiment.${key}`, 'unknown field');
    for (const key of required) if (!Object.hasOwn(obj, key)) v.fail(`experiment.${key}`, 'required');
    const o = obj as {
      format: string; version: number; activeId: string; branches: unknown[]; checksum: string;
      astronomy?: unknown; chemistry?: unknown; colonies?: unknown; cognition?: unknown; settlement?: unknown; earthData?: unknown; batches?: unknown; v14Spec?: unknown; v14Backend?: unknown; v14Result?: unknown; v14Snapshots?: unknown; v14ActiveId?: unknown;
    };
    v.choice(o.format, ['universe-experiment'], 'experiment.format');
    v.choice(o.version, [1, 2], 'experiment.version');
    v.hash(o.checksum, 'experiment.checksum');
    const book=new ExperimentBook();book.activeId=v.id(o.activeId,'experiment.activeId');
    let worldId='';for(const item of v.array(o.branches,'experiment.branches',20)){
      const b=v.object(item,['id','label','content'],'branch'),id=v.id(b.id,'branch.id'),label=v.text(b.label,'branch.label',80),content=v.text(b.content,'branch.content',100_000_000);
      if(book.branches.has(id))throw new Error('分支 ID 重复');const timeline=await Timeline.import(content);
      if(timeline.state.branch.id!==id)throw new Error('分支身份不一致');
      if(worldId&&worldId!==timeline.state.manifest.id)throw new Error('混入其他世界');worldId=timeline.state.manifest.id;book.branches.set(id,{label,timeline});
    }
    if(!book.branches.has(book.activeId))throw new Error('缺少活动分支');
    for(const[id,b]of book.branches){const seen=new Set([id]);let parent=b.timeline.state.branch.parentId;while(parent!==null){if(seen.has(parent))throw new Error('分支存在循环');seen.add(parent);const p=book.branches.get(parent);if(!p)throw new Error('缺少父分支');parent=p.timeline.state.branch.parentId;}}
    if(o.version===2&&o.astronomy!==null){validateGalaxies(o.astronomy);book.astronomy=structuredClone(o.astronomy);}
    // P12 / P13: optional subsystems ride along when present. The cast
    // is safe — codec.ts's `unpack` will re-instantiate TypedArrays in
    // the chemistry state on read, and the registry is plain JSON.
    if(o.chemistry!=null)book.chemistry=o.chemistry as { network: ReactionNetwork; state: ReactorState };
    if(o.colonies!=null)book.colonies=o.colonies as ColonialRegistry;
    if(o.cognition!=null)book.cognition=o.cognition as CognitiveRegistry;
    if(o.settlement!=null)book.settlement=o.settlement as SettlementRegistry;
    if(o.earthData!=null)book.earthData=o.earthData as EarthDataSeries;
    // V14 snapshots / legacy single-result migration. The v14-2
    // format uses `v14Snapshots` + `v14ActiveId`; v14-1 archives
    // have a single `v14Spec` / `v14Backend` / `v14Result` triple
    // that we convert to a one-snapshot list on import so old
    // archives stay loadable.
    if (Array.isArray(o.v14Snapshots)) {
      for (const raw of o.v14Snapshots as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as { id: string; label: string; createdAtTick: number | null; createdAtBranch: string | null; spec: V14WorldSpec; backend: V14Backend; sourceLabel: string; vertices: number[]; colors: number[]; indices: number[]; boundingRadius: number; durationMs: number; createdAtMs: number };
        book.v14Snapshots.push({
          id: r.id,
          label: r.label,
          createdAtTick: r.createdAtTick,
          createdAtBranch: r.createdAtBranch,
          spec: r.spec,
          backend: r.backend,
          sourceLabel: r.sourceLabel,
          vertices: new Float32Array(r.vertices),
          colors: new Float32Array(r.colors),
          indices: new Uint32Array(r.indices),
          boundingRadius: r.boundingRadius,
          durationMs: r.durationMs,
          createdAtMs: r.createdAtMs,
        });
      }
      if (typeof o.v14ActiveId === 'string' && book.v14Snapshots.some((s) => s.id === o.v14ActiveId)) {
        book.v14ActiveId = o.v14ActiveId;
      } else if (book.v14Snapshots.length > 0) {
        book.v14ActiveId = book.v14Snapshots[0]!.id;
      }
    } else if (o.v14Spec != null && o.v14Result != null) {
      // Legacy v14-1 archive: a single spec + result pair. Convert
      // to a one-snapshot list so the rest of the pipeline only has
      // to know about the list shape.
      const spec = o.v14Spec as V14WorldSpec;
      const backend = (o.v14Backend ?? 'inRepo') as V14Backend;
      const r = o.v14Result as { backend: V14Backend; sourceLabel: string; vertices: number[]; colors: number[]; indices: number[]; boundingRadius: number; durationMs: number };
      const legacyId = `legacy-${crypto.randomUUID()}`;
      book.v14Snapshots.push({
        id: legacyId,
        label: '(legacy v14-1 import)',
        createdAtTick: null,
        createdAtBranch: null,
        spec,
        backend,
        sourceLabel: r.sourceLabel,
        vertices: new Float32Array(r.vertices),
        colors: new Float32Array(r.colors),
        indices: new Uint32Array(r.indices),
        boundingRadius: r.boundingRadius,
        durationMs: r.durationMs,
        createdAtMs: 0,
      });
      book.v14ActiveId = legacyId;
    }
    if(Array.isArray(o.batches))book.batches=o.batches as BatchReport[];
    // Checksum is always over the 5 base fields (format / version /
    // activeId / branches / checksum target). v2-only subsystems
    // (astronomy / chemistry / colonies) are *not* part of the digest
    // so a v1 file round-trips with the same checksum, and a v2 file
    // edited only in subsystems still verifies.
    if(await sha256({format:o.format,version:o.version,activeId:o.activeId,branches:o.branches})!==o.checksum)throw new Error('实验文件校验和不一致');
    return book;
  }
}
