import dagre from '@dagrejs/dagre';
import type { VisibleGraph } from './flow.js';
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
export function layoutGraph(graph: VisibleGraph): ReadonlyMap<string, Box> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 110, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const screen of graph.screens) {
    g.setNode(screen.id, { width: screenWidth(screen.route), height: NODE_HEIGHT });
  }
  // dagre writes x and y onto the label object, so each node needs its own.
  for (const ghost of graph.ghosts) g.setNode(ghost.id, { ...GHOST_SIZE });
  for (const link of graph.links) g.setEdge(link.source, link.target);
  for (const ghost of graph.ghosts) g.setEdge(ghost.sourceScreenId, ghostId(ghost.sourceScreenId));

  dagre.layout(g);

  const boxes = new Map<string, Box>();
  for (const id of g.nodes()) {
    const node = g.node(id);
    boxes.set(id, { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height });
  }
  return boxes;
}
