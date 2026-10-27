import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAnalyzerVersion, type BuildGraph, type TestCase, type TransitionId } from '../graph/model.js';
import { testEvidence } from '../graph/tests.js';
import { stateDatabasePath } from '../runtime/layout.js';
import { record } from '../runtime/record.js';
import { IMPORT_FILE } from '../tests/sealed-import.js';
import { text, zip } from '../testing/zip-builder.js';
import { formatImport, importReport } from './import.js';
import { analyze, scan } from './scan.js';

const REPO = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const DEMO = join(REPO, 'fixtures', 'demo');
const ARTIFACTS = join(DEMO, 'e2e', 'artifacts');
const FAILING = 'home: Docs link lists a changelog guide';
const PASSING = 'pricing: Get started opens the signup form';
const SLOW = 120_000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const tempDirs: string[] = [];
const originalHome = process.env.NORI_HOME;
beforeEach(() => {
  process.env.NORI_HOME = mkdtempSync(join(tmpdir(), 'nori-import-home-'));
  tempDirs.push(process.env.NORI_HOME);
});
afterEach(() => {
  process.env.NORI_HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Inside the git top level, so the traces pass confinement, and outside the Next project, so its source
// hash and snapshot stay the same.
function scratchInRepo(): string {
  const dir = mkdtempSync(join(REPO, '.nori-import-test-'));
  tempDirs.push(dir);
  return dir;
}

function routeOfState(graph: BuildGraph): Map<string, string> {
  return new Map(graph.screens.flatMap(({ screen, states }) => states.map((state) => [state.id as string, screen.routePattern as string])));
}

function edge(graph: BuildGraph, id: TransitionId): string {
  const routes = routeOfState(graph);
  const loaded = graph.transitions.find(({ transition }) => transition.id === id);
  if (loaded === undefined) throw new Error(`${id} is not loaded`);
  const { sourceStateId, target } = loaded.transition;
  return `${routes.get(sourceStateId)} -> ${target.kind === 'resolved' ? routes.get(target.stateId) : target.expression}`;
}

const failingEdges = (graph: BuildGraph) =>
  [...testEvidence(graph).byTransition].filter(([, tests]) => tests.failing.length > 0).map(([id]) => edge(graph, id));
const exercisedEdges = (graph: BuildGraph) => [...testEvidence(graph).exercisedByPassingTest].map((id) => edge(graph, id));
const statuses = (graph: BuildGraph) => graph.transitions.map(({ transition, status }) => [transition.id, status]);

function caseTitled(graph: BuildGraph, title: string): TestCase {
  const found = graph.tests.flatMap(({ cases }) => cases).find((testCase) => testCase.title === title);
  if (found === undefined) throw new Error(`no case ${title}`);
  return found;
}

function rowCounts(graph: BuildGraph): Record<string, number> {
  const sqlite = new Database(stateDatabasePath(graph.application.id), { readonly: true });
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [name, (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n]),
    );
  } finally {
    sqlite.close();
  }
}

const ORIGIN = 'http://127.0.0.1:3000';
const STARTED = '2026-10-26T00:00:00.000Z';

const mainFrame = (callId: string, path: string, timestamp: number) => ({
  type: 'frame-snapshot',
  snapshot: { callId, phase: 'after', pageId: 'p', isMainFrame: true, frameUrl: `${ORIGIN}${path}`, timestamp, html: [] },
});

function writeTrace(dir: string, name: string, entries: Record<string, readonly unknown[]>): string {
  mkdirSync(join(dir, 'traces'), { recursive: true });
  const path = join('traces', name);
  writeFileSync(join(dir, path), zip(Object.entries(entries).map(([entry, lines]) => ({ name: entry, data: text(lines.map((line) => JSON.stringify(line)).join('\n')) }))));
  return path;
}

const traceResult = (trace: string, overrides: Record<string, unknown> = {}) => ({
  retry: 0,
  status: 'passed',
  startTime: STARTED,
  attachments: [{ name: 'trace', contentType: 'application/zip', path: trace }],
  ...overrides,
});

function writeReport(dir: string, specs: readonly { title: string; results: readonly unknown[]; status?: string }[]): string {
  const path = join(dir, 'report.json');
  const suite = {
    title: 'a.spec.ts',
    specs: specs.map(({ title, results, status = 'expected' }, line) => ({
      title,
      file: 'a.spec.ts',
      line,
      tests: [{ projectName: '', expectedStatus: 'passed', status, results }],
    })),
  };
  writeFileSync(path, JSON.stringify({ config: { version: '1.64.0' }, suites: [suite], stats: { startTime: STARTED } }));
  return path;
}

