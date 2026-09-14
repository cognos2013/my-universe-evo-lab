import {createGalaxies,stepGalaxies,galaxySummary,enableGalaxyGravity} from '../simulation/cosmos/galaxies.ts';

/**
 * P11 cross-scale coupling. Without these, a 10^45 J supernova dump
 * would saturate the planetary energy ledger and the chemistry /
 * colonial / cognitive subsystems would run with effectively infinite
 * energy on the next step. We instead:
 *
 *   - advance the cosmic clock once every `P11_COSMIC_STEP_EVERY`
 *     planetary ticks (1 Myr ≈ 1000 days at 1:1 ratio)
 *   - take the geometric dilution at ~1 kpc as the default attenuation,
 *     which gives a planet-scale burst of 10^18 J per 10^45 J supernova
 *   - hard-cap each per-tick injection at `P11_MAX_ENERGY_PER_TICK_J`
 *     to keep the chemistry reactor from blowing up if a closer-than-
 *     expected supernova happens to fire
 *
 * Override these via the `SimulationController` constructor `p11`
 * option for tests / sensitivity analysis.
 */
export const P11_COSMIC_STEP_EVERY = 1000;
export const P11_PLANET_FRACTION = 1e-27;
export const P11_MAX_ENERGY_PER_TICK_J = 1e22;

/**
 * P10-C: convert 1 M☉ of galactic metal yield into the planetary
 * `externalMatterInMu` ledger. MU is an abstract model unit, so the
 * exact ratio is a teaching choice rather than a physical constant;
 * 1 M☉ = 1e6 MU gives a single massive-star death (≈ 0.1 M☉ of
 * metals) a budget of 1e5 MU per step — a few percent of a
 * default cell's nutrient pool (1e3 MU).
 */
export const P10C_SOLAR_TO_MU = 1e6;
import { ExperimentBook } from '../experiments/book.ts';
import { getScenario } from '../scenarios/catalog.ts';
import { initializeWorld } from '../simulation/core/initialize.ts';
import type { WorldState } from '../simulation/core/contracts.ts';
import { summarize } from '../simulation/metrics/summary.ts';
import { Timeline } from '../persistence/timeline.ts';
import { serializeState } from '../persistence/codec.ts';
import {validateIntervention} from '../simulation/core/schema.ts';
import type { Lineage, Traits } from '../simulation/core/contracts.ts';
import { loadReactionNetwork, type ReactionNetwork, type Species } from '../simulation/chemistry/network.ts';
import { loadChemistryBySource, type ChemistrySource } from '../simulation/chemistry/loaders.ts';
import { makeReactorState, stepReactor, type ReactorState } from '../simulation/chemistry/reactor.ts';
import { makeColonialRegistry, maintainColonialOrganisms, tryAdhere, tryFission, tryFormColony, type ColonialMember, type ColonialOrganism, type ColonialRegistry } from '../simulation/colonial/agent.ts';
import { makeCognitiveRegistry, makeCognitiveAgent, type CognitiveAgent, type CognitiveRegistry } from '../simulation/cognition/agent.ts';
import { qLearningPolicy, randomPolicy, stepCognitiveRegistry, type Policy } from '../simulation/cognition/policy.ts';
import { makeSettlementRegistry, type SettlementConfig, type SettlementRegistry, type SettlementTemplate } from '../simulation/settlement/types.ts';
import { seedSettlements, stepSettlements } from '../simulation/settlement/simulate.ts';
import { createGrid, fallbackCellCenters } from '../simulation/environment/grid.ts';
import { loadEarthData, type CalibrationConfig, type CalibrationReport, type EarthDataSeries } from '../simulation/earth/types.ts';
import { compareToEarth, type ModelSample } from '../simulation/earth/compare.ts';
import { syntheticHoloceneSeries } from '../simulation/earth/sample.ts';
import { runBatch } from '../simulation/batch/run.ts';
import type { BatchConfig, BatchReport } from '../simulation/batch/types.ts';
import { compareBatchToEarth, type BatchCalibrationReport } from '../simulation/batch/compare.ts';
import { generateWorld } from '../simulation/visual/router.ts';
import { makeV14Snapshot, summariseV14Snapshot, validateV14BatchScanSpec, validateV14Spec, type V14Backend, type V14BatchReport, type V14BatchScanSpec, type V14Snapshot, type V14SnapshotSummary, type V14WorldResult, type V14WorldSpec } from '../simulation/visual/types.ts';

export interface Projection {
  branchId: string; worldId: string; tick: number; running: boolean;
  cohortLimit:number;astronomyStep:number;astronomyRevision:string;
  historyStorage: ReturnType<Timeline['storageStats']>;
  summary: ReturnType<typeof summarize>;
  temperature: Float64Array; nutrient: Float64Array; biomass: Float64Array; land: Float64Array;
  dominant: Int32Array; lastEvent: string; branches: ReturnType<ExperimentBook['list']>; headTick: number; forkTick:number; samples: ReturnType<typeof summarize>[];
  /**
   * P3.2 — list of lineage ids in the order the controller
   * uses to index `cohorts.lineageIndices` / `Projection.dominant`.
   * The biomass surface layer hashes each id to a stable colour
   * so the same lineage always paints the same hue, no matter
   * how many cohorts it splits into. Empty when no lineages
   * exist yet (i.e. world just created).
   */
  lineageIds: string[];
  /**
   * P12 chemistry snapshot. Null when no reaction network has been
   * loaded; otherwise a flat view of the current state (used by the
   * prebiotic UI to render without re-asking the controller).
   */
  chemistry: { step: number; status: 'active' | 'extinct' | 'failed' | 'starved'; totalConsumedJ: number; totalShortfallJ: number; concentrations: Record<string, number>; networkSource: 'raw' | 'gard' | 'markov' } | null;
  /**
   * P13 colonial snapshot. Null when no colonial registry has been
   * loaded; otherwise a flat summary.
   */
  colonies: { total: number; totalMaintenanceJ: number; totalFissions: number } | null;
  /**
   * P14 cognitive-agent snapshot. Null when no registry has been
   * loaded; otherwise a flat summary (agent count, episode,
   * cumulative reward, cumulative cognition energy cost, the
   * current task, and a per-lineage breakdown for the multi-agent
   * dashboard).
   */
  cognition: { agents: number; episode: number; totalReward: number; totalCognitionJ: number; taskKind: 'foraging' | 'thermoregulation' | 'aggregation'; byLineage: { lineageId: string; agents: number; avgReward: number; totalQEntries: number }[] } | null;
  /**
   * P15 settlement snapshot. Null when no registry has been
   * loaded; otherwise a flat summary (settlement count,
   * cumulative production / consumption, dissolution count, and
   * a per-settlement dashboard).
   */
  settlement: { settlements: number; step: number; totalProducedFood: number; totalConsumedFood: number; totalDissolutions: number; totalExchangeFood: number; exchanges: number; totalCoalitionFood: number; coalitions: number; totalCasualtyEvents: number; totalPopulationLost: number; totalFoodDestroyed: number; conflicts: number; totalInstitutionTransitions: number; bySettlement: { id: string; label: string; population: number; food: number; knowledgeLevel: number; cellIndex: number; dissolved: boolean; lifetimeSteps: number; institutionKind: 'public' | 'private' | 'mixed'; techCount: number; totalReceivedFood: number; totalSentFood: number }[] } | null;
  /**
   * P16 Earth-data snapshot. Null when no series has been
   * loaded; otherwise a flat summary (citation, point count,
   * optional calibration report).
   */
  earthData: { citation: string; points: number; startTickDays: number; endTickDays: number; gapFillCount: number; calibration: CalibrationReport | null } | null;
  /**
   * P17 batch report list. Empty when no batches have been run
   * yet; otherwise the most recent report(s). The UI shows the
   * last one in detail and the list head in a dropdown.
   * `lastCalibration` is the most recent `batchCompareToEarth`
   * result (null until the user runs a comparison).
   */
  batches: BatchReport[];
  lastCalibration: BatchCalibrationReport | null;
  /**
   * V14 visual route state. `snapshots` is the list of all
   * persistent snapshots on the book; `activeId` is the one the UI
   * currently renders. `byBranch` is a precomputed histogram so
   * the UI can render a "snapshots per branch" badge without
   * re-traversing the list on every projection. The full mesh
   * for a given id lives on `book.v14Snapshots[i]`; the
   * projection only carries the lightweight metadata (vertex
   * count, spec, etc.) so the postMessage channel stays small.
   */
  v14: {
    snapshots: V14SnapshotSummary[];
    activeId: string | null;
    byBranch: Record<string, number>;
  };
}

/**
 * Payload returned by `inspect`. The `cohorts[i].traits` field is `undefined`
 * when the cohort's trait id no longer exists in the world's trait table
 * (a corruption guard); callers must narrow before use.
 */
export interface InspectionPayload {
  cell: number;
  area: number;
  temperature: number;
  nutrient: number;
  detritus: number;
  cohorts: ReadonlyArray<{
    id: string;
    count: number;
    lineage: Lineage;
    reserve: number;
    traits: Traits | undefined;
  }>;
}

export interface ExportPayload {
  content: string;
  astronomyRevision: string;
  astronomyStep: number;
  worldId: string;
  branchId: string;
  tick: number;
}

export type ComparisonPayload = Awaited<ReturnType<ExperimentBook['compare']>>;
export type ProgressPayload = { operation: 'compare' | 'seek'; tick: number; target: number };

/**
 * String literal union of every request type the controller accepts. Payload
 * shape is left as `Record<string, unknown>` (validated at the controller
 * boundary) so we do not duplicate contract definitions.
 */
export type RequestType =
  | 'pause' | 'create' | 'run' | 'step' | 'fork' | 'refine' | 'expandCapacity'
  | 'switch' | 'intervene' | 'compare' | 'seek' | 'export' | 'import'
  | 'inspect' | 'galaxies' | 'galaxiesAdvance' | 'galaxiesGravity'
  | 'snapshot' | 'internalTick'
  | 'chemistryLoad' | 'chemistryStep' | 'coloniesLoad' | 'coloniesMaintain'
  | 'cognitionLoad' | 'cognitionStep'
  | 'settlementLoad' | 'settlementStep'
  | 'earthDataLoad' | 'earthDataCompare'
  | 'batchRun' | 'batchCompareToEarth'
  | 'v14Generate' | 'v14Select' | 'v14Delete' | 'v14Rename' | 'v14BatchScan' | 'v14Get'
  | 'getCellCenters';

export interface Request {
  id: number;
  type: RequestType;
  payload?: Record<string, unknown>;
}

/**
 * Discriminated union of every reply the controller emits. `id=0` is reserved
 * for unsolicited push messages (projection, progress). Replies that answer a
 * specific request carry the request's `id`.
 */
