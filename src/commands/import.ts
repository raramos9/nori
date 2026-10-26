import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { testImportId } from '../graph/ids.js';
import {
  parseArtifactPath,
  type BuildGraph,
  type LoadedTestImport,
  type TestAttempt,
  type TestCase,
  type TestImportId,
  type TestStep,
  type TestStepMatch,
  type TraceLink,
} from '../graph/model.js';
import { testEvidence } from '../graph/tests.js';
import { artifactPath, importDirectory, importStagingDirectory } from '../runtime/layout.js';
import { record, type ImportOutcome } from '../runtime/record.js';
import { sealCases } from '../store/test-rows.js';
import { readReport, type ReportAttempt, type ReportCase } from '../tests/playwright-report.js';
import { parseSealedImport, REPORT_FILE, sealImport, type SealedImportV1 } from '../tests/sealed-import.js';
import { readTrace } from '../tests/trace.js';
import { copyUntrusted } from '../tests/zip.js';
import type { Command } from './command.js';
import { analyze } from './scan.js';
import { currentEnvironment } from './verify.js';

export type ImportReport = { readonly graph: BuildGraph; readonly outcome: ImportOutcome };

const TRACES_DIR = 'traces';

function outcomeImportId(outcome: ImportOutcome): TestImportId {
  switch (outcome.kind) {
    case 'matched-now':
      return outcome.ingestion.testImport.id;
    case 'already-matched':
      return outcome.testImport.id;
    case 'failed':
      return outcome.importId;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

async function stageAttempt({
  testCase,
  attempt,
  root,
  staging,
  directory,
}: {
  testCase: ReportCase;
  attempt: ReportAttempt;
  root: string;
  staging: string;
  directory: string;
}): Promise<TestAttempt> {
  const failed = attempt.status !== 'passed' && attempt.status !== 'skipped';
  const reportFailures = failed ? attempt.errors.map((message) => ({ message, step: null })) : [];
  const traceless = (reason: Extract<TraceLink, { kind: 'trace-less' }>['reason']): TestAttempt => ({
    retry: attempt.retry,
    status: attempt.status,
    trace: { kind: 'trace-less', reason },
    failures: reportFailures,
  });
  if (attempt.trace === null) return traceless({ kind: 'no-trace-attachment' });
  const file = join(TRACES_DIR, `${testCase.key}-${attempt.retry}.zip`);
  const copied = await copyUntrusted({ path: attempt.trace, root, destination: join(staging, file) });
  if (copied.kind === 'refused') return traceless(copied.reason);
  const read = await readTrace(copied.copy);
  if (read.kind === 'rejected') {
    await rm(copied.copy, { force: true });
    return traceless({ kind: 'unreadable', path: attempt.trace, why: read.why });
  }
  const { steps, failures } = read.trace;
  return {
    retry: attempt.retry,
    status: attempt.status,
    trace: { kind: 'read', original: parseArtifactPath(attempt.trace), sealed: artifactPath(directory, file), steps },
    failures: failed && failures.length > 0 ? failures : reportFailures,
  };
}

// The import is the report's bytes against the checkout's current snapshot. A sealed import is never
// re-read from the user's files: re-importing goes straight to record(), which matches it once per analysis.
export async function importReport({ reportPath, path }: { reportPath: string; path: string }): Promise<ImportReport> {
  const analyzed = await analyze({ path, createdAt: new Date() });
  const { application, snapshot } = analyzed.ingestion;
  const original = resolve(reportPath);
  const report = await readReport(original);
  const id = testImportId({ snapshotId: snapshot.id, sha256: report.sha256 });
  const directory = importDirectory(application.id, snapshot.id, id);

  if (!existsSync(directory)) {
    const staging = importStagingDirectory(application.id);
    try {
      await mkdir(join(staging, TRACES_DIR), { recursive: true, mode: 0o700 });
      await writeFile(join(staging, REPORT_FILE), report.bytes, { mode: 0o600 });
      const cases: TestCase[] = [];
      for (const testCase of report.cases) {
        const attempts: TestAttempt[] = [];
        for (const attempt of testCase.attempts) {
          attempts.push(await stageAttempt({ testCase, attempt, root: analyzed.inputs.top, staging, directory }));
        }
        cases.push({ ...testCase, attempts });
      }
      const sealedImport: SealedImportV1 = {
        format: 1,
        id,
        snapshotId: snapshot.id,
        environment: currentEnvironment(process.env),
        importedAt: new Date(),
        report: {
          original: parseArtifactPath(original),
          sha256: report.sha256,
          playwrightVersion: report.playwrightVersion,
          startedAt: report.startedAt,
        },
        cases: sealCases(directory, cases),
      };
      parseSealedImport(JSON.stringify(sealedImport));
      await sealImport({ staging, sealed: directory, sealedImport });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  const { graph, imports } = await record(analyzed);
  const outcome = imports.find((candidate) => outcomeImportId(candidate) === id);
  if (outcome === undefined) throw new Error(`Import ${id} was sealed but not recorded`);
  return { graph, outcome };
}

function shown(path: string): string {
  const rest = relative(process.cwd(), path);
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest) ? rest : path;
}

function pathOf(url: string): string {
  const { pathname, search } = new URL(url);
  return `${pathname}${search}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function firstLine(message: string): string {
  return message.replace(/^Error: /, '').split('\n')[0] ?? '';
}

function formatTraceless(link: Extract<TraceLink, { kind: 'trace-less' }>): string {
  const { reason } = link;
  switch (reason.kind) {
    case 'no-trace-attachment':
      return 'trace-less: no trace attachment';
    case 'missing':
      return `trace-less: ${shown(reason.path)} does not exist`;
    case 'outside-root':
      return `trace-less: ${shown(reason.path)} is outside ${reason.root}`;
    case 'not-a-file':
      return `trace-less: ${shown(reason.path)} is not a regular file`;
    case 'too-large':
      return `trace-less: ${shown(reason.path)} is ${reason.bytes} bytes, over the ${reason.limit} byte limit`;
    case 'unreadable':
      return `trace-less: ${shown(reason.path)} is not readable (${reason.why.kind})`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function formatStep(step: TestStep, match: TestStepMatch | undefined): string {
  const landing = pathOf(step.chain[step.chain.length - 1] ?? step.chain[0]);
  const walk = step.from === null ? landing : `${pathOf(step.from)} -> ${landing}`;
  switch (match?.kind) {
    case undefined:
      return `${walk} (not matched)`;
    case 'entry':
      return `entry ${landing}`;
    case 'walked':
      return `${walk} (${match.search.triggerCandidates.join(' | ')})`;
    case 'walked-runtime-only':
      return `${walk} (${match.search.triggerCandidates.join(' | ')}, not in source)`;
    case 'ambiguous':
      return `${walk} (ambiguous between ${match.candidates.length} transitions)`;
    case 'no-transition':
      return `${walk} (no transition in source)`;
    case 'not-a-screen':
      return `${walk} (${pathOf(match.url)} is not a screen: ${match.why})`;
    case 'off-origin':
      return `${walk} (off origin)`;
    case 'unattributed':
      return `${walk} (no test action caused it)`;
    default: {
      const _exhaustive: never = match;
      return _exhaustive;
    }
  }
}

function formatAttempt(loaded: LoadedTestImport, testCase: TestCase, attempt: TestAttempt): string[] {
  const indent = '          ';
  const { trace } = attempt;
  if (trace.kind === 'trace-less') {
    return [
      `${indent}${formatTraceless(trace)}`,
      ...attempt.failures.map(({ message }) => `${indent}failed: ${firstLine(message)} (not located on a transition)`),
    ];
  }
  const matchOf = new Map(
    loaded.matches
      .filter(({ caseKey, retry }) => caseKey === testCase.key && retry === attempt.retry)
      .map(({ seq, match }) => [seq, match]),
  );
  const lines = [`${indent}trace ${shown(trace.original)}`];
  for (const step of trace.steps) {
    const here = attempt.failures.filter((failure) => failure.step === step.seq).map(({ message }) => `   failed here: ${firstLine(message)}`);
    lines.push(`${indent}${formatStep(step, matchOf.get(step.seq))}${here.join('')}`);
  }
  for (const { message } of attempt.failures.filter((failure) => failure.step === null)) {
    lines.push(`${indent}failed: ${firstLine(message)} (not located on a transition)`);
  }
  return lines;
}

export function formatImport({ graph, outcome }: ImportReport): string {
  const id = outcomeImportId(outcome);
  if (outcome.kind === 'failed') return `${id}: sealed but not matched: ${outcome.reason}`;
  const loaded = graph.tests.find(({ testImport }) => testImport.id === id);
  if (loaded === undefined) return `${id}: matched but not loaded under analysis ${graph.analysis.id}`;
  const { testImport, cases } = loaded;
  const { snapshot } = graph;
  const header =
    outcome.kind === 'already-matched'
      ? [`already imported as ${id}, nothing changed`]
      : [
          `imported ${id} against build ${snapshot.commitSha.slice(0, 7)}, sources ${snapshot.sourceHash.slice(0, 8)} (${testImport.environment})`,
          `  report ${shown(testImport.report.original)}, Playwright ${testImport.report.playwrightVersion}, ${plural(cases.length, 'case')}`,
        ];
  const body = cases.flatMap((testCase) => [
    `  ${testCase.outcome.padEnd(7)} ${testCase.title}`,
    ...testCase.attempts.flatMap((attempt) => formatAttempt(loaded, testCase, attempt)),
  ]);
  const tests = testEvidence({ ...graph, tests: [loaded] });
  const count = (kind: TestCase['outcome']) => cases.filter((testCase) => testCase.outcome === kind).length;
  const traceless = cases.filter(({ attempts }) => attempts.some(({ trace }) => trace.kind === 'trace-less')).length;
  const summary =
    `${plural(cases.length, 'case')}: ${count('passed')} passed, ${count('failed')} failed, ${count('flaky')} flaky, ${traceless} trace-less; ` +
    `${plural(tests.byTransition.size, 'transition')} walked, ${tests.exercisedByPassingTest.size} exercised by a passing test`;
  return [...header, ...body, summary].join('\n');
}

export const importCommand: Command = {
  summary: 'attach a Playwright JSON report and its traces to the graph as test evidence',
  async run(argv) {
    const { positionals } = parseArgs({ args: [...argv], options: {}, allowPositionals: true, strict: true });
    const [reportPath, path, ...rest] = positionals;
    if (reportPath === undefined || rest.length > 0) {
      process.stderr.write('nori import takes <report.json> [path]\n');
      return 2;
    }
    const report = await importReport({ reportPath, path: path ?? process.cwd() });
    process.stdout.write(`${formatImport(report)}\n`);
    return report.outcome.kind === 'failed' ? 1 : 0;
  },
};
