import { isAbsolute, normalize } from 'node:path';
import type { Redirect, RunStop, RuntimeAction } from '../runtime/crawl-result.js';

type Brand<Name extends string> = string & { readonly __brand: Name };

export type ApplicationId = Brand<'ApplicationId'>;
export type AppKey = Brand<'AppKey'>;
export type BuildId = Brand<'BuildId'>;
export type ScreenId = Brand<'ScreenId'>;
export type StateId = Brand<'StateId'>;
export type TransitionId = Brand<'TransitionId'>;
export type EvidenceId = Brand<'EvidenceId'>;
export type RoutePattern = Brand<'RoutePattern'>;
export type CommitSha = Brand<'CommitSha'>;
export type RunId = Brand<'RunId'>;
export type ArtifactPath = Brand<'ArtifactPath'>;

export type NonEmpty<T> = readonly [T, ...T[]];

// Single mint site per brand: the cast is sound only because the value was just validated.
function brandParser<B extends string>(
  name: string,
  isValid: (value: string) => boolean,
): (value: string) => B {
  return (value) => {
    if (!isValid(value)) {
      throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
    }
    return value as B;
  };
}

function idParser<B extends string>(name: string, prefix: string): (value: string) => B {
  const pattern = new RegExp(`^${prefix}_[0-9a-f]{16}$`);
  return brandParser<B>(name, (value) => pattern.test(value));
}

export const parseApplicationId = idParser<ApplicationId>('ApplicationId', 'app');
export const parseAppKey = idParser<AppKey>('AppKey', 'app');
export const parseBuildId = idParser<BuildId>('BuildId', 'bld');
export const parseScreenId = idParser<ScreenId>('ScreenId', 'scr');
export const parseStateId = idParser<StateId>('StateId', 'sta');
export const parseTransitionId = idParser<TransitionId>('TransitionId', 'trn');
export const parseEvidenceId = idParser<EvidenceId>('EvidenceId', 'evd');
export const parseRunId = idParser<RunId>('RunId', 'run');

export const parseArtifactPath = brandParser<ArtifactPath>(
  'ArtifactPath',
  (value) => isAbsolute(value) && normalize(value) === value,
);

const ROUTE_PATTERN = /^\/$|^(?:\/[^/()@\s]+)+$/;
export const parseRoutePattern = brandParser<RoutePattern>('RoutePattern', (value) =>
  ROUTE_PATTERN.test(value),
);

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const parseCommitSha = brandParser<CommitSha>('CommitSha', (value) => COMMIT_SHA.test(value));

export type Origin = Brand<'Origin'>;
export type PageUrl = Brand<'PageUrl'>;

