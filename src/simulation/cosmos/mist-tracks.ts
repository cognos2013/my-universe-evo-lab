/**
 * MIST stellar-evolution track integration.
 *
 * P10-C exit gate (per docs/15-模拟能力主线-P10至P17.md and
 * docs/18-P10C-恒星演化开发记录.md) requires replacing the
 * segment-midpoint teaching proxies in `STELLAR_BINS` with
 * downloaded MIST v1.2 tracks. This file defines the **interface
 * contract**; the actual ~96 MB track data is not bundled with the
 * repository. The intended workflow is:
 *
 *   1. User downloads MIST v1.2 from https://waps.cfa.harvard.edu/MIST/
 *      (non-rotating, [Fe/H] = 0 track bundle, ~96 MB).
 *   2. The user runs a one-time conversion (out of scope here) that
 *      reads the MIST EEP tracks and writes a compact JSON table of
 *      the form `MistTrackTable` below. The expected reduction is
 *      ~kilobytes per metallicity × O(metallicities) since we only
 *      need the lifetime, returned-fraction, and luminosity envelope
 *      for the metallicity bins P10-C cares about.
 *   3. The table is placed in the project (e.g. `data/mist-tracks.json`)
 *      and loaded at startup; `applyMistOverrides()` produces a
 *      STELLAR_BINS-equivalent array with the teaching proxies
 *      replaced.
 *
 * Until step 3 happens, this file is dormant: `loadMistTrackTable`
 * validates arbitrary input, `applyMistOverrides` falls back to
 * the original STELLAR_BINS (no-op), and the project keeps using the
 * segment-midpoint proxies. See `stellar-imf-v1` ModelCard in
 * `src/knowledge/model-cards.ts` for the limitation statement.
 */
import * as v from '../core/validation.ts';

export type MistMetallicity = 'primordial' | 'metal-poor' | 'solar' | 'metal-rich';

export const MIST_METALLICITIES: ReadonlyArray<MistMetallicity> = [
  'primordial', 'metal-poor', 'solar', 'metal-rich',
];

/** One segment entry keyed by IMF mass range. */
export interface MistTrackEntry {
  /** Lower bound of the segment in solar masses (inclusive). */
  minMassSolar: number;
  /** Upper bound of the segment in solar masses (exclusive). */
  maxMassSolar: number;
  /** Total stellar lifetime at this segment's representative mass, in Myr. */
  lifetimeMyr: number;
  /** Fraction of the population's mass returned to the hot ISM at death (0..1). */
  returnedFraction: number;
  /** Time-averaged luminosity in L☉ across the segment. */
  luminositySolar: number;
}

/** Per-metallicity track table. */
export interface MistTrackTable {
  metallicity: MistMetallicity;
  /** Mass → entry, sorted by minMassSolar ascending, contiguous, no gaps. */
  entries: MistTrackEntry[];
  /** Source URL for audit; not validated, just stored. */
  source?: string;
}

/** Validate an arbitrary input as a `MistTrackTable`. */
export function loadMistTrackTable(input: unknown): MistTrackTable {
  const t = v.object(input, ['metallicity', 'entries'], 'mistTrackTable');
  v.choice(t.metallicity, [...MIST_METALLICITIES], 'mistTrackTable.metallicity');
  const entries = v.array(t.entries, 'mistTrackTable.entries', 64);
  const validated: MistTrackEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = v.object(entries[i]!, ['minMassSolar', 'maxMassSolar', 'lifetimeMyr', 'returnedFraction', 'luminositySolar'], 'mistTrackTable.entry');
    const min = v.number(e.minMassSolar, 'entry.minMassSolar', 0.01, 200);
    const max = v.number(e.maxMassSolar, 'entry.maxMassSolar', 0.01, 200);
    if (max <= min) v.fail('entry.maxMassSolar', 'must exceed minMassSolar');
    if (i > 0 && min !== validated[i - 1]!.maxMassSolar) {
      v.fail('entry.minMassSolar', `must equal previous maxMassSolar (${validated[i - 1]!.maxMassSolar}) for contiguity`);
    }
    validated.push({
      minMassSolar: min,
      maxMassSolar: max,
      lifetimeMyr: v.number(e.lifetimeMyr, 'entry.lifetimeMyr', 0.1, 1e5),
      returnedFraction: v.number(e.returnedFraction, 'entry.returnedFraction', 0, 1),
      luminositySolar: v.number(e.luminositySolar, 'entry.luminositySolar', 1e-6, 1e7),
    });
  }
  const table: MistTrackTable = {
    metallicity: t.metallicity as MistMetallicity,
    entries: validated,
  };
  if (typeof t.source === 'string') table.source = t.source;
  return table;
}

interface StellarBinWithLifetime {
  minSolar: number;
  maxSolar: number;
  lifetimeSteps: number;
  returned: number;
  luminosity: number;
  /** Myr → step conversion: 1 lifetimeStep is by default 5 Myr (the
   * legacy step size), so `lifetimeMyr / 5` is the number of default
   * steps a population with this lifetime survives. */
}

/**
 * Build a MIST-driven replacement for the segment-midpoint teaching
 * proxies. Each IMF segment's `lifetimeSteps` is recomputed so that
 * `lifetimeSteps * 5` Myr = `entry.lifetimeMyr`; `returned` and
 * `luminosity` come straight from the MIST table.
 *
 * The returned array's `lifetimeSteps` is in the canonical 5-Myr
 * step unit so `stepGalaxies`'s rescaling continues to work
 * (`lifetimeInSteps = lifetimeSteps * (5 / dtMyr)`).
 */
export function applyMistOverrides(
  imfBins: ReadonlyArray<{ minSolar: number; maxSolar: number; meanSolar: number; massFraction: number; numberPerSolar: number }>,
  table: MistTrackTable,
): StellarBinWithLifetime[] {
  if (imfBins.length !== table.entries.length) {
    throw new Error(`IMF segment count (${imfBins.length}) does not match MIST table entries (${table.entries.length})`);
  }
  for (let i = 0; i < imfBins.length; i++) {
    if (imfBins[i]!.minSolar !== table.entries[i]!.minMassSolar ||
        imfBins[i]!.maxSolar !== table.entries[i]!.maxMassSolar) {
      throw new Error(`MIST entry ${i} mass range (${table.entries[i]!.minMassSolar}—${table.entries[i]!.maxMassSolar}) does not match IMF segment (${imfBins[i]!.minSolar}—${imfBins[i]!.maxSolar})`);
    }
  }
  return imfBins.map((seg, i) => {
    const e = table.entries[i]!;
    return {
      minSolar: seg.minSolar,
      maxSolar: seg.maxSolar,
      lifetimeSteps: e.lifetimeMyr / 5,
      returned: e.returnedFraction,
      luminosity: e.luminositySolar,
    };
  });
}
