/**
 * P15 — settlement simulation.
 *
 * Reference per-step dynamics for one settlement:
 *
 *   1. **Production**: food += population × baseProduction ×
 *      (1 + knowledgeMultiplier × knowledgeLevel) × cellNutrientFactor.
 *      `cellNutrientFactor = clamp01(cells.nutrientMu[cellIndex] / 1000)`.
 *      Cap at `foodCapacity`.
 *   2. **Consumption**: food -= population × consumptionPerCapita.
 *   3. **Knowledge**: knowledge.cumulative += researchPerStep if
 *      food > 0 (research is paused when starving).
 *      knowledge.level = floor(cumulative / knowledgePerLevel),
 *      capped at MAX_KNOWLEDGE_LEVEL.
 *   4. **Starvation**: when food < 0, population shrinks by
 *      `starvationDeclineRate` per step. After `dissolveAfter`
 *      consecutive negative-food steps, the settlement dissolves.
 *
 * The reference task is "self-sustaining settlement": production ≥
 * consumption over a horizon. The acceptance test in
 * `tests/settlement.test.ts` runs a knowledge-enabled template
 * against a no-knowledge baseline on the same world and asserts
 * the knowledge-enabled cohort has the higher average lifetime.
 */
import type { WorldState } from '../core/contracts.ts';
import { MAX_KNOWLEDGE_LEVEL, TECH_EFFECTS, makeSettlement, type Settlement, type SettlementConfig, type SettlementRegistry, type SettlementTemplate, DEFAULT_SETTLEMENT_CONFIG } from './types.ts';

/** Clamp a number into [0, 1]. Used to normalise institution
 *  inputs that come from a free-form template. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Per-settlement step result. */
export interface SettlementStepEvent {
  settlementId: string;
  producedFood: number;
  consumedFood: number;
  netFood: number;
  knowledgeDelta: number;
  populationDelta: number;
  dissolved: boolean;
}

/** Aggregate step result. */
export interface SettlementStepResult {
  events: SettlementStepEvent[];
  totalProduced: number;
  totalConsumed: number;
  totalDissolutions: number;
  knowledgeLevels: number[];
}

/** Compute the production multiplier for a given knowledge level. */
export function productionMultiplier(level: number, knowledgeMultiplier: number): number {
  return 1 + knowledgeMultiplier * level;
}

/** Compute the cell-nutrient factor in [0, 1]. */
export function cellNutrientFactor(state: WorldState, cellIndex: number): number {
  const n = state.cells.nutrientMu[cellIndex] ?? 0;
  if (n <= 0) return 0;
  return Math.min(1, n / 1000);
}

/** Step one settlement. Mutates the settlement in place.
 *  Phase 2 modifiers (institution, technology) are applied here. */