export type Reply =
  | { id: number; type: 'projection'; payload: Projection }
  | { id: number; type: 'progress'; payload: ProgressPayload }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'ack' }
  | { id: number; type: 'comparison'; payload: ComparisonPayload }
  | { id: number; type: 'inspection'; payload: InspectionPayload }
  | { id: number; type: 'galaxies'; payload: ReturnType<typeof galaxySummary> & { cancelled: boolean } }
  | { id: number; type: 'snapshot'; payload: string }
  | { id: number; type: 'export'; payload: ExportPayload }
  | { id: number; type: 'chemistry'; payload: { status: import('../simulation/chemistry/reactor.ts').ReactorStatus; step: number; energyConsumedJ: number; energyShortfallJ: number; totalConsumedJ: number; concentrations: Record<string, number> } }
  | { id: number; type: 'colonies'; payload: { total: number; dissolved: string[]; fissioned: number; totalMaintenanceJ: number; colonisedCohorts?: number } }
  | { id: number; type: 'cognition'; payload: { agents: number; totalReward: number; totalCognitionJ: number; spentThisStep: number; episode: number; taskKind: 'foraging' | 'thermoregulation' | 'aggregation' } }
  | { id: number; type: 'settlement'; payload: { settlements: number; totalProduced: number; totalConsumed: number; totalDissolutions: number; step: number; spentThisStep: number } }
  | { id: number; type: 'earthData'; payload: { citation: string; points: number; gapFillCount: number; calibration: CalibrationReport | null } }
  | { id: number; type: 'batch'; payload: { report: BatchReport } }
  | { id: number; type: 'batchCalibration'; payload: { report: BatchCalibrationReport } }
  | { id: number; type: 'v14'; payload: { snapshot: V14Snapshot; activeId: string | null } }
  | { id: number; type: 'v14Get'; payload: { snapshot: V14Snapshot | null } }
  | { id: number; type: 'v14List'; payload: { snapshots: V14SnapshotSummary[]; activeId: string | null } }
  | { id: number; type: 'v14Batch'; payload: { report: V14BatchReport; snapshots: V14SnapshotSummary[]; activeId: string | null } }
  | { id: number; type: 'getCellCenters'; payload: { centers: number[]; cellCount: number } };

/**
 * Per-request context handed to handlers. Immutable snapshot of controller
 * state plus three mutator methods (`pause`, `publish`, `emit`) that
 * delegate back to the controller. Handlers must go through this context
 * rather than touching private fields directly.
 */
export interface HandlerContext {
  readonly book: ExperimentBook | null;
  readonly history: Timeline | null;
  readonly state: WorldState | null;
  readonly generation: number;
  pause(): void;
  publish(): void;
  emit(reply: Reply): void;
}

/**
 * Internal handler context. Adds the mutators handlers need to write back
 * controller state (`#book`, `#target`, `#running`, `#event`, schedule
 * continuation). Kept separate from the public `HandlerContext` so the
 * exported API only exposes the read-only view.
 *
 * Re-exported under the `__` prefix so handler-level unit tests can build
 * a mock context. Not part of the supported public API.
 */
export interface __InternalHandlerContext extends HandlerContext {
  setBook(book: ExperimentBook): void;
  setTarget(n: number): void;
  setRunning(b: boolean): void;
  setEvent(s: string): void;
  isRunning(): boolean;
  getTarget(): number;
  sinceEmit(): number;
  schedule(g: number): void;
  /**
   * P11 cross-scale coupling: inject energy (J) into the active world's
   * `ledger.externalEnergyInJ`. The next `stepWorld` distributes this
   * into per-cell environmental energy. Used by the galaxies handler to
   * route core-collapse SN energy from the cosmic timeline down to
   * the planetary heat budget.
   */
  addExternalEnergy(joules: number): void;
  /**
   * P10-C: galactic metal yield → planetary `externalMatterInMu`.
   * Used by `handleInternalTick` to route freshly-synthesised
   * heavy elements from the cosmic timeline into the active
   * planetary mass budget. Independent from the energy budget so
   * supernova energy and supernova metals don't have to share a
   * single cap.
   */
  addExternalMatter(mu: number): void;
  /**
   * Debit the active world's external energy pool (used by P12
   * chemistry to charge endothermic reactions). Caller is responsible
   * for the magnitude; the mutator clamps to zero on the floor.
   */
  consumeExternalEnergy(joules: number): void;
  /**
   * Test-only: set the active world's `externalEnergyInJ` directly.
   * Production code routes energy through interventions, the galaxies
   * handler, or the chemistry handler — they all go through
   * `addExternalEnergy` / `consumeExternalEnergy`. This direct setter
   * exists so unit tests can seed the ledger without rebuilding the
   * intervention/galaxies pipeline.
   */
  setLedgerEnergy(joules: number): void;
  // P11 cross-scale coupling: the internal tick uses these to decide
  // when to step the cosmic clock and how much supernova energy to
  // attenuate. See `P11_COSMIC_STEP_EVERY` for the defaults.
  readonly cosmicStepEvery: number;
  readonly planetFraction: number;
  readonly maxEnergyPerTickJ: number;
  readonly lastCosmicTick: number;
  markCosmicTick(tick: number): void;
  // P10-C: galactic metal yield → planetary matter budget. 1 M☉ of
  // metals = `solarToMu` MU of planetary nutrient (teaching ratio).
  readonly solarToMu: number;
  /**
   * P12 chemistry subsystem: load a reaction network + initial state
   * on the experiment book. Subsequent `chemistryStep` calls advance
   * the reactor.
   */
  setChemistry(chemistry: { network: import('../simulation/chemistry/network.ts').ReactionNetwork; state: import('../simulation/chemistry/reactor.ts').ReactorState } | null): void;
  /**
   * P13 colonial subsystem: replace the colonial registry on the
   * experiment book. `null` clears it.
   */
  setColonies(colonies: import('../simulation/colonial/agent.ts').ColonialRegistry | null): void;
  /**
   * P14 cognitive subsystem: replace the cognitive-agent registry
   * on the experiment book. `null` clears it.
   */
  setCognition(cognition: import('../simulation/cognition/agent.ts').CognitiveRegistry | null): void;
  /**
   * P15 settlement subsystem: replace the settlement registry on
   * the experiment book. `null` clears it.
   */
  setSettlement(settlement: import('../simulation/settlement/types.ts').SettlementRegistry | null): void;
  /**
   * P16 Earth-data subsystem: replace the Earth reference series
   * on the experiment book. `null` clears it.
   */
  setEarthData(earthData: import('../simulation/earth/types.ts').EarthDataSeries | null): void;
  /**
   * P16 calibration subsystem: stash the latest calibration
   * report on the controller so the next projection publishes it.
   */
  setEarthCalibration(calibration: import('../simulation/earth/types.ts').CalibrationReport | null): void;
  /**
   * P17 batch subsystem: append a completed batch report to the
   * book. The controller owns the canonical list so the projection
   * stays in sync.
   */
  pushBatch(report: import('../simulation/batch/types.ts').BatchReport): void;
  /**
   * P17-2 batch calibration: stash the latest per-seed
   * calibration report on the controller so the next projection
   * publishes it. The book doesn't persist this — it's an
   * ephemeral evaluation result.
   */
  setBatchCalibration(report: import('../simulation/batch/compare.ts').BatchCalibrationReport | null): void;
  /**
   * V14 visual route: push a freshly generated snapshot onto the
   * book, set it as the active one, and publish a projection-ready
   * summary on the controller. The book is the durable store (it
   * round-trips through export/import); the controller's summary
   * is a denormalised copy so the UI's normal projection channel
   * learns about the snapshot list without re-querying the book.
   */
  setV14Snapshot(snap: V14Snapshot, makeActive: boolean): void;
  /**
   * V14 visual route: switch the active snapshot. The id must
   * already exist on the book. Used by `v14Select` handler.
   */
  setV14Active(id: string): void;
  /**
   * V14 visual route: remove a snapshot from the book. The active
   * pointer is updated to point at the most recent remaining
   * snapshot (or null if the list becomes empty).
   */
  removeV14Snapshot(id: string): void;
  /**
   * V14 visual route: rename a snapshot in place. Used by the
   * `v14Rename` handler so the user can give a snapshot a
   * meaningful label.
   */
  renameV14Snapshot(id: string, label: string): void;
  /**
   * V14 visual route: append a batch of generated snapshots
   * (no active pointer change). Used by the `v14BatchScan`
   * handler to land all parameter-sweep results in one go.
   */
  pushV14Batch(snaps: V14Snapshot[]): void;
}

/**
 * One handler per `RequestType`. The handler reads the request payload,
 * mutates the world via `ctx`, and is responsible for emitting its own
 * reply (`ack` if the operation is fire-and-forget, a typed reply if it
 * returns data). Throwing is allowed and is converted into a `reply.error`
 * by the dispatcher.
 */
export type Handler = (payload: Record<string, unknown>, ctx: __InternalHandlerContext, requestId: number) => Promise<void>;

// === Handler implementations ==========================================

const handlePause: Handler = async (_p, ctx, id) => {
  ctx.pause();
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleCreate: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (p.cells !== undefined && ![320, 1280, 5120, 20480].includes(p.cells as number)) {
    throw new Error('无效观察精度');
  }
  const scenario = getScenario(
    typeof p.scenario === 'string' ? p.scenario : 'two-lineages',
    (p.cells ?? 320) as 320 | 1280 | 5120 | 20480,
  );
  if (typeof p.seed === 'string') scenario.seed = p.seed;
  if (typeof p.temperature === 'number') scenario.planet.initialTemperatureK = p.temperature;
  // `create` owns world creation: stash the new book on the controller via
  // a synthetic `book` setter exposed through the dispatcher.
  ctx.setBook(
    await ExperimentBook.create(await initializeWorld(scenario)),
  );
  // Push the first projection so the UI can render the freshly
  // created world (population / temperature / layer toggles) before
  // any user interaction. Without this, the page sits on the "—"
  // placeholders until the user clicks "step" or "play".
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleRun: Handler = async (p, ctx, id) => {
  if (!ctx.state) throw new Error('请先创建世界');
  ctx.pause();
  const ticks = p.ticks ?? 100;
  if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 1 || ticks > 100000) {
    throw new Error('推进天数应为 1—100000 的整数');
  }
  const target = ctx.state.tick + ticks;
  if (!Number.isSafeInteger(target)) throw new Error('时间超出范围');
  ctx.setTarget(target);
  ctx.setRunning(true);
  ctx.publish();
  // Kick off the internalTick chain. internalTick is otherwise
  // self-perpetuating (it schedules the next one only if running),
  // so without this first call `run` would set the target but never
  // advance the world.
  ctx.schedule(ctx.generation);
  ctx.emit({ id, type: 'ack' });
};

