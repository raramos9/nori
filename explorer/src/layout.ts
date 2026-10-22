import dagre from '@dagrejs/dagre';
import type { ScreenId } from '../../src/graph/model.js';
import type { Link, VisibleGraph } from './flow.js';
import { ghostId } from './flow.js';

export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export const NODE_HEIGHT = 40;
export const GHOST_SIZE = { width: 132, height: 30 } as const;
const CHAR_WIDTH = 7.4;
const MIN_WIDTH = 84;
const MAX_WIDTH = 260;

export function screenWidth(route: string): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(route.length * CHAR_WIDTH + 44)));
}

// Left-to-right layers; dagre reports centres, React Flow positions by the top-left corner.
export function layoutGraph(graph: VisibleGraph, start?: ScreenId): ReadonlyMap<string, Box> {
  return place(graph, spanningForest(graph, start));
}

// Neighbours the centre links to rank right of it, neighbours that only link in rank left, so no drawn edge needs to cross its own endpoints.
export function layoutFocused(graph: VisibleGraph, center: ScreenId): ReadonlyMap<string, Box> {
  const rankEdges = new Map<string, [ScreenId, ScreenId]>();
  for (const { source, target } of graph.links) {
    if (source === center) rankEdges.set(target, [source, target]);
    else if (!rankEdges.has(source)) rankEdges.set(source, [source, target]);
  }
  return place(graph, [...rankEdges.values()]);
}

export function isBackward(source: Box, target: Box): boolean {
  return target.x + target.width <= source.x;
}

function place(graph: VisibleGraph, rankEdges: readonly (readonly [ScreenId, ScreenId])[]): ReadonlyMap<string, Box> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 110, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const screen of graph.screens) {
    g.setNode(screen.id, { width: screenWidth(screen.route), height: NODE_HEIGHT });
  }
  // dagre writes x and y onto the label object, so each node needs its own.
  for (const ghost of graph.ghosts) g.setNode(ghost.id, { ...GHOST_SIZE });
  // dagre ranks only a spanning forest: on dense cyclic graphs every long edge becomes a chain of dummy nodes.
  for (const [source, target] of rankEdges) g.setEdge(source, target);
  for (const ghost of graph.ghosts) g.setEdge(ghost.sourceScreenId, ghostId(ghost.sourceScreenId));

  dagre.layout(g);

  const boxes = new Map<string, Box>();
  for (const id of g.nodes()) {
    const node = g.node(id);
    boxes.set(id, { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height });
  }
  return boxes;
}

function spanningForest(graph: VisibleGraph, start: ScreenId | undefined): [ScreenId, ScreenId][] {
  const outgoing = new Map<ScreenId, Link[]>();
  const targets = new Set<ScreenId>();
  for (const link of graph.links) {
    const list = outgoing.get(link.source);
    if (list === undefined) outgoing.set(link.source, [link]);
    else list.push(link);
    targets.add(link.target);
  }

  const byRoute = [...graph.screens].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)).map(({ id }) => id);
  const seeds = [...byRoute.filter((id) => !targets.has(id)), ...(start === undefined ? [] : [start]), ...byRoute];

  const reached = new Set<ScreenId>();
  const edges: [ScreenId, ScreenId][] = [];
  const queue: ScreenId[] = [];
  let head = 0;
  for (const seed of seeds) {
    if (reached.has(seed)) continue;
    reached.add(seed);
    queue.push(seed);
    for (let source = queue[head]; source !== undefined; source = queue[++head]) {
      for (const { target } of outgoing.get(source) ?? []) {
        if (reached.has(target)) continue;
        reached.add(target);
        edges.push([source, target]);
        queue.push(target);
      }
    }
  }
  return edges;
}
