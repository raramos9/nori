import { describe, expect, it } from 'vitest';
import { TEST_APP, testAnalysis, testSnapshot } from '../testing/identity.js';
import type { RunStop } from '../runtime/crawl-result.js';
import { appKey, evidenceId, runId, screenId, stateId, transitionId } from './ids.js';
import {
  comparable,
  diffBuilds,
  type BuildDiff,
  type Change,
  type Cited,
  type ComparablePair,
  type TransitionSubject,
} from './diff.js';
import {
  deriveEvidenceStatus,
  DEFAULT_STATE_KEY,
  parseAnalyzerVersion,
  parseArtifactPath,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  type Application,
  type BuildGraph,
  type CaptureEvidence,
  type EvidenceId,
  type LoadedScreen,
  type LoadedTransition,
  type NavigationEvidence,
  type NavigationEvidenceStart,
  type NonEmpty,
  type Run,
  type RunId,
  type ScreenObservation,
  type Session,
  type StaticEvidence,
  type Transition,
  type TransitionObservation,
} from './model.js';

const anonymous: Session = { kind: 'anonymous' };
const admin: Session = { kind: 'storage-state', label: 'admin' };
const origin = parseOrigin('http://localhost:3000');

type Via = 'follow-link' | 'interact' | 'entry';
type RunSpec = { readonly name: string; readonly session?: Session; readonly stop?: RunStop };
type ScreenSpec = {
  readonly route: string;
  readonly static?: boolean;
  readonly seen?: readonly string[];
  readonly failed?: readonly string[];
};
type TransitionSpec = {
  readonly from: string;
  readonly to: string | { readonly unresolved: string };
  readonly static?: boolean;
  readonly seen?: readonly { readonly run: string; readonly via?: Via }[];
};
type GraphSpec = {
  readonly commit?: string;
  readonly application?: Application;
  readonly analyzerVersion?: string;
  readonly runs?: readonly RunSpec[];
  readonly screens: readonly ScreenSpec[];
  readonly transitions?: readonly TransitionSpec[];
  readonly unmatchedRuns?: readonly RunId[];
};

function nonEmpty<T>(items: readonly T[], what: string): NonEmpty<T> {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error(`${what} has no observations`);
  return [first, ...rest];
}

