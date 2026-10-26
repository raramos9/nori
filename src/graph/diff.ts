import { screenId, sessionKey } from './ids.js';
import {
  verdictOf,
  type AnalysisId,
  type AnalyzerVersion,
  type Application,
  type AppKey,
  type BuildGraph,
  type EvidenceId,
  type EvidenceObservation,
  type NonEmpty,
  type RoutePattern,
  type Run,
  type RunId,
  type ScreenId,
  type Session,
  type Snapshot,
  type StateId,
  type TransitionId,
  type Trigger,
  type UnresolvedReason,
  type Verdict,
} from './model.js';

const comparableBrand: unique symbol = Symbol('comparable');

// Proof that base and head are one app read by one analyzer. Only comparable() mints it.
export type ComparablePair = {
  readonly base: BuildGraph;
  readonly head: BuildGraph;
  readonly [comparableBrand]: true;
};

export type PairResult =
  | { readonly kind: 'comparable'; readonly pair: ComparablePair }
  | { readonly kind: 'different-apps'; readonly base: Application; readonly head: Application }
  | { readonly kind: 'different-analyzers'; readonly base: AnalyzerVersion; readonly head: AnalyzerVersion };

export function comparable(base: BuildGraph, head: BuildGraph): PairResult {
  if (base.application.id !== head.application.id) {
    return { kind: 'different-apps', base: base.application, head: head.application };
  }
  if (base.analysis.analyzerVersion !== head.analysis.analyzerVersion) {
    return {
      kind: 'different-analyzers',
      base: base.analysis.analyzerVersion,
      head: head.analysis.analyzerVersion,
    };
  }
  return { kind: 'comparable', pair: { base, head, [comparableBrand]: true } };
}

export type ScreenSubject = {
  readonly kind: 'screen';
  readonly id: ScreenId;
  readonly routePattern: RoutePattern;
};
export type TransitionSubject = {
  readonly kind: 'transition';
  readonly id: TransitionId;
  readonly from: RoutePattern;
  readonly trigger: Trigger;
  readonly to:
    | { readonly kind: 'route'; readonly pattern: RoutePattern }
    | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly expression: string };
};
export type Subject = ScreenSubject | TransitionSubject;

export type RuntimeCite = {
  readonly id: EvidenceId;
  readonly runId: RunId;
  readonly kind: 'capture' | 'navigation';
  readonly verdict: Verdict;
};
export type Cited<S extends readonly EvidenceId[]> = {
  readonly static: S;
  readonly runtime: readonly RuntimeCite[];
};

export type Seen = { readonly status: 'observed' | 'failed'; readonly evidence: NonEmpty<RuntimeCite> };
export type ScreenWitness = { readonly runId: RunId };
export type TransitionWitness = { readonly runId: RunId; readonly sourceCapture: EvidenceId };
type Unseen<W> = { readonly witnesses: NonEmpty<W> };

type ChangeOf<S extends Subject, W> =
  | { readonly kind: 'added'; readonly subject: S; readonly head: Cited<NonEmpty<EvidenceId>> }
  | { readonly kind: 'removed'; readonly subject: S; readonly base: Cited<NonEmpty<EvidenceId>> }
  | {
      readonly kind: 'inference-gained';
      readonly subject: S;
      readonly base: Cited<readonly []>;
      readonly head: Cited<NonEmpty<EvidenceId>>;
    }
  | {
      readonly kind: 'inference-lost';
      readonly subject: S;
      readonly base: Cited<NonEmpty<EvidenceId>>;
      readonly head: Cited<readonly []>;
    }
  | { readonly kind: 'newly-unverified'; readonly subject: S; readonly base: Seen; readonly head: Unseen<W> }
  | { readonly kind: 'newly-observed'; readonly subject: S; readonly base: Unseen<W>; readonly head: Seen }
  | { readonly kind: 'status-changed'; readonly subject: S; readonly base: Seen; readonly head: Seen };

export type Change = ChangeOf<ScreenSubject, ScreenWitness> | ChangeOf<TransitionSubject, TransitionWitness>;

