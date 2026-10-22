import { describe, expect, it } from 'vitest';
import type { CallClassification } from '../src/ingest/navigation.js';
import { tally } from './rate.js';

const resolved: CallClassification = { kind: 'resolved' };
const unresolved: CallClassification = { kind: 'unresolved', reason: 'no-matching-route' };
const external: CallClassification = { kind: 'excluded', why: 'external' };

const call = (...classifications: CallClassification[]) => ({
  contexts: classifications.map((classification) => ({ source: null, classification })),
});

describe('tally', () => {
  it('counts a call resolved in every context as resolved', () => {
    expect(tally([call(resolved, resolved)])).toEqual({ internal: 1, resolved: 1 });
  });

  it('counts a call unresolved in any context as unresolved', () => {
    expect(tally([call(resolved, unresolved)])).toEqual({ internal: 1, resolved: 0 });
  });

  it('does not count an all-excluded call as internal', () => {
    expect(tally([call(external), call(external, external)])).toEqual({ internal: 0, resolved: 0 });
  });

  it('pools several calls', () => {
    expect(tally([call(resolved), call(unresolved), call(external)])).toEqual({ internal: 2, resolved: 1 });
  });
});
