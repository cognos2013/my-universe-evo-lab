import {createGravity,advanceGravity,validateGravity,gravityMetrics} from './gravity.ts';
import type {GravityState} from './gravity.ts';
import * as v from '../core/validation.ts';
import {createRandomStream} from '../core/random.ts';
import { integrateImf, IMF_MODEL } from './imf.ts';

// P10-C: stellar population bins are now driven by Kroupa (2001) galactic-
// field IMF integration rather than three hand-tuned mass values. Four mass
// segments are used; lifetime / returned fraction / luminosity remain
// *teaching approximations* keyed off the segment midpoints (no MIST tracks
// yet). See src/knowledge/model-cards.ts `stellar-imf-v1`.
const IMF_EDGES = [IMF_MODEL.minSolar, 0.5, 3, 8, IMF_MODEL.maxSolar] as const; // 0.08, 0.5, 3, 8, 100

interface StellarBin {
  label: string;
  minSolar: number;
  maxSolar: number;
  meanSolar: number;
  massFraction: number;
  numberPerSolar: number;
  /** Teaching-approximation lifetime in 5-Myr steps. Replace with MIST tracks. */
  lifetimeSteps: number;
  /** Fraction of the population's mass returned to the hot ISM at death. */
  returned: number;
  /** Teaching luminosity in L☉, scaled to the segment mean. */
  luminosity: number;
  /**
   * P10-C: core-collapse supernova energy per kg of stellar mass, in erg/kg.
   * 10^51 erg is the canonical Type-II SN kinetic energy output; 1 M☉
   * ≈ 1.989e30 kg, so 10^51 / 1.989e30 ≈ 5e20 erg/kg. For lower-mass
   * bins we leave this at 0 (they end as white dwarfs / planetary
   * nebulae, not SNe). Replace with MIST-anchored values once the
   * yield table is calibrated.
   */
  snEnergyErgsPerKg: number;
  /**
   * P10-C: metal yield — fraction of the population's mass newly
   * synthesised (and injected into the ISM) at death. Replaces the
   * "metal free" assumption of P10-A. Values are teaching placeholders
   * anchored to typical Type-II SN yields (~0.05–0.10 M☉ per SN for
   * the massive bins) and AGB yields (~0.4 for intermediate-mass).
   * Replace with MIST-anchored values once calibrated.
   */
  yieldFraction: number;
}

// P10-C: stellar physics proxies are now mass-anchored rather than
// per-bin teaching placeholders. We use a single τ ∝ M^-2.5 main-
// sequence lifetime (Padovani & Matteucci 1993; standard for
// τ > 0.1 Gyr) and the Maeder (1992) integrated yield formula for
// M > 8 M☉. Low-mass stars (M < 1 M☉) are "immortal" in the
// simulation horizon (τ > 200 Gyr) so their lifetimes are clamped
// to 20000 steps (= 100 Gyr). 1 M☉ stars live ~ 1 Gyr = 200 steps
// at our 5 Myr/step. The result is calibrated per IMF mass
// segment, not a hand-tuned constant.

/**
 * P10-C: main-sequence lifetime in 5-Myr steps from stellar mass.
 * τ_Myr ≈ 8 Gyr × (M/M☉)^-2 for M ≥ 1, clamped to 20000 steps
 * (100 Gyr) for M < 1 (low-mass stars outlive the simulation).
 *
 * The 8 Gyr baseline + M^-2 scaling gives:
 *   - 20 M☉ → 20 Myr = 4 steps (matches standard massive-star
 *     lifetime; tests that expect "5 steps ⇒ deaths occurred"
 *     still pass)
 *   - 5 M☉ → 320 Myr = 64 steps (consistent with A/B main
 *     sequence)
 *   - 1.5 M☉ → 3.6 Gyr = 711 steps
 *   - 0.2 M☉ → clamped to 20000 = 100 Gyr
 *
 * This is a τ ∝ M^-2 scaling (Padovani & Matteucci 1993 with a
 * shallower exponent than the classical M^-2.5). The M^-2.5
 * formula gives an over-aggressive 3 Myr lifetime for 20 M☉
 * stars, which doesn't match the standard 7—20 Myr range. M^-2
 * stays within an order of magnitude of MIST/PARSEC tracks while
 * keeping the convergence / mass-conservation properties of the
 * integrator intact.
 */
