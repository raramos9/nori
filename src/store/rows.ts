import { join, relative } from 'node:path';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import {
  isUnresolvedReason,
  parseAnalysisId,
  parseAnalyzerVersion,
  parseAppKey,
  parseArtifactPath,
  parseCommitSha,
  parseEvidenceId,
  parseOrigin,
  parsePageUrl,
  parseRepoIdentity,
  parseRoutePattern,
  parseRunId,
  parseScreenId,
  parseSnapshotId,
  parseStateId,
  parseTransitionId,
  type Analysis,
  type Application,
  type AppKey,
  type ArtifactPath,
  type CaptureEvidence,
  type Environment,
  type NavigationEvidence,
  type NavigationEvidenceStart,
  type PageUrl,
  type Run,
  type Screen,
  type ScreenMatch,
  type Session,
  type Snapshot,
  type StaticEvidence,
  type Transition,
  type TransitionMatch,
  type TransitionTarget,
  type Trigger,
  type UIState,
  type Verdict,
  type Worktree,
} from '../graph/model.js';
import { appHome, isInside, runDirectory } from '../runtime/layout.js';
import type {
  AnalysesTable,
  ApplicationsTable,
  CapturesTable,
  NavigationsTable,
  RunsTable,
  ScreensTable,
  SnapshotsTable,
  StaticEvidenceTable,
  TransitionsTable,
  UiStatesTable,
} from './schema.js';

const ANONYMOUS_LABEL = 'anonymous';

export function required<T>(value: T | null, description: string): T {
  if (value === null) throw new Error(`${description} must not be null`);
  return value;
}

export function mustBeNull(value: unknown, description: string): void {
  if (value !== null) throw new Error(`${description} must be null`);
}

