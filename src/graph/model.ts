type Brand<Name extends string> = string & { readonly __brand: Name };

export type ApplicationId = Brand<'ApplicationId'>;
export type BuildId = Brand<'BuildId'>;
export type ScreenId = Brand<'ScreenId'>;
export type StateId = Brand<'StateId'>;
export type TransitionId = Brand<'TransitionId'>;
export type EvidenceId = Brand<'EvidenceId'>;
export type RoutePattern = Brand<'RoutePattern'>;
export type CommitSha = Brand<'CommitSha'>;

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
export const parseBuildId = idParser<BuildId>('BuildId', 'bld');
export const parseScreenId = idParser<ScreenId>('ScreenId', 'scr');
export const parseStateId = idParser<StateId>('StateId', 'sta');
export const parseTransitionId = idParser<TransitionId>('TransitionId', 'trn');
export const parseEvidenceId = idParser<EvidenceId>('EvidenceId', 'evd');

const ROUTE_PATTERN = /^\/$|^(?:\/[^/()@\s]+)+$/;
export const parseRoutePattern = brandParser<RoutePattern>('RoutePattern', (value) =>
  ROUTE_PATTERN.test(value),
);

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const parseCommitSha = brandParser<CommitSha>('CommitSha', (value) => COMMIT_SHA.test(value));

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

export const UNRESOLVED_REASONS = ['dynamic-expression', 'no-matching-route', 'runtime-only'] as const;
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

export type Evidence = StaticEvidence;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EvidenceIdentity = DistributiveOmit<Evidence, 'id'>;

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

export type EvidenceObservation = {
  readonly evidence: Evidence;
  readonly verdict: Verdict;
};

const STATUS_RANK: Record<EvidenceStatus, number> = {
  inferred: 0,
  observed: 1,
  verified: 2,
  failed: 3,
};

function statusFromObservation({ evidence, verdict }: EvidenceObservation): EvidenceStatus {
  switch (evidence.kind) {
    case 'static':
      // Static analysis proposes candidates but can never establish or refute behavior,
      // so even a static contradiction leaves the entity inferred.
      switch (verdict) {
        case 'supports':
        case 'contradicts':
          return 'inferred';
        default: {
          const _exhaustive: never = verdict;
          return _exhaustive;
        }
      }
    default: {
      const _exhaustive: never = evidence.kind;
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
  readonly evidence: readonly Evidence[];
  readonly observations: readonly Observation[];
};

export type LoadedScreen = {
  readonly screen: Screen;
  readonly states: NonEmpty<UIState>;
  readonly observations: NonEmpty<EvidenceObservation>;
  readonly status: EvidenceStatus;
};

export type LoadedTransition = {
  readonly transition: Transition;
  readonly observations: NonEmpty<EvidenceObservation>;
  readonly status: EvidenceStatus;
};

export type BuildGraph = {
  readonly build: Build;
  readonly screens: readonly LoadedScreen[];
  readonly transitions: readonly LoadedTransition[];
};
