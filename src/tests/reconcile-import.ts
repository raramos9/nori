import {
  parsePageUrl,
  type ImportIngestion,
  type NonEmpty,
  type Origin,
  type PageUrl,
  type TestCase,
  type TestImport,
  type TestStep,
  type TestStepMatch,
  type TestStepMatchRow,
  type Trigger,
} from '../graph/model.js';
import { createReconciler, triggerCandidates, type Reconciler, type StaticSide } from '../runtime/reconcile.js';

// A click on anything but an <a href> could be a span inside a Link or a button calling router.push.
const OPEN_TRIGGERS: NonEmpty<Trigger['kind']> = ['link', 'router-push', 'router-replace'];

function onOrigin(origin: Origin, raw: string): PageUrl | null {
  try {
    return parsePageUrl(origin, raw);
  } catch {
    return null;
  }
}

function matchStep(reconciler: Reconciler, step: TestStep): TestStepMatch {
  const { cause, origin } = step;
  if (step.from === null || cause.kind === 'navigate') return { kind: 'entry' };
  if (cause.kind === 'none') return { kind: 'unattributed' };
  const from = onOrigin(origin, step.from);
  if (from === null) return { kind: 'off-origin', url: step.from };
  const [head, ...tail] = step.chain;
  const landing = onOrigin(origin, head);
  if (landing === null) return { kind: 'off-origin', url: head };
  const rest: PageUrl[] = [];
  for (const raw of tail) {
    const url = onOrigin(origin, raw);
    if (url === null) return { kind: 'off-origin', url: raw };
    rest.push(url);
  }
  const triggers = cause.anchor === null ? OPEN_TRIGGERS : triggerCandidates({ kind: 'follow-link', href: cause.anchor, name: null });
  const client = reconciler.matchClientStep({ from, chain: [landing, ...rest], triggers });
  switch (client.kind) {
    case 'not-a-screen':
      return { kind: 'not-a-screen', url: client.url, why: client.why };
    case 'matched':
      return { kind: 'walked', transitionId: client.transitionId, search: client.search };
    case 'runtime-only':
      return { kind: 'walked-runtime-only', transitionId: client.transition.id, search: client.search };
    case 'ambiguous':
      return { kind: 'ambiguous', candidates: client.candidates, search: client.search };
    case 'unknown-trigger':
      return { kind: 'no-transition', search: client.search };
    default: {
      const _exhaustive: never = client;
      return _exhaustive;
    }
  }
}

// Tests never create a transition: a walk the static side does not know keeps the id a crawl would mint,
// and attaches on read only if a crawl did.
export function reconcileImport({
  staticSide,
  sealed,
}: {
  staticSide: StaticSide;
  sealed: { readonly testImport: TestImport; readonly cases: readonly TestCase[] };
}): ImportIngestion {
  const { snapshot, analysis } = staticSide.ingestion;
  const { testImport, cases } = sealed;
  if (testImport.snapshotId !== snapshot.id) {
    throw new Error(`Import ${testImport.id} belongs to snapshot ${testImport.snapshotId}, not ${snapshot.id}`);
  }
  const reconciler = createReconciler(staticSide);
  const matches = cases.flatMap(({ key, attempts }) =>
    attempts.flatMap(({ retry, trace }): TestStepMatchRow[] =>
      trace.kind === 'read' ? trace.steps.map((step) => ({ caseKey: key, retry, seq: step.seq, match: matchStep(reconciler, step) })) : [],
    ),
  );
  return { analysisId: analysis.id, testImport, cases, matches };
}
