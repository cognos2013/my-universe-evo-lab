/**
 * V14 — visual route interfaces.
 *
 * Per docs/01-02, the V1-V5 visual route was paused (Phase 1
 * priority was the simulation engine). This file re-opens the
 * route at the **interface level only**: the actual World Labs
 * integration (Marble / Atlas / World API / Spark) requires
 * API-key provisioning and commercial agreement per docs/04.
 *
 * The phase-1 surface area is:
 *
 *   - `V14Backend` (the kind of generator the user picked).
 *   - `V14WorldSpec` (the prompt + size + style).
 *   - `V14WorldResult` (the produced geometry, returned to the
 *     UI so it can render a 3D scene + show a metadata card).
 *   - `generateWorld(spec, options)` (the router entry point —
 *     picks the right backend and returns the result).
 *
 * Each backend implements `V14BackendImpl` and is registered
 * in `router.ts`. The default backend is `'inRepo'`, which
 * produces an honest procedural mesh (a sphere displaced by
 * low-frequency noise) and self-labels the result as a
 * placeholder so the UI banner reads correctly.
 */
import * as v from '../core/validation.ts';

export type V14Backend = 'inRepo' | 'worldLabs' | 'atlas' | 'spark';

/**
 * Kinds of procedural models the in-repo backend can produce.
 * Each kind has its own generator function in `inRepo.ts` that
 * synthesises a realistic-looking mesh from a seed + style hint.
 *
 * 'cityscape' (V14-4) is the only kind that takes additional
 * context: a `V14CitySpec` linking the result to a P15
 * settlement + the cell it occupies. Building count / height /
 * roof style then mirror the settlement's population /
 * knowledge / institution. The other four kinds only need
 * `prompt + kind + resolution + style + seed`.
 */
export type ProceduralKind = 'terrain' | 'tree' | 'building' | 'rock' | 'humanoid' | 'cityscape';

export const ALL_PROCEDURAL_KINDS: readonly ProceduralKind[] = [
  'terrain', 'tree', 'building', 'rock', 'humanoid', 'cityscape',
] as const;

/** The contract every backend (in-repo, World Labs, ...) must
 *  implement. `kind` is the discriminator; `sourceLabel` is the
 *  honest provenance string the UI displays in the banner. */
export interface V14BackendImpl {
  readonly kind: V14Backend;
  readonly sourceLabel: string;
  generate(spec: V14WorldSpec): Promise<V14WorldResult>;
}

export interface V14WorldSpec {
  /** Text prompt. May be empty for purely procedural specs. The
   *  in-repo backend mixes it into the seed so the same prompt
   *  always produces the same mesh. */
  prompt: string;
  /** What kind of procedural model to generate. Default
   *  `'terrain'`. */
  kind: ProceduralKind;
  /** Mesh resolution. For terrain this is the grid size; for
   *  other kinds it's a detail multiplier. Default 32. */
  resolution: number;
  /** Style hint (interpreted per-kind by the backend). */
  style: 'smooth' | 'rocky' | 'crystal' | 'organic';
  /** Optional explicit seed (string). If absent, the backend
   *  derives one from the prompt + style. */
  seed?: string;
  /**
   * Settlement context for the `cityscape` kind. The generator
   * reads `settlementId` from the active P15 settlement
   * registry; the rest is resolved at generation time by the
   * controller so the UI doesn't have to. Optional — when
   * absent, `cityscape` falls back to a small generic city.
   */
  city?: {
    settlementId: string;
    /** Wall-clock snapshot of the settlement at the moment of
     *  the request; the controller re-validates against the
     *  current book on the worker side. */
    label?: string;
    population: number;
    knowledgeLevel: number;
    institution: 'public' | 'private' | 'mixed';
    taxRate: number;
    techCount: number;
    food: number;
    cellIndex: number;
    cellAreaM2: number;
    cellNutrientMu: number;
    cellTemperatureK: number;
  } | null;
}