const handleStep: Handler = async (_p, ctx, id) => {
  ctx.pause();
  if (!ctx.history) throw new Error('请先创建世界');
  const result = await ctx.history.advance();
  ctx.setEvent(
    `第 ${ctx.state!.tick} 日 · 诞生 ${result.life.births} · 死亡 ${result.life.deaths} · 突变 ${result.life.mutations}`,
  );
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleFork: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.id !== 'string' || typeof p.label !== 'string') throw new Error('无效分支');
  await ctx.book.fork(p.id, p.label);
  ctx.setEvent('从同一时刻复制世界 · 原历史保留');
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleRefine: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.id !== 'string') throw new Error('无效细分请求');
  await ctx.book.refine(p.id);
  ctx.setEvent('区域已细分 · 当前时间与生命保留，原历史可从父分支查看');
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleExpandCapacity: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.id !== 'string') throw new Error('无效扩容请求');
  await ctx.book.expandCapacity(p.id);
  ctx.setEvent('计算容量已扩充 · 原历史保留，可点击开始演化继续');
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleSwitch: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.id !== 'string') throw new Error('无效分支');
  ctx.book.switch(p.id);
  ctx.setEvent('已切换时间线');
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleIntervene: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.id !== 'string' || typeof p.label !== 'string') throw new Error('无效干预');
  const state = ctx.state!;
  validateIntervention(p.command, {
    cellCount: state.cells.areaM2.length,
    branchId: state.branch.id,
    tick: state.tick,
    traitIds: state.traits.map(t => t.id),
    cohorts: Object.fromEntries(state.cohorts.ids.map((id, i) => [id, state.cohorts.counts[i]!])),
  });
  await ctx.book.forkAndIntervene(p.id, p.label, p.command as Parameters<typeof ctx.book.forkAndIntervene>[2]);
  ctx.setEvent('干预已应用到新分支 · 原时间线未改变');
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleCompare: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.book || typeof p.a !== 'string' || typeof p.b !== 'string' || typeof p.ticks !== 'number') {
    throw new Error('无效对照');
  }
  const generation = ctx.generation;
  const result = await ctx.book.compare(
    p.a, p.b, p.ticks,
    (tick, target) => ctx.emit({ id: 0, type: 'progress', payload: { operation: 'compare', tick, target } }),
    () => generation !== ctx.generation,
  );
  ctx.setEvent(`对照完成 · 两条时间线均到第 ${result.tick} 日`);
  ctx.publish();
  ctx.emit({ id, type: 'comparison', payload: result });
};

const handleSeek: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (!ctx.history) throw new Error('请先创建世界');
  if (typeof p.tick !== 'number') throw new Error('无效时间');
  const generation = ctx.generation;
  await ctx.history.seek(p.tick, {
    cancelled: () => generation !== ctx.generation,
    progress: (tick, target) => ctx.emit({ id: 0, type: 'progress', payload: { operation: 'seek', tick, target } }),
  });
  ctx.setEvent(`已恢复至第 ${p.tick} 日 · 从检查点重放`);
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleExport: Handler = async (_p, ctx, id) => {
  if (!ctx.history) throw new Error('请先创建世界');
  ctx.publish();
  ctx.emit({
    id, type: 'export', payload: {
      content: await ctx.book!.export(),
      astronomyRevision: ctx.book!.astronomy ? `${ctx.book!.astronomy.version}:${ctx.book!.astronomy.step}` : 'none',
      astronomyStep: ctx.book!.astronomy?.step ?? -1,
      worldId: ctx.state!.manifest.id,
      branchId: ctx.state!.branch.id,
      tick: ctx.state!.tick,
    },
  });
};

const handleImport: Handler = async (p, ctx, id) => {
  ctx.pause();
  if (typeof p.content !== 'string') throw new Error('无效存档');
  const restored = await ExperimentBook.import(p.content);
  ctx.setBook(restored);
  ctx.setEvent(`已恢复存档 · 第 ${restored.active.state.tick} 日`);
  ctx.publish();
  ctx.emit({ id, type: 'ack' });
};

const handleInspect: Handler = async (p, ctx, id) => {
  const s = ctx.state;
  const cell = p.cell;
  if (!s || typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= s.cells.areaM2.length) {
    throw new Error('无效地表单元');
  }
  // `?? 0` is a display-time guard: `validateState` keeps the four TypedArrays
  // in lockstep, so a `undefined` here means an invariant broke elsewhere
  // and the UI is the last line of defense. Throwing would lose the rest of
  // the inspection payload.
  const cohorts = s.cohorts.ids.flatMap((cid, i) => s.cohorts.cellIndices[i] === cell ? [{
    id: cid,
    count: s.cohorts.counts[i] ?? 0,
    lineage: s.lineages[s.cohorts.lineageIndices[i]!]!,
    reserve: s.cohorts.energyReserveJ[i] ?? 0,
    traits: s.traits.find(t => t.id === s.lineages[s.cohorts.lineageIndices[i]!]!.traitId),
  }] : []);
  ctx.emit({
    id, type: 'inspection', payload: {
      cell,
      area: s.cells.areaM2[cell] ?? 0,
      temperature: s.cells.temperatureK[cell] ?? 0,
      nutrient: s.cells.nutrientMu[cell] ?? 0,
      detritus: s.cells.detritusMu[cell] ?? 0,
      cohorts,
    },
  });
};

const handleGalaxies = async (kind: 'init' | 'advance' | 'gravity', p: Record<string, unknown>, ctx: __InternalHandlerContext, id: number) => {
  ctx.pause();
  if (!ctx.book || !ctx.state) throw new Error('请先创建世界');
  ctx.book.astronomy ??= await createGalaxies(ctx.state.manifest.seed);
  let cancelled = false;
  if (kind === 'gravity') ctx.book.astronomy = enableGalaxyGravity(ctx.book.astronomy);
  if (kind === 'advance') {
    const steps = p.steps ?? 1;
    if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 1 || steps > 100) {
      throw new Error('星系推进步数须为 1—100');
    }
    const generation = ctx.generation;
    for (let i = 0; i < steps; i++) {
      if (generation !== ctx.generation) { cancelled = true; break; }
      ctx.book.astronomy = stepGalaxies(ctx.book.astronomy);
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }
  // P11 cross-scale coupling: route the cosmic supernova energy emitted
  // this step into the active planetary energy ledger so the next
  // `stepWorld` distributes it across cells. This is the "stellar
  // events → planetary energy budget" wire per docs/15.
  const sn = ctx.book.astronomy.lastSupernovaEnergyJ;
  if (sn > 0) ctx.addExternalEnergy(sn);
  ctx.publish();
  ctx.emit({ id, type: 'galaxies', payload: { ...galaxySummary(ctx.book.astronomy), cancelled } });
};

const handleGalaxiesInit: Handler = (p, ctx, id) => handleGalaxies('init', p, ctx, id);
const handleGalaxiesAdvance: Handler = (p, ctx, id) => handleGalaxies('advance', p, ctx, id);
const handleGalaxiesGravity: Handler = (p, ctx, id) => handleGalaxies('gravity', p, ctx, id);

const handleSnapshot: Handler = async (_p, ctx, id) => {
  ctx.pause();
  if (!ctx.state) throw new Error('请先创建世界');
  ctx.publish();
  ctx.emit({ id, type: 'snapshot', payload: await serializeState(ctx.state) });
};

/**
 * P3 — return the unit-sphere 3D position of every cell in the
 * current world. The result is stable for a given cellCount, so
 * the UI caches it after the first call. The payload is a flat
 * `number[]` of length `cellCount * 3` (x0, y0, z0, x1, y1, z1, …)
 * to keep the worker → main postMessage payload compact and
 * structured-clone-friendly.
 */
const handleGetCellCenters: Handler = async (_p, ctx, id) => {
  if (!ctx.state) throw new Error('请先创建世界');
  // createGrid is deterministic, so the same cellCount always
  // produces the same centres. We rebuild on every call (this
  // is a one-shot RPC the UI fires when the surface view is
  // first constructed) and don't cache here.
  const n = ctx.state.cells.areaM2.length;
  // P3.6 — `createGrid` only accepts the standard icosphere
  // subdivisions (320 / 1280 / 5120 / 20480). A save from an
  // older code path, or a future scenario, can have a state
  // whose cell count is e.g. 16280. The handler must not throw
  // in that case — `loadCellCenters` would swallow the error,
  // leave the cellMap empty, and the surface view would render
  // every vertex with cell 0's landFraction (the "all green"
  // bug). Fall back to a Fibonacci-spiral sampling so the
  // surface has at least *some* cell-to-position mapping.
  let centers: import('../simulation/environment/grid.ts').Vector3[];
  try {
    centers = createGrid(n, 1).centers;
  } catch {
    centers = fallbackCellCenters(n);
  }
  const flat: number[] = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = centers[i]!;
    flat[i * 3 + 0] = c[0];
    flat[i * 3 + 1] = c[1];
    flat[i * 3 + 2] = c[2];
  }
  ctx.emit({ id, type: 'getCellCenters', payload: { centers: flat, cellCount: n } });
};

// === P12 chemistry ======================================================

/**
 * Load a reaction network + initial concentrations and bind it to the
 * experiment book. Subsequent `chemistryStep` calls advance the
 * reactor and bill the active world's `externalEnergyInJ` for any
 * endothermic reactions that fire.
 */
