import type {
  BuildGraph,
  EvidenceId,
  EvidenceObservation,
  EvidenceStatus,
  RoutePattern,
  ScreenId,
  StateId,
  TransitionId,
  Trigger,
  UnresolvedReason,
} from '../graph/model.js';

export type SourceRef = {
  readonly evidenceId: EvidenceId;
  readonly file: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly extractor: string;
};

export type ExplorerScreen = {
  readonly id: ScreenId;
  readonly route: RoutePattern;
  readonly status: EvidenceStatus;
  readonly sources: readonly SourceRef[];
};

export type ExplorerTarget =
  | { readonly kind: 'screen'; readonly screenId: ScreenId }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly expression: string };

export type ExplorerTransition = {
  readonly id: TransitionId;
  readonly sourceScreenId: ScreenId;
  readonly trigger: Trigger['kind'];
  readonly target: ExplorerTarget;
  readonly status: EvidenceStatus;
  readonly sources: readonly SourceRef[];
};

export type ExplorerGraph = {
  readonly root: string;
  readonly build: {
    readonly id: string;
    readonly commitSha: string;
    readonly branch: string | null;
    readonly createdAt: string;
    readonly analyzerVersion: string;
  };
  readonly screens: readonly ExplorerScreen[];
  readonly transitions: readonly ExplorerTransition[];
};

function sourceRefs(observations: readonly EvidenceObservation[]): SourceRef[] {
  return observations.flatMap(({ evidence }): SourceRef[] => {
    switch (evidence.kind) {
      case 'static':
        return [
          {
            evidenceId: evidence.id,
            file: evidence.span.file,
            start: evidence.span.start,
            end: evidence.span.end,
            extractor: evidence.extractor,
          },
        ];
      case 'capture':
      case 'navigation':
        return [];
      default: {
        const _exhaustive: never = evidence;
        return _exhaustive;
      }
    }
  });
}

export function toExplorerGraph({ root, graph }: { root: string; graph: BuildGraph }): ExplorerGraph {
  const screenByState = new Map<StateId, ScreenId>();
  for (const { screen, states } of graph.screens) {
    for (const state of states) screenByState.set(state.id, screen.id);
  }
  const screenOf = (stateId: StateId, description: string): ScreenId => {
    const found = screenByState.get(stateId);
    if (found === undefined) throw new Error(`${description} ${stateId} is not a state of any screen in the build`);
    return found;
  };

  const { build } = graph;
  return {
    root,
    build: {
      id: build.id,
      commitSha: build.commitSha,
      branch: build.branch,
      createdAt: build.createdAt.toISOString(),
      analyzerVersion: build.analyzerVersion,
    },
    screens: graph.screens.map(({ screen, status, observations }) => ({
      id: screen.id,
      route: screen.routePattern,
      status,
      sources: sourceRefs(observations),
    })),
    transitions: graph.transitions.map(({ transition, status, observations }) => {
      const { target } = transition;
      return {
        id: transition.id,
        sourceScreenId: screenOf(transition.sourceStateId, `Transition ${transition.id} source state`),
        trigger: transition.trigger.kind,
        target:
          target.kind === 'resolved'
            ? { kind: 'screen', screenId: screenOf(target.stateId, `Transition ${transition.id} target state`) }
            : { kind: 'unresolved', reason: target.reason, expression: target.expression },
        status,
        sources: sourceRefs(observations),
      };
    }),
  };
}
