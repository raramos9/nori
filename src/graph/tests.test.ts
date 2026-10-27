import { describe, expect, expectTypeOf, it } from 'vitest';
import { TEST_APP, testAnalysis, testSnapshot } from '../testing/identity.js';
import { evidenceId, testCaseKey, testImportId, transitionId } from './ids.js';
import {
  parseArtifactPath,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  parseStateId,
  type AttemptStatus,
  type BuildGraph,
  type LoadedTransition,
  type TargetSearch,
  type TestAttempt,
  type TestCase,
  type TransitionObservation,
  type TestStep,
  type TestStepMatch,
  type TransitionId,
} from './model.js';
import { testEvidence } from './tests.js';

const snapshot = testSnapshot();
const analysis = testAnalysis(snapshot);
const origin = parseOrigin('http://app.test');
const source = parseStateId(`sta_${'1'.repeat(16)}`);
const target = (n: number) => ({ kind: 'resolved', stateId: parseStateId(`sta_${String(n).repeat(16)}`) }) as const;
const staticId = transitionId({ sourceStateId: source, trigger: { kind: 'link' }, target: target(2) });
const crawledId = transitionId({ sourceStateId: source, trigger: { kind: 'link' }, target: target(3) });
const unseenId = transitionId({ sourceStateId: source, trigger: { kind: 'link' }, target: target(4) });
const importId = testImportId({ snapshotId: snapshot.id, sha256: 'a'.repeat(64) });

function loaded(id: TransitionId, n: number): LoadedTransition {
  const identity = {
    kind: 'static',
    analysisId: analysis.id,
    span: { file: 'app/page.tsx', start: { line: n, column: 1 }, end: { line: n, column: 9 } },
    extractor: 'next-nav-ts',
  } as const;
  return {
    transition: { id, sourceStateId: source, trigger: { kind: 'link' }, target: target(n) },
    observations: [{ evidence: { ...identity, id: evidenceId(identity) }, verdict: 'supports' }],
    status: 'inferred',
  };
}

const search: TargetSearch = {
  sourceUrl: parsePageUrl(origin, '/'),
  sourcePattern: parseRoutePattern('/'),
  targetUrl: parsePageUrl(origin, '/docs'),
  targetPattern: parseRoutePattern('/docs'),
  skipped: [],
  triggerCandidates: ['link'],
};

const step = (seq: number, assertions: number): TestStep => ({
  seq,
  page: 0,
  at: seq,
  origin,
  cause: { kind: 'input', method: 'click', selector: null, anchor: null },
  from: `${origin}/`,
  chain: [`${origin}/docs`],
  assertions,
});

type Attempt = { status: AttemptStatus; steps: TestStep[]; failures?: TestAttempt['failures'] };

function testCase(title: string, attempts: Attempt[], expectedStatus: AttemptStatus = 'passed'): TestCase {
  return {
    key: testCaseKey({ file: 'a.spec.ts', titlePath: [title], project: '' }),
    title,
    titlePath: [title],
    file: 'a.spec.ts',
    line: 1,
    project: '',
    expectedStatus,
    outcome: attempts.some(({ status }) => status === 'passed') ? (attempts.length > 1 ? 'flaky' : 'passed') : 'failed',
    attempts: attempts.map(({ status, steps, failures = [] }, retry) => ({
      retry,
      status,
      trace: { kind: 'read', original: parseArtifactPath('/r/t.zip'), sealed: parseArtifactPath('/s/t.zip'), steps },
      failures,
    })),
  };
}

