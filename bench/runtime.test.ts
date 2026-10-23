import { describe, expect, it } from 'vitest';
import { stateId } from '../src/graph/ids.js';
import { parseScreenId, type EvidenceStatus, type StateId } from '../src/graph/model.js';
import { formatScore, score } from './runtime-score.js';

const sid = (n: number): StateId => stateId({ screenId: parseScreenId(`scr_${n.toString(16).padStart(16, '0')}`), key: 'default' });
const A = sid(1);
const B = sid(2);
const C = sid(3);

const screens = [
  { screen: { routePattern: '/' }, states: [{ id: A }], status: 'observed' as EvidenceStatus },
  { screen: { routePattern: '/about' }, states: [{ id: B }], status: 'inferred' as EvidenceStatus },
  { screen: { routePattern: '/pricing' }, states: [{ id: C }], status: 'inferred' as EvidenceStatus },
];
const edge = (from: StateId, to: StateId, status: EvidenceStatus) => ({
  transition: { sourceStateId: from, target: { kind: 'resolved' as const, stateId: to } },
  status,
});
const expected = { edges: [{ from: '/', to: '/about' }, { from: '/about', to: '/pricing' }, { from: '/', to: '/pricing' }] };

describe('score', () => {
  it('is zero when nothing is observed', () => {
    const result = score({ screens, transitions: [edge(A, B, 'inferred')] }, expected);
    expect(result).toEqual({ observed: 0, truth: 3, hits: 0, extras: [], missing: ['/ -> /about', '/ -> /pricing', '/about -> /pricing'], observedScreens: 1 });
  });

  it('counts observed edges that are in the truth as hits', () => {
    const result = score({ screens, transitions: [edge(A, B, 'observed'), edge(B, C, 'inferred')] }, expected);
    expect(result).toMatchObject({ observed: 1, hits: 1, extras: [] });
  });

  it('reports observed edges outside the truth as extras', () => {
    const result = score({ screens, transitions: [edge(C, A, 'observed')] }, expected);
    expect(result).toMatchObject({ observed: 1, hits: 0, extras: ['/pricing -> /'] });
  });

  it('counts an edge once however many transitions observe it', () => {
    const result = score({ screens, transitions: [edge(A, B, 'observed'), edge(A, B, 'observed')] }, expected);
    expect(result.observed).toBe(1);
  });

  it('ignores unresolved transitions', () => {
    const unresolved = {
      transition: { sourceStateId: A, target: { kind: 'unresolved' as const, reason: 'runtime-only' as const, expression: 'x' } },
      status: 'observed' as EvidenceStatus,
    };
    expect(score({ screens, transitions: [unresolved] }, expected).observed).toBe(0);
  });

  it('formats a compact report', () => {
    const text = formatScore(score({ screens, transitions: [edge(C, A, 'observed')] }, expected));
    expect(text).toContain('observed 1 of 3 edges, 0 in expected.json');
    expect(text).toContain('extra /pricing -> /');
  });
});
