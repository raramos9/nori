import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { errorCode, NoriError } from '../errors.js';
import { testCaseKey } from '../graph/ids.js';
import type { AttemptStatus, TestCase, TestCaseKey, TestOutcome } from '../graph/model.js';
import { cleanText, LIMITS, oneLine } from './limits.js';

export type ReportAttempt = {
  readonly retry: number;
  readonly status: AttemptStatus;
  readonly startedAt: Date;
  readonly errors: readonly string[];
  readonly trace: string | null;
};

export type ReportCase = Omit<TestCase, 'attempts'> & { readonly attempts: readonly ReportAttempt[] };

export type ParsedReport = {
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly playwrightVersion: string;
  readonly startedAt: Date;
  readonly cases: readonly ReportCase[];
};

const line = z.string().transform(oneLine);
const date = z.iso.datetime().transform((value) => new Date(value));
const attemptStatus = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);

const OUTCOMES: Readonly<Record<'expected' | 'unexpected' | 'flaky' | 'skipped', TestOutcome>> = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

const errorSchema = z.object({ message: z.string().optional() });

const resultSchema = z.object({
  retry: z.number().int().nonnegative(),
  status: attemptStatus,
  startTime: date,
  error: errorSchema.optional(),
  errors: z.array(errorSchema).default([]),
  attachments: z
    .array(z.object({ name: z.string(), contentType: z.string(), path: z.string().optional() }))
    .default([]),
});

const testSchema = z.object({
  projectName: line,
  expectedStatus: attemptStatus,
  status: z.enum(['expected', 'unexpected', 'flaky', 'skipped']),
  results: z.array(resultSchema),
});

const specSchema = z.object({
  title: line,
  file: line,
  line: z.number().int().nonnegative(),
  tests: z.array(testSchema),
});

const suiteSchema = z.object({
  title: line,
  specs: z.array(specSchema).default([]),
  suites: z.array(z.unknown()).default([]),
});

const reportSchema = z.object({
  config: z.object({ version: line }),
  suites: z.array(z.unknown()),
  stats: z.object({ startTime: date }),
});

type Spec = z.infer<typeof specSchema>;

function fail(path: string, message: string): never {
  throw new NoriError(`${path} is not a Playwright JSON report: ${message}`);
}

function parse<T>(schema: z.ZodType<T, unknown>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(path, z.prettifyError(result.error));
  return result.data;
}

// The top-level suites are files; nested ones are describe blocks, whose titles lead the title path.
function specsOf(path: string, suites: readonly unknown[]): { describes: readonly string[]; spec: Spec }[] {
  const found: { describes: readonly string[]; spec: Spec }[] = [];
  const pending = suites.toReversed().map((raw) => ({ raw, describes: [] as readonly string[], depth: 1, file: true }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.depth > LIMITS.reportDepth) fail(path, `suites nest deeper than ${LIMITS.reportDepth}`);
    const suite = parse(suiteSchema, next.raw, path);
    const describes = next.file ? next.describes : [...next.describes, suite.title];
    for (const spec of suite.specs) found.push({ describes, spec });
    for (const raw of suite.suites.toReversed()) pending.push({ raw, describes, depth: next.depth + 1, file: false });
    if (found.length > LIMITS.cases) fail(path, `more than ${LIMITS.cases} cases`);
  }
  return found;
}

function attemptOf(reportPath: string, result: z.infer<typeof resultSchema>): ReportAttempt {
  const messages = result.errors.length > 0 ? result.errors : result.error === undefined ? [] : [result.error];
  if (messages.length > LIMITS.failuresPerAttempt) fail(reportPath, `an attempt has more than ${LIMITS.failuresPerAttempt} errors`);
  const trace = result.attachments.find(
    ({ name, contentType, path }) => name === 'trace' && contentType === 'application/zip' && path !== undefined,
  );
  if (trace?.path !== undefined && oneLine(trace.path) !== trace.path) fail(reportPath, 'a trace path carries control characters or line breaks');
  return {
    retry: result.retry,
    status: result.status,
    startedAt: result.startTime,
    errors: messages.flatMap(({ message }) => (message === undefined ? [] : [cleanText(message)])),
    trace: trace?.path === undefined ? null : resolve(dirname(reportPath), trace.path),
  };
}

// The report is the user's named input, so anything malformed fails the command. Attachment paths
// are resolved against the report's directory and nothing else is opened here.
export async function readReport(path: string): Promise<ParsedReport> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: unknown) => fail(path, `it cannot be opened (${String(errorCode(error))})`));
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) fail(path, 'it is not a file');
    if (stats.size > LIMITS.reportBytes) fail(path, `it is ${stats.size} bytes, over the ${LIMITS.reportBytes} byte limit`);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(path, 'it is not JSON');
  }
  const report = parse(reportSchema, json, path);
  const keys = new Set<TestCaseKey>();
  const cases = specsOf(path, report.suites).flatMap(({ describes, spec }) =>
    spec.tests.map((test): ReportCase => {
      const titlePath = [...describes, spec.title];
      const key = testCaseKey({ file: spec.file, titlePath, project: test.projectName });
      if (keys.has(key)) fail(path, `${spec.file} lists ${JSON.stringify(spec.title)} twice in project ${JSON.stringify(test.projectName)}`);
      keys.add(key);
      if (test.results.length > LIMITS.attemptsPerCase) fail(path, `${spec.title} has more than ${LIMITS.attemptsPerCase} attempts`);
      if (new Set(test.results.map(({ retry }) => retry)).size !== test.results.length) fail(path, `${spec.title} repeats a retry`);
      return {
        key,
        title: spec.title,
        titlePath,
        file: spec.file,
        line: spec.line,
        project: test.projectName,
        expectedStatus: test.expectedStatus,
        outcome: OUTCOMES[test.status],
        attempts: [...test.results].sort((a, b) => a.retry - b.retry).map((result) => attemptOf(path, result)),
      };
    }),
  );
  if (cases.length > LIMITS.cases) fail(path, `more than ${LIMITS.cases} cases`);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
    playwrightVersion: report.config.version,
    startedAt: report.stats.startTime,
    cases,
  };
}