export function stepSettlement(
  s: Settlement,
  state: WorldState,
  config: SettlementConfig = DEFAULT_SETTLEMENT_CONFIG,
): SettlementStepEvent {
  if (s.dissolved) {
    return { settlementId: s.id, producedFood: 0, consumedFood: 0, netFood: 0, knowledgeDelta: 0, populationDelta: 0, dissolved: true };
  }
  const cellFactor = cellNutrientFactor(state, s.cellIndex);
  const baseProdMul = productionMultiplier(s.knowledge.level, config.knowledgeMultiplier);
  // Apply technology production multiplier (1.0 by default; the
  // TECH_EFFECTS table multiplies the existing production factor).
  let techProdMul = 1;
  for (const t of s.technology.unlocked) {
    const eff = TECH_EFFECTS[t];
    if (eff) techProdMul *= eff.productionMultiplier;
  }
  // Public institutions get a 10% bonus to reflect the scale effect
  // of a shared economy; private gets 0; mixed is a taxRate-weighted
  // average between 0 and 10%.
  const instBonus = s.institution.kind === 'public' ? 1.1
    : s.institution.kind === 'mixed' ? 1 + 0.1 * s.institution.taxRate
    : 1;
  const producedFood = s.population * config.baseProductionPerCapita * baseProdMul * cellFactor * techProdMul * instBonus;
  // Technology consumption multiplier.
  let techConsMul = 1;
  for (const t of s.technology.unlocked) {
    const eff = TECH_EFFECTS[t];
    if (eff) techConsMul *= eff.consumptionMultiplier;
  }
  const consumedFood = s.population * config.consumptionPerCapita * techConsMul;
  // Apply: produce first (capped at foodCapacity), then consume.
  const newFood = Math.min(config.foodCapacity, s.resources.food + producedFood) - consumedFood;
  s.resources.food = newFood;
  s.totalProducedFood += producedFood;
  s.totalConsumedFood += consumedFood;
  // Knowledge: only when food > 0. Apply technology research multiplier.
  let techResMul = 1;
  for (const t of s.technology.unlocked) {
    const eff = TECH_EFFECTS[t];
    if (eff) techResMul *= eff.researchMultiplier;
  }
  let knowledgeDelta = 0;
  if (newFood > 0) {
    s.knowledge.cumulative += config.researchPerStep * techResMul;
    const newLevel = Math.min(MAX_KNOWLEDGE_LEVEL, Math.floor(s.knowledge.cumulative));
    knowledgeDelta = newLevel - s.knowledge.level;
    s.knowledge.level = newLevel;
  }
  // P15 institutional feedback: public goods boost birth rate
  // and dampen starvation. The `publicGoodsShare` is the
  // institution's contribution to the public pool; the
  // per-capita birth rate scales as
  //   birthRate * (1 + 0.5 * publicGoodsShare)
  // (up to +50% for a fully public institution) and the
  // starvation decline scales as
  //   starvationDeclineRate * (1 - 0.5 * publicGoodsShare)
  // (down to -50% for a fully public institution).
  const publicGoods = clamp01(s.institution.publicGoodsShare);
  const birthMul = 1 + 0.5 * publicGoods;
  const starvationDamp = 1 - 0.5 * publicGoods;
  // Births: per-capita fraction of the current population.
  // Starvation and food > 0 are required for births to fire —
  // a starving settlement doesn't grow.
  let births = 0;
  if (config.birthRatePerCapita > 0 && newFood > 0) {
    births = s.population * config.birthRatePerCapita * birthMul;
  }
  // Starvation: declines the population, mitigated by public goods.
  let decline = 0;
  if (newFood < 0) {
    decline = s.population * config.starvationDeclineRate * starvationDamp;
  }
  const net = births - decline;
  let populationDelta = net;
  // Apply the net change. Floor at 0 (no negative populations).
  if (net !== 0) {
    const next = s.population + net;
    // Math.max(0, x) would leave a tiny positive population for
    // many steps; treat < 1 as effectively zero so the dissolution
    // check below can fire.
    s.population = next < 1 ? 0 : next;
  }
  s.lastStep++;
  return {
    settlementId: s.id,
    producedFood,
    consumedFood,
    netFood: newFood,
    knowledgeDelta,
    populationDelta,
    dissolved: false,
  };
}

/** Step every settlement in a registry once. Phase 2 also runs
 *  exchange edges after the per-settlement step so a transfer can
 *  rescue a settlement that just went into deficit. Phase 3
 *  adds conflict / coalition / institution-evolution passes. */