export interface V14WorldResult {
  /** Which backend produced this result. */
  backend: V14Backend;
  /** Honest label of the data source — surfaces the docs/04
   *  placeholder caveat. The UI banner reads this verbatim. */
  sourceLabel: string;
  /** Generated vertices as a flat `Float32Array` of `(x, y, z)`
   *  triples. */
  vertices: Float32Array;
  /** Per-vertex RGB colour, flat `Float32Array` of triples. */
  colors: Float32Array;
  /** Indices for triangulated faces (flat `Uint32Array`). */
  indices: Uint32Array;
  /** Center-to-bounding-sphere radius (used by the UI to frame
   *  the camera). */
  boundingRadius: number;
  /** Generation duration in ms (for the UI to report). */
  durationMs: number;
}

/**
 * A persistent V14 result with metadata. The book stores a list of
 * these (`book.v14Snapshots`) so the user can re-render any earlier
 * generation later (e.g. compare a "rocky" terrain at tick 200 vs a
 * "smooth" one at tick 800).
 */
export interface V14Snapshot {
  /** Stable id; UI keys + cross-references use this. */
  id: string;
  /** Human-readable label (e.g. "tick 200 / rocky coast"). */
  label: string;
  /** World tick at the moment of generation. Null when the
   *  experiment book has no active world (e.g. before the user
   *  creates one). */
  createdAtTick: number | null;
  /** Branch id at the moment of generation. Lets the UI warn
   *  when the user switches branches and the snapshot was made
   *  on a different one. */
  createdAtBranch: string | null;
  /** The spec used to generate this snapshot. */
  spec: V14WorldSpec;
  /** Backend that produced the result. */
  backend: V14Backend;
  /** Honest label of the data source (UI banner verbatim). */
  sourceLabel: string;
  /** Generated vertices. */
  vertices: Float32Array;
  /** Per-vertex colours. */
  colors: Float32Array;
  /** Triangle indices. */
  indices: Uint32Array;
  /** Bounding-sphere radius. */
  boundingRadius: number;
  /** Generation duration in ms. */
  durationMs: number;
  /** Wall-clock timestamp (ms since epoch) at the moment of
   *  generation. The UI uses this to sort "most recent". */
  createdAtMs: number;
}

/**
 * Lightweight summary the controller publishes in projections.
 * Excludes the heavy mesh data (vertices / colors / indices) so
 * a projection doesn't copy ~100 kB through the postMessage
 * channel on every tick.
 */
export interface V14SnapshotSummary {
  id: string;
  label: string;
  createdAtTick: number | null;
  createdAtBranch: string | null;
  spec: V14WorldSpec;
  backend: V14Backend;
  sourceLabel: string;
  vertexCount: number;
  indexCount: number;
  boundingRadius: number;
  durationMs: number;
  createdAtMs: number;
}

/** Build a summary from a full snapshot. */
export function summariseV14Snapshot(s: V14Snapshot): V14SnapshotSummary {
  return {
    id: s.id,
    label: s.label,
    createdAtTick: s.createdAtTick,
    createdAtBranch: s.createdAtBranch,
    spec: s.spec,
    backend: s.backend,
    sourceLabel: s.sourceLabel,
    vertexCount: s.vertices.length / 3,
    indexCount: s.indices.length,
    boundingRadius: s.boundingRadius,
    durationMs: s.durationMs,
    createdAtMs: s.createdAtMs,
  };
}

/**
 * Make a default human label from a spec + world tick. Used when
 * the caller does not pass a `label` to the v14Generate handler.
 */
export function defaultV14Label(spec: V14WorldSpec, tick: number | null): string {
  const tickPart = tick === null ? '' : `tick ${tick} · `;
  return `${tickPart}${spec.kind}/${spec.style}/${spec.resolution}`;
}

/** Build a `V14Snapshot` from a result + metadata. */
export function makeV14Snapshot(args: {
  id: string;
  spec: V14WorldSpec;
  result: V14WorldResult;
  tick: number | null;
  branch: string | null;
  label?: string;
  createdAtMs?: number;
}): V14Snapshot {
  return {
    id: args.id,
    label: args.label ?? defaultV14Label(args.spec, args.tick),
    createdAtTick: args.tick,
    createdAtBranch: args.branch,
    spec: args.spec,
    backend: args.result.backend,
    sourceLabel: args.result.sourceLabel,
    vertices: args.result.vertices,
    colors: args.result.colors,
    indices: args.result.indices,
    boundingRadius: args.result.boundingRadius,
    durationMs: args.result.durationMs,
    createdAtMs: args.createdAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  };
}