const handleChemistryLoad: Handler = async (p, ctx, id) => {
  if (!ctx.state) throw new Error('请先创建世界');
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  // P10-2: support synthetic GARD / Markov networks via the
  // `source` field. Default is `'raw'` (the original hand-written
  // network contract). `'gard'` and `'markov'` ship in-repo
  // placeholder networks; their `source` field on the network
  // self-identifies so the UI can render an honest banner.
  const source = (p.source ?? 'raw') as ChemistrySource;
  if (source !== 'raw' && source !== 'gard' && source !== 'markov') {
    throw new Error(`未知 chemistry source: ${source}（仅支持 raw / gard / markov）`);
  }
  const network = loadChemistryBySource(source, p.network);
  const initial: Map<Species, number> = new Map();
  const initRaw = (p.initial as Record<string, number> | undefined) ?? {};
  for (const s of network.species) {
    const v = initRaw[s as string];
    initial.set(s, typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
  }
  const energyInJ = typeof p.energyInJ === 'number' ? Math.max(0, p.energyInJ) : 0;
  const state = makeReactorState(network, initial, energyInJ);
  ctx.setChemistry({ network, state });
  ctx.emit({ id, type: 'ack' });
};

/**
 * Advance the chemistry reactor by one step. Endothermic reactions
 * charge the world's `externalEnergyInJ`; any energy actually used is
 * debited via `consumeExternalEnergy`. After the step we replace the
 * stored state with the new one and emit a chemistry reply carrying
 * the new status + a flat concentrations snapshot.
 *
 * Pass `silent: true` in the payload to skip emitting the reply —
 * `internalTick` uses this for auto-step mode so the event log is not
 * flooded with chemistry events on every tick.
 */
const handleChemistryStep: Handler = async (p, ctx, id) => {
  if (!ctx.state) throw new Error('请先创建世界');
  const chem = ctx.book?.chemistry ?? null;
  if (!chem) throw new Error('化学反应网络尚未加载，请先调用 chemistryLoad');
  // Cap the available energy at what the world can actually pay.
  const available = ctx.state.ledger.externalEnergyInJ;
  // We snapshot the reactor's energy budget and then add the ledger
  // pool on top of it, so the reactor can fire energy-driven reactions
  // up to the world's available energy. After the step we debit the
  // actual energy consumed.
  const liveState: ReactorState = {
    ...chem.state,
    energyAvailableJ: chem.state.energyAvailableJ + available,
  };
  const { state: nextReactor, events } = stepReactor(liveState, chem.network);
  // The reactor may have consumed more than the ledger held; the
  // actual spend is `events.energyConsumedJ - chem.state.energyAvailableJ`
  // (i.e. the share drawn from the world's pool). We debit at most
  // `available` so the ledger never goes negative.
  const fromLedger = Math.max(0, events.energyConsumedJ - chem.state.energyAvailableJ);
  ctx.consumeExternalEnergy(fromLedger);
  // Persist the new reactor state with the residual energy (the
  // reactor kept whatever it didn't use, minus shortfall).
  const newState: ReactorState = {
    ...nextReactor,
    energyAvailableJ: chem.state.energyAvailableJ + available - events.energyConsumedJ,
  };
  ctx.setChemistry({ network: chem.network, state: newState });
  if (p.silent === true) return; // auto-step: don't emit, don't ack
  const concentrations: Record<string, number> = {};
  for (const s of chem.network.species) concentrations[s as string] = newState.concentrations.get(s) ?? 0;
  ctx.emit({
    id, type: 'chemistry',
    payload: {
      status: newState.status,
      step: newState.step,
      energyConsumedJ: events.energyConsumedJ,
      energyShortfallJ: events.energyShortfallJ,
      totalConsumedJ: newState.energyConsumedJ,
      concentrations,
    },
  });
};

// === P13 colonies =======================================================

/**
 * Seed the colonial registry by scanning the active world. For every
 * cohort on the world we attempt to either form a new organism or
 * adhere to an existing one in the same cell, sharing the cohort's
 * trait id. The `payload` accepts a partial `ColonialConfig` to
 * override the defaults; missing fields fall back to the package
 * defaults. The returned `colonies` reply lists how many organisms
 * were created and how many cohorts ended up in a colony.
 *
 * This is the "two units of selection" entry point: from here on the
 * colony and the cohorts are independently tracked.
 */
const handleColoniesLoad: Handler = async (p, ctx, id) => {
  const state = ctx.state;
  if (!state) throw new Error('请先创建世界');
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  const overrides = (p.config ?? {}) as Partial<{
    minMembers: number; fissionMembers: number; fissionCooldown: number;
    maintenanceJPerMember: number; admissibleTraitIds: string[];
  }>;
  const config = {
    minMembers: typeof overrides.minMembers === 'number' ? overrides.minMembers : 2,
    fissionMembers: typeof overrides.fissionMembers === 'number' ? overrides.fissionMembers : 8,
    fissionCooldown: typeof overrides.fissionCooldown === 'number' ? overrides.fissionCooldown : 50,
    maintenanceJPerMember: typeof overrides.maintenanceJPerMember === 'number' ? overrides.maintenanceJPerMember : 1,
    admissibleTraitIds: Array.isArray(overrides.admissibleTraitIds) ? overrides.admissibleTraitIds.filter((s): s is string => typeof s === 'string') : [],
  };
  const registry: ColonialRegistry = makeColonialRegistry();
  // First pass: every cohort becomes a candidate. For each, try to
  // adhere to an existing organism in the same cell with the same
  // trait; if that fails, form a new organism.
  let colonisedCohorts = 0;
  for (let i = 0; i < state.cohorts.ids.length; i++) {
    const cell = state.cohorts.cellIndices[i]!;
    const cohortId = state.cohorts.ids[i]!;
    const lineageIdx = state.cohorts.lineageIndices[i]!;
    const lineage = state.lineages[lineageIdx];
    if (!lineage) continue;
    const candidate: ColonialMember = { cellIndex: cell, cohortId, traitId: lineage.traitId };
    // Try to join an existing organism in the same cell with the same trait.
    const same = registry.organisms.find(o => o.members.some(m => m.cellIndex === cell) && o.members.every(m => m.traitId === lineage.traitId));
    if (same && tryAdhere(same, candidate, state, config)) {
      colonisedCohorts++;
    } else {
      if (tryFormColony(candidate, state, registry, config, state.tick)) {
        colonisedCohorts++;
      }
    }
  }
  ctx.setColonies(registry);
  ctx.emit({
    id, type: 'colonies',
    payload: {
      total: registry.organisms.length,
      dissolved: [],
      fissioned: 0,
      totalMaintenanceJ: registry.totalMaintenanceJ,
      colonisedCohorts,
    },
  });
};

/**
 * Charge maintenance against `externalEnergyInJ` for every colonial
 * organism on the experiment book. Organisms that cannot pay are
 * dissolved; their member cohorts remain on the active world. After
 * the maintenance pass, any colony that has reached the fission size
 * threshold (and the cooldown has elapsed) is split.
 *
 * Pass `silent: true` in the payload to skip emitting the reply —
 * `internalTick` uses this for auto-step mode so the event log is not
 * flooded with colonies events on every tick.
 */
const handleColoniesMaintain: Handler = async (p, ctx, id) => {
  if (!ctx.state) throw new Error('请先创建世界');
  let registry: ColonialRegistry = ctx.book?.colonies ?? makeColonialRegistry();
  if (!ctx.book?.colonies) ctx.setColonies(registry);
  const energyIn = ctx.state.ledger.externalEnergyInJ;
  const result = maintainColonialOrganisms(registry, ctx.state, energyIn);
  ctx.consumeExternalEnergy(result.spent);
  // Try to fission each survivor.
  let fissioned = 0;
  for (const org of [...registry.organisms]) {
    if (tryFission(org, registry, ctx.state.tick)) fissioned++;
  }
  // Persist any updates (fissions + the registry list was mutated in place).
  ctx.setColonies(registry);
  if (p.silent === true) return; // auto-step: don't emit, don't ack
  ctx.emit({
    id, type: 'colonies',
    payload: {
      total: registry.organisms.length,
      dissolved: result.dissolved,
      fissioned,
      totalMaintenanceJ: registry.totalMaintenanceJ,
    },
  });
};

// === P14 cognition =====================================================

/**
 * Seed the cognitive registry by attaching an agent to every cohort
 * on the active world. The `policy` field in the payload chooses the
 * reference learner: 'q-learning' (default) or 'random' (baseline).
 * Each agent's `cellIndex` and `lineageId` are taken from the
 * cohort; `count` defaults to the cohort's individual count.
 */
const handleCognitionLoad: Handler = async (p, ctx, id) => {
  const state = ctx.state;
  if (!state) throw new Error('请先创建世界');
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  const policyName = typeof p.policy === 'string' ? p.policy : 'q-learning';
  if (policyName !== 'q-learning' && policyName !== 'random') {
    throw new Error(`未知策略: ${policyName}（仅支持 q-learning / random）`);
  }
  const taskKind = typeof p.task === 'string' ? p.task : 'foraging';
  if (taskKind !== 'foraging' && taskKind !== 'thermoregulation' && taskKind !== 'aggregation') {
    throw new Error(`未知任务: ${taskKind}（仅支持 foraging / thermoregulation / aggregation）`);
  }
  const epsilon0 = typeof p.epsilon0 === 'number' ? Math.max(0, Math.min(1, p.epsilon0)) : 0.2;
  const registry = makeCognitiveRegistry();
  for (let i = 0; i < state.cohorts.ids.length; i++) {
    const cell = state.cohorts.cellIndices[i]!;
    const cohortId = state.cohorts.ids[i]!;
    const lineageIdx = state.cohorts.lineageIndices[i]!;
    const lineage = state.lineages[lineageIdx];
    if (!lineage) continue;
    const agent = makeCognitiveAgent({
      id: `cog-${registry.nextId++}`,
      cellIndex: cell,
      lineageId: lineage.id,
      count: state.cohorts.counts[i] ?? 0,
      epsilon0,
      taskKind,
    });
    registry.agents.push(agent);
  }
  ctx.setCognition(registry);
  ctx.emit({
    id, type: 'cognition',
    payload: {
      agents: registry.agents.length,
      totalReward: 0,
      totalCognitionJ: 0,
      spentThisStep: 0,
      episode: 0,
      taskKind,
    },
  });
};

/**
 * Advance every agent one step. Per docs/15 P14: cognition **costs
 * energy**; we debit `externalEnergyInJ` for the cognition cost
 * (capped at the available pool). The `silent` flag in the payload
 * lets `internalTick` call this without emitting a reply, so the
 * event stream stays clean during planetary auto-step.
 */
const handleCognitionStep: Handler = async (p, ctx, id) => {
  const state = ctx.state;
  if (!state) throw new Error('请先创建世界');
  let registry: CognitiveRegistry = ctx.book?.cognition ?? makeCognitiveRegistry();
  if (!ctx.book?.cognition) ctx.setCognition(registry);
  const policyName = typeof p.policy === 'string' ? p.policy : 'q-learning';
  const policy: Policy = policyName === 'random' ? randomPolicy : qLearningPolicy;
  const result = stepCognitiveRegistry(registry, state, policy);
  ctx.consumeExternalEnergy(result.spent);
  ctx.setCognition(registry);
  if (p.silent === true) return;
  ctx.emit({
    id, type: 'cognition',
    payload: {
      agents: registry.agents.length,
      totalReward: registry.totalReward,
      totalCognitionJ: registry.totalCognitionJ,
      spentThisStep: result.spent,
      episode: registry.episode,
      taskKind: registry.agents[0]?.taskKind ?? 'foraging',
    },
  });
};

// === P15 settlements ==================================================

/**
 * Seed a settlement registry from a list of templates. The payload
 * shape mirrors `SettlementTemplate` with optional `config`
 * overrides applied uniformly. Per docs/15 P15: the civilisation
 * layer is *seeded from a template*, not derived from P12 — this
 * call is the only legal way to introduce settlements.
 */
const handleSettlementLoad: Handler = async (p, ctx, id) => {
  const state = ctx.state;
  if (!state) throw new Error('请先创建世界');
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  const rawTemplates = Array.isArray(p.templates) ? p.templates : [];
  if (rawTemplates.length === 0) throw new Error('settlementLoad 需要至少一个模板');
  if (rawTemplates.length > 64) throw new Error('settlementLoad 模板数 ≤ 64');
  // Validate each template lightly; type errors throw with a clear
  // message.
  const templates: SettlementTemplate[] = rawTemplates.map((t, i) => {
    const o = t as Record<string, unknown>;
    if (typeof o.label !== 'string' || o.label.length === 0) {
      throw new Error(`templates[${i}].label 必须是非空字符串`);
    }
    if (typeof o.cellIndex !== 'number' || !Number.isInteger(o.cellIndex) || o.cellIndex < 0 || o.cellIndex >= state.cells.areaM2.length) {
      throw new Error(`templates[${i}].cellIndex 越界或非整数`);
    }
    // Phase 2: institution.
    let institution: SettlementTemplate['institution'];
    if (o.institution && typeof o.institution === 'object') {
      const inst = o.institution as Record<string, unknown>;
      const kind = inst.kind;
      if (kind !== 'public' && kind !== 'private' && kind !== 'mixed') {
        throw new Error(`templates[${i}].institution.kind 必须是 public / private / mixed`);
      }
      const taxRate = typeof inst.taxRate === 'number' ? Math.max(0, Math.min(1, inst.taxRate)) : 0;
      const publicGoodsShare = typeof inst.publicGoodsShare === 'number' ? Math.max(0, Math.min(1, inst.publicGoodsShare)) : 0;
      institution = { kind, taxRate, publicGoodsShare };
    }
    // Phase 2: technology.
    let technology: SettlementTemplate['technology'];
    if (o.technology && typeof o.technology === 'object') {
      const tech = o.technology as Record<string, unknown>;
      if (Array.isArray(tech.unlocked)) {
        const unlocked = tech.unlocked.filter((s): s is string => typeof s === 'string');
        technology = { unlocked };
      }
    }
    // Phase 2: exchangeTo.
    let exchangeTo: SettlementTemplate['exchangeTo'];
    if (Array.isArray(o.exchangeTo)) {
      exchangeTo = [];
      for (const e of o.exchangeTo) {
        if (!e || typeof e !== 'object') continue;
        const edge = e as Record<string, unknown>;
        if (typeof edge.targetLabel === 'string' && typeof edge.ratePerStep === 'number' && edge.ratePerStep > 0) {
          exchangeTo.push({ targetLabel: edge.targetLabel, ratePerStep: edge.ratePerStep });
        }
      }
    }
    // Phase 3: coalitionTo.
    let coalitionTo: SettlementTemplate['coalitionTo'];
    if (Array.isArray(o.coalitionTo)) {
      coalitionTo = [];
      for (const e of o.coalitionTo) {
        if (!e || typeof e !== 'object') continue;
        const edge = e as Record<string, unknown>;
        if (typeof edge.targetLabel === 'string' && typeof edge.ratePerStep === 'number' && edge.ratePerStep > 0) {
          coalitionTo.push({ targetLabel: edge.targetLabel, ratePerStep: edge.ratePerStep });
        }
      }
    }
    // Phase 3: conflictTo.
    let conflictTo: SettlementTemplate['conflictTo'];
    if (Array.isArray(o.conflictTo)) {
      conflictTo = [];
      for (const e of o.conflictTo) {
        if (!e || typeof e !== 'object') continue;
        const edge = e as Record<string, unknown>;
        if (typeof edge.targetLabel === 'string'
          && typeof edge.probability === 'number' && edge.probability >= 0 && edge.probability <= 1
          && typeof edge.casualtyFraction === 'number' && edge.casualtyFraction >= 0 && edge.casualtyFraction <= 1
          && typeof edge.damageFood === 'number' && edge.damageFood >= 0) {
          conflictTo.push({
            targetLabel: edge.targetLabel,
            probability: edge.probability,
            casualtyFraction: edge.casualtyFraction,
            damageFood: edge.damageFood,
          });
        }
      }
    }
    return {
      label: o.label,
      cellIndex: o.cellIndex,
      ...(typeof o.population === 'number' ? { population: o.population } : {}),
      ...(typeof o.initialFood === 'number' ? { initialFood: o.initialFood } : {}),
      ...(typeof o.initialKnowledgeLevel === 'number' ? { initialKnowledgeLevel: o.initialKnowledgeLevel } : {}),
      ...(institution ? { institution } : {}),
      ...(technology ? { technology } : {}),
      ...(exchangeTo ? { exchangeTo } : {}),
      ...(coalitionTo ? { coalitionTo } : {}),
      ...(conflictTo ? { conflictTo } : {}),
    };
  });
  const registry = makeSettlementRegistry();
  // Pass `config` (whole-registry overrides) through.
  const config = (p.config ?? {}) as Partial<SettlementConfig>;
  const { created } = seedSettlements(registry, templates, state.tick, config);
  ctx.setSettlement(registry);
  // Push a projection so the UI sees the newly-loaded settlement
  // registry immediately. Without this, the world is paused and
  // no further projection would be sent until the next user
  // action (step / run), leaving the per-settlement list empty.
  ctx.publish();
  ctx.emit({
    id, type: 'settlement',
    payload: {
      settlements: created,
      totalProduced: 0,
      totalConsumed: 0,
      totalDissolutions: 0,
      step: 0,
      spentThisStep: 0,
    },
  });
};

/**
 * Advance every settlement one step. The `silent` flag in the
 * payload lets `internalTick` call this without emitting a reply,
 * so the event stream stays clean during planetary auto-step.
 */
const handleSettlementStep: Handler = async (p, ctx, id) => {
  const state = ctx.state;
  if (!state) throw new Error('请先创建世界');
  let registry: SettlementRegistry = ctx.book?.settlement ?? makeSettlementRegistry();
  if (!ctx.book?.settlement) ctx.setSettlement(registry);
  const result = stepSettlements(registry, state);
  ctx.setSettlement(registry);
  if (p.silent === true) return;
  ctx.emit({
    id, type: 'settlement',
    payload: {
      settlements: registry.settlements.length,
      totalProduced: registry.totalProducedFood,
      totalConsumed: registry.totalConsumedFood,
      totalDissolutions: registry.totalDissolutions,
      step: registry.step,
      spentThisStep: result.totalProduced,
    },
  });
};

// === P16 Earth data ====================================================

/**
 * Load an Earth-data reference series. The payload is the
 * raw JSON array (as it would be loaded from a file); the
 * handler validates it via `loadEarthData` and stores the
 * resulting `EarthDataSeries` on the book.
 *
 * If `payload.useSample` is true, the handler substitutes the
 * in-repo synthetic Holocene series. This is the easiest
 * path for the UI ("load the demo data").
 */
const handleEarthDataLoad: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  let series: EarthDataSeries;
  if (p.useSample === true) {
    series = syntheticHoloceneSeries();
  } else if (p.data !== undefined) {
    series = loadEarthData(p.data);
  } else {
    throw new Error('earthDataLoad 需要 data 字段（或 useSample: true）');
  }
  // Clear any prior calibration report when the series changes.
  ctx.setEarthCalibration(null);
  ctx.setEarthData(series);
  ctx.emit({
    id, type: 'earthData',
    payload: {
      citation: series.citation,
      points: series.points.length,
      gapFillCount: series.gapFillCount,
      calibration: null,
    },
  });
};