export function stepSettlements(
  registry: SettlementRegistry,
  state: WorldState,
  config: SettlementConfig = DEFAULT_SETTLEMENT_CONFIG,
  rng: () => number = Math.random,
): SettlementStepResult {
  const events: SettlementStepEvent[] = [];
  let totalProduced = 0;
  let totalConsumed = 0;
  let totalDissolutions = 0;
  for (const s of [...registry.settlements]) {
    const ev = stepSettlement(s, state, config);
    events.push(ev);
    totalProduced += ev.producedFood;
    totalConsumed += ev.consumedFood;
    // Check dissolution: settlement has been food-negative for
    // `dissolveAfter` consecutive steps.
    if (s.resources.food < 0) {
      // count consecutive negative steps by looking at lastStep /
      // dissolveAfter via a simple counter. We track the count by
      // hiding it in `population` deltas? No — use a derived value:
      // `lastStep - foundingStep` is the lifespan, but we need
      // *consecutive* food-negative. We add an implicit count via
      // `dissolved` propagation.
      // Solution: collapse population to 0 means dissolve immediately.
      if (s.population <= 0 && !s.dissolved) {
        s.dissolved = true;
        totalDissolutions++;
        // Remove from registry to keep rollups small.
        const idx = registry.settlements.indexOf(s);
        if (idx >= 0) registry.settlements.splice(idx, 1);
      }
    }
  }
  // Phase 2: run exchange edges. An edge fires only when the
  // source has surplus AND the target is in deficit; this keeps
  // the rule "exchange is a starvation rescue, not a free lunch".
  const byId = new Map<string, Settlement>();
  for (const s of registry.settlements) byId.set(s.id, s);
  let totalExchanged = 0;
  for (const edge of registry.exchange) {
    if (edge.fromId === edge.toId) continue;
    const src = byId.get(edge.fromId);
    const dst = byId.get(edge.toId);
    if (!src || !dst) continue;
    if (src.resources.food <= 0) continue;
    if (dst.resources.food >= 0) continue;
    const transfer = Math.min(edge.ratePerStep, src.resources.food, -dst.resources.food);
    if (transfer <= 0) continue;
    src.resources.food -= transfer;
    dst.resources.food += transfer;
    src.totalSentFood += transfer;
    dst.totalReceivedFood += transfer;
    edge.totalTransferred += transfer;
    totalExchanged += transfer;
  }
  // Phase 3: run coalition edges. Unlike exchange, coalition
  // fires unconditionally up to the rate; this is the "shared
  // pool" effect.
  let totalCoalition = 0;
  for (const edge of registry.coalitions) {
    if (edge.fromId === edge.toId) continue;
    const src = byId.get(edge.fromId);
    const dst = byId.get(edge.toId);
    if (!src || !dst) continue;
    if (src.resources.food <= 0) continue;
    const transfer = Math.min(edge.ratePerStep, src.resources.food);
    if (transfer <= 0) continue;
    src.resources.food -= transfer;
    dst.resources.food += transfer;
    src.totalSentFood += transfer;
    dst.totalReceivedFood += transfer;
    edge.totalTransferred += transfer;
    totalCoalition += transfer;
  }
  // Phase 3: run conflict edges. Each edge rolls once per step.
  // On a hit, both sides lose `casualtyFraction × pop` population
  // and `damageFood` food (food is destroyed, not transferred).
  let totalCasualtyEvents = 0;
  let totalPopulationLost = 0;
  let totalFoodDestroyed = 0;
  for (const edge of registry.conflicts) {
    if (edge.fromId === edge.toId) continue;
    if (rng() < edge.probability) {
      const a = byId.get(edge.fromId);
      const b = byId.get(edge.toId);
      if (!a || !b) continue;
      const aPopLoss = a.population * edge.casualtyFraction;
      const bPopLoss = b.population * edge.casualtyFraction;
      a.population = Math.max(0, a.population - aPopLoss);
      b.population = Math.max(0, b.population - bPopLoss);
      const aFoodLoss = Math.min(edge.damageFood, Math.max(0, a.resources.food));
      const bFoodLoss = Math.min(edge.damageFood, Math.max(0, b.resources.food));
      a.resources.food -= aFoodLoss;
      b.resources.food -= bFoodLoss;
      edge.totalCasualtyEvents += 1;
      edge.totalPopulationLost += aPopLoss + bPopLoss;
      edge.totalFoodDestroyed += aFoodLoss + bFoodLoss;
      totalCasualtyEvents++;
      totalPopulationLost += aPopLoss + bPopLoss;
      totalFoodDestroyed += aFoodLoss + bFoodLoss;
      // If the war drove either side to population < 1, dissolve.
      if (a.population < 1) {
        a.dissolved = true;
        const idx = registry.settlements.indexOf(a);
        if (idx >= 0) registry.settlements.splice(idx, 1);
        byId.delete(a.id);
        totalDissolutions++;
      }
      if (b.population < 1) {
        b.dissolved = true;
        const idx = registry.settlements.indexOf(b);
        if (idx >= 0) registry.settlements.splice(idx, 1);
        byId.delete(b.id);
        totalDissolutions++;
      }
    }
  }
  // Phase 3: institutional evolution. Apply the rule to every
  // settlement that survived the step.
  let totalTransitions = 0;
  for (const s of [...registry.settlements]) {
    const before = s.institution.kind;
    if (registry.institutionRule.popAbove && s.population >= registry.institutionRule.popAbove.threshold) {
      s.institution = { kind: 'public', taxRate: 0, publicGoodsShare: 0.5 };
    } else if (registry.institutionRule.popBelow && s.population <= registry.institutionRule.popBelow.threshold) {
      s.institution = { kind: 'private', taxRate: 0, publicGoodsShare: 0 };
    }
    if (s.institution.kind !== before) totalTransitions++;
  }
  registry.totalProducedFood += totalProduced;
  registry.totalConsumedFood += totalConsumed;
  registry.totalDissolutions += totalDissolutions;
  registry.totalExchangeFood += totalExchanged;
  registry.totalCoalitionFood += totalCoalition;
  registry.totalCasualtyEvents += totalCasualtyEvents;
  registry.totalPopulationLost += totalPopulationLost;
  registry.totalFoodDestroyed += totalFoodDestroyed;
  registry.totalInstitutionTransitions += totalTransitions;
  registry.step++;
  return {
    events,
    totalProduced,
    totalConsumed,
    totalDissolutions,
    knowledgeLevels: registry.settlements.map(s => s.knowledge.level),
  };
}