export function parseOrigin(value: string): Origin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Origin: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid Origin: ${JSON.stringify(value)} is not http or https`);
  }
  return url.origin as Origin;
}

// A page URL is absolute, on the run's origin, with the fragment cut: two hrefs that differ only by
// fragment load the same document.
export function parsePageUrl(origin: Origin, raw: string): PageUrl {
  const url = new URL(raw, origin);
  if (url.origin !== origin) throw new Error(`${JSON.stringify(raw)} is not on ${origin}`);
  url.hash = '';
  return url.href as PageUrl;
}

export type Session =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'storage-state'; readonly label: string };

export type Framework = 'next-app-router';

export type Application = {
  readonly id: ApplicationId;
  readonly rootPath: string;
  readonly framework: Framework;
};

export type Build = {
  readonly id: BuildId;
  readonly applicationId: ApplicationId;
  readonly commitSha: CommitSha;
  readonly sourceHash: string;
  readonly branch: string | null;
  readonly analyzerVersion: string;
  readonly createdAt: Date;
};

export type Screen = {
  readonly id: ScreenId;
  readonly applicationId: ApplicationId;
  readonly routePattern: RoutePattern;
};

export const DEFAULT_STATE_KEY = 'default';

export type UIState = {
  readonly id: StateId;
  readonly screenId: ScreenId;
  readonly key: string;
};

export type Trigger =
  | { readonly kind: 'link' }
  | { readonly kind: 'router-push' }
  | { readonly kind: 'router-replace' }
  | { readonly kind: 'redirect' };

export const UNRESOLVED_REASONS = [
  'dynamic-expression',
  'no-matching-route',
  'ambiguous-route',
  'runtime-only',
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

export function isUnresolvedReason(value: string): value is UnresolvedReason {
  return UNRESOLVED_REASONS.some((reason) => reason === value);
}

export type TransitionTarget =
  | { readonly kind: 'resolved'; readonly stateId: StateId }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly expression: string };

export type Transition = {
  readonly id: TransitionId;
  readonly sourceStateId: StateId;
  readonly trigger: Trigger;
  readonly target: TransitionTarget;
};

export type SourceSpan = {
  readonly file: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
};

export type StaticEvidence = {
  readonly kind: 'static';
  readonly id: EvidenceId;
  readonly buildId: BuildId;
  readonly span: SourceSpan;
  readonly extractor: string;
};

export type Run = {
  readonly id: RunId;
  readonly applicationId: ApplicationId;
  readonly buildId: BuildId;
  readonly origin: Origin;
  readonly session: Session;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly stop: RunStop;
  readonly crawlerVersion: string;
  readonly reconcilerVersion: string;
  readonly requests: { readonly allowed: number; readonly blocked: number };
};

export type Capture = {
  readonly url: PageUrl;
  readonly httpStatus: number;
  readonly screenshot: ArtifactPath;
  readonly dom: ArtifactPath;
};

export type CaptureEvidence = Capture & {
  readonly kind: 'capture';
  readonly id: EvidenceId;
  readonly buildId: BuildId;
  readonly runId: RunId;
};

// An entry is the crawler opening a seed URL: there is no source screen, so no action step.
export type NavigationEvidenceStart =
  | { readonly kind: 'entry' }
  | {
      readonly kind: 'action';
      readonly from: { readonly evidenceId: EvidenceId; readonly url: PageUrl };
      readonly action: RuntimeAction;
    };

export type NavigationEvidence = {
  readonly kind: 'navigation';
  readonly id: EvidenceId;
  readonly buildId: BuildId;
  readonly runId: RunId;
  readonly start: NavigationEvidenceStart;
  readonly requested: PageUrl;
  readonly redirects: readonly Redirect[];
  readonly landing: Capture & { readonly evidenceId: EvidenceId };
  readonly logSeq: number;
};

export type RuntimeEvidence = CaptureEvidence | NavigationEvidence;
export type Evidence = StaticEvidence | RuntimeEvidence;

export type EvidenceIdentity =
  | Omit<StaticEvidence, 'id'>
  | Pick<CaptureEvidence, 'kind' | 'buildId' | 'runId' | 'url'>
  | Pick<NavigationEvidence, 'kind' | 'buildId' | 'runId' | 'start' | 'requested'>;

export type ObservationSubject =
  | { readonly kind: 'screen'; readonly id: ScreenId }
  | { readonly kind: 'transition'; readonly id: TransitionId };

export type Verdict = 'supports' | 'contradicts';

export type Observation = {
  readonly evidenceId: EvidenceId;
  readonly subject: ObservationSubject;
  readonly verdict: Verdict;
};

export type EvidenceStatus = 'inferred' | 'observed' | 'verified' | 'failed';

export type ScreenMatch =
  | { readonly verdict: 'supports'; readonly rule: 'rendered'; readonly url: PageUrl; readonly pattern: RoutePattern }
  | {
      readonly verdict: 'contradicts';
      readonly rule: 'server-error';
      readonly url: PageUrl;
      readonly pattern: RoutePattern;
      readonly httpStatus: number;
    };

export type NotAScreen = 'asset' | 'handler' | 'no-matching-route' | 'ambiguous-route';

export type SkippedHop = { readonly url: PageUrl; readonly why: 'pass-through' | NotAScreen };

export type TargetSearch = {
  readonly sourceUrl: PageUrl;
  readonly sourcePattern: RoutePattern;
  readonly targetUrl: PageUrl;
  readonly targetPattern: RoutePattern;
  readonly skipped: readonly SkippedHop[];
  readonly triggerCandidates: NonEmpty<Trigger['kind']>;
};

// Runtime only ever supports a transition. It can't name the call site an anchor came from, so a
// different landing is another transition or a redirect, never a refutation.
export type TransitionMatch =
  | (TargetSearch & { readonly verdict: 'supports'; readonly rule: 'action-matched-static' })
  | (TargetSearch & { readonly verdict: 'supports'; readonly rule: 'action-runtime-only' })
  | (TargetSearch & { readonly verdict: 'supports'; readonly rule: 'redirect-matched-static'; readonly hop: number });

export type ScreenObservation =
  | { readonly evidence: StaticEvidence; readonly verdict: Verdict }
  | { readonly evidence: CaptureEvidence; readonly match: ScreenMatch };

export type TransitionObservation =
  | { readonly evidence: StaticEvidence; readonly verdict: Verdict }
  | { readonly evidence: NavigationEvidence; readonly match: TransitionMatch };

export type EvidenceObservation = ScreenObservation | TransitionObservation;

export function verdictOf(observation: EvidenceObservation): Verdict {
  return 'match' in observation ? observation.match.verdict : observation.verdict;
}

const STATUS_RANK: Record<EvidenceStatus, number> = {
  inferred: 0,
  observed: 1,
  verified: 2,
  failed: 3,
};

// failed may dominate only because the one runtime contradiction is a 5xx render, a defect under any
// session, never a session-dependent absence.
function statusFromObservation(observation: EvidenceObservation): EvidenceStatus {
  switch (observation.evidence.kind) {
    case 'static':
      return 'inferred';
    case 'capture':
    case 'navigation':
      return verdictOf(observation) === 'supports' ? 'observed' : 'failed';
    default: {
      const _exhaustive: never = observation.evidence;
      return _exhaustive;
    }
  }
}

export function deriveEvidenceStatus(observations: NonEmpty<EvidenceObservation>): EvidenceStatus {
  let best = statusFromObservation(observations[0]);
  for (const observation of observations) {
    const status = statusFromObservation(observation);
    if (STATUS_RANK[status] > STATUS_RANK[best]) best = status;
  }
  return best;
}

export type StaticIngestion = {
  readonly application: Application;
  readonly build: Build;
  readonly screens: readonly Screen[];
  readonly transitions: readonly Transition[];
  readonly evidence: readonly StaticEvidence[];
  readonly observations: readonly Observation[];
};

export type RuntimeOnlyTransition = Transition & {
  readonly target: { readonly kind: 'resolved'; readonly stateId: StateId };
};

export type IgnoreReason =
  | { readonly kind: 'aborted'; readonly error: string }
  | { readonly kind: 'not-a-screen'; readonly url: PageUrl; readonly why: NotAScreen }
  | { readonly kind: 'client-error'; readonly url: PageUrl; readonly httpStatus: number }
  | { readonly kind: 'source-not-rendered'; readonly url: PageUrl; readonly httpStatus: number }
  | { readonly kind: 'landing-error'; readonly url: PageUrl; readonly httpStatus: number }
  | { readonly kind: 'ambiguous-trigger'; readonly candidates: NonEmpty<TransitionId> }
  | { readonly kind: 'unknown-trigger' }
  | { readonly kind: 'redirect-from-non-screen'; readonly url: PageUrl }
  | { readonly kind: 'unmatched-redirect'; readonly from: RoutePattern; readonly to: RoutePattern };

export type CaptureStep = { readonly kind: 'capture'; readonly evidenceId: EvidenceId };
export type ActionStep = { readonly kind: 'action'; readonly seq: number };
export type RedirectStep = { readonly kind: 'redirect'; readonly seq: number; readonly hop: number };
// An aborted navigation never reached a landing, so it is one step of its own, whatever started it.
export type AbortedStep = { readonly kind: 'aborted'; readonly seq: number };
export type StepRef = CaptureStep | ActionStep | RedirectStep | AbortedStep;

export type StepOutcome =
  | { readonly step: CaptureStep | ActionStep | RedirectStep; readonly kind: 'supports'; readonly subject: ScreenId | TransitionId }
  | { readonly step: CaptureStep; readonly kind: 'contradicts'; readonly subject: ScreenId }
  | { readonly step: ActionStep; readonly kind: 'created'; readonly subject: TransitionId }
  | { readonly step: StepRef; readonly kind: 'ignored'; readonly reason: IgnoreReason };

export type RunIngestion = {
  readonly run: Run;
  readonly captures: readonly { readonly evidence: CaptureEvidence; readonly match: ScreenMatch | null }[];
  readonly navigations: readonly {
    readonly evidence: NavigationEvidence;
    readonly matches: readonly { readonly transitionId: TransitionId; readonly match: TransitionMatch }[];
  }[];
  readonly created: readonly RuntimeOnlyTransition[];
  readonly report: readonly StepOutcome[];
};

export type LoadedScreen = {
  readonly screen: Screen;
  readonly states: NonEmpty<UIState>;
  readonly observations: NonEmpty<ScreenObservation>;
  readonly status: EvidenceStatus;
};

export type LoadedTransition = {
  readonly transition: Transition;
  readonly observations: NonEmpty<TransitionObservation>;
  readonly status: EvidenceStatus;
};

export type BuildGraph = {
  readonly build: Build;
  readonly runs: readonly Run[];
  readonly screens: readonly LoadedScreen[];
  readonly transitions: readonly LoadedTransition[];
};

// The static unresolved transitions that might be the call a runtime-only transition walked: same
// source state, same trigger. Derived on read so it can never go stale against the static side.
export function mayExplain(graph: BuildGraph, transitionId: TransitionId): readonly TransitionId[] {
  const isStatic = (observation: TransitionObservation) => observation.evidence.kind === 'static';
  const loaded = graph.transitions.find(({ transition }) => transition.id === transitionId);
  if (loaded === undefined || loaded.observations.some(isStatic)) return [];
  const { sourceStateId, trigger } = loaded.transition;
  return graph.transitions
    .filter(
      ({ transition }) =>
        transition.target.kind === 'unresolved' &&
        transition.sourceStateId === sourceStateId &&
        transition.trigger.kind === trigger.kind,
    )
    .map(({ transition }) => transition.id)
    .sort();
}