/**
 * Run a calibration comparison. The payload is
 * `{ model: ModelSample[], config: CalibrationConfig }`; the
 * model trajectory is linearly interpolated at the Earth's
 * tick days. The report is stashed on the controller (so the
 * next projection publishes it) and returned.
 */
const handleEarthDataCompare: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (!ctx.book.earthData) throw new Error('请先调用 earthDataLoad');
  if (!Array.isArray(p.model) || p.model.length === 0) {
    throw new Error('earthDataCompare 需要 model 字段（轨迹采样）');
  }
  const config = (p.config ?? {}) as Partial<CalibrationConfig>;
  const trainFraction = typeof config.trainFraction === 'number' ? config.trainFraction : 0.7;
  if (trainFraction < 0.5 || trainFraction > 0.95) {
    throw new Error('trainFraction 必须在 [0.5, 0.95]');
  }
  const baseline = config.baseline ?? 'constant-mean';
  if (baseline !== 'constant-mean' && baseline !== 'linear-trend' && baseline !== 'persistence') {
    throw new Error(`未知 baseline: ${baseline}`);
  }
  const quantity = config.quantity ?? 'temperatureK';
  const model: ModelSample[] = (p.model as Array<Record<string, unknown>>).map((m, i) => {
    if (typeof m.tickDays !== 'number' || typeof m.value !== 'number') {
      throw new Error(`model[${i}] 必须包含 tickDays / value 数字字段`);
    }
    return { tickDays: m.tickDays, value: m.value };
  });
  const report = compareToEarth(ctx.book.earthData, model, { trainFraction, baseline, quantity });
  ctx.setEarthCalibration(report);
  ctx.emit({
    id, type: 'earthData',
    payload: {
      citation: ctx.book.earthData.citation,
      points: ctx.book.earthData.points.length,
      gapFillCount: ctx.book.earthData.gapFillCount,
      calibration: report,
    },
  });
};

// === P17 batch =========================================================

/**
 * Run a scenario across many seeds and return a `BatchReport`.
 * The runner is synchronous in phase 1: we build a fresh
 * `SimulationController` for each seed, run it for the requested
 * `ticks` planetary days, and record the final population /
 * temperature / lineages. The report is appended to the book so
 * the projection carries it.
 *
 * Reference task: `empty-planet` and `two-lineages` scenarios at
 * resolution 320. Future phases can extend to P12 / P13 / P14 /
 * P15 subsystems.
 */
const handleBatchRun: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  const scenario = (p.scenario ?? {}) as { id?: string; version?: string };
  if (typeof scenario.id !== 'string' || typeof scenario.version !== 'string') {
    throw new Error('batchRun 需要 scenario.id / scenario.version');
  }
  const resolution = (p.resolution ?? 320) as 320 | 1280 | 5120 | 20480;
  if (![320, 1280, 5120, 20480].includes(resolution)) {
    throw new Error('resolution 必须是 320 / 1280 / 5120 / 20480');
  }
  const ticks = typeof p.ticks === 'number' ? p.ticks : 100;
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 100000) {
    throw new Error('ticks 必须是 1—100000 的整数');
  }
  const paramSweeps = Array.isArray(p.paramSweeps) && p.paramSweeps.length > 0
    ? (p.paramSweeps as BatchConfig['paramSweeps'])
    : undefined;
  const config: BatchConfig = {
    scenario: { id: scenario.id, version: scenario.version },
    seedStart: typeof p.seedStart === 'number' ? p.seedStart : 0,
    seedCount: typeof p.seedCount === 'number' ? p.seedCount : 4,
    parallel: p.parallel === true,
    resolution,
    ticks,
    ...(paramSweeps ? { paramSweeps } : {}),
  };
  if (config.seedCount < 1 || config.seedCount > 64) {
    throw new Error('seedCount 必须在 [1, 64]');
  }
  if (config.paramSweeps) {
    for (const sw of config.paramSweeps) {
      if (sw.param !== 'resolution' && sw.param !== 'ticks') {
        throw new Error(`不支持的参数扫描: ${sw.param}（仅 resolution / ticks）`);
      }
      if (!Array.isArray(sw.values) || sw.values.length === 0 || sw.values.length > 16) {
        throw new Error(`${sw.param} 扫描值数 1—16`);
      }
    }
  }
  const report = await runBatch(config.scenario, config);
  ctx.pushBatch(report);
  ctx.emit({ id, type: 'batch', payload: { report } });
};

/**
 * Compare a previously-run batch against the loaded Earth series.
 * The `batchIndex` field picks which batch (default: most recent).
 * The report is stashed on the controller so the next projection
 * publishes it as `Projection.lastCalibration`.
 */
const handleBatchCompareToEarth: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (!ctx.book.earthData) throw new Error('请先调用 earthDataLoad');
  if (ctx.book.batches.length === 0) throw new Error('请先运行 batchRun（无 batch 可对比）');
  const idxRaw = typeof p.batchIndex === 'number' ? p.batchIndex : ctx.book.batches.length - 1;
  const idx = Math.max(0, Math.min(ctx.book.batches.length - 1, idxRaw));
  const batch = ctx.book.batches[idx]!;
  const cfg = (p.config ?? {}) as Partial<CalibrationConfig>;
  const trainFraction = typeof cfg.trainFraction === 'number' ? cfg.trainFraction : 0.7;
  if (trainFraction < 0.5 || trainFraction > 0.95) {
    throw new Error('trainFraction 必须在 [0.5, 0.95]');
  }
  const baseline = cfg.baseline ?? 'constant-mean';
  if (baseline !== 'constant-mean' && baseline !== 'linear-trend' && baseline !== 'persistence') {
    throw new Error(`未知 baseline: ${baseline}`);
  }
  const quantity = cfg.quantity ?? 'temperatureK';
  const report = compareBatchToEarth(batch, ctx.book.earthData, {
    trainFraction, baseline, quantity,
  });
  ctx.setBatchCalibration(report);
  ctx.emit({ id, type: 'batchCalibration', payload: { report } });
};

