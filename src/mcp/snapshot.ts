import { sourceIndex } from '../explorer/source.js';
import type { ExplorerGraph, ExplorerScreen, ExplorerTransition, SourceRef } from '../explorer/view.js';
import type { CommitSha } from '../graph/model.js';

export type FreshnessKey = {
  readonly commitSha: CommitSha;
  readonly sourceHash: string;
};

export type GraphIndex = {
  readonly screens: ReadonlyMap<string, ExplorerScreen>;
  readonly outgoing: ReadonlyMap<string, readonly ExplorerTransition[]>;
  readonly incoming: ReadonlyMap<string, readonly ExplorerTransition[]>;
  readonly sources: ReadonlyMap<string, SourceRef>;
};

export type Snapshot = {
  readonly key: FreshnessKey;
  readonly graph: ExplorerGraph;
  readonly index: GraphIndex;
};

export function sameKey(a: FreshnessKey, b: FreshnessKey): boolean {
  return a.commitSha === b.commitSha && a.sourceHash === b.sourceHash;
}

function indexGraph(graph: ExplorerGraph): GraphIndex {
  const outgoing = new Map<string, ExplorerTransition[]>();
  const incoming = new Map<string, ExplorerTransition[]>();
  const push = (index: Map<string, ExplorerTransition[]>, key: string, transition: ExplorerTransition) => {
    const list = index.get(key);
    if (list === undefined) index.set(key, [transition]);
    else list.push(transition);
  };
  for (const transition of graph.transitions) {
    push(outgoing, transition.sourceScreenId, transition);
    if (transition.target.kind === 'screen') push(incoming, transition.target.screenId, transition);
  }
  return {
    screens: new Map(graph.screens.map((screen) => [screen.id, screen])),
    outgoing,
    incoming,
    sources: sourceIndex(graph),
  };
}

export function createSnapshot({ graph, key }: { graph: ExplorerGraph; key: FreshnessKey }): Snapshot {
  return { key, graph, index: indexGraph(graph) };
}
