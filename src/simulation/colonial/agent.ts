/**
 * P13 — multi-cellular colonial agents.
 *
 * Per docs/15 P13: "spatial adjacent cells, adhesion, metabolic
 * exchange, maintenance cost, and collective reproduction; the
 * independent cell and the collective are different units of
 * selection. Same-colour aggregates are NOT automatically a multi-
 * cell organism; we need a boundary, a cooperation cost, internal
 * differentiation, and a collective life cycle."
 *
 * This file is the **interface + minimal reference implementation**
 * for a colonial registry. It does NOT yet plug into `WorldState` /
 * the planetary controller — that integration is the next milestone.
 * The reference implementation here is enough to:
 *
 *   1. Build a `ColonialOrganism` from a single founding member.
 *   2. Try to `adhere` a candidate (cell, cohort) into an existing
 *      organism when the spatial / trait / lineage predicates hold.
 *   3. Charge a maintenance cost against an external energy pool
 *      (the `ledger.externalEnergyInJ` from P11).
 *   4. Try to `fission` an organism when the size threshold is met,
 *      splitting its members between parent and child along a
 *      spatial-cut heuristic.
 *
 * The "two units of selection" requirement is the most important
 * one for the design: a colonial organism is a *new* fitness-bearing
 * unit distinct from its member cohorts. If the colony's maintenance
 * cost cannot be paid, the colony *dissolves* (members return to
 * independent cells), not the individuals — exactly because the
 * cooperative trait is the colony's, not the cell's.
 */
import type { WorldState } from '../core/contracts.ts';
import { species } from '../chemistry/network.ts';
import * as v from '../core/validation.ts';

// === Types ==============================================================

/** A cell-and-cohort pair that belongs to a colonial organism. */
export interface ColonialMember {
  cellIndex: number;
  cohortId: string;
  traitId: string;
}

/**
 * A multi-cellular organism. A member cohort remains an independent
 * unit of selection in its own right; the colony adds a *second*
 * selection layer that pays a maintenance cost, may reproduce
 * collectively, and dissolves if that cost is unmet.
 */
export interface ColonialOrganism {
  id: string;
  parentId: string | null;
  bornStep: number;
  members: ColonialMember[];
  /** Last step at which the colony fissioned (0 if never). */
  lastFissionStep: number;
}

/** Configuration for colonial dynamics. */
export interface ColonialConfig {
  /** Minimum number of members to call a colony "established". */
  minMembers: number;
  /** Members above this size trigger a fission event. */
  fissionMembers: number;
  /** Minimum step interval between fissions of the same colony. */
  fissionCooldown: number;
  /** Energy (J) charged per member per step. */
  maintenanceJPerMember: number;
  /** Trait IDs that are allowed to cohere. */
  admissibleTraitIds: readonly string[];
}

const DEFAULT_COLONIAL_CONFIG: ColonialConfig = {
  minMembers: 2,
  fissionMembers: 8,
  fissionCooldown: 50,
  maintenanceJPerMember: 1,
  admissibleTraitIds: [],
};

/** A registry of colonial organisms maintained outside `WorldState`. */
export interface ColonialRegistry {
  organisms: ColonialOrganism[];
  nextId: number;
  /** Cumulative energy spent on colonial maintenance. */
  totalMaintenanceJ: number;
  /** Cumulative fissions since the registry was created. */
  totalFissions: number;
}

export function makeColonialRegistry(): ColonialRegistry {
  return { organisms: [], nextId: 1, totalMaintenanceJ: 0, totalFissions: 0 };
}

// === Validation ==========================================================

export function validateColonialOrganism(input: unknown): asserts input is ColonialOrganism {
  const o = v.object(input, ['id', 'parentId', 'bornStep', 'members', 'lastFissionStep'], 'colonialOrganism');
  v.id(o.id, 'colonialOrganism.id');
  if (o.parentId !== null && typeof o.parentId !== 'string') {
    v.fail('colonialOrganism.parentId', 'must be a string or null');
  }
  v.integer(o.bornStep, 'colonialOrganism.bornStep', 0, 1e9);
  v.integer(o.lastFissionStep, 'colonialOrganism.lastFissionStep', 0, 1e9);
  const members = v.array(o.members, 'colonialOrganism.members', 4096);
  for (let i = 0; i < members.length; i++) {
    const m = v.object(members[i]!, ['cellIndex', 'cohortId', 'traitId'], 'member');
    v.integer(m.cellIndex, 'member.cellIndex', 0, 1e7);
    v.text(m.cohortId, 'member.cohortId', 256);
    v.text(m.traitId, 'member.traitId', 256);
  }
}

// === Adhesion ===========================================================

/**
 * Adhesion predicate: can the candidate (cell, cohort) join the
 * existing organism? Per P13 the answer is NOT "yes if same colour";
 * we also need spatial proximity (handled by the caller, this
 * function only checks the *intent*) and an admissible trait.
 */