// === V14 visual route =================================================

/**
 * Generate a V14 world. The payload is the `V14WorldSpec` (validated
 * at the controller boundary). The router picks the backend
 * (default `'inRepo'`); the result is stashed on the book as a new
 * snapshot (auto-active unless `keepActive: false`) so it round-trips
 * through export/import, and a snapshot list is published so the
 * UI's projection channel learns about it.
 *
 * Backend errors (e.g. `worldLabs` without an API key) are caught
 * here and turned into a `reply.error` so the UI can display a
 * friendly message — callers never see an unhandled rejection.
 */
const handleV14Generate: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  validateV14Spec(p);
  const spec: V14WorldSpec = p as unknown as V14WorldSpec;
  const backend: V14Backend = (typeof p.backend === 'string' ? p.backend : 'inRepo') as V14Backend;
  if (backend !== 'inRepo' && backend !== 'worldLabs' && backend !== 'atlas' && backend !== 'spark') {
    throw new Error(`未知 V14 backend: ${backend}（仅支持 inRepo / worldLabs / atlas / spark）`);
  }
  // V14-4: resolve cityscape context. If the caller asked for a
  // `cityscape` and didn't pre-fill `spec.city` (or asked for a
  // specific `settlementId` they want re-validated), look up
  // the matching settlement + cell data on the active book. The
  // settlement id is honoured over a generic fallback so the
  // P15 UI button can pin a specific settlement.
  if (spec.kind === 'cityscape') {
    const requestedId = spec.city?.settlementId;
    const reg = ctx.book.settlement;
    const settlement = reg
      ? (requestedId
          ? reg.settlements.find((s) => s.id === requestedId)
          : reg.settlements[0])
      : null;
    if (settlement) {
      const state = ctx.state;
      const cell = state ? state.cells : null;
      const cellIndex = settlement.cellIndex;
      spec.city = {
        settlementId: settlement.id,
        label: settlement.label,
        population: Math.max(0, settlement.population),
        knowledgeLevel: Math.max(0, settlement.knowledge.level),
        institution: settlement.institution.kind,
        taxRate: settlement.institution.taxRate,
        techCount: settlement.technology.unlocked.length,
        food: Math.max(0, settlement.resources.food),
        cellIndex,
        cellAreaM2: cell && cellIndex < cell.areaM2.length ? Math.max(1, cell.areaM2[cellIndex] ?? 1) : 1e9,
        cellNutrientMu: cell && cellIndex < cell.nutrientMu.length ? Math.max(0, cell.nutrientMu[cellIndex] ?? 0) : 0,
        cellTemperatureK: cell && cellIndex < cell.temperatureK.length ? cell.temperatureK[cellIndex] ?? 288 : 288,
      };
    }
    // When the caller asked for a specific settlement id that
    // doesn't exist, fail loudly — the UI's "📷 生成 3D" button
    // should never silently fall back to the wrong city.
    if (requestedId && !settlement) {
      throw new Error(`P15 settlement 不存在：${requestedId}`);
    }
  }
  const result = await generateWorld(spec, { backend });
  const makeActive = p.keepActive !== false;
  // Default label for cityscape: "cityscape · {settlementLabel}".
  // For other kinds the generic default in `makeV14Snapshot` is
  // fine.
  let label: string | undefined;
  if (typeof p.label === 'string' && p.label.length > 0) {
    label = p.label;
  } else if (spec.kind === 'cityscape' && spec.city?.label) {
    label = `cityscape · ${spec.city.label}`;
  }
  const snap = makeV14Snapshot({
    id: `v14-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    spec,
    result,
    tick: ctx.state ? ctx.state.tick : null,
    branch: ctx.state ? ctx.state.branch.id : null,
    ...(label ? { label } : {}),
  });
  ctx.setV14Snapshot(snap, makeActive);
  ctx.publish();
  ctx.emit({ id, type: 'v14', payload: { snapshot: snap, activeId: ctx.book.v14ActiveId } });
};

/**
 * Switch the active V14 snapshot by id. The id must exist on the
 * book; otherwise this throws a friendly error.
 */
const handleV14Select: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('无效 V14 snapshot id');
  ctx.setV14Active(p.id);
  ctx.publish();
  ctx.emit({ id, type: 'v14List', payload: { snapshots: ctx.book.v14Summaries(), activeId: ctx.book.v14ActiveId } });
};

/**
 * Remove a V14 snapshot by id. The active pointer is updated to
 * the most-recent remaining snapshot (or `null` when the list
 * becomes empty).
 */
const handleV14Delete: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('无效 V14 snapshot id');
  ctx.removeV14Snapshot(p.id);
  ctx.publish();
  ctx.emit({ id, type: 'v14List', payload: { snapshots: ctx.book.v14Summaries(), activeId: ctx.book.v14ActiveId } });
};

/**
 * Rename a V14 snapshot in place. The label is trimmed and
 * length-bounded (max 80 chars) so the UI's list view doesn't
 * overflow.
 */
/**
 * Fetch a single V14 snapshot (with the full mesh payload, not
 * just the summary) by id. Returns `null` if the id is unknown.
 * The main thread uses this to render a snapshot in the V14
 * 3D viewport without round-tripping the whole book through
 * `export` → `ExperimentBook.import` (which is the old,
 * codec-brittle path that the v14.ts UI used).
 */
const handleV14Get: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (typeof p.id !== 'string' || p.id.length === 0) {
    ctx.emit({ id, type: 'v14Get', payload: { snapshot: null } });
    return;
  }
  const snap = ctx.book.v14Snapshots.find((s) => s.id === p.id) ?? null;
  ctx.emit({ id, type: 'v14Get', payload: { snapshot: snap } });
};

const handleV14Rename: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('无效 V14 snapshot id');
  if (typeof p.label !== 'string') throw new Error('label 必须是字符串');
  const label = p.label.trim();
  if (label.length === 0) throw new Error('label 不能为空');
  if (label.length > 80) throw new Error('label 不能超过 80 字符');
  ctx.renameV14Snapshot(p.id, label);
  ctx.publish();
  ctx.emit({ id, type: 'v14List', payload: { snapshots: ctx.book.v14Summaries(), activeId: ctx.book.v14ActiveId } });
};

/**
 * V14 batch parameter scan. Runs every combination of
 * `seeds × kinds × styles` and pushes each result as a
 * snapshot. Total runs capped at 16 × 5 × 4 = 320 by the
 * validator. The active pointer is unchanged (so the user's
 * current view is preserved). The reply carries the full
 * `V14BatchReport` plus the updated snapshot list.
 *
 * Per docs/15 G, the report must include a distribution
 * (not just raw counts) so the UI can answer "is this
 * seed/runtime typical?". We compute histograms and
 * vertex / duration statistics inline.
 */
const handleV14BatchScan: Handler = async (p, ctx, id) => {
  if (!ctx.book) throw new Error('实验簿尚未初始化');
  validateV14BatchScanSpec(p);
  const spec: V14BatchScanSpec = p as unknown as V14BatchScanSpec;
  const prompt = spec.prompt ?? 'batch';
  const tick = ctx.state ? ctx.state.tick : null;
  const branch = ctx.state ? ctx.state.branch.id : null;
  const startMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const newSnaps: V14Snapshot[] = [];
  // Run sequentially so the postMessage channel doesn't get
  // flooded. Each generation is cheap (< 50 ms typically); a
  // 16 × 2 × 2 = 64-run sweep finishes in well under a second.
  for (const seed of spec.seeds) {
    for (const kind of spec.kinds) {
      for (const style of spec.styles) {
        const subSpec: V14WorldSpec = {
          prompt,
          kind,
          resolution: spec.resolution,
          style,
          seed: `batch-${seed}-${kind}-${style}`,
        };
        const result = await generateWorld(subSpec, { backend: 'inRepo' });
        const id2 = `v14-batch-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
        const label = spec.labelPrefix
          ? `${spec.labelPrefix} ${kind}/${style}/s${seed}`
          : `batch ${kind}/${style}/s${seed}`;
        newSnaps.push(makeV14Snapshot({
          id: id2,
          spec: subSpec,
          result,
          tick,
          branch,
          label,
        }));
      }
    }
  }
  ctx.pushV14Batch(newSnaps);
  // Build the report.
  const perKind: Record<string, number> = { terrain: 0, tree: 0, building: 0, rock: 0, humanoid: 0 };
  const perStyle: Record<string, number> = { smooth: 0, rocky: 0, crystal: 0, organic: 0 };
  const vertCounts: number[] = [];
  const durMs: number[] = [];
  for (const s of newSnaps) {
    perKind[s.spec.kind] = (perKind[s.spec.kind] ?? 0) + 1;
    perStyle[s.spec.style] = (perStyle[s.spec.style] ?? 0) + 1;
    vertCounts.push(s.vertices.length / 3);
    durMs.push(s.durationMs);
  }
  vertCounts.sort((a, b) => a - b);
  durMs.sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const median = (xs: number[]) => xs.length === 0 ? 0 : xs[Math.floor(xs.length / 2)]!;
  const min = (xs: number[]) => xs.length === 0 ? 0 : xs[0]!;
  const max = (xs: number[]) => xs.length === 0 ? 0 : xs[xs.length - 1]!;
  // Vertex histogram: 7 log bins, 0–64 / 64–256 / 256–1k / 1k–4k / 4k–16k / 16k–64k / 64k+.
  const vertBins = [
    { lo: 0, hi: 64, label: '<64' },
    { lo: 64, hi: 256, label: '64–256' },
    { lo: 256, hi: 1024, label: '256–1k' },
    { lo: 1024, hi: 4096, label: '1k–4k' },
    { lo: 4096, hi: 16384, label: '4k–16k' },
    { lo: 16384, hi: 65536, label: '16k–64k' },
    { lo: 65536, hi: Infinity, label: '64k+' },
  ];
  const vertexHistogram = vertBins.map((b) => ({
    label: b.label,
    count: vertCounts.filter((v) => v >= b.lo && v < b.hi).length,
  }));
  // Duration histogram: 9 coarse bins, 0–1/1–2/2–5/5–10/10–20/20–50/50–100/100–200/200+ ms.
  // The first bin starts at 0 because `inRepo` generators often
  // finish in well under 1 ms (and the in-Node timer resolution
  // can round to 0), so a 1-anchored lower bound would orphan
  // every fast run.
  const durBins = [0, 1, 2, 5, 10, 20, 50, 100, 200, Infinity];
  const durationHistogram = durBins.slice(0, -1).map((lo, i) => {
    const hi = durBins[i + 1]!;
    return {
      label: i === durBins.length - 2 ? `${lo}+` : `${lo}–${hi}`,
      count: durMs.filter((d) => d >= lo && d < hi).length,
    };
  });
  const report: V14BatchReport = {
    totalRuns: newSnaps.length,
    perKind: perKind as V14BatchReport['perKind'],
    perStyle: perStyle as V14BatchReport['perStyle'],
    vertexHistogram,
    durationHistogram,
    vertexStats: { mean: mean(vertCounts), median: median(vertCounts), min: min(vertCounts), max: max(vertCounts) },
    durationStats: { mean: mean(durMs), median: median(durMs), min: min(durMs), max: max(durMs) },
    totalDurationMs: ((typeof performance !== 'undefined' ? performance.now() : Date.now())) - startMs,
    snapshotIds: newSnaps.map((s) => s.id),
    backend: 'inRepo',
    startedAtTick: tick,
    startedAtBranch: branch,
  };
  ctx.publish();
  ctx.emit({
    id, type: 'v14Batch',
    payload: {
      report,
      snapshots: ctx.book.v14Summaries(),
      activeId: ctx.book.v14ActiveId,
    },
  });
};

