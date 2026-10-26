import { join, relative } from 'node:path';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import {
  parseArtifactPath,
  parseOrigin,
  parseSnapshotId,
  parseTestCaseKey,
  parseTestImportId,
  parseTransitionId,
  type AppKey,
  type Origin,
  type TestAttempt,
  type TestCase,
  type TestImport,
  type TestStepMatch,
  type TraceLink,
  type TracelessReason,
  type TraceRejection,
} from '../graph/model.js';
import { appHome, artifactPath, importDirectory, isInside } from '../runtime/layout.js';
import { pageUrlSchema, parseDate, parseJson, targetSearch } from './rows.js';
import type { TestImportsTable } from './schema.js';

// A sealed case is a TestCase whose read trace names its sealed copy relative to the import directory,
// so import.json and the test_imports.cases column share this one codec.
export type SealedTraceLink =
  | (Omit<Extract<TraceLink, { kind: 'read' }>, 'sealed'> & { readonly sealed: string })
  | Extract<TraceLink, { kind: 'trace-less' }>;
export type SealedAttempt = Omit<TestAttempt, 'trace'> & { readonly trace: SealedTraceLink };
export type SealedCase = Omit<TestCase, 'attempts'> & { readonly attempts: readonly SealedAttempt[] };

const count = z.number().int().nonnegative();
const artifact = z.string().transform(parseArtifactPath);
const attemptStatus = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);

function storedOrigin(value: string): Origin {
  const origin = parseOrigin(value);
  if (origin !== value) throw new Error(`${JSON.stringify(value)} is not an origin`);
  return origin;
}

const traceRejectionSchema: z.ZodType<TraceRejection, unknown> = z.union([
  z.object({
    kind: z.enum(['not-a-zip', 'zip64', 'multi-disk', 'encrypted', 'truncated', 'overlapping-entries', 'no-trace-entries']),
  }),
  z.object({ kind: z.literal('too-many-entries'), count }),
  z.object({ kind: z.literal('unsupported-method'), entry: z.string(), method: count }),
  z.object({
    kind: z.enum([
      'unsafe-name',
      'duplicate-name',
      'header-mismatch',
      'size-mismatch',
      'crc-mismatch',
      'inflate-failed',
      'bad-trace-entry',
    ]),
    entry: z.string(),
  }),
  z.object({ kind: z.literal('entry-too-large'), entry: z.string(), bytes: count }),
  z.object({ kind: z.literal('total-too-large'), bytes: count }),
  z.object({ kind: z.literal('unsupported-trace-version'), version: z.number() }),
  z.object({ kind: z.literal('bad-trace-line'), entry: z.string(), line: count }),
  z.object({ kind: z.literal('too-many-lines'), entry: z.string(), count }),
  z.object({ kind: z.literal('too-many-calls'), count }),
  z.object({ kind: z.literal('too-many-steps'), count }),
  z.object({ kind: z.literal('io-error'), code: z.string() }),
]);

const tracelessReasonSchema: z.ZodType<TracelessReason, unknown> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-trace-attachment') }),
  z.object({ kind: z.literal('missing'), path: z.string() }),
  z.object({ kind: z.literal('outside-root'), path: z.string(), root: z.string() }),
  z.object({ kind: z.literal('not-a-file'), path: z.string() }),
  z.object({ kind: z.literal('too-large'), path: z.string(), bytes: count, limit: count }),
  z.object({ kind: z.literal('unreadable'), path: z.string(), why: traceRejectionSchema }),
]);

const stepSchema = z.object({
  seq: count,
  page: count,
  at: z.number(),
  origin: z.string().transform(storedOrigin),
  cause: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('navigate'),
      method: z.enum(['goto', 'reload', 'goBack', 'goForward']),
      requested: z.string().nullable(),
    }),
    z.object({ kind: z.literal('input'), method: z.string(), selector: z.string().nullable(), anchor: pageUrlSchema.nullable() }),
    z.object({ kind: z.literal('none') }),
  ]),
  from: z.string().nullable(),
  chain: z.tuple([z.string()], z.string()),
  assertions: count,
});

const sealedCasesSchema: z.ZodType<readonly SealedCase[], unknown> = z.array(
  z.object({
    key: z.string().transform(parseTestCaseKey),
    title: z.string(),
    titlePath: z.array(z.string()),
    file: z.string(),
    line: count,
    project: z.string(),
    expectedStatus: attemptStatus,
    outcome: z.enum(['passed', 'failed', 'skipped', 'flaky']),
    attempts: z.array(
      z.object({
        retry: count,
        status: attemptStatus,
        trace: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('read'), original: artifact, sealed: z.string(), steps: z.array(stepSchema) }),
          z.object({ kind: z.literal('trace-less'), reason: tracelessReasonSchema }),
        ]),
        failures: z.array(z.object({ message: z.string(), step: count.nullable() })),
      }),
    ),
  }),
);

