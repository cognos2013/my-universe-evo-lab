/**
 * P15 — settlement and civilisation systems.
 *
 * Per docs/15 P15: "生产/消费/交换、知识与技术前提、制度规则和环境
 * 反馈闭合；可衰退或消失". This file is the **interface contract**
 * for settlements. It does NOT claim settlements emerge from
 * pre-life chemistry (P12) — they are seeded from a template, per
 * the P15 rule that the civilisation layer must be marked as an
 * independent initialisation, not a P12-derived outcome.
 *
 * A settlement carries:
 *
 *   - `population`: how many agent-equivalents live there.
 *   - `food / materials / energy`: per-capita resource stocks.
 *   - `knowledgeLevel`: technology / institutional sophistication.
 *   - `cellIndex`: which world cell the settlement occupies.
 *   - `foundingStep` / `lastStep`: lifecycle stamps.
 *   - `dissolved`: true once the settlement has collapsed.
 *
 * The reference task is "self-sustaining settlement": production ≥
 * consumption over a horizon. The acceptance test in `simulate.ts`
 * runs a knowledge-enabled template against a no-knowledge baseline
 * on the same world and asserts the knowledge-enabled cohort has
 * the higher average lifetime.
 */
import * as v from '../core/validation.ts';

// === Resources =========================================================

/** Per-settlement resource ledger. Numbers are abstract units; the
 *  conversion to world energy / matter is mediated by the
 *  controller. */
export interface ResourceLedger {
  food: number;
  materials: number;
  energyJ: number;
}

/** A technology / institutional stack. The current `level` is the
 *  single knob the P15 reference model exposes; phase 2 may add
 *  per-domain fields (agriculture, metallurgy, governance). */
export interface Knowledge {
  /** Cumulative research performed (never decreases). */
  cumulative: number;
  /** Effective level (0..maxLevel). Multiplies production rate. */
  level: number;
}

export const MAX_KNOWLEDGE_LEVEL = 5;

// === Institutions =====================================================

/**
 * Phase 2: institutional rules governing how a settlement
 * distributes its production and decides on consumption.
 *
 *   - `public`:  production goes into a shared pool; each member
 *                takes from the pool equally. Naturally resilient
 *                to individual cell shocks (everyone shares the
 *                risk) but lower per-capita output when the pool
 *                is small.
 *   - `private`: each member keeps their own share. Higher
 *                individual incentives but more vulnerable to
 *                local shocks.
 *   - `mixed`:   a fraction `taxRate` goes to a public pool, the
 *                rest stays private. The reference policy.
 *
 * Institution affects `stepSettlement`: `public` adds a 10% bonus
 * to the production multiplier (shared-economy scale effect) but
 * `private` is the default with no bonus. The numbers are
 * intentionally small — phase 2 is about the *contract*, not
 * getting the coefficients right.
 */
export type InstitutionKind = 'public' | 'private' | 'mixed';

export interface Institution {
  kind: InstitutionKind;
  /** Tax rate for `mixed` (0..1). Ignored for other kinds. */
  taxRate: number;
  /**
   * P15: public-goods share in [0, 1]. A non-zero value boosts
   * the settlement's per-step birth rate and reduces
   * starvation severity — the institutional feedback loop
   * per docs/15 ("公共制度应通过公共品影响出生率与饥荒").
   * `kind: 'public'` defaults to 0.5; `kind: 'mixed'` scales
   * with `taxRate`; `kind: 'private'` defaults to 0.
   */
  publicGoodsShare: number;
}

// === Technology =======================================================

/**
 * Phase 2: a simple technology tree. Each `id` is a string;
 * `unlocked` is the set of techs the settlement currently has.
 * The `TECH_EFFECTS` table maps ids to production-rate
 * multipliers so the *effect* of a tech is data, not code.
 *
 * Phase 2 ships three example techs:
 *
 *   - `irrigation`:   1.25× production (boosts cell-nutrient use).
 *   - `granary`:      0.7× consumption (food storage efficiency).
 *   - `writing`:      1.5× research rate (knowledge accumulation).
 */
export type TechId = string;

export interface TechnologyRegistry {
  unlocked: TechId[];
}

/** Lookup table for the phase-2 reference techs. */
export const TECH_EFFECTS: Readonly<Record<TechId, {
  productionMultiplier: number;
  consumptionMultiplier: number;
  researchMultiplier: number;
}>> = Object.freeze({
  irrigation: { productionMultiplier: 1.25, consumptionMultiplier: 1, researchMultiplier: 1 },
  granary:    { productionMultiplier: 1,    consumptionMultiplier: 0.7, researchMultiplier: 1 },
  writing:    { productionMultiplier: 1,    consumptionMultiplier: 1,   researchMultiplier: 1.5 },
});