export type GapReason = 'no-run-in-session' | 'not-exhausted' | 'source-not-captured' | 'not-link-walked';
export type Gap = {
  readonly subject: Subject;
  readonly seenIn: 'base' | 'head';
  readonly seen: Seen;
  readonly sessions: NonEmpty<Session>;
  readonly why: GapReason;
};

export type DiffSide = {
  readonly snapshot: Snapshot;
  readonly analysisId: AnalysisId;
  readonly runs: readonly Run[];
  readonly unmatchedRuns: readonly RunId[];
};

export type BuildDiff = {
  readonly appKey: AppKey;
  readonly analyzerVersion: AnalyzerVersion;
  readonly base: DiffSide;
  readonly head: DiffSide;
  readonly changes: readonly Change[];
  readonly gaps: readonly Gap[];
};

// What one graph says about one entity. walkingRuns are the seeing runs whose evidence came from
// following links: only those prove the crawl would have reached the entity again.
type SideEntry = {
  readonly subject: Subject;
  readonly static: readonly EvidenceId[];
  readonly runtime: readonly RuntimeCite[];
  readonly seeingRuns: readonly Run[];
  readonly walkingRuns: readonly Run[];
};

type Side = { readonly graph: BuildGraph; readonly entries: ReadonlyMap<string, SideEntry> };

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

function compare<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function indexSide(graph: BuildGraph): Side {
  const patternOfState = new Map<StateId, RoutePattern>();
  for (const { screen, states } of graph.screens) {
    for (const state of states) patternOfState.set(state.id, screen.routePattern);
  }
  const pattern = (id: StateId): RoutePattern => {
    const found = patternOfState.get(id);
    if (found === undefined) throw new Error(`State ${id} is not a state of build ${graph.analysis.id}`);
    return found;
  };
  const runById = new Map(graph.runs.map((run) => [run.id, run]));
  // A capture is not proof of a walk: an interaction navigation lands on one too. Only the landing
  // of an entry or follow-link navigation shows the crawl reached that page by following links.
  const linkLanded = new Set<EvidenceId>();
  for (const { observations } of graph.transitions) {
    for (const { evidence } of observations) {
      if (evidence.kind !== 'navigation') continue;
      if (evidence.start.kind === 'entry' || evidence.start.action.kind === 'follow-link') {
        linkLanded.add(evidence.landing.evidenceId);
      }
    }
  }

  const entryFor = (
    subject: Subject,
    observations: readonly EvidenceObservation[],
  ): SideEntry => {
    const staticIds: EvidenceId[] = [];
    const runtime: RuntimeCite[] = [];
    const seeing = new Map<RunId, Run>();
    const walking = new Map<RunId, Run>();
    for (const observation of observations) {
      const { evidence } = observation;
      const verdict = verdictOf(observation);
      if (evidence.kind === 'static') {
        if (verdict === 'supports') staticIds.push(evidence.id);
        continue;
      }
      const run = runById.get(evidence.runId);
      if (run === undefined) throw new Error(`Run ${evidence.runId} is not matched under ${graph.analysis.id}`);
      runtime.push({ id: evidence.id, runId: run.id, kind: evidence.kind, verdict });
      seeing.set(run.id, run);
      const linkWalked =
        evidence.kind === 'capture'
          ? linkLanded.has(evidence.id)
          : evidence.start.kind === 'entry' || evidence.start.action.kind === 'follow-link';
      if (linkWalked) walking.set(run.id, run);
    }
    if (staticIds.length === 0 && runtime.length === 0) {
      throw new Error(`${subject.kind} ${subject.id} is in build ${graph.analysis.id} with no supporting evidence`);
    }
    const byRunId = (runs: ReadonlyMap<RunId, Run>) => [...runs.values()].sort((a, b) => compare(a.id, b.id));
    return {
      subject,
      static: staticIds.sort(compare),
      runtime: runtime.sort((a, b) => compare(a.id, b.id)),
      seeingRuns: byRunId(seeing),
      walkingRuns: byRunId(walking),
    };
  };

  const entries = new Map<string, SideEntry>();
  for (const { screen, observations } of graph.screens) {
    entries.set(screen.id, entryFor({ kind: 'screen', id: screen.id, routePattern: screen.routePattern }, observations));
  }
  for (const { transition, observations } of graph.transitions) {
    const { target } = transition;
    const subject: TransitionSubject = {
      kind: 'transition',
      id: transition.id,
      from: pattern(transition.sourceStateId),
      trigger: transition.trigger,
      to:
        target.kind === 'resolved'
          ? { kind: 'route', pattern: pattern(target.stateId) }
          : { kind: 'unresolved', reason: target.reason, expression: target.expression },
    };
    entries.set(transition.id, entryFor(subject, observations));
  }
  return { graph, entries };
}