export function parseDate(value: string, description: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${description} ${JSON.stringify(value)} is not a date`);
  return date;
}

export function storedPageUrl(value: string): PageUrl {
  const url = parsePageUrl(parseOrigin(value), value);
  if (url !== value) throw new Error(`${JSON.stringify(value)} is not a stored page URL`);
  return url;
}

export const pageUrlSchema = z.string().transform(storedPageUrl);
const routePattern = z.string().transform(parseRoutePattern);
const triggerKind = z.enum(['link', 'router-push', 'router-replace', 'redirect']);
export const targetSearch = {
  sourceUrl: pageUrlSchema,
  sourcePattern: routePattern,
  targetUrl: pageUrlSchema,
  targetPattern: routePattern,
  skipped: z.array(
    z.object({
      url: pageUrlSchema,
      why: z.enum(['pass-through', 'asset', 'handler', 'no-matching-route', 'ambiguous-route']),
    }),
  ),
  triggerCandidates: z.tuple([triggerKind], triggerKind),
};

const transitionMatchSchema = z.discriminatedUnion('rule', [
  z.object({ ...targetSearch, verdict: z.literal('supports'), rule: z.literal('action-matched-static') }),
  z.object({ ...targetSearch, verdict: z.literal('supports'), rule: z.literal('action-runtime-only') }),
  z.object({
    ...targetSearch,
    verdict: z.literal('supports'),
    rule: z.literal('redirect-matched-static'),
    hop: z.number().int().nonnegative(),
  }),
]);

const screenMatchSchema = z.discriminatedUnion('rule', [
  z.object({ verdict: z.literal('supports'), rule: z.literal('rendered'), url: pageUrlSchema, pattern: routePattern }),
  z.object({
    verdict: z.literal('contradicts'),
    rule: z.literal('server-error'),
    url: pageUrlSchema,
    pattern: routePattern,
    httpStatus: z.number().int(),
  }),
]);

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow-link'), href: pageUrlSchema, name: z.string().nullable() }),
  z.object({ kind: z.literal('interact'), page: pageUrlSchema, click: z.string(), fields: z.array(z.string()) }),
]);

export const redirectsSchema = z.array(z.object({ to: pageUrlSchema, via: z.enum(['http', 'client']) }));

export function parseJson<T>(schema: z.ZodType<T, unknown>, text: string, description: string): T {
  const result = schema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(`${description}: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseScreenMatch(text: string, description: string): ScreenMatch {
  return parseJson(screenMatchSchema, text, description);
}

export function parseTransitionMatch(text: string, description: string): TransitionMatch {
  return parseJson(transitionMatchSchema, text, description);
}

export function parseVerdict(value: string, description: string): Verdict {
  switch (value) {
    case 'supports':
    case 'contradicts':
      return value;
    default:
      throw new Error(`${description}: unknown verdict ${JSON.stringify(value)}`);
  }
}

export function applicationToRow(application: Application): Selectable<ApplicationsTable> {
  return {
    id: application.id,
    repo_identity: application.repoIdentity,
    subpath: application.subpath,
    framework: application.framework,
  };
}

export function parseApplication(row: Selectable<ApplicationsTable>): Application {
  if (row.framework !== 'next-app-router') {
    throw new Error(`Application ${row.id}: unknown framework ${JSON.stringify(row.framework)}`);
  }
  return {
    id: parseAppKey(row.id),
    repoIdentity: parseRepoIdentity(row.repo_identity),
    subpath: row.subpath,
    framework: row.framework,
  };
}

export function snapshotToRow(snapshot: Snapshot): Selectable<SnapshotsTable> {
  return {
    id: snapshot.id,
    application_id: snapshot.appKey,
    commit_sha: snapshot.commitSha,
    source_hash: snapshot.sourceHash,
    worktree: snapshot.worktree,
    branch: snapshot.branch,
    created_at: snapshot.createdAt.toISOString(),
  };
}

function parseWorktree(row: Selectable<SnapshotsTable>): Worktree {
  switch (row.worktree) {
    case 'clean':
    case 'dirty':
      return row.worktree;
    default:
      throw new Error(`Snapshot ${row.id}: unknown worktree ${JSON.stringify(row.worktree)}`);
  }
}

export function parseSnapshot(row: Selectable<SnapshotsTable>): Snapshot {
  return {
    id: parseSnapshotId(row.id),
    appKey: parseAppKey(row.application_id),
    commitSha: parseCommitSha(row.commit_sha),
    sourceHash: row.source_hash,
    worktree: parseWorktree(row),
    branch: row.branch,
    createdAt: parseDate(row.created_at, `Snapshot ${row.id}: created_at`),
  };
}

export function analysisToRow(analysis: Analysis): Selectable<AnalysesTable> {
  return {
    id: analysis.id,
    snapshot_id: analysis.snapshotId,
    analyzer_version: analysis.analyzerVersion,
    inputs_hash: analysis.inputsHash,
    created_at: analysis.createdAt.toISOString(),
  };
}

export function parseAnalysis(row: Selectable<AnalysesTable>): Analysis {
  return {
    id: parseAnalysisId(row.id),
    snapshotId: parseSnapshotId(row.snapshot_id),
    analyzerVersion: parseAnalyzerVersion(row.analyzer_version),
    inputsHash: row.inputs_hash,
    createdAt: parseDate(row.created_at, `Analysis ${row.id}: created_at`),
  };
}

export function parseScreen(row: Selectable<ScreensTable>): Screen {
  return {
    id: parseScreenId(row.id),
    appKey: parseAppKey(row.application_id),
    routePattern: parseRoutePattern(row.route_pattern),
  };
}

export function parseState(row: Selectable<UiStatesTable>): UIState {
  return { id: parseStateId(row.id), screenId: parseScreenId(row.screen_id), key: row.key };
}

const TRIGGERS: Record<Trigger['kind'], Trigger> = {
  link: { kind: 'link' },
  'router-push': { kind: 'router-push' },
  'router-replace': { kind: 'router-replace' },
  redirect: { kind: 'redirect' },
};

function isTriggerKind(value: string): value is Trigger['kind'] {
  return Object.hasOwn(TRIGGERS, value);
}

function parseTrigger(row: Selectable<TransitionsTable>): Trigger {
  if (!isTriggerKind(row.trigger_kind)) {
    throw new Error(`Transition ${row.id}: unknown trigger_kind ${JSON.stringify(row.trigger_kind)}`);
  }
  return TRIGGERS[row.trigger_kind];
}

function parseTarget(row: Selectable<TransitionsTable>): TransitionTarget {
  const where = (column: string) => `Transition ${row.id}: ${column} (target_kind '${row.target_kind}')`;
  switch (row.target_kind) {
    case 'resolved':
      mustBeNull(row.unresolved_reason, where('unresolved_reason'));
      mustBeNull(row.unresolved_expression, where('unresolved_expression'));
      return {
        kind: 'resolved',
        stateId: parseStateId(required(row.target_state_id, where('target_state_id'))),
      };
    case 'unresolved': {
      mustBeNull(row.target_state_id, where('target_state_id'));
      const reason = required(row.unresolved_reason, where('unresolved_reason'));
      if (!isUnresolvedReason(reason)) {
        throw new Error(`Transition ${row.id}: unknown unresolved_reason ${JSON.stringify(reason)}`);
      }
      return {
        kind: 'unresolved',
        reason,
        expression: required(row.unresolved_expression, where('unresolved_expression')),
      };
    }
    default:
      throw new Error(`Transition ${row.id}: unknown target_kind ${JSON.stringify(row.target_kind)}`);
  }
}

export function parseTransition(row: Selectable<TransitionsTable>): Transition {
  return {
    id: parseTransitionId(row.id),
    sourceStateId: parseStateId(row.source_state_id),
    trigger: parseTrigger(row),
    target: parseTarget(row),
  };
}

export function transitionToRow(transition: Transition): Selectable<TransitionsTable> {
  const base = {
    id: transition.id,
    source_state_id: transition.sourceStateId,
    trigger_kind: transition.trigger.kind,
  };
  const { target } = transition;
  switch (target.kind) {
    case 'resolved':
      return {
        ...base,
        target_kind: target.kind,
        target_state_id: target.stateId,
        unresolved_reason: null,
        unresolved_expression: null,
      };
    case 'unresolved':
      return {
        ...base,
        target_kind: target.kind,
        target_state_id: null,
        unresolved_reason: target.reason,
        unresolved_expression: target.expression,
      };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export function staticEvidenceToRow(evidence: StaticEvidence): Selectable<StaticEvidenceTable> {
  return {
    id: evidence.id,
    analysis_id: evidence.analysisId,
    extractor: evidence.extractor,
    span_file: evidence.span.file,
    span_start_line: evidence.span.start.line,
    span_start_column: evidence.span.start.column,
    span_end_line: evidence.span.end.line,
    span_end_column: evidence.span.end.column,
  };
}

export function parseStaticEvidence(row: Selectable<StaticEvidenceTable>): StaticEvidence {
  return {
    kind: 'static',
    id: parseEvidenceId(row.id),
    analysisId: parseAnalysisId(row.analysis_id),
    extractor: row.extractor,
    span: {
      file: row.span_file,
      start: { line: row.span_start_line, column: row.span_start_column },
      end: { line: row.span_end_line, column: row.span_end_column },
    },
  };
}

function sessionLabel(session: Session): string {
  return session.kind === 'anonymous' ? ANONYMOUS_LABEL : session.label;
}

function parseSession(row: Selectable<RunsTable>): Session {
  switch (row.session_kind) {
    case 'anonymous':
      if (row.session_label !== ANONYMOUS_LABEL) throw new Error(`Run ${row.id}: anonymous session has a label`);
      return { kind: 'anonymous' };
    case 'storage-state':
      if (row.session_label === '') throw new Error(`Run ${row.id}: storage-state session has no label`);
      return { kind: 'storage-state', label: row.session_label };
    default:
      throw new Error(`Run ${row.id}: unknown session_kind ${JSON.stringify(row.session_kind)}`);
  }
}

function parseStop(row: Selectable<RunsTable>): Run['stop'] {
  switch (row.stop) {
    case 'frontier-exhausted':
    case 'budget':
      return row.stop;
    default:
      throw new Error(`Run ${row.id}: unknown stop ${JSON.stringify(row.stop)}`);
  }
}

function parseEnvironment(row: Selectable<RunsTable>): Environment {
  switch (row.environment) {
    case 'local':
    case 'ci':
      return row.environment;
    default:
      throw new Error(`Run ${row.id}: unknown environment ${JSON.stringify(row.environment)}`);
  }
}

export function runToRow(run: Run): Selectable<RunsTable> {
  return {
    id: run.id,
    snapshot_id: run.snapshotId,
    origin: run.origin,
    session_kind: run.session.kind,
    session_label: sessionLabel(run.session),
    environment: run.environment,
    seeded_by: run.seededBy,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    stop: run.stop,
    crawler_version: run.crawlerVersion,
    requests_allowed: run.requests.allowed,
    requests_blocked: run.requests.blocked,
  };
}

export function parseRun(row: Selectable<RunsTable>): Run {
  const origin = parseOrigin(row.origin);
  if (origin !== row.origin) throw new Error(`Run ${row.id}: origin ${JSON.stringify(row.origin)} is not an origin`);
  return {
    id: parseRunId(row.id),
    snapshotId: parseSnapshotId(row.snapshot_id),
    origin,
    session: parseSession(row),
    environment: parseEnvironment(row),
    seededBy: parseAnalyzerVersion(row.seeded_by),
    startedAt: parseDate(row.started_at, `Run ${row.id}: started_at`),
    finishedAt: parseDate(row.finished_at, `Run ${row.id}: finished_at`),
    stop: parseStop(row),
    crawlerVersion: row.crawler_version,
    requests: { allowed: row.requests_allowed, blocked: row.requests_blocked },
  };
}

function storedArtifact(appKey: AppKey, run: Run, path: ArtifactPath): string {
  if (!isInside(runDirectory(appKey, run.snapshotId, run.id), path)) {
    throw new Error(`Artifact ${path} is not inside the sealed directory of run ${run.id}`);
  }
  return relative(appHome(appKey), path);
}

function loadedArtifact(appKey: AppKey, run: Run, stored: string, description: string): ArtifactPath {
  const path = parseArtifactPath(join(appHome(appKey), stored));
  if (!isInside(runDirectory(appKey, run.snapshotId, run.id), path)) {
    throw new Error(`${description} ${JSON.stringify(stored)} is not inside run ${run.id}`);
  }
  return path;
}

export function captureToRow(appKey: AppKey, run: Run, evidence: CaptureEvidence): Selectable<CapturesTable> {
  return {
    evidence_id: evidence.id,
    run_id: run.id,
    url: evidence.url,
    http_status: evidence.httpStatus,
    screenshot_path: storedArtifact(appKey, run, evidence.screenshot),
    dom_path: storedArtifact(appKey, run, evidence.dom),
  };
}

export function parseCapture(appKey: AppKey, run: Run, row: Selectable<CapturesTable>): CaptureEvidence {
  const where = `Capture ${row.evidence_id}`;
  const url = storedPageUrl(row.url);
  if (new URL(url).origin !== run.origin) throw new Error(`${where}: ${url} is not on ${run.origin}`);
  return {
    kind: 'capture',
    id: parseEvidenceId(row.evidence_id),
    runId: run.id,
    url,
    httpStatus: row.http_status,
    screenshot: loadedArtifact(appKey, run, row.screenshot_path, `${where}: screenshot_path`),
    dom: loadedArtifact(appKey, run, row.dom_path, `${where}: dom_path`),
  };
}

export function navigationToRow(evidence: NavigationEvidence): Selectable<NavigationsTable> {
  const { start } = evidence;
  return {
    evidence_id: evidence.id,
    run_id: evidence.runId,
    start_kind: start.kind,
    from_capture_id: start.kind === 'action' ? start.from.evidenceId : null,
    action_kind: start.kind === 'action' ? start.action.kind : null,
    action: start.kind === 'action' ? JSON.stringify(start.action) : null,
    requested_url: evidence.requested,
    redirects: JSON.stringify(evidence.redirects),
    landing_capture_id: evidence.landing.evidenceId,
    log_seq: evidence.logSeq,
  };
}

export function parseNavigation(
  run: Run,
  row: Selectable<NavigationsTable>,
  captures: ReadonlyMap<string, CaptureEvidence>,
): NavigationEvidence {
  const where = `Navigation ${row.evidence_id}`;
  const captureOf = (id: string | null, column: string): CaptureEvidence => {
    const capture = id === null ? undefined : captures.get(id);
    if (capture === undefined) throw new Error(`${where}: ${column} ${JSON.stringify(id)} is not a capture of run ${run.id}`);
    return capture;
  };
  let start: NavigationEvidenceStart;
  switch (row.start_kind) {
    case 'entry':
      start = { kind: 'entry' };
      break;
    case 'action': {
      const from = captureOf(row.from_capture_id, 'from_capture_id');
      if (row.action === null) throw new Error(`${where}: action must not be null`);
      const action = parseJson(actionSchema, row.action, `${where}: action`);
      if (action.kind !== row.action_kind) throw new Error(`${where}: action_kind disagrees with action`);
      start = { kind: 'action', from: { evidenceId: from.id, url: from.url }, action };
      break;
    }
    default:
      throw new Error(`${where}: unknown start_kind ${JSON.stringify(row.start_kind)}`);
  }
  const landing = captureOf(row.landing_capture_id, 'landing_capture_id');
  return {
    kind: 'navigation',
    id: parseEvidenceId(row.evidence_id),
    runId: run.id,
    start,
    requested: storedPageUrl(row.requested_url),
    redirects: parseJson(redirectsSchema, row.redirects, `${where}: redirects`),
    landing: {
      evidenceId: landing.id,
      url: landing.url,
      httpStatus: landing.httpStatus,
      screenshot: landing.screenshot,
      dom: landing.dom,
    },
    logSeq: row.log_seq,
  };
}
