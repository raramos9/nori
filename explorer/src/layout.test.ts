import { describe, expect, it } from 'vitest';
import { parseEvidenceId, parseRoutePattern, parseScreenId, parseTransitionId } from '../../src/graph/model.js';
import type { ExplorerGraph, ExplorerScreen, ExplorerTransition } from '../../src/explorer/view.js';
import { STATUSES, visibleGraph } from './flow.js';
import { layoutGraph } from './layout.js';

const hex = (n: number) => n.toString(16).padStart(16, '0');
const screen = (n: number, route: string): ExplorerScreen => ({
  id: parseScreenId(`scr_${hex(n)}`),
  route: parseRoutePattern(route),
  status: 'inferred',
  sources: [],
});

let counter = 0;
function transition(from: ExplorerScreen, to: ExplorerScreen): ExplorerTransition {
  counter += 1;
  return {
    id: parseTransitionId(`trn_${hex(counter)}`),
    sourceScreenId: from.id,
    trigger: 'link',
    target: { kind: 'screen', screenId: to.id },
    status: 'inferred',
    sources: [{ evidenceId: parseEvidenceId(`evd_${hex(counter)}`), file: 'a.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, extractor: 'x' }],
  };
}

function view(screens: ExplorerScreen[], edges: [ExplorerScreen, ExplorerScreen][]) {
  const graph: ExplorerGraph = {
    root: '/r',
    build: { id: 'b', commitSha: 'a'.repeat(40), branch: null, createdAt: '2026-01-01T00:00:00.000Z', analyzerVersion: '1' },
    screens,
    transitions: edges.map(([from, to]) => transition(from, to)),
  };
  return visibleGraph(graph, { statuses: new Set(STATUSES), showUnresolved: true });
}

function xOf(boxes: ReadonlyMap<string, { x: number }>, s: ExplorerScreen): number {
  const box = boxes.get(s.id);
  if (box === undefined) throw new Error(`no box for ${s.route}`);
  return box.x;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('layoutGraph', () => {
  it('lays a chain with a back edge out left to right', () => {
    const [a, b, c] = [screen(1, '/a'), screen(2, '/b'), screen(3, '/c')];
    const boxes = layoutGraph(view([a, b, c], [[a, b], [b, c], [c, a]]));
    expect(xOf(boxes, a)).toBeLessThan(xOf(boxes, b));
    expect(xOf(boxes, b)).toBeLessThan(xOf(boxes, c));
  });

  it('puts a focus centre between its in-neighbour and out-neighbour', () => {
    const [from, center, out, mutual] = [screen(1, '/from'), screen(2, '/center'), screen(3, '/out'), screen(4, '/mutual')];
    const boxes = layoutGraph(
      view([from, center, out, mutual], [[from, center], [center, out], [center, mutual], [mutual, center]]),
      center.id,
    );
    expect(xOf(boxes, from)).toBeLessThan(xOf(boxes, center));
    expect(xOf(boxes, center)).toBeLessThan(xOf(boxes, out));
  });

  it('lays out a dense cyclic graph quickly', () => {
    const random = mulberry32(42);
    const screens = Array.from({ length: 200 }, (_, i) => screen(i + 1, `/s${i}`));
    const edges: [ExplorerScreen, ExplorerScreen][] = [];
    for (const from of screens) {
      const targets = new Set<ExplorerScreen>();
      while (targets.size < 9) {
        const target = screens[Math.floor(random() * screens.length)];
        if (target !== undefined && target !== from) targets.add(target);
      }
      for (const target of targets) edges.push([from, target]);
    }
    const graph = view(screens, edges);
    expect(graph.links).toHaveLength(1800);

    const started = performance.now();
    const boxes = layoutGraph(graph);
    expect(boxes.size).toBe(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
