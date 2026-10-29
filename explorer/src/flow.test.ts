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
import { NO_TESTS } from '../../src/graph/tests.js';
import { focusGraph, indexGraph, matchingScreens, STATUSES, visibleGraph, walk, type Filters } from './flow.js';
import { layoutGraph } from './layout.js';

const hex = (n: number) => n.toString(16).padStart(16, '0');
const screen = (n: number, route: string, status: EvidenceStatus = 'inferred'): ExplorerScreen => ({
  id: parseScreenId(`scr_${hex(n)}`),
  route: parseRoutePattern(route),
  status,
  sources: [],
  captures: [],
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
    walks: [],
    runtimeOnly: false,
    observedIn: [],
    mayExplain: [],
    tests: NO_TESTS,
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
  runs: [],
  coverage: { denominator: 'candidate transitions in snapshot snp_test', inferred: 0, observed: 0, exercisedByPassingTest: 0 },
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

describe('layoutGraph', () => {
  it('gives every node its own position', () => {
    const boxes = [...layoutGraph(visibleGraph(graph, all)).values()];
    expect(boxes).toHaveLength(5);
    expect(new Set(boxes.map(({ x, y }) => `${x},${y}`)).size).toBe(boxes.length);
  });
});

describe('focusGraph', () => {
  const contact = screen(4, '/contact');
  const faq = screen(5, '/faq');
  const wide: ExplorerGraph = {
    ...graph,
    screens: [home, about, pricing, contact, faq],
    transitions: [
      ...graph.transitions,
      transition(contact, to(about)),
      transition(pricing, to(contact)),
      transition(faq, to(faq)),
      transition(faq, dynamic),
    ],
  };
  const view = visibleGraph(wide, all);

  it('keeps in and out neighbours but drops unrelated screens and links between neighbours', () => {
    const focused = focusGraph(view, about.id);
    expect(focused?.screens.map((s) => s.id)).toEqual([home.id, about.id, pricing.id, contact.id]);
    expect(focused?.links.map((l) => [l.source, l.target])).toEqual([
      [home.id, about.id],
      [about.id, pricing.id],
      [contact.id, about.id],
    ]);
  });

  it('keeps only the center ghost and self-loops', () => {
    const focused = focusGraph(view, home.id);
    expect(focused?.ghosts.map((g) => g.sourceScreenId)).toEqual([home.id]);
    expect([...(focused?.selfLoops.keys() ?? [])]).toEqual([home.id]);
    expect(focusGraph(view, faq.id)?.screens.map((s) => s.id)).toEqual([faq.id]);
  });

  it('is null when the center is filtered out', () => {
    const inferred = visibleGraph(wide, { ...all, statuses: new Set<EvidenceStatus>(['inferred']) });
    expect(focusGraph(inferred, pricing.id)).toBeNull();
  });
});

describe('walk', () => {
  it('appends new screens, truncates on revisit, and ignores revisiting the center', () => {
    const trail = walk(walk(walk([], home.id), about.id), pricing.id);
    expect(trail).toEqual([home.id, about.id, pricing.id]);
    expect(walk(trail, about.id)).toEqual([home.id, about.id]);
    expect(walk(trail, pricing.id)).toEqual(trail);
  });
});