function build(spec: GraphSpec) {
  const application = spec.application ?? TEST_APP;
  const snapshot = testSnapshot({ commit: spec.commit ?? 'a' });
  const analysis = testAnalysis(snapshot, spec.analyzerVersion === undefined ? {} : { analyzerVersion: spec.analyzerVersion });
  const runs = (spec.runs ?? []).map(({ name, session = anonymous, stop = 'frontier-exhausted' }, index): [string, Run] => {
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    return [
      name,
      {
        id: runId({ snapshotId: snapshot.id, origin, session, startedAt }),
        snapshotId: snapshot.id,
        origin,
        session,
        environment: 'local',
        seededBy: analysis.analyzerVersion,
        startedAt,
        finishedAt: startedAt,
        stop,
        crawlerVersion: 'test',
        requests: { allowed: 0, blocked: 0 },
      },
    ];
  });
  const runNamed = (name: string): Run => {
    const found = new Map(runs).get(name);
    if (found === undefined) throw new Error(`no run named ${name}`);
    return found;
  };

  let line = 0;
  const staticEvidence = (): StaticEvidence => {
    const identity = {
      kind: 'static',
      analysisId: analysis.id,
      span: { file: 'app/page.tsx', start: { line: ++line, column: 1 }, end: { line, column: 9 } },
      extractor: 'next-link',
    } as const;
    return { ...identity, id: evidenceId(identity) };
  };

  const pageUrl = (route: string) => parsePageUrl(origin, route);
  const captures = new Map<string, CaptureEvidence>();
  const captureFor = (runName: string, route: string, httpStatus = 200): CaptureEvidence => {
    const key = `${runName} ${route}`;
    const existing = captures.get(key);
    if (existing !== undefined) return existing;
    const identity = { kind: 'capture', runId: runNamed(runName).id, url: pageUrl(route) } as const;
    const capture: CaptureEvidence = {
      ...identity,
      id: evidenceId(identity),
      httpStatus,
      screenshot: parseArtifactPath('/tmp/shot.png'),
      dom: parseArtifactPath('/tmp/dom.html'),
    };
    captures.set(key, capture);
    return capture;
  };

  const screenIdOf = (route: string) =>
    screenId({ appKey: application.id, routePattern: parseRoutePattern(route) });
  const stateOf = (route: string) => stateId({ screenId: screenIdOf(route), key: DEFAULT_STATE_KEY });

  const screens = spec.screens.map(({ route, static: isStatic = true, seen = [], failed = [] }): LoadedScreen => {
    const routePattern = parseRoutePattern(route);
    const observations: ScreenObservation[] = [
      ...(isStatic ? [{ evidence: staticEvidence(), verdict: 'supports' } as const] : []),
      ...seen.map((name): ScreenObservation => ({
        evidence: captureFor(name, route),
        match: { verdict: 'supports', rule: 'rendered', url: pageUrl(route), pattern: routePattern },
      })),
      ...failed.map((name): ScreenObservation => ({
        evidence: captureFor(name, route, 500),
        match: { verdict: 'contradicts', rule: 'server-error', url: pageUrl(route), pattern: routePattern, httpStatus: 500 },
      })),
    ];
    const id = screenIdOf(route);
    const nonEmptyObservations = nonEmpty(observations, route);
    return {
      screen: { id, appKey: application.id, routePattern },
      states: [{ id: stateOf(route), screenId: id, key: DEFAULT_STATE_KEY }],
      observations: nonEmptyObservations,
      status: deriveEvidenceStatus(nonEmptyObservations),
    };
  });

  const transitions = (spec.transitions ?? []).map(({ from, to, static: isStatic = true, seen = [] }): LoadedTransition => {
    const target: Transition['target'] =
      typeof to === 'string'
        ? { kind: 'resolved', stateId: stateOf(to) }
        : { kind: 'unresolved', reason: 'dynamic-expression', expression: to.unresolved };
    const trigger = { kind: 'link' } as const;
    const sourceStateId = stateOf(from);
    const observations: TransitionObservation[] = [
      ...(isStatic ? [{ evidence: staticEvidence(), verdict: 'supports' } as const] : []),
      ...seen.map(({ run, via = 'follow-link' }): TransitionObservation => {
        if (typeof to !== 'string') throw new Error('only a resolved transition can be walked');
        const landing = captureFor(run, to);
        const start: NavigationEvidenceStart =
          via === 'entry'
            ? { kind: 'entry' }
            : {
                kind: 'action',
                from: { evidenceId: captureFor(run, from).id, url: pageUrl(from) },
                action:
                  via === 'follow-link'
                    ? { kind: 'follow-link', href: pageUrl(to), name: null }
                    : { kind: 'interact', page: pageUrl(from), click: 'button', fields: [] },
              };
        const identity = { kind: 'navigation', runId: runNamed(run).id, start, requested: pageUrl(to) } as const;
        const evidence: NavigationEvidence = {
          ...identity,
          id: evidenceId(identity),
          redirects: [],
          landing: { ...landing, evidenceId: landing.id },
          logSeq: 0,
        };
        return {
          evidence,
          match: {
            verdict: 'supports',
            rule: 'action-matched-static',
            sourceUrl: pageUrl(from),
            sourcePattern: parseRoutePattern(from),
            targetUrl: pageUrl(to),
            targetPattern: parseRoutePattern(to),
            skipped: [],
            triggerCandidates: ['link'],
          },
        };
      }),
    ];
    const nonEmptyObservations = nonEmpty(observations, `${from} -> ${JSON.stringify(to)}`);
    return {
      transition: { id: transitionId({ sourceStateId, trigger, target }), sourceStateId, trigger, target },
      observations: nonEmptyObservations,
      status: deriveEvidenceStatus(nonEmptyObservations),
    };
  });

  const graph: BuildGraph = {
    application,
    snapshot,
    analysis,
    runs: runs.map(([, run]) => run),
    unmatchedRuns: spec.unmatchedRuns ?? [],
    screens,
    transitions,
  };
  return {
    graph,
    run: (name: string): RunId => runNamed(name).id,
    capture: (runName: string, route: string): EvidenceId => captureFor(runName, route).id,
  };
}

function pairOf(base: BuildGraph, head: BuildGraph): ComparablePair {
  const result = comparable(base, head);
  if (result.kind !== 'comparable') throw new Error(result.kind);
  return result.pair;
}

function diff(base: GraphSpec, head: GraphSpec): BuildDiff {
  return diffBuilds(pairOf(build(base).graph, build({ commit: 'b', ...head }).graph));
}

const kindsOf = (changes: readonly Change[]) => changes.map(({ kind }) => kind);
const label = (change: Change) =>
  `${change.kind} ${change.subject.kind === 'screen' ? change.subject.routePattern : `${change.subject.from} -> ${JSON.stringify(change.subject.to)}`}`;

const crawled = { runs: [{ name: 'r' }] } as const;

