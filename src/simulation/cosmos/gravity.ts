import * as v from '../core/validation.ts';
export type Vec3=[number,number,number];
export interface GravityBody {id:string;massSolar:number;positionKpc:Vec3;velocityKpcMyr:Vec3;spin:Vec3}
export interface Merger {timeMyr:number;parents:[string,string];child:string;massSolar:number;internalEnergyDelta:number}
export interface GravityState {version:1;timeMyr:number;softeningKpc:number;mergeRadiusKpc:number;bodies:GravityBody[];mergers:Merger[];internalEnergy:number;initialMassSolar:number;initialMomentum:Vec3;initialAngularMomentum:Vec3;initialEnergy:number}
export const G=6.67430e-11*1.98847e30*(365.25*86400*1e6)**2/(3.0856775814913673e19)**3;
const dot=(a:Vec3,b:Vec3)=>a.reduce((s,x,i)=>s+x*b[i]!,0);
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function gravityMetrics(s:GravityState){
  let kinetic=0,potential=0,mass=0;const momentum:Vec3=[0,0,0],angular:Vec3=[0,0,0];
  for(let i=0;i<s.bodies.length;i++){const b=s.bodies[i]!;mass+=b.massSolar;kinetic+=b.massSolar*dot(b.velocityKpcMyr,b.velocityKpcMyr)/2;
    const a=cross(b.positionKpc,b.velocityKpcMyr);for(let k=0;k<3;k++){momentum[k]!+=b.massSolar*b.velocityKpcMyr[k]!;angular[k]!+=b.massSolar*a[k]!+b.spin[k]!;}
    for(let j=i+1;j<s.bodies.length;j++){const d=sub(s.bodies[j]!.positionKpc,b.positionKpc);potential-=G*b.massSolar*s.bodies[j]!.massSolar/Math.sqrt(dot(d,d)+s.softeningKpc**2);}
  }
  return{mass,momentum,angular,kinetic,potential,energy:kinetic+potential+s.internalEnergy};
}
function vector(x:unknown,label:string){const a=v.array(x,label,3);if(a.length!==3)throw new Error(`${label}: expected three components`);a.forEach(n=>v.number(n,label,-1e30,1e30));}
export function validateGravity(input:unknown):asserts input is GravityState{
  const s=v.object(input,['version','timeMyr','softeningKpc','mergeRadiusKpc','bodies','mergers','internalEnergy','initialMassSolar','initialMomentum','initialAngularMomentum','initialEnergy'],'gravity');
  v.choice(s.version,[1],'gravity.version');v.number(s.timeMyr,'gravity.timeMyr',0,1e6);v.number(s.softeningKpc,'gravity.softeningKpc',.01,100);v.number(s.mergeRadiusKpc,'gravity.mergeRadiusKpc',0,100);
  const bodies=v.array(s.bodies,'gravity.bodies',64);if(!bodies.length)throw new Error('引力系统没有天体');const ids:string[]=[];
  for(const raw of bodies){const b=v.object(raw,['id','massSolar','positionKpc','velocityKpcMyr','spin'],'gravity.body');ids.push(v.id(b.id,'body.id'));v.number(b.massSolar,'body.massSolar',1,1e15);vector(b.positionKpc,'body.positionKpc');vector(b.velocityKpcMyr,'body.velocityKpcMyr');vector(b.spin,'body.spin');}v.unique(ids,'gravity.bodyIds');
  v.number(s.initialMassSolar,'gravity.initialMassSolar',1,1e17);v.number(s.internalEnergy,'gravity.internalEnergy',-1e35,1e35);v.number(s.initialEnergy,'gravity.initialEnergy',-1e35,1e35);vector(s.initialMomentum,'gravity.initialMomentum');vector(s.initialAngularMomentum,'gravity.initialAngularMomentum');
  const used=new Set<string>(),children=new Set<string>();let time=0;
  for(const raw of v.array(s.mergers,'gravity.mergers',63)){const e=v.object(raw,['timeMyr','parents','child','massSolar','internalEnergyDelta'],'merger');const t=v.number(e.timeMyr,'merger.timeMyr',time,s.timeMyr as number);time=t;
    const parents=v.ids(e.parents,'merger.parents',2);if(parents.length!==2)throw new Error('合并必须有两个父天体');const child=v.id(e.child,'merger.child');if(parents.includes(child)||used.has(child)||children.has(child))throw new Error('合并谱系重复或循环');
    for(const p of parents){if(used.has(p)||ids.includes(p))throw new Error('合并父天体重复消费或仍为活体');used.add(p);}children.add(child);
    v.number(e.massSolar,'merger.massSolar',1,1e17);v.number(e.internalEnergyDelta,'merger.internalEnergyDelta',-1e35,1e35);
  }
  for(const c of children)if(!used.has(c)&&!ids.includes(c))throw new Error('合并子天体缺失');
  const state=input as GravityState,m=gravityMetrics(state);if(Math.abs(m.mass-state.initialMassSolar)>state.initialMassSolar*1e-10)throw new Error('引力质量账不闭合');
  const momentumScale=Math.max(1,...state.initialMomentum.map(Math.abs),...state.bodies.map(b=>b.massSolar*Math.hypot(...b.velocityKpcMyr)));
  if(m.momentum.some((p,k)=>Math.abs(p-state.initialMomentum[k]!)>momentumScale*1e-9))throw new Error('引力动量账不闭合');
}
export function createGravity(bodies:GravityBody[],softeningKpc=.5,mergeRadiusKpc=1):GravityState{
  const s:GravityState={version:1,timeMyr:0,softeningKpc,mergeRadiusKpc,bodies:structuredClone(bodies).sort((a,b)=>a.id.localeCompare(b.id)),mergers:[],internalEnergy:0,initialMassSolar:1,initialMomentum:[0,0,0],initialAngularMomentum:[0,0,0],initialEnergy:0};
  const m=gravityMetrics(s);s.initialMassSolar=m.mass;s.initialMomentum=m.momentum;s.initialAngularMomentum=m.angular;s.initialEnergy=m.energy;validateGravity(s);return s;
}
function accelerations(s:GravityState):Vec3[]{
  const out=s.bodies.map(()=>[0,0,0] as Vec3);
  for(let i=0;i<s.bodies.length;i++)for(let j=i+1;j<s.bodies.length;j++){
    const a=s.bodies[i]!,b=s.bodies[j]!,d=sub(b.positionKpc,a.positionKpc),factor=G/(dot(d,d)+s.softeningKpc**2)**1.5;
    for(let k=0;k<3;k++){out[i]![k]!+=factor*b.massSolar*d[k]!;out[j]![k]!-=factor*a.massSolar*d[k]!;}
  }return out;
}
function mergeCloseBoundPairs(s:GravityState){
  if(!s.mergeRadiusKpc)return;
  for(let i=0;i<s.bodies.length;i++)for(let j=i+1;j<s.bodies.length;j++){
    const a=s.bodies[i]!,b=s.bodies[j]!,d=sub(b.positionKpc,a.positionKpc),dv=sub(b.velocityKpcMyr,a.velocityKpcMyr),mass=a.massSolar+b.massSolar;
    if(dot(d,d)>s.mergeRadiusKpc**2||dot(d,dv)>0||dot(dv,dv)/2>=G*mass/Math.sqrt(dot(d,d)+s.softeningKpc**2))continue;
    const before=gravityMetrics(s).energy,id=`assembly-${s.mergers.length+1}`;
    if(s.bodies.some(b=>b.id===id)||s.mergers.some(m=>m.child===id||m.parents.includes(id)))throw new Error('合并 ID 冲突，原状态保留');
    const position=a.positionKpc.map((x,k)=>(x*a.massSolar+b.positionKpc[k]!*b.massSolar)/mass) as Vec3;
    const velocity=a.velocityKpcMyr.map((x,k)=>(x*a.massSolar+b.velocityKpcMyr[k]!*b.massSolar)/mass) as Vec3;
    const sa=cross(sub(a.positionKpc,position),sub(a.velocityKpcMyr,velocity)),sb=cross(sub(b.positionKpc,position),sub(b.velocityKpcMyr,velocity));
    const spin=a.spin.map((x,k)=>x+b.spin[k]!+a.massSolar*sa[k]!+b.massSolar*sb[k]!) as Vec3;
    s.bodies=s.bodies.filter((_,k)=>k!==i&&k!==j);s.bodies.push({id,massSolar:mass,positionKpc:position,velocityKpcMyr:velocity,spin});s.bodies.sort((a,b)=>a.id.localeCompare(b.id));
    const delta=before-gravityMetrics(s).energy;s.internalEnergy+=delta;s.mergers.push({timeMyr:s.timeMyr,parents:[a.id,b.id],child:id,massSolar:mass,internalEnergyDelta:delta});
    mergeCloseBoundPairs(s);return;
  }
}
/** Isolated proper coordinates, no Hubble flow; fixed-step kick-drift-kick. */
export function advanceGravity(input:GravityState,durationMyr:number,maxStepMyr=.05):GravityState{
  validateGravity(input);v.number(durationMyr,'durationMyr',0,100);v.number(maxStepMyr,'maxStepMyr',.001,.5);
  const steps=Math.ceil(durationMyr/maxStepMyr);if(steps>100000)throw new Error('引力子步预算超限');const s=structuredClone(input);s.bodies.sort((a,b)=>a.id.localeCompare(b.id));if(!steps)return s;
  const dt=durationMyr/steps;
  for(let t=0;t<steps;t++){
    const a=accelerations(s);for(let i=0;i<s.bodies.length;i++)for(let k=0;k<3;k++){const b=s.bodies[i]!;b.velocityKpcMyr[k]!+=a[i]![k]!*dt/2;b.positionKpc[k]!+=b.velocityKpcMyr[k]!*dt;}
    const next=accelerations(s);for(let i=0;i<s.bodies.length;i++)for(let k=0;k<3;k++)s.bodies[i]!.velocityKpcMyr[k]!+=next[i]![k]!*dt/2;
    s.timeMyr=input.timeMyr+(t+1)*dt;mergeCloseBoundPairs(s);
  }validateGravity(s);return s;
}
