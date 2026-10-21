import { describe, expect, it } from 'vitest';
import {
  parseEvidenceId,
  parseRoutePattern,
  parseScreenId,
  parseTransitionId,
  type EvidenceStatus,
  type ScreenId,
} from '../../src/graph/model.js';
import type { ExplorerGraph, ExplorerScreen, ExplorerTarget, ExplorerTransition } from '../../src/explorer/view.js';
import { indexGraph, matchingScreens, STATUSES, visibleGraph, type Filters } from './flow.js';

const hex = (n: number) => n.toString(16).padStart(16, '0');
const screen = (n: number, route: string, status: EvidenceStatus = 'inferred'): ExplorerScreen => ({
  id: parseScreenId(`scr_${hex(n)}`),
  route: parseRoutePattern(route),
  status,
  sources: [],
});

let counter = 0;
function transition(
  from: ExplorerScreen,
  target: ExplorerTarget,
  status: EvidenceStatus = 'inferred',
): ExplorerTransition {
  counter += 1;
  return {
    id: parseTransitionId(`trn_${hex(counter)}`),
    sourceScreenId: from.id,
    trigger: 'link',
    target,
    status,
    sources: [{ evidenceId: parseEvidenceId(`evd_${hex(counter)}`), file: 'a.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, extractor: 'x' }],
  };
}
const to = (s: ExplorerScreen): ExplorerTarget => ({ kind: 'screen', screenId: s.id });
const dynamic: ExplorerTarget = { kind: 'unresolved', reason: 'dynamic-expression', expression: 'x' };

const home = screen(1, '/');
const about = screen(2, '/about');
const pricing = screen(3, '/pricing', 'observed');

const graph: ExplorerGraph = {
  root: '/r',
  build: { id: 'b', commitSha: 'a'.repeat(40), branch: null, createdAt: '2026-01-01T00:00:00.000Z', analyzerVersion: '1' },
  screens: [home, about, pricing],
  transitions: [
    transition(home, to(about)),
    transition(home, to(about)),
    transition(home, to(home)),
    transition(home, dynamic),
    transition(about, dynamic),
    transition(about, to(pricing), 'observed'),
  ],
};
const all: Filters = { statuses: new Set(STATUSES), showUnresolved: true };

describe('visibleGraph', () => {
  it('collapses parallel resolved calls, one ghost per source, and self-loops out of the edges', () => {
    const view = visibleGraph(graph, all);
    expect(view.links.map((l) => [l.source, l.target, l.transitions.length])).toEqual([
      [home.id, about.id, 2],
      [about.id, pricing.id, 1],
    ]);
    expect(view.ghosts.map((g) => [g.sourceScreenId, g.transitions.length])).toEqual([
      [home.id, 1],
      [about.id, 1],
    ]);
    expect(view.selfLoops.get(home.id)).toHaveLength(1);
  });

  it('drops ghosts when unresolved links are hidden', () => {
    expect(visibleGraph(graph, { ...all, showUnresolved: false }).ghosts).toEqual([]);
  });

  it('drops screens and the edges that touch them when their status is unchecked', () => {
    const view = visibleGraph(graph, { ...all, statuses: new Set<EvidenceStatus>(['inferred']) });
    expect(view.screens.map((s) => s.id)).toEqual([home.id, about.id]);
    expect(view.links.map((l) => l.target)).toEqual([about.id]);
  });
});

describe('indexGraph', () => {
  it('counts incoming resolved transitions and groups outgoing by source', () => {
    const index = indexGraph(graph);
    expect(index.incomingCount.get(about.id)).toBe(2);
    expect(index.outgoing.get(home.id)).toHaveLength(4);
  });
});

describe('matchingScreens', () => {
  it('matches routes case-insensitively and nothing for a blank query', () => {
    const ids = (q: string): ScreenId[] => [...matchingScreens(graph.screens, q)];
    expect(ids('PRIC')).toEqual([pricing.id]);
    expect(ids('  ')).toEqual([]);
  });
});