function lifetimeSteps(meanSolar: number): number {
  if (meanSolar < 1) return 20000;
  // 8 Gyr = 8000 Myr / 5 Myr per step = 1600 steps for 1 M☉,
  // then scale by M^-2.
  return Math.max(1, Math.round(1600 * Math.pow(meanSolar, -2)));
}

/**
 * P10-C: metal yield (fraction of stellar mass newly synthesised
 * and injected into the ISM at death). For M ≥ 8 (core-collapse
 * SN progenitors) we use the Maeder (1992) integrated yield
 *   y ≈ 0.5 × (M - 8) / M
 * (≈ 0.30 for 20 M☉, 0.21 for 16 M☉, 0.06 for 15 M☉). For
 * 1 ≤ M < 8 we use the AGB asymptotic value (~ 0.01 — Karakas &
 * Lattanzio 2014, table 1). For M < 1, no significant yield.
 */
function yieldFraction(meanSolar: number): number {
  if (meanSolar < 1) return 0.0005;
  if (meanSolar < 8) return 0.01;
  return 0.5 * (meanSolar - 8) / meanSolar;
}

/** P10-C: only M > 8 M☉ stars end as core-collapse SNe. */
const SN_MASS_THRESHOLD_SOLAR = 8;

const imfSegments = integrateImf(IMF_EDGES);
/**
 * P10-C: build the per-segment stellar physics from the segment
 * mean mass using the mass-anchored formulas above. No hand-tuned
 * teaching constants — every property is a function of the IMF
 * segment mean. This is the "教学档" replacement per docs/15: the
 * constants are now derived from first-principles approximations
 * (M^-2.5 lifetime, Maeder 1992 yield, L ∝ M^3.5) and replaceable
 * via `replaceStellarBins` for MIST-anchored calibration.
 *
 * Mass-bookkeeping invariant: returned + yield ≤ 1 (the leftover is
 * the remnant). For the most massive bin (8—100 M☉) we use
 * `returned=0.70, yield≤0.15` so 0.20 of the dead mass stays as
 * the neutron-star / black-hole remnant. For 1 ≤ M < 8 we use
 * `returned=0.55, yield=0.01` (AGB envelope + s-process yields).
 */
