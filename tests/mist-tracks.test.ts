/**
 * MIST track contract tests.
 *
 * These tests only validate the *interface*: that arbitrary input is
 * validated as a `MistTrackTable`, that bad input is rejected, and that
 * `applyMistOverrides` produces bins compatible with the IMF partition.
 * They do not assert against real MIST data (the ~96 MB track bundle is
 * not in the repo; see src/simulation/cosmos/mist-tracks.ts for the
 * download + convert workflow).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMistTrackTable, applyMistOverrides } from '../src/simulation/cosmos/mist-tracks.ts';
import { integrateImf, IMF_MODEL } from '../src/simulation/cosmos/imf.ts';

const IMF_EDGES = [IMF_MODEL.minSolar, 0.5, 3, 8, IMF_MODEL.maxSolar] as const;

test('loadMistTrackTable accepts a minimal valid table', () => {
  const t = loadMistTrackTable({
    metallicity: 'solar',
    entries: [
      { minMassSolar: 0.08, maxMassSolar: 0.5, lifetimeMyr: 50000, returnedFraction: 0.4, luminositySolar: 0.01 },
      { minMassSolar: 0.5, maxMassSolar: 3, lifetimeMyr: 2000, returnedFraction: 0.6, luminositySolar: 2 },
      { minMassSolar: 3, maxMassSolar: 8, lifetimeMyr: 200, returnedFraction: 0.75, luminositySolar: 100 },
      { minMassSolar: 8, maxMassSolar: 100, lifetimeMyr: 10, returnedFraction: 0.85, luminositySolar: 10000 },
    ],
  });
  assert.equal(t.metallicity, 'solar');
  assert.equal(t.entries.length, 4);
});

test('loadMistTrackTable rejects non-contiguous, inverted, and out-of-range entries', () => {
  const base = (entries: unknown) => loadMistTrackTable({ metallicity: 'solar', entries });
  assert.throws(() => base([
    { minMassSolar: 0.5, maxMassSolar: 0.08, lifetimeMyr: 1, returnedFraction: 0.5, luminositySolar: 1 },
  ]), /exceed/);
  // Non-contiguous: second entry's min != first entry's max.
  assert.throws(() => base([
    { minMassSolar: 0.08, maxMassSolar: 0.5, lifetimeMyr: 1, returnedFraction: 0.5, luminositySolar: 1 },
    { minMassSolar: 1, maxMassSolar: 3, lifetimeMyr: 1, returnedFraction: 0.5, luminositySolar: 1 },
  ]), /contiguity/);
  // Out-of-range metallicity.
  assert.throws(() => loadMistTrackTable({ metallicity: 'foo', entries: [] }), /metallicity/);
  // Out-of-range numeric fields.
  assert.throws(() => base([
    { minMassSolar: -0.1, maxMassSolar: 0.5, lifetimeMyr: 1, returnedFraction: 0.5, luminositySolar: 1 },
  ]), /minMassSolar/);
  assert.throws(() => base([
    { minMassSolar: 0.08, maxMassSolar: 0.5, lifetimeMyr: 1, returnedFraction: 1.5, luminositySolar: 1 },
  ]), /returnedFraction/);
});

test('applyMistOverrides produces IMF-aligned lifetime / returned / luminosity', () => {
  const imf = integrateImf(IMF_EDGES);
  const table = loadMistTrackTable({
    metallicity: 'solar',
    entries: imf.map((seg, i) => ({
      minMassSolar: seg.minSolar,
      maxMassSolar: seg.maxSolar,
      // Use a *distinct* lifetimeMyr per bin so we can verify the override
      // actually flows through. Multiply by (i + 10) to keep them well
      // separated and within (0.1, 1e5).
      lifetimeMyr: 1000 * (i + 10),
      returnedFraction: 0.1 + 0.2 * i,
      luminositySolar: Math.pow(10, i),
    })),
  });
  const overridden = applyMistOverrides(imf, table);
  assert.equal(overridden.length, 4);
  for (let i = 0; i < imf.length; i++) {
    assert.equal(overridden[i]!.minSolar, imf[i]!.minSolar);
    assert.equal(overridden[i]!.maxSolar, imf[i]!.maxSolar);
    // lifetimeSteps = lifetimeMyr / 5; for the test above, i=0 → 10000,
    // i=1 → 11000, i=2 → 12000, i=3 → 13000.
    assert.equal(overridden[i]!.lifetimeSteps, (1000 * (i + 10)) / 5);
    assert.equal(overridden[i]!.returned, 0.1 + 0.2 * i);
    assert.equal(overridden[i]!.luminosity, Math.pow(10, i));
  }
});

test('applyMistOverrides rejects length / range mismatch with IMF partition', () => {
  const imf = integrateImf(IMF_EDGES);
  // Too few entries.
  assert.throws(() => applyMistOverrides(imf, loadMistTrackTable({
    metallicity: 'solar',
    entries: imf.slice(0, 2).map((seg, i) => ({
      minMassSolar: seg.minSolar, maxMassSolar: seg.maxSolar,
      lifetimeMyr: 1000, returnedFraction: 0.5, luminositySolar: 1,
    })),
  })), /segment count/);
  // Off-by-one mass range on the last entry.
  assert.throws(() => applyMistOverrides(imf, loadMistTrackTable({
    metallicity: 'solar',
    entries: imf.map((seg, i) => ({
      minMassSolar: seg.minSolar,
      maxMassSolar: i === imf.length - 1 ? seg.maxSolar + 1 : seg.maxSolar,
      lifetimeMyr: 1000, returnedFraction: 0.5, luminositySolar: 1,
    })),
  })), /mass range/);
});