// === Exchange ==========================================================

/**
 * Phase 2: a directed exchange edge from one settlement to
 * another. Each step, the *source* settlement can transfer up to
 * `ratePerStep` units of food to the *target*. The exchange is
 * only triggered when the source has surplus and the target is in
 * deficit — so it functions as a "starvation rescue" without
 * requiring an explicit user action.
 */
export interface ExchangeEdge {
  /** Source settlement id. */
  fromId: string;
  /** Target settlement id. */
  toId: string;
  /** Maximum food units transferred per step. */
  ratePerStep: number;
  /** Cumulative food transferred along this edge since the
   *  registry was created. */
  totalTransferred: number;
}

// === Phase 3: Conflict & Coalition =====================================

/**
 * A directed conflict edge between two settlements. Each step
 * the conflict `probability` is rolled once; on a hit both
 * settlements lose `casualtyFraction` of their population and
 * `damageFood` food units (the food is *destroyed*, not
 * transferred — the war is destructive). The probability is
 * symmetric in the sense that the same edge rolls once per step
 * and applies to both sides.
 *
 * Phase 3 deliberately keeps this simple — a full war simulator
 * with troop counts, technology modifiers, and truces is a much
 * larger project. The reference contract is just
 * "if a conflict edge is present, both sides bleed".
 */
export interface ConflictEdge {
  /** Aggressor settlement id (the one that *initiates* the war
   *  in the narrative; the contract treats the edge symmetrically
   *  but we keep the direction for future asymmetric rules). */
  fromId: string;
  /** Defender settlement id. */
  toId: string;
  /** Per-step probability in [0, 1] of a casualty event firing. */
  probability: number;
  /** Fraction of population lost by *each* side on a hit (0..1). */
  casualtyFraction: number;
  /** Food units destroyed on each side on a hit. */
  damageFood: number;
  /** Total casualty events fired since the registry was created. */
  totalCasualtyEvents: number;
  /** Cumulative population lost on each side. */
  totalPopulationLost: number;
  /** Cumulative food destroyed on each side. */
  totalFoodDestroyed: number;
}

/**
 * A directed coalition edge. Coalition is the "upgrade" of
 * exchange: instead of triggering only on deficit, a coalition
 * pool continuously shares food between members according to a
 * per-step `ratePerStep` cap. There is no "deficit required" gate
 * (the cost is the sense of shared risk: surplus leaks out).
 *
 * Like `ExchangeEdge`, the source is the one that transfers;
 * the target is the one that receives. We track totals on both
 * sides so the UI can show the imbalance.
 */
export interface CoalitionEdge {
  fromId: string;
  toId: string;
  /** Maximum food units transferred per step. */
  ratePerStep: number;
  /** Cumulative food transferred along this edge since creation. */
  totalTransferred: number;
}

/**
 * A rule that *automatically* changes a settlement's institution
 * based on its state. The reference rules in phase 3 are:
 *
 *   - `popAbove`: if population exceeds the threshold, switch to
 *     `public` (state formation).
 *   - `popBelow`: if population drops below the threshold,
 *     dissolve to `private` (state collapse).
 *
 * Rules are evaluated once per step after the production /
 * consumption / exchange pass. Phase 3 ships a default rule set
 * that the controller applies unless the user overrides.
 */
export interface InstitutionEvolutionRule {
  /** When `population` exceeds this, switch to `public`. */
  popAbove?: { threshold: number };
  /** When `population` drops below this, switch to `private`. */
  popBelow?: { threshold: number };
}

// === Settlement ========================================================

/** A settlement on the world. Independent of `ColonialOrganism`
 *  (P13) — a settlement is a *new* selection layer with its own
 *  lifecycle. Phase 1 does not consume or be consumed by colonies;
 *  future phases may wire the two together. */
export interface Settlement {
  id: string;
  /** Display label (free text). */
  label: string;
  cellIndex: number;
  population: number;
  resources: ResourceLedger;
  knowledge: Knowledge;
  foundingStep: number;
  lastStep: number;
  /** True once the settlement has collapsed (food < 0 for
   *  `dissolveAfter` consecutive steps). */
  dissolved: boolean;
  /** Cumulative food production across the settlement's lifetime. */
  totalProducedFood: number;
  /** Cumulative food consumption across the settlement's lifetime. */
  totalConsumedFood: number;
  /** Cumulative food received via exchange from other settlements. */
  totalReceivedFood: number;
  /** Cumulative food sent via exchange to other settlements. */
  totalSentFood: number;
  /** Phase 2: institutional rule for production / consumption. */
  institution: Institution;
  /** Phase 2: technology tree state. */
  technology: TechnologyRegistry;
}

