import { createHash } from 'node:crypto';
import {
  parseApplicationId,
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
  type RoutePattern,
  type ScreenId,
  type StateId,
  type TransitionId,
  type TransitionTarget,
  type Trigger,
} from './model.js';

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
    default: {
      const _exhaustive: never = identity.kind;
      return _exhaustive;
    }
  }
}

export function evidenceId(identity: EvidenceIdentity): EvidenceId {
  return parseEvidenceId(derive('evd', evidenceIdentityParts(identity)));
}