describe('nori import', () => {
  it(
    'imports one passing and one failing case, with the failure on / -> /docs only',
    async () => {
      const before = statuses(await scan({ path: DEMO }));
      const { graph, outcome } = await importReport({ reportPath: join(ARTIFACTS, 'report.json'), path: DEMO });
      expect(outcome.kind).toBe('matched-now');

      const [loaded] = graph.tests;
      expect(graph.tests).toHaveLength(1);
      expect(loaded?.testImport.report.original).toBe(join(ARTIFACTS, 'report.json'));
      expect(existsSync(loaded?.testImport.report.sealed ?? '')).toBe(true);
      const failed = caseTitled(graph, FAILING);
      const passed = caseTitled(graph, PASSING);
      expect([failed.outcome, passed.outcome]).toEqual(['failed', 'passed']);
      expect(failed.attempts[0]?.trace).toMatchObject({ kind: 'read', original: join(ARTIFACTS, 'traces/home-to-docs/trace.zip') });
      expect(passed.attempts[0]?.trace).toMatchObject({ kind: 'read', original: join(ARTIFACTS, 'traces/pricing-to-signup/trace.zip') });
      for (const { trace } of [...failed.attempts, ...passed.attempts]) {
        if (trace.kind === 'read') expect(readFileSync(trace.sealed)).toEqual(readFileSync(trace.original));
      }

      expect(failingEdges(graph)).toEqual(['/ -> /docs']);
      expect(exercisedEdges(graph)).toEqual(['/pricing -> /signup']);
      const [docs] = [...testEvidence(graph).byTransition].filter(([id]) => edge(graph, id) === '/ -> /docs');
      expect(docs?.[1].failing[0]?.message).toContain('docs index has no changelog guide');
      expect(statuses(graph)).toEqual(before);
    },
    SLOW,
  );

  it(
    're-importing the same report changes no rows',
    async () => {
      const first = await importReport({ reportPath: join(ARTIFACTS, 'report.json'), path: DEMO });
      const rows = rowCounts(first.graph);
      const again = await importReport({ reportPath: join(ARTIFACTS, 'report.json'), path: DEMO });
      expect(again.outcome.kind).toBe('already-matched');
      expect(rowCounts(again.graph)).toEqual(rows);
      expect(formatImport(again).split('\n')[0]).toBe(`already imported as ${first.graph.tests[0]?.testImport.id}, nothing changed`);
    },
    SLOW,
  );

  it(
    'imports the missing-trace report with the failing case trace-less',
    async () => {
      const { graph } = await importReport({ reportPath: join(ARTIFACTS, 'missing-trace/report.json'), path: DEMO });
      const failed = caseTitled(graph, FAILING);
      expect(failed.attempts[0]?.trace).toEqual({
        kind: 'trace-less',
        reason: { kind: 'missing', path: join(ARTIFACTS, 'missing-trace/traces/home-to-docs/trace.zip') },
      });
      expect(failed.attempts[0]?.failures).toEqual([{ message: expect.stringContaining('no changelog guide'), step: null }]);
      expect(failingEdges(graph)).toEqual([]);
      expect(exercisedEdges(graph)).toEqual(['/pricing -> /signup']);
    },
    SLOW,
  );

  it(
    'a newer analysis re-matches the import after the original files are deleted',
    async () => {
      const copy = scratchInRepo();
      cpSync(join(ARTIFACTS, 'report.json'), join(copy, 'report.json'));
      cpSync(join(ARTIFACTS, 'traces'), join(copy, 'traces'), { recursive: true });
      const first = await importReport({ reportPath: join(copy, 'report.json'), path: DEMO });
      rmSync(copy, { recursive: true });
      const { graph, imports } = await record(
        await analyze({ path: DEMO, createdAt: new Date(), analyzerVersion: parseAnalyzerVersion('next') }),
      );
      expect(graph.analysis.id).not.toBe(first.graph.analysis.id);
      expect(imports.map(({ kind }) => kind)).toEqual(['matched-now']);
      expect(failingEdges(graph)).toEqual(['/ -> /docs']);
      expect(exercisedEdges(graph)).toEqual(['/pricing -> /signup']);
    },
    SLOW,
  );

  it(
    'seals and prints a trace whose selector and method carry escape sequences without a control character',
    async () => {
      const dir = scratchInRepo();
      const trace = writeTrace(dir, 'trace.zip', {
        '1-trace.trace': [
          { type: 'context-options', version: 10, options: { baseURL: ORIGIN } },
          { type: 'before', callId: 'c@1', startTime: 0, method: 'goto', params: { url: '/' } },
          mainFrame('c@1', '/', 1),
          { type: 'before', callId: 'c@2', startTime: 2, method: 'click\u001b[2J\u0007', params: {} },
          { type: 'before', callId: 'c@3', startTime: 3, method: 'click', params: { selector: 'text=\u001b[2JDocs\u0007' } },
          mainFrame('c@3', '/docs', 4),
        ],
      });
      const reportPath = writeReport(dir, [{ title: 'docs \u001b[31mred\u001b[39m', results: [traceResult(trace)] }]);
      const report = await importReport({ reportPath, path: DEMO });
      const printed = formatImport(report);
      expect(printed).toContain('/ -> /docs');
      expect(printed).not.toMatch(CONTROL);
      const [loaded] = report.graph.tests;
      const sealed = readFileSync(join(dirname(loaded?.testImport.report.sealed ?? ''), IMPORT_FILE), 'utf8');
      expect(JSON.parse(sealed).cases[0].attempts[0].trace.steps[1].cause).toMatchObject({ method: 'click', selector: 'text=Docs' });
      expect(JSON.stringify(JSON.parse(sealed))).not.toMatch(/\\u00(?:0[0-8]|1[0-9a-f]|7f|[89][0-9a-f])/);
    },
    SLOW,
  );

  it(
    'keeps the test failure when a caught call failed earlier, and does not locate it',
    async () => {
      const dir = scratchInRepo();
      const trace = writeTrace(dir, 'caught.zip', {
        'test.trace': [
          { type: 'before', callId: 'c@1', startTime: 0, method: 'pw:api' },
          { type: 'after', callId: 'c@1', endTime: 1 },
          { type: 'before', callId: 'c@2', startTime: 2, method: 'pw:api' },
          { type: 'after', callId: 'c@2', endTime: 4, error: { message: 'TimeoutError: locator.click: Timeout 100ms exceeded.' } },
        ],
        '1-trace.trace': [
          { type: 'context-options', version: 10, options: { baseURL: ORIGIN } },
          { type: 'before', callId: 'c@1', startTime: 0, method: 'goto', params: { url: '/' } },
          mainFrame('c@1', '/', 1),
          { type: 'before', callId: 'c@2', startTime: 2, method: 'click', params: { selector: '#x' } },
          mainFrame('c@2', '/', 3),
        ],
      });
      const reportPath = writeReport(dir, [
        { title: 'boom', status: 'unexpected', results: [traceResult(trace, { status: 'failed', error: { message: 'Error: boom' } })] },
      ]);
      const report = await importReport({ reportPath, path: DEMO });
      expect(caseTitled(report.graph, 'boom').attempts[0]?.failures).toEqual([{ message: 'Error: boom', step: null }]);
      expect(formatImport(report)).toContain('failed: boom (not located on a transition)');
    },
    SLOW,
  );

  it(
    'copies a trace that many attempts name once and links every attempt to that copy',
    async () => {
      const dir = scratchInRepo();
      const trace = writeTrace(dir, 'shared.zip', {
        '1-trace.trace': [
          { type: 'context-options', version: 10, options: { baseURL: ORIGIN } },
          { type: 'before', callId: 'c@1', startTime: 0, method: 'goto', params: { url: '/' } },
          mainFrame('c@1', '/', 1),
        ],
      });
      const results = [0, 1, 2].map((retry) => traceResult(trace, { retry }));
      const reportPath = writeReport(dir, [{ title: 'one', results }, { title: 'two', results }]);
      const { graph } = await importReport({ reportPath, path: DEMO });
      const sealed = graph.tests[0]?.cases.flatMap(({ attempts }) => attempts.map(({ trace: link }) => (link.kind === 'read' ? link.sealed : null)));
      expect(sealed).toHaveLength(6);
      expect(new Set(sealed).size).toBe(1);
      expect(readdirSync(dirname(sealed?.[0] ?? ''))).toHaveLength(1);
    },
    SLOW,
  );
});