function graphWith(cases: TestCase[], walks: Record<string, TestStepMatch[]>): BuildGraph {
  return {
    application: TEST_APP,
    snapshot,
    analysis,
    runs: [],
    unmatchedRuns: [],
    screens: [],
    transitions: [loaded(staticId, 2), loaded(crawledId, 3)],
    tests: [
      {
        testImport: {
          id: importId,
          snapshotId: snapshot.id,
          environment: 'local',
          importedAt: new Date(0),
          report: {
            original: parseArtifactPath('/r/report.json'),
            sealed: parseArtifactPath('/s/report.json'),
            sha256: 'a'.repeat(64),
            playwrightVersion: '1.64.0',
            startedAt: new Date(0),
          },
        },
        cases,
        matches: cases.flatMap(({ key, title, attempts }) =>
          attempts.flatMap(({ retry }) =>
            (walks[`${title}/${retry}`] ?? []).map((match, seq) => ({ caseKey: key, retry, seq, match })),
          ),
        ),
      },
    ],
    unmatchedImports: [],
  };
}

const walked = (transitionId: TransitionId): TestStepMatch => ({ kind: 'walked', transitionId, search });
const runtimeOnly = (transitionId: TransitionId): TestStepMatch => ({ kind: 'walked-runtime-only', transitionId, search });

describe('testEvidence', () => {
  it('attaches a runtime-only walk only when a crawl loaded that transition', () => {
    const graph = graphWith([testCase('t', [{ status: 'passed', steps: [step(0, 1), step(1, 1)] }])], {
      't/0': [runtimeOnly(crawledId), runtimeOnly(unseenId)],
    });
    const tests = testEvidence(graph);
    expect([...tests.byTransition.keys()]).toEqual([crawledId]);
    expect([...tests.exercisedByPassingTest]).toEqual([crawledId]);
  });

  it('counts a passing walk as exercised only when an assertion passed on its landing', () => {
    const graph = graphWith([testCase('t', [{ status: 'passed', steps: [step(0, 0), step(1, 2)] }])], {
      't/0': [walked(staticId), walked(crawledId)],
    });
    const tests = testEvidence(graph);
    expect(tests.byTransition.get(staticId)?.passing).toEqual([expect.objectContaining({ asserted: false, seq: 0 })]);
    expect([...tests.exercisedByPassingTest]).toEqual([crawledId]);
  });

  it('puts a failure on the step it ran on and the earlier walks in walkedInFailing', () => {
    const failures = [{ message: 'not visible', step: 1 }, { message: 'soft', step: 1 }];
    const graph = graphWith([testCase('t', [{ status: 'failed', steps: [step(0, 1), step(1, 1)], failures }])], {
      't/0': [walked(staticId), walked(crawledId)],
    });
    const tests = testEvidence(graph);
    expect(tests.byTransition.get(staticId)).toMatchObject({ passing: [], failing: [], walkedInFailing: [{ seq: 0 }] });
    expect(tests.byTransition.get(crawledId)?.failing.map(({ message }) => message)).toEqual(['not visible', 'soft']);
    expect(tests.exercisedByPassingTest.size).toBe(0);
  });

  it('lists a flaky case under both failing and passing, and ignores a test.fail() case', () => {
    const graph = graphWith(
      [
        testCase('flaky', [
          { status: 'failed', steps: [step(0, 0)], failures: [{ message: 'timing', step: 0 }] },
          { status: 'passed', steps: [step(0, 1)] },
        ]),
        testCase('expected to fail', [{ status: 'failed', steps: [step(0, 1)], failures: [{ message: 'x', step: 0 }] }], 'failed'),
      ],
      { 'flaky/0': [walked(staticId)], 'flaky/1': [walked(staticId)], 'expected to fail/0': [walked(crawledId)] },
    );
    const tests = testEvidence(graph);
    expect(tests.byTransition.get(staticId)).toMatchObject({
      failing: [{ outcome: 'flaky', retry: 0, message: 'timing' }],
      passing: [{ outcome: 'flaky', retry: 1, asserted: true }],
    });
    expect(tests.byTransition.has(crawledId)).toBe(false);
  });
});

describe('status separation', () => {
  it('pins transition observation evidence to static and navigation, so a test variant breaks this on purpose', () => {
    expectTypeOf<TransitionObservation['evidence']['kind']>().toEqualTypeOf<'static' | 'navigation'>();
  });
});
