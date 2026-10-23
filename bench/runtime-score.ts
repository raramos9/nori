import type { BuildGraph, EvidenceStatus, StateId, TransitionTarget } from '../src/graph/model.js';

export type Expected = {
  readonly edges: readonly { readonly from: string; readonly to: string }[];
};

type ScorableGraph = {
  readonly screens: readonly {
    readonly screen: { readonly routePattern: string };
    readonly states: readonly { readonly id: StateId }[];
    readonly status: EvidenceStatus;
  }[];
  readonly transitions: readonly {
    readonly transition: { readonly sourceStateId: StateId; readonly target: TransitionTarget };
    readonly status: EvidenceStatus;
  }[];
};

export type RuntimeScore = {
  readonly observed: number;
  readonly truth: number;
  readonly hits: number;
  readonly extras: readonly string[];
  readonly observedScreens: number;
};

const edgeKey = (from: string, to: string) => `${from} -> ${to}`;

export function score(graph: ScorableGraph | BuildGraph, expected: Expected): RuntimeScore {
  const patternByState = new Map<StateId, string>();
  for (const { screen, states } of graph.screens) {
    for (const state of states) patternByState.set(state.id, screen.routePattern);
  }
  const truth = new Set(expected.edges.map(({ from, to }) => edgeKey(from, to)));
  const observed = new Set<string>();
  for (const { transition, status } of graph.transitions) {
    if (status !== 'observed' || transition.target.kind !== 'resolved') continue;
    const from = patternByState.get(transition.sourceStateId);
    const to = patternByState.get(transition.target.stateId);
    if (from === undefined || to === undefined) throw new Error('transition points at an unknown state');
    observed.add(edgeKey(from, to));
  }
  const extras = [...observed].filter((key) => !truth.has(key)).sort();
  return {
    observed: observed.size,
    truth: truth.size,
    hits: observed.size - extras.length,
    extras,
    observedScreens: graph.screens.filter(({ status }) => status === 'observed').length,
  };
}

export function formatScore({ observed, truth, hits, extras, observedScreens }: RuntimeScore): string {
  const precision = observed === 0 ? '-' : `${((100 * hits) / observed).toFixed(1)}%`;
  return [
    `observed ${observed} of ${truth} edges, ${hits} in expected.json (precision ${precision})`,
    `observed screens ${observedScreens}`,
    ...extras.map((key) => `extra ${key}`),
  ].join('\n');
}
