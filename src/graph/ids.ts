import { createHash } from 'node:crypto';
import {
  parseApplicationId,
  parseRunId,
  parseBuildId,
  parseEvidenceId,
  parseScreenId,
  parseStateId,
  parseTransitionId,
  type ApplicationId,
  type BuildId,
  type CommitSha,
  type EvidenceId,
  type EvidenceIdentity,
  type NavigationEvidenceStart,
  type Origin,
  type RunId,
  type Session,
  type RoutePattern,
  type ScreenId,
  type StateId,
  type TransitionId,
  type TransitionTarget,
  type Trigger,
} from './model.js';
import type { RuntimeAction } from '../runtime/crawl-result.js';

type Part = string | number;

// JSON-encoding the parts keeps ("ab","c") and ("a","bc") from colliding.
function derive(prefix: string, parts: readonly Part[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${prefix}_${digest.slice(0, 16)}`;
}

export function applicationId({ rootPath }: { rootPath: string }): ApplicationId {
  return parseApplicationId(derive('app', [rootPath]));
}

export function buildId(args: {
  applicationId: ApplicationId;
  commitSha: CommitSha;
  sourceHash: string;
  analyzerVersion: string;
}): BuildId {
  return parseBuildId(
    derive('bld', [args.applicationId, args.commitSha, args.sourceHash, args.analyzerVersion]),
  );
}

export function screenId(args: {
  applicationId: ApplicationId;
  routePattern: RoutePattern;
}): ScreenId {
  return parseScreenId(derive('scr', [args.applicationId, args.routePattern]));
}

export function stateId({ screenId, key }: { screenId: ScreenId; key: string }): StateId {
  return parseStateId(derive('sta', [screenId, key]));
}

function targetIdentity(target: TransitionTarget): string {
  switch (target.kind) {
    case 'resolved':
      return target.stateId;
    case 'unresolved':
      return `unresolved:${target.expression}`;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export function transitionId(args: {
  sourceStateId: StateId;
  trigger: Trigger;
  target: TransitionTarget;
}): TransitionId {
  return parseTransitionId(
    derive('trn', [args.sourceStateId, args.trigger.kind, targetIdentity(args.target)]),
  );
}

function sessionKey(session: Session): string {
  switch (session.kind) {
    case 'anonymous':
      return session.kind;
    case 'storage-state':
      return `${session.kind}:${session.label}`;
    default: {
      const _exhaustive: never = session;
      return _exhaustive;
    }
  }
}

export function runId(args: { buildId: BuildId; origin: Origin; session: Session; startedAt: Date }): RunId {
  return parseRunId(
    derive('run', [args.buildId, args.origin, sessionKey(args.session), args.startedAt.toISOString()]),
  );
}

// The link's name is left out: two anchors to the same href from the same page are one navigation.
function actionKey(action: RuntimeAction): string {
  switch (action.kind) {
    case 'follow-link':
      return `${action.kind} ${action.href}`;
    default: {
      const _exhaustive: never = action.kind;
      return _exhaustive;
    }
  }
}

function startKey(start: NavigationEvidenceStart): string {
  switch (start.kind) {
    case 'entry':
      return start.kind;
    case 'action':
      return `${start.from.url} ${actionKey(start.action)}`;
    default: {
      const _exhaustive: never = start;
      return _exhaustive;
    }
  }
}

function evidenceIdentityParts(identity: EvidenceIdentity): readonly Part[] {
  switch (identity.kind) {
    case 'static': {
      const { file, start, end } = identity.span;
      return [
        identity.buildId,
        identity.kind,
        file,
        start.line,
        start.column,
        end.line,
        end.column,
        identity.extractor,
      ];
    }
    case 'capture':
      return [identity.buildId, identity.kind, identity.runId, identity.url];
    case 'navigation':
      return [identity.buildId, identity.kind, identity.runId, startKey(identity.start), identity.requested];
    default: {
      const _exhaustive: never = identity;
      return _exhaustive;
    }
  }
}

export function evidenceId(identity: EvidenceIdentity): EvidenceId {
  return parseEvidenceId(derive('evd', evidenceIdentityParts(identity)));
}