// The runs of `other` that looked where `seen` was seen and found nothing, or the first reason there
// are none. Absence is a claim only against a crawl that could have produced the missing observation.
function candidateRuns(seen: SideEntry, other: BuildGraph): NonEmpty<Run> | GapReason {
  if (seen.walkingRuns.length === 0) return 'not-link-walked';
  const sessions = new Set(seen.walkingRuns.map((run) => sessionKey(run.session)));
  const inSession = other.runs.filter((run) => sessions.has(sessionKey(run.session)));
  if (inSession.length === 0) return 'no-run-in-session';
  const exhausted = nonEmpty(inSession.filter((run) => run.stop === 'frontier-exhausted'));
  return exhausted === null ? 'not-exhausted' : exhausted;
}

function screenWitnesses(seen: SideEntry, other: Side): NonEmpty<ScreenWitness> | GapReason {
  const runs = candidateRuns(seen, other.graph);
  if (typeof runs === 'string') return runs;
  const [first, ...rest] = runs;
  return [{ runId: first.id }, ...rest.map((run) => ({ runId: run.id }))];
}

function transitionWitnesses(
  subject: TransitionSubject,
  seen: SideEntry,
  other: Side,
): NonEmpty<TransitionWitness> | GapReason {
  const runs = candidateRuns(seen, other.graph);
  if (typeof runs === 'string') return runs;
  const source = other.entries.get(screenId({ appKey: other.graph.application.id, routePattern: subject.from }));
  const witnesses = runs.flatMap((run): TransitionWitness[] => {
    const capture = source?.runtime.find((cite) => cite.runId === run.id && cite.kind === 'capture' && cite.verdict === 'supports');
    return capture === undefined ? [] : [{ runId: run.id, sourceCapture: capture.id }];
  });
  return nonEmpty(witnesses) ?? 'source-not-captured';
}

function seenOf(entry: SideEntry): Seen | null {
  const evidence = nonEmpty(entry.runtime);
  if (evidence === null) return null;
  return { status: evidence.some((cite) => cite.verdict === 'contradicts') ? 'failed' : 'observed', evidence };
}

function sessionsOf(entry: SideEntry): NonEmpty<Session> {
  const bySessionKey = new Map(entry.seeingRuns.map((run) => [sessionKey(run.session), run.session]));
  const sessions = nonEmpty([...bySessionKey.entries()].sort(([a], [b]) => compare(a, b)).map(([, session]) => session));
  if (sessions === null) throw new Error(`${entry.subject.kind} ${entry.subject.id} has runtime evidence from no run`);
  return sessions;
}

type Findings<S extends Subject, W> = { readonly changes: ChangeOf<S, W>[]; readonly gaps: Gap[] };