/**
 * Compute the per-branch histogram from a list of snapshot
 * summaries. Branches with no snapshots are omitted. The UI
 * uses this to render "N snapshots on branch-X" badges without
 * re-traversing the list on every projection.
 */
function computeByBranch(summaries: V14SnapshotSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of summaries) {
    const key = s.createdAtBranch ?? '<no-branch>';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const handleInternalTick: Handler = async (p, ctx) => {
  if (!ctx.state || p.generation !== ctx.generation || !ctx.history) return;
  if (!ctx.isRunning()) return;
  const result = await ctx.history.advance();
  ctx.setEvent(
    `第 ${result.state.tick} 日 · 诞生 ${result.life.births} · 死亡 ${result.life.deaths} · 迁移 ${result.life.migrants} · 突变 ${result.life.mutations}`,
  );
  // P11 cross-scale coupling: every `cosmicStepEvery` planetary ticks
  // we advance the cosmic clock by 5 Myr (the default `stepGalaxies`
  // step). This is the "stellar events → planetary energy budget"
  // wire per docs/15. Before this, supernova energy only reached
  // the planet when the user explicitly clicked the galaxy panel's
  // "前进 1 亿年" button — i.e. never during normal "play" runs.
  if (ctx.book && result.state.tick - ctx.lastCosmicTick >= ctx.cosmicStepEvery) {
    ctx.book.astronomy ??= await createGalaxies(ctx.state.manifest.seed);
    ctx.book.astronomy = stepGalaxies(ctx.book.astronomy);
    ctx.markCosmicTick(result.state.tick);
    const sn = ctx.book.astronomy.lastSupernovaEnergyJ;
    if (sn > 0) {
      // Geometric dilution at 1 kpc + per-tick cap. The raw supernova
      // energy (10^45 J for a 20 M☉ star) would otherwise saturate
      // the planetary ledger and let the chemistry reactor burn
      // endothermic reactions with effectively free energy.
      const effective = Math.min(sn * ctx.planetFraction, ctx.maxEnergyPerTickJ);
      ctx.addExternalEnergy(effective);
    }
    // P10-C: metal yield (M☉) → planetary `externalMatterInMu`.
    // The metals are already in `book.astronomy.lastYieldedSolar`
    // and in each halo's `metalMassSolar` (both tracked for mass
    // conservation); this second copy feeds the planetary nutrient
    // pool so the surface chemistry can use heavy elements over
    // long horizons.
    const yielded = ctx.book.astronomy.lastYieldedSolar;
    if (yielded > 0) ctx.addExternalMatter(yielded * ctx.solarToMu);
  }
  // P12 / P13 auto-step: if the experiment book has loaded a
  // chemistry reactor or a colonial registry, advance them in
  // lockstep with the planetary tick. Silent mode skips the
  // per-step reply so the event stream stays clean; the next
  // projection snapshot already carries the cumulative state.
  if (ctx.book?.chemistry) {
    await handlers.chemistryStep({ silent: true }, ctx, 0);
  }
  if (ctx.book?.colonies) {
    await handlers.coloniesMaintain({ silent: true }, ctx, 0);
  }
  if (ctx.book?.cognition) {
    await handlers.cognitionStep({ silent: true }, ctx, 0);
  }
  if (ctx.book?.settlement) {
    await handlers.settlementStep({ silent: true }, ctx, 0);
  }
  // target check
  const target = ctx.getTarget();
  if (ctx.state.tick >= target) {
    ctx.setRunning(false);
  }
  // 100ms throttle on publish
  const sinceEmit = ctx.sinceEmit();
  if (sinceEmit >= 100 || !ctx.isRunning()) ctx.publish();
  if (ctx.isRunning()) ctx.schedule(ctx.generation);
};

/**
 * Dispatch table mapping each `RequestType` to its handler. The dispatcher
 * in `SimulationController.#handle` consults this table directly.
 */
const handlers: Record<RequestType, Handler> = {
  pause: handlePause,
  create: handleCreate,
  run: handleRun,
  step: handleStep,
  fork: handleFork,
  refine: handleRefine,
  expandCapacity: handleExpandCapacity,
  switch: handleSwitch,
  intervene: handleIntervene,
  compare: handleCompare,
  seek: handleSeek,
  export: handleExport,
  import: handleImport,
  inspect: handleInspect,
  galaxies: handleGalaxiesInit,
  galaxiesAdvance: handleGalaxiesAdvance,
  galaxiesGravity: handleGalaxiesGravity,
  snapshot: handleSnapshot,
  internalTick: handleInternalTick,
  chemistryLoad: handleChemistryLoad,
  chemistryStep: handleChemistryStep,
  coloniesLoad: handleColoniesLoad,
  coloniesMaintain: handleColoniesMaintain,
  cognitionLoad: handleCognitionLoad,
  cognitionStep: handleCognitionStep,
  settlementLoad: handleSettlementLoad,
  settlementStep: handleSettlementStep,
  earthDataLoad: handleEarthDataLoad,
  earthDataCompare: handleEarthDataCompare,
  batchRun: handleBatchRun,
  batchCompareToEarth: handleBatchCompareToEarth,
  v14Generate: handleV14Generate,
  v14Select: handleV14Select,
  v14Delete: handleV14Delete,
  v14Rename: handleV14Rename,
  v14Get: handleV14Get,
  v14BatchScan: handleV14BatchScan,
  getCellCenters: handleGetCellCenters,
};

/** Test-only handle into the dispatch table. Not part of the public API. */
export const __handlers = handlers;

// === Controller ======================================================

export class SimulationController {
  #book: ExperimentBook | null = null;
  get #history(): Timeline | null { return this.#book?.active ?? null; }
  get #state(): WorldState | null { return this.#history?.state ?? null; }
  #queue: Promise<void> = Promise.resolve();
  #target = 0;
  #running = false; #generation = 0; #lastEmit = 0; #event = '世界尚未初始化';
  #emit: (reply: Reply) => void;
  // P11 cross-scale coupling: track the last planetary tick on which we
  // advanced the cosmic clock so we can run `stepGalaxies` every
  // `cosmicStepEvery` planetary ticks instead of on every tick.
  #lastCosmicTick = 0;
  readonly #cosmicStepEvery: number;
  readonly #planetFraction: number;
  readonly #maxEnergyPerTickJ: number;
  readonly #solarToMu: number;
  constructor(
    emit: (reply: Reply) => void,
    options?: {
      cosmicStepEvery?: number;
      planetFraction?: number;
      maxEnergyPerTickJ?: number;
      solarToMu?: number;
    },
  ) {
    this.#emit = emit;
    this.#cosmicStepEvery = Math.max(1, options?.cosmicStepEvery ?? P11_COSMIC_STEP_EVERY);
    this.#planetFraction = options?.planetFraction ?? P11_PLANET_FRACTION;
    this.#maxEnergyPerTickJ = options?.maxEnergyPerTickJ ?? P11_MAX_ENERGY_PER_TICK_J;
    this.#solarToMu = options?.solarToMu ?? P10C_SOLAR_TO_MU;
  }
  snapshotState(): WorldState { if (!this.#state) throw new Error('请先创建世界'); return structuredClone(this.#state); }
  projection(): Projection {
    const s = this.#state; if (!s) throw new Error('请先创建世界');
    const biomass = new Float64Array(s.cells.areaM2.length), dominant = new Int32Array(s.cells.areaM2.length).fill(-1), max = new Float64Array(s.cells.areaM2.length);
    for (let i = 0; i < s.cohorts.ids.length; i++) {
      const cell = s.cohorts.cellIndices[i]!, count = s.cohorts.counts[i]!;
      biomass[cell]! += count * s.rules.life.structureMuPerIndividual;
      if (count > max[cell]!) { max[cell] = count; dominant[cell] = s.cohorts.lineageIndices[i]!; }
    }
    return {
      astronomyRevision: this.#book!.astronomy ? `${this.#book!.astronomy.version}:${this.#book!.astronomy.step}` : 'none',
      astronomyStep: this.#book!.astronomy?.step ?? -1,
      cohortLimit: s.rules.limits.maxCohorts,
      historyStorage: this.#history!.storageStats(),
      branchId: s.branch.id,
      worldId: s.manifest.id,
      tick: s.tick,
      running: this.#running,
      summary: summarize(s),
      temperature: s.cells.temperatureK.slice(),
      nutrient: s.cells.nutrientMu.slice(),
      biomass,
      land: s.cells.landFraction.slice(),
      dominant,
      lineageIds: s.lineages.map((l) => l.id),
      lastEvent: this.#event,
      headTick: this.#history!.headTick,
      forkTick: s.branch.forkTick,
      samples: this.#history!.samples.slice(),
      branches: this.#book!.list(),
      chemistry: this.#book!.chemistry ? {
        step: this.#book!.chemistry.state.step,
        status: this.#book!.chemistry.state.status,
        totalConsumedJ: this.#book!.chemistry.state.energyConsumedJ,
        totalShortfallJ: this.#book!.chemistry.state.energyShortfallJ,
        concentrations: Object.fromEntries(this.#book!.chemistry.network.species.map(sp => [sp as string, this.#book!.chemistry!.state.concentrations.get(sp) ?? 0])),
        networkSource: this.#book!.chemistry.network.source?.startsWith('synthetic-GARD') ? 'gard' as const
          : this.#book!.chemistry.network.source?.startsWith('synthetic-Markov') ? 'markov' as const
            : 'raw' as const,
      } : null,
      colonies: this.#book!.colonies ? {
        total: this.#book!.colonies.organisms.length,
        totalMaintenanceJ: this.#book!.colonies.totalMaintenanceJ,
        totalFissions: this.#book!.colonies.totalFissions,
      } : null,
      cognition: this.#book!.cognition ? (() => {
        const reg = this.#book!.cognition!;
        // Per-lineage rollup. If a registry has no agents, the
        // taskKind is reported as `foraging` (the default) so the
        // UI never has to handle null.
        const byLineageMap = new Map<string, { agents: number; totalReward: number; totalQEntries: number }>();
        for (const a of reg.agents) {
          const cur = byLineageMap.get(a.lineageId) ?? { agents: 0, totalReward: 0, totalQEntries: 0 };
          cur.agents += 1;
          cur.totalReward += a.totalReward;
          cur.totalQEntries += a.qTable.size;
          byLineageMap.set(a.lineageId, cur);
        }
        const byLineage = [...byLineageMap.entries()].map(([lineageId, v]) => ({
          lineageId,
          agents: v.agents,
          avgReward: v.agents > 0 ? v.totalReward / v.agents : 0,
          totalQEntries: v.totalQEntries,
        }));
        return {
          agents: reg.agents.length,
          episode: reg.episode,
          totalReward: reg.totalReward,
          totalCognitionJ: reg.totalCognitionJ,
          taskKind: reg.agents[0]?.taskKind ?? 'foraging',
          byLineage,
        };
      })() : null,
      settlement: this.#book!.settlement ? (() => {
        const reg = this.#book!.settlement!;
        const bySettlement = reg.settlements.map(s => ({
          id: s.id,
          label: s.label,
          population: Math.round(s.population),
          food: Math.round(s.resources.food),
          knowledgeLevel: s.knowledge.level,
          cellIndex: s.cellIndex,
          dissolved: s.dissolved,
          lifetimeSteps: Math.max(0, s.lastStep - s.foundingStep),
          institutionKind: s.institution.kind,
          techCount: s.technology.unlocked.length,
          totalReceivedFood: Math.round(s.totalReceivedFood),
          totalSentFood: Math.round(s.totalSentFood),
        }));
        return {
          settlements: reg.settlements.length,
          step: reg.step,
          totalProducedFood: reg.totalProducedFood,
          totalConsumedFood: reg.totalConsumedFood,
          totalDissolutions: reg.totalDissolutions,
          totalExchangeFood: reg.totalExchangeFood,
          exchanges: reg.exchange.length,
          totalCoalitionFood: reg.totalCoalitionFood,
          coalitions: reg.coalitions.length,
          totalCasualtyEvents: reg.totalCasualtyEvents,
          totalPopulationLost: reg.totalPopulationLost,
          totalFoodDestroyed: reg.totalFoodDestroyed,
          conflicts: reg.conflicts.length,
          totalInstitutionTransitions: reg.totalInstitutionTransitions,
          bySettlement,
        };
      })() : null,
      earthData: this.#book!.earthData ? (() => {
        const s = this.#book!.earthData!;
        const projection = (this as unknown as { __earthCalibration?: CalibrationReport }).__earthCalibration;
        return {
          citation: s.citation,
          points: s.points.length,
          startTickDays: s.startTickDays,
          endTickDays: s.endTickDays,
          gapFillCount: s.gapFillCount,
          calibration: projection ?? null,
        };
      })() : null,
      batches: this.#book!.batches.map(b => ({
        scenario: b.scenario,
        seedStart: b.seedStart,
        seedCount: b.seedCount,
        outcomes: b.outcomes,
        summary: b.summary,
        crashes: b.crashes,
        failures: b.failures,
        completedSeeds: b.completedSeeds,
        done: b.done,
      })),
      lastCalibration: (this as unknown as { __lastBatchCalibration?: BatchCalibrationReport }).__lastBatchCalibration ?? null,
      v14: (this as unknown as { __v14?: { snapshots: V14SnapshotSummary[]; activeId: string | null; byBranch: Record<string, number> } }).__v14 ?? { snapshots: [], activeId: null, byBranch: {} },
    };
  }
  #publish(): void { this.#lastEmit = performance.now(); this.#emit({ id: 0, type: 'projection', payload: this.projection() }); }
  pause(): void { this.#running = false; this.#generation++; }
  handle(request: Request): Promise<void> {
    if (request.type === 'pause') this.pause(); // Interrupt long seek/compare at their next yield.
    const result = this.#queue.then(() => this.#handle(request));
    this.#queue = result.catch(() => {}); return result;
  }
  #schedule(generation: number) { setTimeout(() => void this.handle({ id: 0, type: 'internalTick', payload: { generation } }), 0); }
  /**
   * Build a `HandlerContext` snapshot with private setters so handlers can
   * mutate `#book`, `#target`, `#running`, `#event` without breaking
   * encapsulation (handlers are not class members, so they cannot touch
   * `#`-prefixed fields directly).
   */
  /**
   * Test-only public helper: set the active world's
   * `externalEnergyInJ` directly. Production routes energy through
   * interventions / galaxies / chemistry; this direct setter exists so
   * unit tests can seed the ledger without rebuilding those pipelines.
   */
  testSetLedgerEnergy(joules: number): void {
    const h = this.#history;
    if (h) h.state.ledger.externalEnergyInJ = Math.max(0, joules);
  }

  #ctx(): __InternalHandlerContext {
    const self = this;
    return {
      get book() { return self.#book; },
      get history() { return self.#history; },
      get state() { return self.#state; },
      get generation() { return self.#generation; },
      pause: () => self.pause(),
      publish: () => self.#publish(),
      emit: (reply: Reply) => self.#emit(reply),
      setBook: (b: ExperimentBook) => { self.#book = b; },
      setTarget: (n: number) => { self.#target = n; },
      setRunning: (b: boolean) => { self.#running = b; },
      setEvent: (s: string) => { self.#event = s; },
      isRunning: () => self.#running,
      getTarget: () => self.#target,
      sinceEmit: () => performance.now() - self.#lastEmit,
      schedule: (g: number) => self.#schedule(g),
      addExternalEnergy: (j: number) => {
        const h = self.#history;
        if (!h) return;
        const state = h.state;
        // P11 cross-scale: stellar energy (supernova, etc.)
        // arrives at the planet as additional irradiance. The
        // ledger records the total joules received; the
        // planetary energy reservoir (Σ area·T·heat) must
        // also reflect the addition so the `validateState`
        // energy-balance check at the next tick passes.
        //
        // Distribute `j` across all cells in proportion to
        // their area — large cells absorb proportionally more.
        // Each cell's temperature rises by ΔT = j / (Σ area ·
        // heat). We split across cells by `area[i] / Σarea`.
        const cells = state.cells;
        if (!Number.isFinite(j) || j === 0) return;
        if (cells.areaM2.length === 0) return;
        let totalArea = 0;
        for (let i = 0; i < cells.areaM2.length; i++) totalArea += cells.areaM2[i]!;
        if (totalArea <= 0) return;
        const heat = state.rules.environment.heatCapacityJPerM2K;
        for (let i = 0; i < cells.areaM2.length; i++) {
          const share = (cells.areaM2[i]! / totalArea) * j;
          cells.temperatureK[i]! += share / (cells.areaM2[i]! * heat);
        }
        state.ledger.externalEnergyInJ += j;
      },
      addExternalMatter: (mu: number) => {
        // P10-C: galactic metal yield → planetary nutrient pool.
        // Metals and energy follow independent budgets so the
        // supernova energy spike doesn't have to also carry a
        // matching mass budget.
        //
        // P11/P10-C fix: the ledger records the total
        // micrograms received, but the planetary matter
        // reservoir (Σ nutrient + detritus + cohort structure)
        // must also reflect the addition so the
        // `validateState` matter-balance check at the next
        // tick passes. Distribute `mu` evenly across all
        // cells (galactic infall is global).
        const h = self.#history;
        if (!h) return;
        const state = h.state;
        if (!Number.isFinite(mu) || mu === 0) return;
        const cells = state.cells;
        if (cells.areaM2.length === 0) return;
        const share = mu / cells.areaM2.length;
        for (let i = 0; i < cells.areaM2.length; i++) {
          cells.nutrientMu[i]! += share;
        }
        state.ledger.externalMatterInMu += mu;
      },
      consumeExternalEnergy: (j: number) => {
        const h = self.#history;
        if (!h) return;
        const ledger = h.state.ledger;
        const take = Math.min(Math.max(j, 0), ledger.externalEnergyInJ);
        ledger.externalEnergyInJ -= take;
      },
      setLedgerEnergy: (j: number) => {
        const h = self.#history;
        if (h) h.state.ledger.externalEnergyInJ = Math.max(0, j);
      },
      cosmicStepEvery: self.#cosmicStepEvery,
      planetFraction: self.#planetFraction,
      maxEnergyPerTickJ: self.#maxEnergyPerTickJ,
      solarToMu: self.#solarToMu,
      lastCosmicTick: self.#lastCosmicTick,
      markCosmicTick: (tick: number) => { self.#lastCosmicTick = tick; },
      setChemistry: (c) => {
        if (self.#book) self.#book.chemistry = c;
      },
      setColonies: (r) => {
        if (self.#book) self.#book.colonies = r;
      },
      setCognition: (c) => {
        if (self.#book) self.#book.cognition = c;
      },
      setSettlement: (s) => {
        if (self.#book) self.#book.settlement = s;
      },
      setEarthData: (e) => {
        if (self.#book) self.#book.earthData = e;
      },
      setEarthCalibration: (c) => {
        if (c === null) {
          delete (self as unknown as { __earthCalibration?: CalibrationReport }).__earthCalibration;
        } else {
          (self as unknown as { __earthCalibration?: CalibrationReport }).__earthCalibration = c;
        }
      },
      pushBatch: (b) => {
        if (self.#book) self.#book.batches.push(b);
      },
      setBatchCalibration: (c) => {
        if (c === null) {
          delete (self as unknown as { __lastBatchCalibration?: BatchCalibrationReport }).__lastBatchCalibration;
        } else {
          (self as unknown as { __lastBatchCalibration?: BatchCalibrationReport }).__lastBatchCalibration = c;
        }
      },
      setV14Snapshot: (snap, makeActive) => {
        if (self.#book) self.#book.pushSnapshot(snap, makeActive);
        const summaries = self.#book ? self.#book.v14Summaries() : [];
        const activeId = self.#book ? self.#book.v14ActiveId : null;
        (self as unknown as { __v14?: { snapshots: V14SnapshotSummary[]; activeId: string | null; byBranch: Record<string, number> } }).__v14 = { snapshots: summaries, activeId, byBranch: computeByBranch(summaries) };
      },
      setV14Active: (id) => {
        if (self.#book) self.#book.selectSnapshot(id);
        const summaries = self.#book ? self.#book.v14Summaries() : [];
        const activeId = self.#book ? self.#book.v14ActiveId : null;
        (self as unknown as { __v14?: { snapshots: V14SnapshotSummary[]; activeId: string | null; byBranch: Record<string, number> } }).__v14 = { snapshots: summaries, activeId, byBranch: computeByBranch(summaries) };
      },
      removeV14Snapshot: (id) => {
        if (self.#book) self.#book.removeSnapshot(id);
        const summaries = self.#book ? self.#book.v14Summaries() : [];
        const activeId = self.#book ? self.#book.v14ActiveId : null;
        (self as unknown as { __v14?: { snapshots: V14SnapshotSummary[]; activeId: string | null; byBranch: Record<string, number> } }).__v14 = { snapshots: summaries, activeId, byBranch: computeByBranch(summaries) };
      },
      renameV14Snapshot: (id, label) => {
        if (self.#book) self.#book.renameSnapshot(id, label);
      },
      pushV14Batch: (snaps) => {
        if (!self.#book) return;
        for (const s of snaps) self.#book.v14Snapshots.push(s);
        const summaries = self.#book.v14Summaries();
        const activeId = self.#book.v14ActiveId;
        (self as unknown as { __v14?: { snapshots: V14SnapshotSummary[]; activeId: string | null; byBranch: Record<string, number> } }).__v14 = { snapshots: summaries, activeId, byBranch: computeByBranch(summaries) };
      },
    };
  }
  async #handle(request: Request): Promise<void> {
    try {
      const handler = handlers[request.type];
      if (!handler) throw new Error(`未知操作：${request.type}`);
      await handler(request.payload ?? {}, this.#ctx(), request.id);
    } catch (error) {
      this.pause();
      if (this.#state) this.#publish();
      this.#emit({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
