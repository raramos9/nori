import type {
  AttemptStatus,
  BuildGraph,
  TestAttempt,
  TestCase,
  TestCaseKey,
  TestImportId,
  TestOutcome,
  TestStepMatch,
  TransitionId,
} from './model.js';

export type TestRef = {
  readonly importId: TestImportId;
  readonly caseKey: TestCaseKey;
  readonly title: string;
  readonly outcome: TestOutcome;
  readonly retry: number;
  readonly seq: number;
};

export type TransitionTests = {
  // asserted: at least one expect passed on the landing before the next step.
  readonly passing: readonly (TestRef & { readonly asserted: boolean })[];
  readonly failing: readonly (TestRef & { readonly message: string })[];
  readonly walkedInFailing: readonly TestRef[];
};

export const NO_TESTS: TransitionTests = { passing: [], failing: [], walkedInFailing: [] };

export type TestEvidence = {
  readonly byTransition: ReadonlyMap<TransitionId, TransitionTests>;
  readonly exercisedByPassingTest: ReadonlySet<TransitionId>;
};

type Evidence = 'passing' | 'failing';
type Collected = { -readonly [K in keyof TransitionTests]: TransitionTests[K][number][] };

const FAILING_STATUSES: ReadonlySet<AttemptStatus> = new Set(['failed', 'timedOut']);

// test.fail() cases expect a failure, so neither their passes nor their failures say anything about a transition.
function evidenceOf(testCase: TestCase, attempt: TestAttempt): Evidence | null {
  if (testCase.expectedStatus !== 'passed') return null;
  if (attempt.status === 'passed') return 'passing';
  return FAILING_STATUSES.has(attempt.status) ? 'failing' : null;
}

function walkedTransition(match: TestStepMatch | undefined): TransitionId | null {
  return match?.kind === 'walked' || match?.kind === 'walked-runtime-only' ? match.transitionId : null;
}

// A failure attaches to the transition its step walked and only that one; every other transition a
// failing attempt walked is walkedInFailing, which a view may list but never colors. A walk attaches only
// to a transition the graph loaded, so tests can neither add an edge nor change a status.
export function testEvidence(graph: BuildGraph): TestEvidence {
  const loaded = new Set(graph.transitions.map(({ transition }) => transition.id));
  const byTransition = new Map<TransitionId, Collected>();
  const exercised = new Set<TransitionId>();
  const testsOf = (id: TransitionId) => {
    const found = byTransition.get(id) ?? { passing: [], failing: [], walkedInFailing: [] };
    byTransition.set(id, found);
    return found;
  };

  for (const { testImport, cases, matches } of graph.tests) {
    const matchOf = new Map(matches.map(({ caseKey, retry, seq, match }) => [`${caseKey} ${retry} ${seq}`, match]));
    for (const testCase of cases) {
      for (const attempt of testCase.attempts) {
        const evidence = evidenceOf(testCase, attempt);
        if (evidence === null || attempt.trace.kind !== 'read') continue;
        for (const step of attempt.trace.steps) {
          const id = walkedTransition(matchOf.get(`${testCase.key} ${attempt.retry} ${step.seq}`));
          if (id === null || !loaded.has(id)) continue;
          const ref: TestRef = {
            importId: testImport.id,
            caseKey: testCase.key,
            title: testCase.title,
            outcome: testCase.outcome,
            retry: attempt.retry,
            seq: step.seq,
          };
          const tests = testsOf(id);
          if (evidence === 'passing') {
            const asserted = step.assertions > 0;
            tests.passing.push({ ...ref, asserted });
            if (asserted) exercised.add(id);
            continue;
          }
          const here = attempt.failures.filter((failure) => failure.step === step.seq);
          if (here.length === 0) tests.walkedInFailing.push(ref);
          for (const { message } of here) tests.failing.push({ ...ref, message });
        }
      }
    }
  }
  return { byTransition, exercisedByPassingTest: exercised };
}