// === V14 batch parameter scan (G) =====================================

/**
 * Param sweep for `v14BatchScan`. The handler runs
 * `seeds.length × kinds.length × styles.length` separate
 * generations and pushes every result as a snapshot on the
 * book. The same `prompt` is reused across all runs (the seed
 * differs per run, so the meshes still vary).
 */
export interface V14BatchScanSpec {
  /** Optional fixed prompt; default `'batch'`. */
  prompt?: string;
  /** Seeds to scan (1—16). Each becomes `seed-${n}`. */
  seeds: number[];
  /** Kinds to include (1—5 entries from `ALL_PROCEDURAL_KINDS`). */
  kinds: ProceduralKind[];
  /** Styles to include (1—4 entries). */
  styles: V14WorldSpec['style'][];
  /** Resolution used for every run (4—256). */
  resolution: number;
  /** Optional label prefix; the snapshot label is
   *  `${labelPrefix} ${kind}/${style}/s${seed}`. */
  labelPrefix?: string;
}

/** Validate a `V14BatchScanSpec`. */
export function validateV14BatchScanSpec(s: unknown): asserts s is V14BatchScanSpec {
  if (!s || typeof s !== 'object') v.fail('v14BatchSpec', 'must be an object');
  const o = s as Record<string, unknown>;
  if (o.prompt !== undefined && typeof o.prompt !== 'string') {
    v.fail('v14BatchSpec.prompt', 'must be a string when present');
  }
  if (!Array.isArray(o.seeds) || o.seeds.length === 0) {
    v.fail('v14BatchSpec.seeds', 'must be a non-empty array');
  }
  if (o.seeds.length > 16) v.fail('v14BatchSpec.seeds', 'length ≤ 16');
  for (let i = 0; i < o.seeds.length; i++) {
    if (typeof o.seeds[i] !== 'number' || !Number.isInteger(o.seeds[i]) || o.seeds[i]! < 0) {
      v.fail(`v14BatchSpec.seeds[${i}]`, 'must be a non-negative integer');
    }
  }
  if (!Array.isArray(o.kinds) || o.kinds.length === 0) {
    v.fail('v14BatchSpec.kinds', 'must be a non-empty array');
  }
  if (o.kinds.length > ALL_PROCEDURAL_KINDS.length) {
    v.fail('v14BatchSpec.kinds', `length ≤ ${ALL_PROCEDURAL_KINDS.length}`);
  }
  for (let i = 0; i < o.kinds.length; i++) {
    if (!ALL_PROCEDURAL_KINDS.includes(o.kinds[i] as ProceduralKind)) {
      v.fail(`v14BatchSpec.kinds[${i}]`, 'must be one of terrain / tree / building / rock / humanoid');
    }
  }
  const validStyles = ['smooth', 'rocky', 'crystal', 'organic'] as const;
  if (!Array.isArray(o.styles) || o.styles.length === 0) {
    v.fail('v14BatchSpec.styles', 'must be a non-empty array');
  }
  for (let i = 0; i < o.styles.length; i++) {
    if (!validStyles.includes(o.styles[i] as typeof validStyles[number])) {
      v.fail(`v14BatchSpec.styles[${i}]`, 'must be one of smooth / rocky / crystal / organic');
    }
  }
  if (typeof o.resolution !== 'number' || !Number.isInteger(o.resolution) || o.resolution < 4 || o.resolution > 256) {
    v.fail('v14BatchSpec.resolution', 'must be an integer in [4, 256]');
  }
  if (o.labelPrefix !== undefined && typeof o.labelPrefix !== 'string') {
    v.fail('v14BatchSpec.labelPrefix', 'must be a string when present');
  }
}

/**
 * Report returned by `v14BatchScan`. The histogram bins are
 * coarse: vertex / triangle counts use powers of 2, durationMs
 * uses 1/2/5/10/20/50/100/200/500/1000+ ms. The UI renders
 * these as bar charts; the controller doesn't have a graphing
 * library so the bins are designed to be readable as plain
 * numbers in a `<ul>` too.
 */