describe('comparable', () => {
  it('names both apps when they differ', () => {
    const other: Application = { ...TEST_APP, subpath: 'web', id: appKey({ repoIdentity: TEST_APP.repoIdentity, subpath: 'web' }) };
    const base = build({ screens: [] }).graph;
    const head = build({ commit: 'b', application: other, screens: [] }).graph;
    expect(comparable(base, head)).toEqual({ kind: 'different-apps', base: TEST_APP, head: other });
  });

  it('names both analyzer versions when they differ', () => {
    const base = build({ analyzerVersion: '1.0.0', screens: [] }).graph;
    const head = build({ commit: 'b', analyzerVersion: '2.0.0', screens: [] }).graph;
    expect(comparable(base, head)).toEqual({
      kind: 'different-analyzers',
      base: parseAnalyzerVersion('1.0.0'),
      head: parseAnalyzerVersion('2.0.0'),
    });
  });

  it('accepts a graph against itself', () => {
    const { graph } = build({ screens: [] });
    expect(comparable(graph, graph).kind).toBe('comparable');
  });
});

describe('diffBuilds static claims', () => {
  it('adds a screen only the head analysis found, citing its static evidence', () => {
    const result = diff({ screens: [{ route: '/a' }] }, { screens: [{ route: '/a' }, { route: '/b' }] });
    expect(result.changes).toEqual([
      {
        kind: 'added',
        subject: { kind: 'screen', id: expect.any(String), routePattern: '/b' },
        head: { static: [expect.any(String)], runtime: [] },
      },
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('removes a screen only the base analysis found', () => {
    const result = diff({ screens: [{ route: '/a' }, { route: '/b' }] }, { screens: [{ route: '/a' }] });
    expect(result.changes).toMatchObject([{ kind: 'removed', subject: { routePattern: '/b' }, base: { runtime: [] } }]);
    expect(result.gaps).toEqual([]);
  });

  it('adds and removes transitions with their route patterns', () => {
    const result = diff(
      { screens: [{ route: '/a' }, { route: '/b' }], transitions: [{ from: '/a', to: '/b' }] },
      { screens: [{ route: '/a' }, { route: '/b' }], transitions: [{ from: '/b', to: '/a' }] },
    );
    expect(result.changes.map(label)).toEqual(['removed /a -> {"kind":"route","pattern":"/b"}', 'added /b -> {"kind":"route","pattern":"/a"}']);
  });

  it('keeps an unresolved target as it is', () => {
    const result = diff(
      { screens: [{ route: '/a' }] },
      { screens: [{ route: '/a' }], transitions: [{ from: '/a', to: { unresolved: 'href' } }] },
    );
    expect(result.changes).toMatchObject([
      { kind: 'added', subject: { kind: 'transition', from: '/a', to: { kind: 'unresolved', reason: 'dynamic-expression', expression: 'href' } } },
    ]);
  });

  it('never calls a runtime-only screen added or removed', () => {
    const result = diff(
      { ...crawled, screens: [{ route: '/a', static: false, seen: ['r'] }] },
      { screens: [] },
    );
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ seenIn: 'base', why: 'no-run-in-session' }]);
  });

  it('reports a screen that lost its static support as inference-lost, and the mirror as inference-gained', () => {
    const withStatic = { ...crawled, screens: [{ route: '/a', seen: ['r'] }] };
    const runtimeOnly = { ...crawled, screens: [{ route: '/a', static: false, seen: ['r'] }] };
    const lost = diff(withStatic, runtimeOnly);
    expect(lost.changes).toMatchObject([
      { kind: 'inference-lost', base: { static: [expect.any(String)] }, head: { static: [], runtime: [expect.objectContaining({ kind: 'capture' })] } },
    ]);
    const gained = diff(runtimeOnly, withStatic);
    expect(gained.changes).toMatchObject([
      { kind: 'inference-gained', base: { static: [], runtime: [expect.objectContaining({ kind: 'capture' })] }, head: { static: [expect.any(String)] } },
    ]);
    expect(lost.gaps).toEqual([]);
    expect(gained.gaps).toEqual([]);
  });
});

describe('diffBuilds runtime claims', () => {
  it('reports a screen both sides saw with a different outcome as status-changed', () => {
    const result = diff(
      { ...crawled, screens: [{ route: '/a', seen: ['r'] }] },
      { ...crawled, screens: [{ route: '/a', failed: ['r'] }] },
    );
    expect(result.changes).toMatchObject([
      { kind: 'status-changed', base: { status: 'observed' }, head: { status: 'failed' } },
    ]);
  });

  it('says nothing when both sides saw the same thing', () => {
    const side = { ...crawled, screens: [{ route: '/a', seen: ['r'] }] };
    expect(diff(side, side)).toMatchObject({ changes: [], gaps: [] });
  });

  it('reports a screen the head crawl exhausted its frontier without seeing as newly-unverified', () => {
    const base = build({ ...crawled, screens: [{ route: '/a', seen: ['r'] }] });
    const head = build({ commit: 'b', ...crawled, screens: [{ route: '/a' }] });
    const result = diffBuilds(pairOf(base.graph, head.graph));
    expect(result.changes).toMatchObject([
      {
        kind: 'newly-unverified',
        base: { status: 'observed', evidence: [{ kind: 'capture', runId: base.run('r') }] },
        head: { witnesses: [{ runId: head.run('r') }] },
      },
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('reports a screen the head crawl saw and a base crawl did not as newly-observed', () => {
    const base = build({ ...crawled, screens: [{ route: '/a' }] });
    const head = build({ commit: 'b', ...crawled, screens: [{ route: '/a', seen: ['r'] }] });
    const result = diffBuilds(pairOf(base.graph, head.graph));
    expect(result.changes).toMatchObject([
      { kind: 'newly-observed', base: { witnesses: [{ runId: base.run('r') }] }, head: { status: 'observed' } },
    ]);
  });

  it('cites the head capture of the source screen as the witness for a transition', () => {
    const base = build({
      ...crawled,
      screens: [{ route: '/a', seen: ['r'] }, { route: '/b' }],
      transitions: [{ from: '/a', to: '/b', seen: [{ run: 'r' }] }],
    });
    const head = build({
      commit: 'b',
      ...crawled,
      screens: [{ route: '/a', seen: ['r'] }, { route: '/b' }],
      transitions: [{ from: '/a', to: '/b' }],
    });
    const result = diffBuilds(pairOf(base.graph, head.graph));
    expect(result.changes).toMatchObject([
      {
        kind: 'newly-unverified',
        subject: { kind: 'transition' },
        head: { witnesses: [{ runId: head.run('r'), sourceCapture: head.capture('r', '/a') }] },
      },
    ]);
  });

  it('treats a crawled base against an uncrawled head as gaps only', () => {
    const screens = [{ route: '/a', seen: ['r'] }, { route: '/b', seen: ['r'] }];
    const transitions = [{ from: '/a', to: '/b', seen: [{ run: 'r' }] }];
    const result = diff({ ...crawled, screens, transitions }, { screens: [{ route: '/a' }, { route: '/b' }], transitions: [{ from: '/a', to: '/b' }] });
    expect(result.changes).toEqual([]);
    expect(result.gaps).toHaveLength(3);
    expect(result.gaps.every((gap) => gap.seenIn === 'base' && gap.why === 'no-run-in-session')).toBe(true);
    expect(result.gaps[0]?.sessions).toEqual([anonymous]);
  });

  it('treats an uncrawled base against a crawled head as gaps seen in head', () => {
    const result = diff({ screens: [{ route: '/a' }] }, { ...crawled, screens: [{ route: '/a', seen: ['r'] }] });
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ seenIn: 'head', why: 'no-run-in-session' }]);
  });

  it('refuses a head run that stopped on its budget as a witness', () => {
    const result = diff(
      { ...crawled, screens: [{ route: '/a', seen: ['r'] }] },
      { runs: [{ name: 'r', stop: 'budget' }], screens: [{ route: '/a' }] },
    );
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ why: 'not-exhausted' }]);
  });

  it('refuses a head run of another session as a witness', () => {
    const result = diff(
      { runs: [{ name: 'r', session: admin }], screens: [{ route: '/a', seen: ['r'] }] },
      { ...crawled, screens: [{ route: '/a' }] },
    );
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ why: 'no-run-in-session', sessions: [admin] }]);
  });

  it('lets a head run in the seeing session witness when it has company in another', () => {
    const result = diff(
      { runs: [{ name: 'r', session: admin }], screens: [{ route: '/a', seen: ['r'] }] },
      { runs: [{ name: 'x' }, { name: 'r', session: admin }], screens: [{ route: '/a' }] },
    );
    expect(kindsOf(result.changes)).toEqual(['newly-unverified']);
  });

  it('keeps a transition seen only through an interaction out of changes', () => {
    const screens = [{ route: '/a', seen: ['r'] }, { route: '/b' }];
    const result = diff(
      { ...crawled, screens, transitions: [{ from: '/a', to: '/b', seen: [{ run: 'r', via: 'interact' }] }] },
      { ...crawled, screens, transitions: [{ from: '/a', to: '/b' }] },
    );
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ subject: { kind: 'transition' }, why: 'interaction-only' }]);
  });

  it('accepts a transition reached from an entry as walked', () => {
    const screens = [{ route: '/a', seen: ['r'] }, { route: '/b' }];
    const result = diff(
      { ...crawled, screens, transitions: [{ from: '/a', to: '/b', seen: [{ run: 'r', via: 'entry' }] }] },
      { ...crawled, screens, transitions: [{ from: '/a', to: '/b' }] },
    );
    expect(kindsOf(result.changes)).toEqual(['newly-unverified']);
  });

  it('keeps a transition out of changes when no exhausted head run captured its source screen', () => {
    const base = { ...crawled, screens: [{ route: '/a' }, { route: '/b' }], transitions: [{ from: '/a', to: '/b', seen: [{ run: 'r' }] }] };
    const result = diff(base, { ...crawled, screens: [{ route: '/a' }, { route: '/b' }], transitions: [{ from: '/a', to: '/b' }] });
    expect(result.changes).toEqual([]);
    expect(result.gaps).toMatchObject([{ subject: { kind: 'transition' }, why: 'source-not-captured' }]);
  });
});