// === Configuration =====================================================

/** Tunables for a settlement's dynamics. */
export interface SettlementConfig {
  /** Population at founding. */
  initialPopulation: number;
  /** Food produced per step per population unit, before the
   *  knowledge multiplier and the cell-nutrient factor. */
  baseProductionPerCapita: number;
  /** Food consumed per step per population unit. */
  consumptionPerCapita: number;
  /** Each knowledge level multiplies production by this much. */
  knowledgeMultiplier: number;
  /** Research performed per step when food > 0. */
  researchPerStep: number;
  /** Population decline rate per step when food < 0 (0..1). */
  starvationDeclineRate: number;
  /**
   * P15: per-step birth rate as a fraction of the current
   * population. The actual rate is multiplied by
   * `(1 + 0.5 * institution.publicGoodsShare)` so a fully
   * public-goods settlement (share = 1) sees births 50% above
   * baseline, while a pure-private settlement (share = 0)
   * sits at baseline. Set to 0 to disable births entirely
   * (the pre-P15 behaviour, where population only declined).
   */
  birthRatePerCapita: number;
  /** Consecutive food-negative steps before the settlement dissolves. */
  dissolveAfter: number;
  /** Maximum food that can be stored (cap). */
  foodCapacity: number;
  /** Initial food at founding. */
  initialFood: number;
  /** Initial knowledge level. */
  initialKnowledgeLevel: number;
}

export const DEFAULT_SETTLEMENT_CONFIG: SettlementConfig = {
  initialPopulation: 50,
  baseProductionPerCapita: 1.0,
  consumptionPerCapita: 0.8,
  knowledgeMultiplier: 1.5,
  researchPerStep: 0.1,
  starvationDeclineRate: 0.1,
  birthRatePerCapita: 0.01, // 1% per step baseline; modulated by institution
  dissolveAfter: 10,
  foodCapacity: 1000,
  initialFood: 200,
  initialKnowledgeLevel: 0,
};

/** A *template* used by `settlementLoad` to seed many settlements at
 *  once. The world itself is the source of cell-nutrient; everything
 *  else is in the template. Phase 2 adds `institution`, `technology`,
 *  and `exchangeTo` (a list of `(targetLabel, ratePerStep)` pairs
 *  — the controller wires them to actual settlement ids once all
 *  templates have been created). Phase 3 adds `conflictTo` and
 *  `coalitionTo`. */
export interface SettlementTemplate {
  label: string;
  cellIndex: number;
  population?: number;
  initialFood?: number;
  initialKnowledgeLevel?: number;
  institution?: Institution;
  technology?: TechnologyRegistry;
  /** Phase 2: edges to other settlement *labels* with per-step
   *  transfer rates. Resolved to ids after all settlements exist. */
  exchangeTo?: { targetLabel: string; ratePerStep: number }[];
  /** Phase 3: conflict edges. Each entry is a *symmetric* war
   *  relation — the `targetLabel` is the other side, the
   *  `probability`/`casualtyFraction`/`damageFood` apply to both. */
  conflictTo?: { targetLabel: string; probability: number; casualtyFraction: number; damageFood: number }[];
  /** Phase 3: coalition edges. Like exchangeTo but with no
   *  deficit gate — the food transfers every step up to the
   *  rate, regardless of source or target balance. */
  coalitionTo?: { targetLabel: string; ratePerStep: number }[];
}

// === Factory ===========================================================

export function makeSettlement(args: {
  id: string; label: string; cellIndex: number; foundingStep: number;
  config?: Partial<SettlementConfig>;
  institution?: Institution;
  technology?: TechnologyRegistry;
}): Settlement {
  const cfg = { ...DEFAULT_SETTLEMENT_CONFIG, ...(args.config ?? {}) };
  return {
    id: args.id,
    label: args.label,
    cellIndex: args.cellIndex,
    population: cfg.initialPopulation,
    resources: {
      food: cfg.initialFood,
      materials: 0,
      energyJ: 0,
    },
    knowledge: {
      // `cumulative` is the "research performed" counter; seed it
      // with the requested level so a "knowledge-enabled"
      // settlement starts with the corresponding accumulated
      // research. Otherwise `level` (capped at MAX) and
      // `cumulative` (uncapped) would diverge.
      cumulative: cfg.initialKnowledgeLevel,
      level: cfg.initialKnowledgeLevel,
    },
    foundingStep: args.foundingStep,
    lastStep: args.foundingStep,
    dissolved: false,
    totalProducedFood: 0,
    totalConsumedFood: 0,
    totalReceivedFood: 0,
    totalSentFood: 0,
    institution: args.institution ?? { kind: 'private', taxRate: 0, publicGoodsShare: 0 },
    technology: args.technology ?? { unlocked: [] },
  };
}