export interface V14BatchReport {
  /** Total runs actually executed. */
  totalRuns: number;
  /** Per-kind counts. */
  perKind: Record<ProceduralKind, number>;
  /** Per-style counts. */
  perStyle: Record<V14WorldSpec['style'], number>;
  /** Vertex-count histogram (bin index → count). The bin label
   *  is the upper bound (rounded to nearest 1k). */
  vertexHistogram: { label: string; count: number }[];
  /** Duration (ms) histogram. */
  durationHistogram: { label: string; count: number }[];
  /** Mean / median vertex count across all runs. */
  vertexStats: { mean: number; median: number; min: number; max: number };
  /** Mean / median duration across all runs. */
  durationStats: { mean: number; median: number; min: number; max: number };
  /** Total wall-clock duration (sum of per-run `durationMs` is
   *  misleading; this is real elapsed time). */
  totalDurationMs: number;
  /** Snapshot ids of every run (the UI can open any of them). */
  snapshotIds: string[];
  /** Backend that produced all results (typically `'inRepo'`). */
  backend: V14Backend;
  /** World tick at the moment the scan started; null when no
   *  world is loaded. */
  startedAtTick: number | null;
  /** Branch id at the moment the scan started. */
  startedAtBranch: string | null;
}

/** Validate a `V14WorldSpec`. */
export function validateV14Spec(s: unknown): asserts s is V14WorldSpec {
  if (!s || typeof s !== 'object') v.fail('v14Spec', 'must be an object');
  const o = s as Record<string, unknown>;
  if (typeof o.prompt !== 'string') v.fail('v14Spec.prompt', 'must be a string');
  v.text(o.prompt, 'v14Spec.prompt', 1024);
  const kind = o.kind ?? 'terrain';
  if (kind !== 'terrain' && kind !== 'tree' && kind !== 'building' && kind !== 'rock' && kind !== 'humanoid' && kind !== 'cityscape') {
    v.fail('v14Spec.kind', 'must be one of terrain / tree / building / rock / humanoid / cityscape');
  }
  if (typeof o.resolution !== 'number' || !Number.isInteger(o.resolution) || o.resolution < 4 || o.resolution > 256) {
    v.fail('v14Spec.resolution', 'must be an integer in [4, 256]');
  }
  if (o.style !== 'smooth' && o.style !== 'rocky' && o.style !== 'crystal' && o.style !== 'organic') {
    v.fail('v14Spec.style', 'must be one of smooth / rocky / crystal / organic');
  }
  if (o.seed !== undefined && typeof o.seed !== 'string') {
    v.fail('v14Spec.seed', 'must be a string when present');
  }
  if (o.city !== undefined && o.city !== null) {
    const c = o.city as Record<string, unknown>;
    if (typeof c.settlementId !== 'string' || c.settlementId.length === 0) {
      v.fail('v14Spec.city.settlementId', 'must be a non-empty string');
    }
    if (typeof c.population !== 'number' || !Number.isFinite(c.population) || c.population < 0) {
      v.fail('v14Spec.city.population', 'must be a non-negative number');
    }
    if (typeof c.knowledgeLevel !== 'number' || !Number.isFinite(c.knowledgeLevel) || c.knowledgeLevel < 0) {
      v.fail('v14Spec.city.knowledgeLevel', 'must be a non-negative number');
    }
    if (c.institution !== 'public' && c.institution !== 'private' && c.institution !== 'mixed') {
      v.fail('v14Spec.city.institution', 'must be one of public / private / mixed');
    }
    if (typeof c.taxRate !== 'number' || c.taxRate < 0 || c.taxRate > 1) {
      v.fail('v14Spec.city.taxRate', 'must be a number in [0, 1]');
    }
    if (typeof c.techCount !== 'number' || c.techCount < 0) {
      v.fail('v14Spec.city.techCount', 'must be a non-negative number');
    }
    if (typeof c.food !== 'number' || c.food < 0) {
      v.fail('v14Spec.city.food', 'must be a non-negative number');
    }
    if (typeof c.cellIndex !== 'number' || !Number.isInteger(c.cellIndex) || c.cellIndex < 0) {
      v.fail('v14Spec.city.cellIndex', 'must be a non-negative integer');
    }
  }
}
