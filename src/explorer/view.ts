import { mayExplain, verdictOf } from '../graph/model.js';
import type {
  BuildGraph,
  EvidenceId,
  EvidenceObservation,
  EvidenceStatus,
  RoutePattern,
  RunId,
  Run,
  NavigationEvidence,
  TransitionMatch,
  ScreenId,
  Session,
  ScreenObservation,
  SkippedHop,
  TransitionObservation,
  StateId,
  TransitionId,
  Trigger,
  UnresolvedReason,
  Verdict,
} from '../graph/model.js';

export type SourceRef = {
  readonly evidenceId: EvidenceId;
  readonly file: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly extractor: string;
};

export type ExplorerRun = {
  readonly id: RunId;
  readonly session: string;
  readonly origin: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stop: Run['stop'];
  readonly requests: Run['requests'];
};

export type ExplorerCapture = {
  readonly evidenceId: EvidenceId;
  readonly runId: RunId;
  readonly session: string;
  readonly url: string;
  readonly httpStatus: number;
  readonly verdict: Verdict;
  readonly screenshotPath: string;
  readonly domPath: string;
};

export type ExplorerWalk = {
  readonly evidenceId: EvidenceId;
  readonly runId: RunId;
  readonly session: string;
  readonly rule: TransitionMatch['rule'];
  readonly hop: number | null;
  readonly requested: string;
  readonly redirects: NavigationEvidence['redirects'];
  readonly skipped: readonly SkippedHop[];
  readonly landing: { readonly evidenceId: EvidenceId; readonly url: string; readonly screenshotPath: string };
};

export type ExplorerScreen = {
  readonly id: ScreenId;
  readonly route: RoutePattern;
  readonly status: EvidenceStatus;
  readonly sources: readonly SourceRef[];
  readonly captures: readonly ExplorerCapture[];
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
  readonly walks: readonly ExplorerWalk[];
  readonly runtimeOnly: boolean;
  readonly observedIn: readonly string[];
  readonly mayExplain: readonly TransitionId[];
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
  readonly runs: readonly ExplorerRun[];
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

function sessionLabel(session: Session): string {
  return session.kind === 'anonymous' ? 'anonymous' : session.label;
}

function captures(
  observations: readonly ScreenObservation[],
  sessionOf: (runId: RunId) => string,
): ExplorerCapture[] {
  return observations.flatMap((observation): ExplorerCapture[] => {
    switch (observation.evidence.kind) {
      case 'static':
        return [];
      case 'capture': {
        const { evidence } = observation;
        return [
          {
            evidenceId: evidence.id,
            runId: evidence.runId,
            session: sessionOf(evidence.runId),
            url: evidence.url,
            httpStatus: evidence.httpStatus,
            verdict: verdictOf(observation),
            screenshotPath: evidence.screenshot,
            domPath: evidence.dom,
          },
        ];
      }
      default: {
        const _exhaustive: never = observation.evidence;
        return _exhaustive;
      }
    }
  });
}

function walks(
  observations: readonly TransitionObservation[],
  sessionOf: (runId: RunId) => string,
): ExplorerWalk[] {
  return observations.flatMap((observation): ExplorerWalk[] => {
    switch (observation.evidence.kind) {
      case 'static':
        return [];
      case 'navigation': {
        if (!('match' in observation)) return [];
        const { evidence, match } = observation;
        return [
          {
            evidenceId: evidence.id,
            runId: evidence.runId,
            session: sessionOf(evidence.runId),
            rule: match.rule,
            hop: 'hop' in match ? match.hop : null,
            requested: evidence.requested,
            redirects: evidence.redirects,
            skipped: match.skipped,
            landing: {
              evidenceId: evidence.landing.evidenceId,
              url: evidence.landing.url,
              screenshotPath: evidence.landing.screenshot,
            },
          },
        ];
      }
      default: {
        const _exhaustive: never = observation.evidence;
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

  const sessions = new Map<RunId, string>(graph.runs.map((run) => [run.id, sessionLabel(run.session)]));
  const sessionOf = (runId: RunId): string => {
    const found = sessions.get(runId);
    if (found === undefined) throw new Error(`Run ${runId} is not a run of the build`);
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
      captures: captures(observations, sessionOf),
    })),
    transitions: graph.transitions.map(({ transition, status, observations }) => {
      const { target } = transition;
      const transitionWalks = walks(observations, sessionOf);
      const runtimeOnly = !observations.some(({ evidence }) => evidence.kind === 'static');
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
        walks: transitionWalks,
        runtimeOnly,
        observedIn: [...new Set(transitionWalks.map((walk) => walk.session))].sort(),
        mayExplain: runtimeOnly ? mayExplain(graph, transition.id) : [],
      };
    }),
    runs: graph.runs.map((run) => ({
      id: run.id,
      session: sessionLabel(run.session),
      origin: run.origin,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt.toISOString(),
      stop: run.stop,
      requests: run.requests,
    })),
  };
}
