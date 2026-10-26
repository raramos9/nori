import { createHash } from 'node:crypto';
import {
  parseAnalysisId,
  parseAppKey,
  parseRunId,
  parseSnapshotId,
  parseEvidenceId,
  parseScreenId,
  parseStateId,
  parseTransitionId,
  type AnalysisId,
  type AnalyzerVersion,
  type AppKey,
  type CommitSha,
  type EvidenceId,
  type EvidenceIdentity,
  type NavigationEvidenceStart,
  type Origin,
  type RunId,
  type Session,
  type SnapshotId,
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

export function appKey({ repoIdentity, subpath }: { repoIdentity: string; subpath: string }): AppKey {
  return parseAppKey(derive('app', ['app-key/1', repoIdentity, subpath]));
}

export function snapshotId(args: { appKey: AppKey; commitSha: CommitSha; sourceHash: string }): SnapshotId {
  return parseSnapshotId(derive('snp', [args.appKey, args.commitSha, args.sourceHash]));
}

export function analysisId(args: {
  snapshotId: SnapshotId;
  analyzerVersion: AnalyzerVersion;
  inputsHash: string;
}): AnalysisId {
  return parseAnalysisId(derive('ana', [args.snapshotId, args.analyzerVersion, args.inputsHash]));
}

export function screenId(args: { appKey: AppKey; routePattern: RoutePattern }): ScreenId {
  return parseScreenId(derive('scr', [args.appKey, args.routePattern]));
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

export function sessionKey(session: Session): string {
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

export function runId(args: { snapshotId: SnapshotId; origin: Origin; session: Session; startedAt: Date }): RunId {
  return parseRunId(
    derive('run', [args.snapshotId, args.origin, sessionKey(args.session), args.startedAt.toISOString()]),
  );
}

// The link's name is left out: two anchors to the same href from the same page are one navigation.
function actionKey(action: RuntimeAction): string {
  switch (action.kind) {
    case 'follow-link':
      return `${action.kind} ${action.href}`;
    case 'interact':
      return `${action.kind} ${action.click}`;
    default: {
      const _exhaustive: never = action;
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
        identity.analysisId,
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
      return [identity.runId, identity.kind, identity.url];
    case 'navigation':
      return [identity.runId, identity.kind, startKey(identity.start), identity.requested];
    default: {
      const _exhaustive: never = identity;
      return _exhaustive;
    }
  }
}

export function evidenceId(identity: EvidenceIdentity): EvidenceId {
  return parseEvidenceId(derive('evd', evidenceIdentityParts(identity)));
}