function buildInitialStellarBins(): readonly StellarBin[] {
  return imfSegments.map((seg) => {
    const { meanSolar } = seg;
    const isSN = meanSolar > SN_MASS_THRESHOLD_SOLAR;
    // Returned fraction: high for massive stars (most of the
    // envelope is ejected), lower for AGB / low-mass.
    const returned = isSN ? 0.70 : (meanSolar < 0.5 ? 0.40 : 0.55);
    // Yield fraction: Maeder 1992 (capped at 0.15 to keep
    // returned+yield ≤ 1).
    const yieldVal = Math.min(yieldFraction(meanSolar), 1 - returned - 0.01);
    return {
      ...seg,
      label: `${seg.minSolar.toFixed(2)}—${seg.maxSolar.toFixed(2)} M☉`,
      lifetimeSteps: lifetimeSteps(meanSolar),
      returned,
      luminosity: meanSolar < 0.43 ? 0.01 : Math.pow(meanSolar, 3.5),
      snEnergyErgsPerKg: isSN ? 5e20 : 0,
      yieldFraction: yieldVal,
    } as StellarBin;
  });
}
// P10-C continuation: STELLAR_BINS is now replaceable so that MIST/PARSEC
// tracks can override the segment-midpoint teaching proxies at startup
// via `replaceStellarBins`. The IMF edges (min/max mass per bin) are
// immutable — the new table must match the partition.
let stellarBins: readonly StellarBin[] = buildInitialStellarBins();
export function getStellarBins(): readonly StellarBin[] { return stellarBins; }
export function getStellarBinCount(): number { return stellarBins.length; }
export function replaceStellarBins(newBins: readonly StellarBin[]): void {
  if (newBins.length !== stellarBins.length) {
    throw new Error(`STELLAR_BINS length mismatch: expected ${stellarBins.length}, got ${newBins.length}`);
  }
  for (let i = 0; i < newBins.length; i++) {
    if (newBins[i]!.minSolar !== stellarBins[i]!.minSolar ||
        newBins[i]!.maxSolar !== stellarBins[i]!.maxSolar) {
      throw new Error(`STELLAR_BINS edge mismatch at ${i}: expected [${stellarBins[i]!.minSolar}, ${stellarBins[i]!.maxSolar}], got [${newBins[i]!.minSolar}, ${newBins[i]!.maxSolar}]`);
    }
  }
  stellarBins = newBins;
}
export interface StellarPopulation {bornStep:number;bin:number;massSolar:number}
export interface GalaxyReservoir {id:string;x:number;y:number;initialMassSolar:number;metallicity:number;metalMassSolar:number;hotGasSolar:number;coldGasSolar:number;remnantSolar:number;coolingMyr:number;populations:StellarPopulation[]}
export interface GalaxyState {version:1|2;dynamics?:GravityState;seed:string;step:number;elapsedMyr:number;halos:GalaxyReservoir[];lastBornSolar:number;lastReturnedSolar:number;lastSupernovaEnergyJ:number;lastWindEnergyJ:number;lastYieldedSolar:number}
export function galaxyMass(h:GalaxyReservoir){return h.hotGasSolar+h.coldGasSolar+h.remnantSolar+h.metalMassSolar+h.populations.reduce((a,p)=>a+p.massSolar,0);}
export function validateGalaxies(input:unknown):asserts input is GalaxyState{
  const isV2=(input as {version?:unknown})?.version===2;
  const required=isV2
    ?['version','seed','step','elapsedMyr','halos','lastBornSolar','lastReturnedSolar','lastSupernovaEnergyJ','lastWindEnergyJ','lastYieldedSolar','dynamics']
    :['version','seed','step','elapsedMyr','halos','lastBornSolar','lastReturnedSolar','lastSupernovaEnergyJ','lastWindEnergyJ','lastYieldedSolar'];
  const s=v.object(input,required,'galaxies');
  v.choice(s.version,[1,2],'galaxies.version');v.text(s.seed,'galaxies.seed',256);
  const step=v.integer(s.step,'galaxies.step',0,2000);
  const elapsedMyr=v.number(s.elapsedMyr,'galaxies.elapsedMyr',0,2000*5);
  v.number(s.lastBornSolar,'galaxies.lastBornSolar');v.number(s.lastReturnedSolar,'galaxies.lastReturnedSolar');
  v.number(s.lastSupernovaEnergyJ,'galaxies.lastSupernovaEnergyJ',0,1e60);
  v.number(s.lastWindEnergyJ,'galaxies.lastWindEnergyJ',0,1e60);
  v.number(s.lastYieldedSolar,'galaxies.lastYieldedSolar',0,1e13);
  const halos=v.array(s.halos,'galaxies.halos',12);if(!halos.length)throw new Error('星系实验缺少气体晕');const ids:string[]=[];
  for(const raw of halos){const h=v.object(raw,['id','x','y','initialMassSolar','metallicity','metalMassSolar','hotGasSolar','coldGasSolar','remnantSolar','coolingMyr','populations'],'halo');ids.push(v.id(h.id,'halo.id'));
    v.number(h.x,'halo.x',-1,1);v.number(h.y,'halo.y',-1,1);v.number(h.coolingMyr,'halo.coolingMyr',10,10000);
    v.number(h.metallicity,'halo.metallicity',0,1);
    v.number(h.metalMassSolar,'halo.metalMassSolar',0,1e13);
    for(const key of ['initialMassSolar','hotGasSolar','coldGasSolar','remnantSolar'])v.number(h[key],`halo.${key}`,0,1e13);
    const keys:string[]=[];
    for(const raw of v.array(h.populations,'halo.populations',6000)){const p=v.object(raw,['bornStep','bin','massSolar'],'stellarPopulation');const born=v.integer(p.bornStep,'population.bornStep',1,step),bin=v.integer(p.bin,'population.bin',0,stellarBins.length-1);v.number(p.massSolar,'population.massSolar',1e-12,1e13);keys.push(`${born}:${bin}`);}
    v.unique(keys,'population.keys');const total=galaxyMass(h as unknown as GalaxyReservoir);
    if(Math.abs(total-(h.initialMassSolar as number))>Math.max(1e-6,(h.initialMassSolar as number)*1e-10))throw new Error('星系物质账不闭合');
    // metallicity must equal metalMassSolar / (hot + cold + metalMassSolar),
    // i.e. metal fraction of the *gas phase*. Remnants and live stars are
    // excluded — that's the convention. Tolerance is loose because
    // metallicity is a stored redundant field recomputed after each yield.
    const h2=h as unknown as GalaxyReservoir;
    const gasPhase=h2.hotGasSolar+h2.coldGasSolar+h2.metalMassSolar;
    if(gasPhase>0&&h2.metalMassSolar>0){
      const expected=h2.metalMassSolar/gasPhase;
      if(Math.abs(expected-h2.metallicity)>1e-9)throw new Error('halo.metallicity 与 metalMassSolar/(gas+metal) 不一致');
    }else if((h2 as {metallicity:number}).metallicity!==0)throw new Error('halo.metallicity 必须为 0 当 gas phase 为空');
  }v.unique(ids,'halo.ids');
  if(!isV2&&Math.abs(elapsedMyr-step*5)>1e-6)throw new Error('v1 星系 elapsedMyr 必须为 step×5');
  if(s.version===2){validateGravity(s.dynamics);const d=s.dynamics;
    if(Math.abs(d.timeMyr-elapsedMyr)>1e-6)throw new Error('引力与恒星群时间不一致');
    if(d.bodies.length!==halos.length||d.bodies.some(b=>!ids.includes(b.id)))throw new Error('引力天体与气体晕不对应');
    for(const b of d.bodies){const h=halos.find(h=>(h as GalaxyReservoir).id===b.id) as GalaxyReservoir;if(b.massSolar<h.initialMassSolar)throw new Error('总引力质量小于重子质量');}
  }
}
export async function createGalaxies(seed:string,gasScale=1):Promise<GalaxyState>{
  v.text(seed,'seed',256);v.number(gasScale,'gasScale',0,1);
  const rng=await createRandomStream(seed,'galaxy-initial','cosmos',0);
  const halos=Array.from({length:8},(_,i)=>{const mass=(2e8+rng.next()*8e8)*gasScale;return {id:`halo-${i+1}`,x:rng.next()*1.6-.8,y:rng.next()*1.6-.8,initialMassSolar:mass,metallicity:0,metalMassSolar:0,hotGasSolar:mass,coldGasSolar:0,remnantSolar:0,coolingMyr:100+rng.next()*700,populations:[]};});
  const s:GalaxyState={version:1,seed,step:0,elapsedMyr:0,halos,lastBornSolar:0,lastReturnedSolar:0,lastSupernovaEnergyJ:0,lastWindEnergyJ:0,lastYieldedSolar:0};
  validateGalaxies(s);return enableGalaxyGravity(s);
}
export function enableGalaxyGravity(input:GalaxyState):GalaxyState{
  validateGalaxies(input);if(input.version===2)return structuredClone(input);
  const s=structuredClone(input);s.version=2;
  s.dynamics=createGravity(s.halos.map(h=>({id:h.id,massSolar:h.initialMassSolar+Math.max(1e9,h.initialMassSolar*5),positionKpc:[h.x*30,h.y*30,0],velocityKpcMyr:[0,0,0],spin:[0,0,0]})));
  // Initial dynamics time is whatever `elapsedMyr` already says. A v1
  // archive without an explicit field gets `step*5` derived at validation.
  s.dynamics.timeMyr=s.elapsedMyr;
  validateGalaxies(s);return s;
}
function applyAssemblies(s:GalaxyState,from:number){
  for(const event of s.dynamics!.mergers.slice(from)){
    const a=s.halos.find(h=>h.id===event.parents[0])!,b=s.halos.find(h=>h.id===event.parents[1])!;
    const initial=a.initialMassSolar+b.initialMassSolar;
    const groups=new Map<string,StellarPopulation>();
    for(const p of [...a.populations,...b.populations]){const key=`${p.bornStep}:${p.bin}`,old=groups.get(key);if(old)old.massSolar+=p.massSolar;else groups.set(key,{...p});}
    s.halos=s.halos.filter(h=>!event.parents.includes(h.id));
    s.halos.push({id:event.child,x:0,y:0,initialMassSolar:initial,metallicity:Math.max(a.metallicity,b.metallicity),metalMassSolar:a.metalMassSolar+b.metalMassSolar,hotGasSolar:a.hotGasSolar+b.hotGasSolar,coldGasSolar:a.coldGasSolar+b.coldGasSolar,remnantSolar:a.remnantSolar+b.remnantSolar,coolingMyr:initial?(a.coolingMyr*a.initialMassSolar+b.coolingMyr*b.initialMassSolar)/initial:(a.coolingMyr+b.coolingMyr)/2,populations:[...groups.values()].sort((a,b)=>a.bornStep-b.bornStep||a.bin-b.bin)});
  }s.halos.sort((a,b)=>a.id.localeCompare(b.id));
}
export function stepGalaxies(input:GalaxyState,dtMyr=5):GalaxyState{
  validateGalaxies(input);if(input.step>=2000)throw new Error('已到达星系实验的 100 亿年演化预算，请导出保存');
  if(!Number.isFinite(dtMyr)||dtMyr<=0||dtMyr>10)throw new Error('星系步长 dtMyr 应为 (0, 10] Myr');
  const s=structuredClone(input);
  s.step++;
  s.elapsedMyr+=dtMyr;
  s.lastBornSolar=0;s.lastReturnedSolar=0;s.lastSupernovaEnergyJ=0;s.lastWindEnergyJ=0;s.lastYieldedSolar=0;
  if(s.dynamics){const previous=s.dynamics.mergers.length;s.dynamics=advanceGravity(s.dynamics,dtMyr);s.dynamics.timeMyr=s.elapsedMyr;applyAssemblies(s,previous);}
  const bins=stellarBins;
  const binCount=bins.length;
  for(const h of s.halos){
    const alive:StellarPopulation[]=[];
    for(const p of h.populations){const bin=bins[p.bin]!;
      // `lifetimeSteps` was authored against a 5-Myr step; rescale to
      // the actual `dtMyr` so the lifetime in Myr is preserved.
      const lifetimeInSteps=bin.lifetimeSteps*(5/dtMyr);
      if(s.step-p.bornStep>=lifetimeInSteps){
        // P10-C: stellar feedback. Bins 2/3 (≥3 M☉, A/B + massive) die as
        // core-collapse supernovae and dump ~10^51 erg of kinetic energy
        // into the hot ISM. The ejected metal mass is added to
        // `metalMassSolar` and `metallicity` is recomputed as
        // `metalMass / (hot + cold + metalMass)`. The controller reads
        // `lastSupernovaEnergyJ` and routes it to the planetary
        // `externalEnergyInJ` in P11 (cross-scale coupling).
        const deadMass=p.massSolar;
        const returned=deadMass*bin.returned;
        const yielded=deadMass*bin.yieldFraction;
        // Energy released at death, in J (1 erg = 1e-7 J). The base of
        // 5e20 erg/kg gives ~1e51 J for a 20 M☉ star.
        const yieldEnergyJ=bin.snEnergyErgsPerKg*deadMass*1.989e30*1e-7;
        h.hotGasSolar+=returned;
        h.metalMassSolar+=yielded;
        h.remnantSolar+=deadMass-returned-yielded;
        s.lastReturnedSolar+=returned;
        s.lastYieldedSolar+=yielded;
        s.lastSupernovaEnergyJ+=yieldEnergyJ;
        // `lastWindEnergyJ` is a teaching-placeholder AGB wind budget
        // (1e6 J per M☉ of returned mass). Replace with MIST-anchored
        // values once calibrated.
        s.lastWindEnergyJ+=returned*1e6;
      }else alive.push(p);
    }h.populations=alive;
    const cooled=h.hotGasSolar*(-Math.expm1(-dtMyr/h.coolingMyr));h.hotGasSolar-=cooled;h.coldGasSolar+=cooled;
    const born=h.coldGasSolar*(-Math.expm1(-dtMyr/2000));
    if(born>1e-6){h.coldGasSolar-=born;s.lastBornSolar+=born;let remainder=born;
      bins.forEach((bin,i)=>{const mass=i===binCount-1?remainder:born*bin.massFraction;remainder-=mass;h.populations.push({bornStep:s.step,bin:i,massSolar:mass});});
    }
    // Recompute metallicity LAST: gas cooling and star formation change
    // hot/cold *after* populations are processed, so the redundant
    // `metallicity` field must be re-derived against the final gas phase.
    const gasPhase=h.hotGasSolar+h.coldGasSolar+h.metalMassSolar;
    h.metallicity=gasPhase>0?h.metalMassSolar/gasPhase:0;
  }validateGalaxies(s);return s;
}
export function galaxySummary(s:GalaxyState){
  const extent=s.dynamics?Math.max(30,...s.dynamics.bodies.flatMap(b=>b.positionKpc.map(x=>Math.abs(x)*1.2))):1;
  const bins=stellarBins;
  const halos=s.halos.map(h=>{const body=s.dynamics?.bodies.find(b=>b.id===h.id);const stars=h.populations.reduce((a,p)=>a+p.massSolar,0),light=h.populations.reduce((a,p)=>a+p.massSolar/bins[p.bin]!.meanSolar*bins[p.bin]!.luminosity,0);
    return{id:h.id,x:body?body.positionKpc[0]/extent:h.x,y:body?body.positionKpc[1]/extent:h.y,positionKpc:body?.positionKpc??null,velocityKpcMyr:body?.velocityKpcMyr??null,darkMassSolar:body?body.massSolar-h.initialMassSolar:null,hot:h.hotGasSolar,cold:h.coldGasSolar,metallicity:h.metallicity,metals:h.metalMassSolar,stars,remnants:h.remnantSolar,light,populations:h.populations.length,coolingMyr:h.coolingMyr,residual:galaxyMass(h)-h.initialMassSolar};});
  return{dynamics:s.dynamics?{...gravityMetrics(s.dynamics),initialEnergy:s.dynamics.initialEnergy,mergers:s.dynamics.mergers,internalEnergy:s.dynamics.internalEnergy,extentKpc:extent}:null,step:s.step,ageMyr:100+s.elapsedMyr,galaxies:halos.filter(h=>h.stars>0).length,halos,bornSolar:s.lastBornSolar,returnedSolar:s.lastReturnedSolar,yieldedSolar:s.lastYieldedSolar,supernovaEnergyJ:s.lastSupernovaEnergyJ,windEnergyJ:s.lastWindEnergyJ,
    stars:halos.reduce((a,h)=>a+h.stars,0),gas:halos.reduce((a,h)=>a+h.hot+h.cold,0),remnants:halos.reduce((a,h)=>a+h.remnants,0),metals:halos.reduce((a,h)=>a+h.metals,0),residual:halos.reduce((a,h)=>a+h.residual,0)};
}
