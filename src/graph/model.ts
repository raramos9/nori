import { isAbsolute, normalize } from 'node:path';
import type { Redirect, RunStop, RuntimeAction } from '../runtime/crawl-result.js';

type Brand<Name extends string> = string & { readonly __brand: Name };

export type AppKey = Brand<'AppKey'>;
export type SnapshotId = Brand<'SnapshotId'>;
export type AnalysisId = Brand<'AnalysisId'>;
export type AnalyzerVersion = Brand<'AnalyzerVersion'>;
export type ScreenId = Brand<'ScreenId'>;
export type StateId = Brand<'StateId'>;
export type TransitionId = Brand<'TransitionId'>;
export type EvidenceId = Brand<'EvidenceId'>;
export type RoutePattern = Brand<'RoutePattern'>;
export type CommitSha = Brand<'CommitSha'>;
export type RunId = Brand<'RunId'>;
export type ArtifactPath = Brand<'ArtifactPath'>;
export type TestImportId = Brand<'TestImportId'>;
export type TestCaseKey = Brand<'TestCaseKey'>;

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

export const parseAppKey = idParser<AppKey>('AppKey', 'app');
export const parseSnapshotId = idParser<SnapshotId>('SnapshotId', 'snp');
export const parseAnalysisId = idParser<AnalysisId>('AnalysisId', 'ana');
export const parseScreenId = idParser<ScreenId>('ScreenId', 'scr');
export const parseStateId = idParser<StateId>('StateId', 'sta');
export const parseTransitionId = idParser<TransitionId>('TransitionId', 'trn');
export const parseEvidenceId = idParser<EvidenceId>('EvidenceId', 'evd');
export const parseRunId = idParser<RunId>('RunId', 'run');
export const parseTestImportId = idParser<TestImportId>('TestImportId', 'imp');
export const parseTestCaseKey = idParser<TestCaseKey>('TestCaseKey', 'tcs');

export const parseArtifactPath = brandParser<ArtifactPath>(
  'ArtifactPath',
  (value) => isAbsolute(value) && normalize(value) === value,
);

export const parseAnalyzerVersion = brandParser<AnalyzerVersion>(
  'AnalyzerVersion',
  (value) => value !== '' && value.trim() === value,
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

export type RepoIdentity = `remote:${string}` | `local:${string}`;

export function parseRepoIdentity(value: string): RepoIdentity {
  if (value.startsWith('remote:') || value.startsWith('local:')) return value as RepoIdentity;
  throw new Error(`Invalid RepoIdentity: ${JSON.stringify(value)}`);
}

export type Application = {
  readonly id: AppKey;
  readonly repoIdentity: RepoIdentity;
  readonly subpath: string;
  readonly framework: Framework;
};

export type Worktree = 'clean' | 'dirty';

export type Snapshot = {
  readonly id: SnapshotId;
  readonly appKey: AppKey;
  readonly commitSha: CommitSha;
  readonly sourceHash: string;
  readonly worktree: Worktree;
  readonly branch: string | null;
  readonly createdAt: Date;
};

export type Analysis = {
  readonly id: AnalysisId;
  readonly snapshotId: SnapshotId;
  readonly analyzerVersion: AnalyzerVersion;
  readonly inputsHash: string;
  readonly createdAt: Date;
};

export type Environment = 'local' | 'ci';

export type Screen = {
  readonly id: ScreenId;
  readonly appKey: AppKey;
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
  readonly analysisId: AnalysisId;
  readonly span: SourceSpan;
  readonly extractor: string;
};

export type Run = {
  readonly id: RunId;
  readonly snapshotId: SnapshotId;
  readonly origin: Origin;
  readonly session: Session;
  readonly environment: Environment;
  readonly seededBy: AnalyzerVersion;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly stop: RunStop;
  readonly crawlerVersion: string;
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
  | Pick<CaptureEvidence, 'kind' | 'runId' | 'url'>
  | Pick<NavigationEvidence, 'kind' | 'runId' | 'start' | 'requested'>;

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
  readonly snapshot: Snapshot;
  readonly analysis: Analysis;
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
  readonly analysisId: AnalysisId;
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
  readonly application: Application;
  readonly snapshot: Snapshot;
  readonly analysis: Analysis;
  readonly runs: readonly Run[];
  readonly unmatchedRuns: readonly RunId[];
  readonly screens: readonly LoadedScreen[];
  readonly transitions: readonly LoadedTransition[];
  readonly tests: readonly LoadedTestImport[];
  readonly unmatchedImports: readonly TestImportId[];
};

export type TestImport = {
  readonly id: TestImportId;
  readonly snapshotId: SnapshotId;
  readonly environment: Environment;
  readonly importedAt: Date;
  readonly report: {
    readonly original: ArtifactPath;
    readonly sealed: ArtifactPath;
    readonly sha256: string;
    readonly playwrightVersion: string;
    readonly startedAt: Date;
  };
};

// Playwright's test.status, renamed. flaky means a failed attempt and a passed retry.
export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'flaky';
// Playwright's result.status, verbatim.
export type AttemptStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export type TestCase = {
  readonly key: TestCaseKey;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly project: string;
  readonly expectedStatus: AttemptStatus;
  readonly outcome: TestOutcome;
  readonly attempts: readonly TestAttempt[];
};

export type TestAttempt = {
  readonly retry: number;
  readonly status: AttemptStatus;
  readonly trace: TraceLink;
  // Empty unless the attempt failed. A located failure names the step whose page the failing call ran on.
  readonly failures: readonly TestFailure[];
};

export type TestFailure = { readonly message: string; readonly step: number | null };

export type TraceLink =
  | { readonly kind: 'read'; readonly original: ArtifactPath; readonly sealed: ArtifactPath; readonly steps: readonly TestStep[] }
  | { readonly kind: 'trace-less'; readonly reason: TracelessReason };

export type TracelessReason =
  | { readonly kind: 'no-trace-attachment' }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'outside-root'; readonly path: string; readonly root: string }
  | { readonly kind: 'not-a-file'; readonly path: string }
  | { readonly kind: 'hard-linked'; readonly path: string }
  | { readonly kind: 'changed'; readonly path: string }
  | { readonly kind: 'too-large'; readonly path: string; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'over-budget'; readonly path: string; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'unreadable'; readonly path: string; readonly why: TraceRejection };