describe('diffBuilds envelope', () => {
  it('copies the runs and unmatched runs of each side', () => {
    const base = build({ ...crawled, screens: [{ route: '/a' }] });
    const unmatched = build({ commit: 'c', runs: [{ name: 'u' }], screens: [] }).run('u');
    const head = build({ commit: 'b', ...crawled, screens: [{ route: '/a' }], unmatchedRuns: [unmatched] });
    const result = diffBuilds(pairOf(base.graph, head.graph));
    expect(result).toMatchObject({
      appKey: TEST_APP.id,
      base: { analysisId: base.graph.analysis.id, runs: base.graph.runs, unmatchedRuns: [] },
      head: { analysisId: head.graph.analysis.id, runs: head.graph.runs, unmatchedRuns: [unmatched] },
    });
  });

  it('finds nothing against itself', () => {
    const { graph } = build({
      ...crawled,
      screens: [{ route: '/a', seen: ['r'] }, { route: '/b', failed: ['r'] }, { route: '/c', static: false, seen: ['r'] }],
      transitions: [{ from: '/a', to: '/b', seen: [{ run: 'r' }] }, { from: '/a', to: { unresolved: 'href' } }],
    });
    expect(diffBuilds(pairOf(graph, graph))).toMatchObject({ changes: [], gaps: [] });
  });

  it('orders screens before transitions, by route, whatever order the graphs list them in', () => {
    const screens = [{ route: '/c' }, { route: '/a' }, { route: '/b' }];
    const transitions = [{ from: '/c', to: '/a' }, { from: '/a', to: '/b' }];
    const forward = diff({ screens: [] }, { screens, transitions });
    const backward = diff({ screens: [] }, { screens: [...screens].reverse(), transitions: [...transitions].reverse() });
    expect(forward.changes.map(label)).toEqual([
      'added /a',
      'added /b',
      'added /c',
      'added /a -> {"kind":"route","pattern":"/b"}',
      'added /c -> {"kind":"route","pattern":"/a"}',
    ]);
    expect(backward.changes.map(label)).toEqual(forward.changes.map(label));
  });
});