export function sealCases(directory: string, cases: readonly TestCase[]): readonly SealedCase[] {
  return cases.map((testCase) => ({
    ...testCase,
    attempts: testCase.attempts.map((attempt) => ({
      ...attempt,
      trace: attempt.trace.kind === 'read' ? { ...attempt.trace, sealed: relative(directory, attempt.trace.sealed) } : attempt.trace,
    })),
  }));
}

export function unsealCases(directory: string, cases: readonly SealedCase[]): readonly TestCase[] {
  return cases.map((testCase) => ({
    ...testCase,
    attempts: testCase.attempts.map((attempt) => ({
      ...attempt,
      trace: attempt.trace.kind === 'read' ? { ...attempt.trace, sealed: artifactPath(directory, attempt.trace.sealed) } : attempt.trace,
    })),
  }));
}

export function parseSealedCases(value: unknown, description: string): readonly SealedCase[] {
  const result = sealedCasesSchema.safeParse(value);
  if (!result.success) throw new Error(`${description}: ${z.prettifyError(result.error)}`);
  return result.data;
}

const transitionId = z.string().transform(parseTransitionId);

const testStepMatchSchema: z.ZodType<TestStepMatch, unknown> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entry') }),
  z.object({ kind: z.literal('walked'), transitionId, search: z.object(targetSearch) }),
  z.object({ kind: z.literal('walked-runtime-only'), transitionId, search: z.object(targetSearch) }),
  z.object({ kind: z.literal('ambiguous'), candidates: z.tuple([transitionId], transitionId), search: z.object(targetSearch) }),
  z.object({ kind: z.literal('no-transition'), search: z.object(targetSearch) }),
  z.object({
    kind: z.literal('not-a-screen'),
    url: pageUrlSchema,
    why: z.enum(['asset', 'handler', 'no-matching-route', 'ambiguous-route']),
  }),
  z.object({ kind: z.literal('off-origin'), url: z.string() }),
  z.object({ kind: z.literal('unattributed') }),
]);

export function parseTestStepMatch(text: string, description: string): TestStepMatch {
  return parseJson(testStepMatchSchema, text, description);
}

export function matchedTransition(match: TestStepMatch): string | null {
  return match.kind === 'walked' || match.kind === 'walked-runtime-only' ? match.transitionId : null;
}

function sealedReport(appKey: AppKey, testImport: TestImport): string {
  if (!isInside(importDirectory(appKey, testImport.snapshotId, testImport.id), testImport.report.sealed)) {
    throw new Error(`Report ${testImport.report.sealed} is not inside the sealed directory of import ${testImport.id}`);
  }
  return relative(appHome(appKey), testImport.report.sealed);
}

export function testImportToRow(
  appKey: AppKey,
  testImport: TestImport,
  cases: readonly TestCase[],
): Selectable<TestImportsTable> {
  const directory = importDirectory(appKey, testImport.snapshotId, testImport.id);
  return {
    id: testImport.id,
    snapshot_id: testImport.snapshotId,
    environment: testImport.environment,
    report_original: testImport.report.original,
    report_sealed: sealedReport(appKey, testImport),
    report_sha256: testImport.report.sha256,
    playwright_version: testImport.report.playwrightVersion,
    report_started_at: testImport.report.startedAt.toISOString(),
    imported_at: testImport.importedAt.toISOString(),
    cases: JSON.stringify(sealCases(directory, cases)),
  };
}

export function parseTestImport(
  appKey: AppKey,
  row: Selectable<TestImportsTable>,
): { readonly testImport: TestImport; readonly cases: readonly TestCase[] } {
  const where = `Test import ${row.id}`;
  const id = parseTestImportId(row.id);
  const snapshotId = parseSnapshotId(row.snapshot_id);
  const directory = importDirectory(appKey, snapshotId, id);
  const sealed = parseArtifactPath(join(appHome(appKey), row.report_sealed));
  if (!isInside(directory, sealed)) throw new Error(`${where}: report_sealed ${JSON.stringify(row.report_sealed)} is not inside it`);
  if (row.environment !== 'local' && row.environment !== 'ci') {
    throw new Error(`${where}: unknown environment ${JSON.stringify(row.environment)}`);
  }
  return {
    testImport: {
      id,
      snapshotId,
      environment: row.environment,
      importedAt: parseDate(row.imported_at, `${where}: imported_at`),
      report: {
        original: parseArtifactPath(row.report_original),
        sealed,
        sha256: row.report_sha256,
        playwrightVersion: row.playwright_version,
        startedAt: parseDate(row.report_started_at, `${where}: report_started_at`),
      },
    },
    cases: unsealCases(directory, parseSealedCases(JSON.parse(row.cases), `${where}: cases`)),
  };
}