// The table in the design: a static claim when exactly one side has static support, an inference
// change when the sides disagree about it, then the runtime rule over whatever either side observed.
function classify<S extends Subject, W>(
  subject: S,
  base: SideEntry | undefined,
  head: SideEntry | undefined,
  witnessesOn: (seen: SideEntry, other: Side) => NonEmpty<W> | GapReason,
  sides: { readonly base: Side; readonly head: Side },
): Findings<S, W> {
  const changes: ChangeOf<S, W>[] = [];
  const gaps: Gap[] = [];
  const baseStatic = base === undefined ? null : nonEmpty(base.static);
  const headStatic = head === undefined ? null : nonEmpty(head.static);

  if (base !== undefined && baseStatic !== null && head === undefined) {
    changes.push({ kind: 'removed', subject, base: { static: baseStatic, runtime: base.runtime } });
    return { changes, gaps };
  }
  if (head !== undefined && headStatic !== null && base === undefined) {
    changes.push({ kind: 'added', subject, head: { static: headStatic, runtime: head.runtime } });
    return { changes, gaps };
  }
  if (base !== undefined && head !== undefined) {
    if (baseStatic !== null && headStatic === null) {
      changes.push({
        kind: 'inference-lost',
        subject,
        base: { static: baseStatic, runtime: base.runtime },
        head: { static: [], runtime: head.runtime },
      });
    } else if (baseStatic === null && headStatic !== null) {
      changes.push({
        kind: 'inference-gained',
        subject,
        base: { static: [], runtime: base.runtime },
        head: { static: headStatic, runtime: head.runtime },
      });
    }
  }

  const baseSeen = base === undefined ? null : seenOf(base);
  const headSeen = head === undefined ? null : seenOf(head);
  if (base !== undefined && baseSeen !== null && headSeen !== null) {
    if (baseSeen.status !== headSeen.status) {
      changes.push({ kind: 'status-changed', subject, base: baseSeen, head: headSeen });
    }
  } else if (base !== undefined && baseSeen !== null) {
    const witnesses = witnessesOn(base, sides.head);
    if (typeof witnesses === 'string') {
      gaps.push({ subject, seenIn: 'base', seen: baseSeen, sessions: sessionsOf(base), why: witnesses });
    } else {
      changes.push({ kind: 'newly-unverified', subject, base: baseSeen, head: { witnesses } });
    }
  } else if (head !== undefined && headSeen !== null) {
    const witnesses = witnessesOn(head, sides.base);
    if (typeof witnesses === 'string') {
      gaps.push({ subject, seenIn: 'head', seen: headSeen, sessions: sessionsOf(head), why: witnesses });
    } else {
      changes.push({ kind: 'newly-observed', subject, base: { witnesses }, head: headSeen });
    }
  }
  return { changes, gaps };
}

function subjectOrder(a: Subject, b: Subject): number {
  const rank = (subject: Subject) => (subject.kind === 'screen' ? 0 : 1);
  const route = (subject: Subject) => (subject.kind === 'screen' ? subject.routePattern : subject.from);
  return compare(rank(a), rank(b)) || compare(route(a), route(b)) || compare(a.id, b.id);
}

export function diffBuilds({ base, head }: ComparablePair): BuildDiff {
  const sides = { base: indexSide(base), head: indexSide(head) };
  const ids = new Set([...sides.base.entries.keys(), ...sides.head.entries.keys()]);
  const changes: Change[] = [];
  const gaps: Gap[] = [];
  for (const id of ids) {
    const inBase = sides.base.entries.get(id);
    const inHead = sides.head.entries.get(id);
    const subject = (inBase ?? inHead)?.subject;
    if (subject === undefined) continue;
    switch (subject.kind) {
      case 'screen': {
        const found = classify(subject, inBase, inHead, screenWitnesses, sides);
        changes.push(...found.changes);
        gaps.push(...found.gaps);
        break;
      }
      case 'transition': {
        const found = classify(
          subject,
          inBase,
          inHead,
          (seen, other) => transitionWitnesses(subject, seen, other),
          sides,
        );
        changes.push(...found.changes);
        gaps.push(...found.gaps);
        break;
      }
      default: {
        const _exhaustive: never = subject;
        return _exhaustive;
      }
    }
  }
  changes.sort((a, b) => subjectOrder(a.subject, b.subject) || compare(a.kind, b.kind));
  gaps.sort((a, b) => subjectOrder(a.subject, b.subject) || compare(a.seenIn, b.seenIn));
  const side = ({ graph }: Side): DiffSide => ({
    snapshot: graph.snapshot,
    analysisId: graph.analysis.id,
    runs: graph.runs,
    unmatchedRuns: graph.unmatchedRuns,
  });
  return {
    appKey: base.application.id,
    analyzerVersion: base.analysis.analyzerVersion,
    base: side(sides.base),
    head: side(sides.head),
    changes,
    gaps,
  };
}
