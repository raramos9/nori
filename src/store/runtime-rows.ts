import { join, relative } from 'node:path';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import {
  parseApplicationId,
  parseArtifactPath,
  parseBuildId,
  parseEvidenceId,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  parseRunId,
  type ArtifactPath,
  type CaptureEvidence,
  type NavigationEvidence,
  type NavigationEvidenceStart,
  type PageUrl,
  type Run,
  type ScreenMatch,
  type Session,
  type TransitionMatch,
} from '../graph/model.js';
import { appHome, isInside, runDirectories } from '../runtime/layout.js';
import type { CapturesTable, NavigationsTable, RunsTable } from './schema.js';

const ANONYMOUS_LABEL = 'anonymous';

function parseDate(value: string, description: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${description} ${JSON.stringify(value)} is not a date`);
  return date;
}

function storedPageUrl(value: string): PageUrl {
  const url = parsePageUrl(parseOrigin(value), value);
  if (url !== value) throw new Error(`${JSON.stringify(value)} is not a stored page URL`);
  return url;
}

const pageUrl = z.string().transform(storedPageUrl);
const routePattern = z.string().transform(parseRoutePattern);
const triggerKind = z.enum(['link', 'router-push', 'router-replace', 'redirect']);
const targetSearch = {
  sourceUrl: pageUrl,
  sourcePattern: routePattern,
  targetUrl: pageUrl,
  targetPattern: routePattern,
  skipped: z.array(
    z.object({
      url: pageUrl,
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
  z.object({ verdict: z.literal('supports'), rule: z.literal('rendered'), url: pageUrl, pattern: routePattern }),
  z.object({
    verdict: z.literal('contradicts'),
    rule: z.literal('server-error'),
    url: pageUrl,
    pattern: routePattern,
    httpStatus: z.number().int(),
  }),
]);

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow-link'), href: pageUrl, name: z.string().nullable() }),
]);

const redirectsSchema = z.array(z.object({ to: pageUrl, via: z.enum(['http', 'client']) }));

function parseJson<T>(schema: z.ZodType<T>, text: string, description: string): T {
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

export function runToRow(run: Run): Selectable<RunsTable> {
  return {
    id: run.id,
    application_id: run.applicationId,
    build_id: run.buildId,
    origin: run.origin,
    session_kind: run.session.kind,
    session_label: sessionLabel(run.session),
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    stop: run.stop,
    crawler_version: run.crawlerVersion,
    reconciler_version: run.reconcilerVersion,
    requests_allowed: run.requests.allowed,
    requests_blocked: run.requests.blocked,
  };
}

export function parseRun(row: Selectable<RunsTable>): Run {
  const origin = parseOrigin(row.origin);
  if (origin !== row.origin) throw new Error(`Run ${row.id}: origin ${JSON.stringify(row.origin)} is not an origin`);
  return {
    id: parseRunId(row.id),
    applicationId: parseApplicationId(row.application_id),
    buildId: parseBuildId(row.build_id),
    origin,
    session: parseSession(row),
    startedAt: parseDate(row.started_at, `Run ${row.id}: started_at`),
    finishedAt: parseDate(row.finished_at, `Run ${row.id}: finished_at`),
    stop: parseStop(row),
    crawlerVersion: row.crawler_version,
    reconcilerVersion: row.reconciler_version,
    requests: { allowed: row.requests_allowed, blocked: row.requests_blocked },
  };
}

// The db names an artifact relative to the app home, so the home can move without rewriting rows.
function storedArtifact(run: Run, path: ArtifactPath): string {
  if (!isInside(runDirectories(run.applicationId, run.id).sealed, path)) {
    throw new Error(`Artifact ${path} is not inside the sealed directory of run ${run.id}`);
  }
  return relative(appHome(run.applicationId), path);
}

function loadedArtifact(run: Run, stored: string, description: string): ArtifactPath {
  const path = parseArtifactPath(join(appHome(run.applicationId), stored));
  if (!isInside(runDirectories(run.applicationId, run.id).sealed, path)) {
    throw new Error(`${description} ${JSON.stringify(stored)} is not inside run ${run.id}`);
  }
  return path;
}

export function captureToRow(run: Run, evidence: CaptureEvidence): Selectable<CapturesTable> {
  return {
    evidence_id: evidence.id,
    run_id: run.id,
    url: evidence.url,
    http_status: evidence.httpStatus,
    screenshot_path: storedArtifact(run, evidence.screenshot),
    dom_path: storedArtifact(run, evidence.dom),
  };
}

export function parseCapture(run: Run, row: Selectable<CapturesTable>): CaptureEvidence {
  const where = `Capture ${row.evidence_id}`;
  const url = storedPageUrl(row.url);
  if (new URL(url).origin !== run.origin) throw new Error(`${where}: ${url} is not on ${run.origin}`);
  return {
    kind: 'capture',
    id: parseEvidenceId(row.evidence_id),
    buildId: run.buildId,
    runId: run.id,
    url,
    httpStatus: row.http_status,
    screenshot: loadedArtifact(run, row.screenshot_path, `${where}: screenshot_path`),
    dom: loadedArtifact(run, row.dom_path, `${where}: dom_path`),
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
    buildId: run.buildId,
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