// === Registry ==========================================================

/** A registry of settlements maintained outside `WorldState`. */
export interface SettlementRegistry {
  settlements: Settlement[];
  nextId: number;
  /** Cumulative food produced across all settlements. */
  totalProducedFood: number;
  /** Cumulative food consumed across all settlements. */
  totalConsumedFood: number;
  /** Total dissolutions since registry creation. */
  totalDissolutions: number;
  /** Phase 2: exchange edges. */
  exchange: ExchangeEdge[];
  /** Phase 2: cumulative food transferred (sum across all edges). */
  totalExchangeFood: number;
  /** Phase 3: conflict edges. */
  conflicts: ConflictEdge[];
  /** Phase 3: cumulative casualty events across all conflicts. */
  totalCasualtyEvents: number;
  /** Phase 3: cumulative population lost to conflicts. */
  totalPopulationLost: number;
  /** Phase 3: cumulative food destroyed by conflicts. */
  totalFoodDestroyed: number;
  /** Phase 3: coalition edges. */
  coalitions: CoalitionEdge[];
  /** Phase 3: cumulative food transferred via coalitions. */
  totalCoalitionFood: number;
  /** Phase 3: institution-evolution rule applied to every
   *  settlement each step. */
  institutionRule: InstitutionEvolutionRule;
  /** Phase 3: cumulative institution transitions. */
  totalInstitutionTransitions: number;
  /** Tick counter. */
  step: number;
}

export function makeSettlementRegistry(): SettlementRegistry {
  return {
    settlements: [],
    nextId: 1,
    totalProducedFood: 0,
    totalConsumedFood: 0,
    totalDissolutions: 0,
    exchange: [],
    totalExchangeFood: 0,
    conflicts: [],
    totalCasualtyEvents: 0,
    totalPopulationLost: 0,
    totalFoodDestroyed: 0,
    coalitions: [],
    totalCoalitionFood: 0,
    institutionRule: { popAbove: { threshold: 80 }, popBelow: { threshold: 15 } },
    totalInstitutionTransitions: 0,
    step: 0,
  };
}

// === Validation ========================================================

export function validateSettlement(input: unknown): asserts input is Settlement {
  const o = v.object(input, ['id', 'label', 'cellIndex', 'population', 'resources', 'knowledge', 'foundingStep', 'lastStep', 'dissolved', 'totalProducedFood', 'totalConsumedFood', 'totalReceivedFood', 'totalSentFood', 'institution', 'technology'], 'settlement');
  v.id(o.id, 'settlement.id');
  v.text(o.label, 'settlement.label', 80);
  v.integer(o.cellIndex, 'settlement.cellIndex', 0, 1e7);
  v.number(o.population, 'settlement.population', 0, 1e9);
  v.integer(o.foundingStep, 'settlement.foundingStep', 0, 1e9);
  v.integer(o.lastStep, 'settlement.lastStep', 0, 1e9);
  if (typeof o.dissolved !== 'boolean') v.fail('settlement.dissolved', 'must be a boolean');
  v.number(o.totalProducedFood, 'settlement.totalProducedFood', 0, 1e18);
  v.number(o.totalConsumedFood, 'settlement.totalConsumedFood', 0, 1e18);
  v.number(o.totalReceivedFood, 'settlement.totalReceivedFood', 0, 1e18);
  v.number(o.totalSentFood, 'settlement.totalSentFood', 0, 1e18);
  const r = v.object(o.resources, ['food', 'materials', 'energyJ'], 'settlement.resources');
  v.number(r.food, 'resources.food', -1e15, 1e15);
  v.number(r.materials, 'resources.materials', -1e15, 1e15);
  v.number(r.energyJ, 'resources.energyJ', -1e15, 1e15);
  const k = v.object(o.knowledge, ['cumulative', 'level'], 'settlement.knowledge');
  v.number(k.cumulative, 'knowledge.cumulative', 0, 1e15);
  v.number(k.level, 'knowledge.level', 0, MAX_KNOWLEDGE_LEVEL);
  const inst = v.object(o.institution, ['kind', 'taxRate'], 'settlement.institution');
  v.choice(inst.kind, ['public', 'private', 'mixed'], 'institution.kind');
  v.number(inst.taxRate, 'institution.taxRate', 0, 1);
  const tech = v.object(o.technology, ['unlocked'], 'settlement.technology');
  v.array(tech.unlocked, 'technology.unlocked', 16);
}