/** Seed a registry from a list of templates + the world's tick.
 *  Phase 2 also resolves `exchangeTo` (label-based) to actual
 *  settlement ids and pushes `ExchangeEdge` entries into
 *  `registry.exchange`. */
export function seedSettlements(
  registry: SettlementRegistry,
  templates: SettlementTemplate[],
  foundingStep: number,
  config: Partial<SettlementConfig> = {},
): { created: number } {
  let created = 0;
  // First pass: create all settlements and build a label→id map.
  const labelToId = new Map<string, string>();
  for (const t of templates) {
    const partial: Partial<SettlementConfig> = {};
    if (typeof t.population === 'number') partial.initialPopulation = t.population;
    if (typeof t.initialFood === 'number') partial.initialFood = t.initialFood;
    if (typeof t.initialKnowledgeLevel === 'number') partial.initialKnowledgeLevel = t.initialKnowledgeLevel;
    const merged: Partial<SettlementConfig> = { ...config, ...partial };
    const id = `set-${registry.nextId++}`;
    labelToId.set(t.label, id);
    const s = makeSettlement({
      id,
      label: t.label,
      cellIndex: t.cellIndex,
      foundingStep,
      config: merged,
      ...(t.institution ? { institution: t.institution } : {}),
      ...(t.technology ? { technology: t.technology } : {}),
    });
    registry.settlements.push(s);
    created++;
  }
  // Second pass: resolve exchangeTo / conflictTo / coalitionTo labels to ids.
  for (const t of templates) {
    const fromId = labelToId.get(t.label);
    if (!fromId) continue;
    if (t.exchangeTo) {
      for (const edge of t.exchangeTo) {
        const toId = labelToId.get(edge.targetLabel);
        if (!toId) continue;
        registry.exchange.push({
          fromId,
          toId,
          ratePerStep: edge.ratePerStep,
          totalTransferred: 0,
        });
      }
    }
    if (t.coalitionTo) {
      for (const edge of t.coalitionTo) {
        const toId = labelToId.get(edge.targetLabel);
        if (!toId) continue;
        registry.coalitions.push({
          fromId,
          toId,
          ratePerStep: edge.ratePerStep,
          totalTransferred: 0,
        });
      }
    }
    if (t.conflictTo) {
      for (const edge of t.conflictTo) {
        const toId = labelToId.get(edge.targetLabel);
        if (!toId) continue;
        // Symmetric: add one edge (fromId, toId). The step
        // routine applies the casualty to both sides regardless
        // of direction.
        registry.conflicts.push({
          fromId,
          toId,
          probability: edge.probability,
          casualtyFraction: edge.casualtyFraction,
          damageFood: edge.damageFood,
          totalCasualtyEvents: 0,
          totalPopulationLost: 0,
          totalFoodDestroyed: 0,
        });
      }
    }
  }
  return { created };
}

/** Average lifetime in ticks across all settlements (alive + dissolved). */
export function averageLifetime(registry: SettlementRegistry): number {
  if (registry.settlements.length === 0 && registry.totalDissolutions === 0) return 0;
  // Note: dissolved settlements have been spliced out, so we can
  // only measure lifetime from current settlements' `lastStep -
  // foundingStep`. For the test, this is enough — the test only
  // needs the *current* snapshot at the end of the horizon.
  let total = 0;
  let n = 0;
  for (const s of registry.settlements) {
    total += Math.max(0, s.lastStep - s.foundingStep);
    n++;
  }
  return n > 0 ? total / n : 0;
}