// Every way the untrusted trace bytes can be refused.
export type TraceRejection =
  | { readonly kind: 'not-a-zip' | 'zip64' | 'multi-disk' | 'encrypted' | 'truncated' | 'overlapping-entries' }
  | { readonly kind: 'too-many-entries'; readonly count: number }
  | { readonly kind: 'unsupported-method'; readonly entry: string; readonly method: number }
  | {
      readonly kind: 'unsafe-name' | 'duplicate-name' | 'header-mismatch' | 'size-mismatch' | 'crc-mismatch' | 'inflate-failed';
      readonly entry: string;
    }
  | { readonly kind: 'entry-too-large'; readonly entry: string; readonly bytes: number }
  | { readonly kind: 'total-too-large'; readonly bytes: number }
  | { readonly kind: 'no-trace-entries' }
  | { readonly kind: 'unsupported-trace-version'; readonly version: number }
  | { readonly kind: 'bad-trace-line'; readonly entry: string; readonly line: number }
  | { readonly kind: 'too-many-lines'; readonly entry: string; readonly count: number }
  | { readonly kind: 'too-many-calls'; readonly count: number }
  | { readonly kind: 'too-many-steps'; readonly count: number }
  | { readonly kind: 'too-many-failures'; readonly count: number }
  | { readonly kind: 'bad-trace-entry'; readonly entry: string }
  | { readonly kind: 'io-error'; readonly code: string };

export type NavigateMethod = 'goto' | 'reload' | 'goBack' | 'goForward';

// anchor is the href of the <a> Playwright marked as the click target in the cause's action snapshot.
export type StepCause =
  | { readonly kind: 'navigate'; readonly method: NavigateMethod; readonly requested: string | null }
  | { readonly kind: 'input'; readonly method: string; readonly selector: string | null; readonly anchor: PageUrl | null }
  | { readonly kind: 'none' };

// One URL change on one page's main frame. The chain's last URL is the landing; earlier ones are client
// redirects the same cause led through.
export type TestStep = {
  readonly seq: number;
  readonly page: number;
  readonly at: number;
  readonly origin: Origin;
  readonly cause: StepCause;
  readonly from: string | null;
  readonly chain: NonEmpty<string>;
  readonly assertions: number;
};

// What one step became under one analysis. Never a TransitionObservation, never a verdict. A
// walked-runtime-only step names the transition a crawl would mint and attaches only if a crawl did.
export type TestStepMatch =
  | { readonly kind: 'entry' }
  | { readonly kind: 'walked'; readonly transitionId: TransitionId; readonly search: TargetSearch }
  | { readonly kind: 'walked-runtime-only'; readonly transitionId: TransitionId; readonly search: TargetSearch }
  | { readonly kind: 'ambiguous'; readonly candidates: NonEmpty<TransitionId>; readonly search: TargetSearch }
  | { readonly kind: 'no-transition'; readonly search: TargetSearch }
  | { readonly kind: 'not-a-screen'; readonly url: PageUrl; readonly why: NotAScreen }
  | { readonly kind: 'off-origin'; readonly url: string }
  | { readonly kind: 'unattributed' };

export type TestStepRef = { readonly caseKey: TestCaseKey; readonly retry: number; readonly seq: number };

export type TestStepMatchRow = TestStepRef & { readonly match: TestStepMatch };

export type ImportIngestion = {
  readonly analysisId: AnalysisId;
  readonly testImport: TestImport;
  readonly cases: readonly TestCase[];
  readonly matches: readonly TestStepMatchRow[];
};

export type LoadedTestImport = {
  readonly testImport: TestImport;
  readonly cases: readonly TestCase[];
  readonly matches: readonly TestStepMatchRow[];
};

export type BuildSummary = {
  readonly snapshot: Snapshot;
  readonly analyses: NonEmpty<Analysis>;
  readonly runCount: number;
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