export function canAdhere(
  organism: ColonialOrganism,
  candidate: ColonialMember,
  state: WorldState,
  config: ColonialConfig = DEFAULT_COLONIAL_CONFIG,
): boolean {
  // Admissible trait: either the config is permissive (empty list) or
  // the candidate's trait is explicitly listed.
  if (config.admissibleTraitIds.length > 0 && !config.admissibleTraitIds.includes(candidate.traitId)) return false;
  // A candidate cannot already be a member of this organism.
  for (const m of organism.members) {
    if (m.cellIndex === candidate.cellIndex && m.cohortId === candidate.cohortId) return false;
  }
  // Cells must exist on the world and have a non-empty cohort slot.
  if (candidate.cellIndex < 0 || candidate.cellIndex >= state.cells.areaM2.length) return false;
  // Adhesion must not collapse two different traits in the same
  // colonial organism (P13 internal differentiation rule: the
  // *organism* needs to evolve; mixing arbitrary traits would be
  // vestigial).
  for (const m of organism.members) {
    if (m.traitId !== candidate.traitId) return false;
  }
  return true;
}

/**
 * Try to form a new colonial organism from the candidate. Returns the
 * new organism on success, `null` if no organism can be built.
 */
export function tryFormColony(
  candidate: ColonialMember,
  state: WorldState,
  registry: ColonialRegistry,
  config: ColonialConfig = DEFAULT_COLONIAL_CONFIG,
  step = 0,
): ColonialOrganism | null {
  if (candidate.cellIndex < 0 || candidate.cellIndex >= state.cells.areaM2.length) return null;
  if (config.admissibleTraitIds.length > 0 && !config.admissibleTraitIds.includes(candidate.traitId)) return null;
  const organism: ColonialOrganism = {
    id: `org-${registry.nextId++}`,
    parentId: null,
    bornStep: step,
    members: [candidate],
    lastFissionStep: 0,
  };
  validateColonialOrganism(organism);
  registry.organisms.push(organism);
  return organism;
}

/**
 * Try to add a candidate to an existing organism. Returns the
 * updated organism on success, `null` otherwise.
 */
export function tryAdhere(
  organism: ColonialOrganism,
  candidate: ColonialMember,
  state: WorldState,
  config: ColonialConfig = DEFAULT_COLONIAL_CONFIG,
): ColonialOrganism | null {
  if (!canAdhere(organism, candidate, state, config)) return null;
  organism.members.push(candidate);
  validateColonialOrganism(organism);
  return organism;
}

// === Maintenance ========================================================

/**
 * Charge maintenance cost for every established organism (size ≥
 * `minMembers`). Returns the energy spent. If the available energy
 * cannot cover the cost, the organism **dissolves** (members return
 * to independent cells) — this is the "two units of selection"
 * behaviour: a colony is dropped, the cells continue.
 */
export function maintainColonialOrganisms(
  registry: ColonialRegistry,
  state: WorldState,
  energyInJ: number,
  config: ColonialConfig = DEFAULT_COLONIAL_CONFIG,
): { spent: number; dissolved: string[] } {
  let energy = energyInJ;
  const dissolved: string[] = [];
  const survivors: ColonialOrganism[] = [];
  for (const org of registry.organisms) {
    if (org.members.length < config.minMembers) { survivors.push(org); continue; }
    const cost = org.members.length * config.maintenanceJPerMember;
    if (energy >= cost) {
      energy -= cost;
      registry.totalMaintenanceJ += cost;
      survivors.push(org);
    } else {
      // Dissolve: the colony ceases; the member cohorts are *not*
      // killed (they remain independent cells in WorldState).
      dissolved.push(org.id);
    }
  }
  registry.organisms = survivors;
  return { spent: energyInJ - energy, dissolved };
}

// === Fission =============================================================

/**
 * Try to fission an organism when its size exceeds `fissionMembers`
 * and the cooldown has elapsed. Splits the organism's members into
 * parent (first half by cell index) and child (second half). Returns
 * the new child organism on success.
 */
export function tryFission(
  organism: ColonialOrganism,
  registry: ColonialRegistry,
  step: number,
  config: ColonialConfig = DEFAULT_COLONIAL_CONFIG,
): ColonialOrganism | null {
  if (organism.members.length < config.fissionMembers) return null;
  if (step - organism.lastFissionStep < config.fissionCooldown) return null;
  // Split along a spatial cut: sort members by cell index and assign
  // the lower half to the parent, upper half to the child.
  const sorted = [...organism.members].sort((a, b) => a.cellIndex - b.cellIndex);
  const mid = Math.floor(sorted.length / 2);
  const childMembers = sorted.splice(mid);
  organism.members = sorted;
  organism.lastFissionStep = step;
  const child: ColonialOrganism = {
    id: `org-${registry.nextId++}`,
    parentId: organism.id,
    bornStep: step,
    members: childMembers,
    lastFissionStep: 0,
  };
  validateColonialOrganism(child);
  registry.organisms.push(child);
  registry.totalFissions++;
  return child;
}