describe('Change types', () => {
  const noEvidence: Cited<readonly []> = { static: [], runtime: [] };
  const subject: TransitionSubject = {
    kind: 'transition',
    id: transitionId({ sourceStateId: stateId({ screenId: screenId({ appKey: TEST_APP.id, routePattern: parseRoutePattern('/a') }), key: 'default' }), trigger: { kind: 'link' }, target: { kind: 'unresolved', reason: 'dynamic-expression', expression: 'x' } }),
    from: parseRoutePattern('/a'),
    trigger: { kind: 'link' },
    to: { kind: 'unresolved', reason: 'dynamic-expression', expression: 'x' },
  };

  it('has no added without static evidence and no transition witness without a source capture', () => {
    // @ts-expect-error an added change cites at least one static evidence id
    const added: Change = { kind: 'added', subject, head: noEvidence };
    const run = build({ runs: [{ name: 'r' }], screens: [] }).run('r');
    const seen = { status: 'observed', evidence: [{ id: evidenceId({ kind: 'capture', runId: run, url: parsePageUrl(origin, '/a') }), runId: run, kind: 'capture', verdict: 'supports' }] } as const;
    // @ts-expect-error a newly-unverified transition carries witnesses with a source capture
    const unverified: Change = { kind: 'newly-unverified', subject, base: seen, head: { witnesses: [{ runId: run }] } };
    expect([added.kind, unverified.kind]).toEqual(['added', 'newly-unverified']);
  });
});
