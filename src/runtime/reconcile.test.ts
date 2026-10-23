import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { analyze, type Analysis } from '../commands/scan.js';
import { runId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  mayExplain,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  type RunIngestion,
  type ScreenId,
  type Session,
  type StateId,
  type StepOutcome,
  type StepRef,
  type TransitionId,
  type Trigger,
} from '../graph/model.js';
import { GraphStore } from '../store/graph-store.js';
import type { CrawlResult, CrawledNavigation } from './crawl-result.js';
import { runDirectories } from './layout.js';
import { reconcileRun, triggerCandidates } from './reconcile.js';

const origin = parseOrigin('http://localhost:3000');
const page = (path: string) => parsePageUrl(origin, path);
const anonymous: Session = { kind: 'anonymous' };
const signedIn: Session = { kind: 'storage-state', label: 'signed-in' };

let analysis: Analysis;
beforeAll(async () => {
  analysis = await analyze({ path: 'fixtures/demo', createdAt: new Date('2026-10-22T00:00:00.000Z') });
});

const stores: GraphStore[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function screenOf(pattern: string): ScreenId {
  return screenId({ applicationId: analysis.ingestion.application.id, routePattern: parseRoutePattern(pattern) });
}

function stateOf(pattern: string): StateId {
  return stateId({ screenId: screenOf(pattern), key: DEFAULT_STATE_KEY });
}

function edge(from: string, trigger: Trigger['kind'], to: string): TransitionId {
  return transitionId({
    sourceStateId: stateOf(from),
    trigger: { kind: trigger },
    target: { kind: 'resolved', stateId: stateOf(to) },
  });
}

function isStatic(id: TransitionId): boolean {
  return analysis.ingestion.transitions.some((transition) => transition.id === id);
}

type NavigationSpec = {
  readonly from?: string;
  readonly to: string;
  readonly redirects?: readonly string[];
  readonly aborted?: string;
  readonly interact?: { readonly click: string; readonly fields: readonly string[] };
};

function crawlOf({
  session,
  startedAt = '2026-10-22T10:00:00.000Z',
  captures,
  navigations,
}: {
  session: Session;
  startedAt?: string;
  captures: readonly (readonly [path: string, httpStatus: number])[];
  navigations: readonly NavigationSpec[];
}): CrawlResult {
  const keyOf = (path: string) => {
    const key = captures.findIndex(([captured]) => captured === path);
    if (key === -1) throw new Error(`no capture of ${path} in the fixture`);
    return key;
  };
  return {
    origin,
    session,
    startedAt: new Date(startedAt),
    finishedAt: new Date('2026-10-22T10:05:00.000Z'),
    stop: 'frontier-exhausted',
    crawlerVersion: 'test',
    requests: { allowed: 10, blocked: 0 },
    captures: captures.map(([path, httpStatus], key) => ({
      key,
      url: page(path),
      httpStatus,
      screenshot: `captures/${key}.png`,
      dom: `captures/${key}.html`,
    })),
    navigations: navigations.map((spec, seq): CrawledNavigation => {
      const redirects = (spec.redirects ?? []).map((to) => ({ to: page(to), via: 'http' as const }));
      const last = spec.redirects?.at(-1) ?? spec.to;
      return {
        seq,
        start:
          spec.from === undefined
            ? { kind: 'entry' }
            : {
                kind: 'action',
                from: keyOf(spec.from),
                action:
                  spec.interact === undefined
                    ? { kind: 'follow-link', href: page(spec.to), name: null }
                    : { kind: 'interact', page: page(spec.from), ...spec.interact },
              },
        requested: page(spec.to),
        redirects,
        landing:
          spec.aborted === undefined
            ? { kind: 'captured', capture: keyOf(last) }
            : { kind: 'aborted', error: spec.aborted },
      };
    }),
  };
}

function reconcile(crawl: CrawlResult): RunIngestion {
  const id = runId({ buildId: analysis.ingestion.build.id, origin, session: crawl.session, startedAt: crawl.startedAt });
  return reconcileRun({
    staticSide: analysis,
    crawl,
    runDirectory: runDirectories(analysis.ingestion.application.id, id).sealed,
  });
}

function outcomeOf(ingestion: RunIngestion, step: StepRef): StepOutcome {
  const found = ingestion.report.filter((outcome) => JSON.stringify(outcome.step) === JSON.stringify(step));
  const [only, ...others] = found;
  if (only === undefined || others.length > 0) throw new Error(`${found.length} outcomes for ${JSON.stringify(step)}`);
  return only;
}

function matchesOf(ingestion: RunIngestion) {
  return ingestion.navigations.flatMap((navigation) => navigation.matches);
}

function supportedScreens(ingestion: RunIngestion): string[] {
  return ingestion.report.flatMap((outcome) =>
    outcome.step.kind === 'capture' && outcome.kind === 'supports' ? [outcome.subject] : [],
  );
}

function captureRef(ingestion: RunIngestion, path: string): StepRef {
  const capture = ingestion.captures.find(({ evidence }) => evidence.url === page(path));
  if (capture === undefined) throw new Error(`no capture of ${path}`);
  return { kind: 'capture', evidenceId: capture.evidence.id };
}

function captureStep(ingestion: RunIngestion, path: string): StepOutcome {
  return outcomeOf(ingestion, captureRef(ingestion, path));
}

const loggedOut = () =>
  crawlOf({
    session: anonymous,
    captures: [
      ['/', 200],
      ['/login', 200],
    ],
    navigations: [{ to: '/' }, { from: '/', to: '/dashboard', redirects: ['/login'] }],
  });

const loggedIn = () =>
  crawlOf({
    session: signedIn,
    captures: [
      ['/', 200],
      ['/dashboard', 200],
      ['/settings/billing', 200],
    ],
    navigations: [
      { to: '/' },
      { from: '/', to: '/home', redirects: ['/dashboard'] },
      { from: '/dashboard', to: '/settings/billing' },
    ],
  });

const failures = () =>
  crawlOf({
    session: anonymous,
    startedAt: '2026-10-22T11:00:00.000Z',
    captures: [
      ['/', 200],
      ['/api/export', 200],
      ['/projects/999', 404],
      ['/pricing', 500],
    ],
    navigations: [
      { to: '/' },
      { from: '/', to: '/pricing-sheet.pdf', aborted: 'net::ERR_ABORTED' },
      { from: '/', to: '/api/export' },
      { to: '/projects/999' },
      { from: '/', to: '/pricing' },
    ],
  });

describe('triggerCandidates', () => {
  it('names the link trigger for a followed link', () => {
    expect(triggerCandidates({ kind: 'follow-link', href: page('/a'), name: null })).toEqual(['link']);
  });

  it('cannot tell a push from a replace for an interaction', () => {
    expect(triggerCandidates({ kind: 'interact', page: page('/a'), click: 'Go', fields: [] })).toEqual([
      'router-push',
      'router-replace',
    ]);
  });
});

describe('reconcileRun on fixtures/demo', () => {
  it('matches an interaction to the static router push or replace it drove, and never invents one', () => {
    const push = edge('/login', 'router-push', '/dashboard');
    const replace = edge('/signup', 'router-replace', '/projects/new');
    expect(isStatic(push)).toBe(true);
    expect(isStatic(replace)).toBe(true);
    const ingestion = reconcile(
      crawlOf({
        session: anonymous,
        captures: [
          ['/login', 200],
          ['/signup', 200],
          ['/dashboard', 200],
          ['/projects/new', 200],
          ['/pricing', 200],
        ],
        navigations: [
          { from: '/login', to: '/dashboard', interact: { click: 'Log in', fields: ['Email', 'Password'] } },
          { from: '/signup', to: '/projects/new', interact: { click: 'Create account', fields: ['Work email'] } },
          { from: '/login', to: '/pricing', interact: { click: 'Log in', fields: [] } },
        ],
      }),
    );

    expect(outcomeOf(ingestion, { kind: 'action', seq: 0 })).toMatchObject({ kind: 'supports', subject: push });
    expect(outcomeOf(ingestion, { kind: 'action', seq: 1 })).toMatchObject({ kind: 'supports', subject: replace });
    expect(matchesOf(ingestion).find(({ transitionId }) => transitionId === push)?.match).toMatchObject({
      rule: 'action-matched-static',
      triggerCandidates: ['router-push', 'router-replace'],
    });
    expect(outcomeOf(ingestion, { kind: 'action', seq: 2 })).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'unknown-trigger' },
    });
    expect(ingestion.created).toEqual([]);
  });

  it('(a) attributes an auth bounce to the link and the guard, not to a link to /login', () => {
    expect(isStatic(edge('/', 'link', '/dashboard'))).toBe(true);
    const ingestion = reconcile(loggedOut());

    expect(outcomeOf(ingestion, { kind: 'action', seq: 1 })).toEqual({
      step: { kind: 'action', seq: 1 },
      kind: 'supports',
      subject: edge('/', 'link', '/dashboard'),
    });
    expect(outcomeOf(ingestion, { kind: 'redirect', seq: 1, hop: 0 })).toEqual({
      step: { kind: 'redirect', seq: 1, hop: 0 },
      kind: 'supports',
      subject: edge('/dashboard', 'redirect', '/login'),
    });
    const action = matchesOf(ingestion).find(({ transitionId }) => transitionId === edge('/', 'link', '/dashboard'));
    expect(action?.match).toMatchObject({
      rule: 'action-matched-static',
      targetUrl: page('/dashboard'),
      skipped: [],
    });
    expect(ingestion.captures.map(({ evidence }) => evidence.url)).not.toContain(page('/dashboard'));
    expect(supportedScreens(ingestion).sort()).toEqual([screenOf('/'), screenOf('/login')].sort());
    expect(matchesOf(ingestion).map(({ transitionId }) => transitionId)).not.toContain(edge('/', 'link', '/login'));
    expect(ingestion.created).toEqual([]);
  });

  it('(b) skips the redirect-only /home and supports its own redirect', () => {
    const ingestion = reconcile(loggedIn());

    expect(outcomeOf(ingestion, { kind: 'action', seq: 1 })).toMatchObject({
      kind: 'supports',
      subject: edge('/', 'link', '/dashboard'),
    });
    const action = matchesOf(ingestion).find(({ transitionId }) => transitionId === edge('/', 'link', '/dashboard'));
    expect(action?.match).toMatchObject({
      rule: 'action-matched-static',
      targetUrl: page('/dashboard'),
      skipped: [{ url: page('/home'), why: 'pass-through' }],
    });
    expect(outcomeOf(ingestion, { kind: 'redirect', seq: 1, hop: 0 })).toMatchObject({
      kind: 'supports',
      subject: edge('/home', 'redirect', '/dashboard'),
    });
    expect(supportedScreens(ingestion)).not.toContain(screenOf('/home'));
  });

  it('(c) creates a runtime-only link the fetch-driven feed hid from static analysis', () => {
    const created = edge('/dashboard', 'link', '/settings/billing');
    expect(isStatic(created)).toBe(false);
    const ingestion = reconcile(loggedIn());

    expect(outcomeOf(ingestion, { kind: 'action', seq: 2 })).toEqual({
      step: { kind: 'action', seq: 2 },
      kind: 'created',
      subject: created,
    });
    expect(ingestion.created).toEqual([
      {
        id: created,
        sourceStateId: stateOf('/dashboard'),
        trigger: { kind: 'link' },
        target: { kind: 'resolved', stateId: stateOf('/settings/billing') },
      },
    ]);
    expect(matchesOf(ingestion).find(({ transitionId }) => transitionId === created)?.match.rule).toBe(
      'action-runtime-only',
    );
  });

  it('(d) never creates a redirect edge from an uncaptured hop', () => {
    const literal = reconcile(
      crawlOf({
        session: anonymous,
        captures: [['/login', 200]],
        navigations: [{ to: '/home', redirects: ['/dashboard', '/login'] }],
      }),
    );
    expect(literal.report).toEqual([
      { step: captureRef(literal, '/login'), kind: 'supports', subject: screenOf('/login') },
      {
        step: { kind: 'redirect', seq: 0, hop: 0 },
        kind: 'supports',
        subject: edge('/home', 'redirect', '/dashboard'),
      },
      {
        step: { kind: 'redirect', seq: 0, hop: 1 },
        kind: 'supports',
        subject: edge('/dashboard', 'redirect', '/login'),
      },
    ]);
    expect(literal.created).toEqual([]);

    // The (app) layout guard runs before /home's own redirect, so a real logged-out /home goes straight to /login.
    const guarded = reconcile(
      crawlOf({
        session: anonymous,
        captures: [['/login', 200]],
        navigations: [{ to: '/home', redirects: ['/login'] }],
      }),
    );
    expect(outcomeOf(guarded, { kind: 'redirect', seq: 0, hop: 0 })).toEqual({
      step: { kind: 'redirect', seq: 0, hop: 0 },
      kind: 'ignored',
      reason: { kind: 'unmatched-redirect', from: parseRoutePattern('/home'), to: parseRoutePattern('/login') },
    });
    expect(guarded.created).toEqual([]);
    expect(matchesOf(guarded)).toEqual([]);
  });

  it('(e) ignores aborted, non-screen and 4xx steps and lets a 5xx contradict its screen', () => {
    const ingestion = reconcile(failures());

    expect(outcomeOf(ingestion, { kind: 'aborted', seq: 1 })).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'aborted', error: 'net::ERR_ABORTED' },
    });
    expect(captureStep(ingestion, '/api/export')).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'not-a-screen', url: page('/api/export'), why: 'handler' },
    });
    expect(outcomeOf(ingestion, { kind: 'action', seq: 2 })).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'not-a-screen', url: page('/api/export'), why: 'handler' },
    });
    expect(captureStep(ingestion, '/projects/999')).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'client-error', url: page('/projects/999'), httpStatus: 404 },
    });
    expect(captureStep(ingestion, '/pricing')).toMatchObject({ kind: 'contradicts', subject: screenOf('/pricing') });
    expect(ingestion.captures.find(({ evidence }) => evidence.url === page('/pricing'))?.match).toEqual({
      verdict: 'contradicts',
      rule: 'server-error',
      url: page('/pricing'),
      pattern: parseRoutePattern('/pricing'),
      httpStatus: 500,
    });
    expect(outcomeOf(ingestion, { kind: 'action', seq: 4 })).toMatchObject({
      kind: 'ignored',
      reason: { kind: 'landing-error', url: page('/pricing'), httpStatus: 500 },
    });
    expect(matchesOf(ingestion)).toEqual([]);
    expect(ingestion.navigations.map(({ evidence }) => evidence.logSeq).sort()).toEqual([0, 2, 3, 4]);
  });

  it('(f) gives the same output for the same crawl, whatever order it lists things in', () => {
    const crawl = loggedIn();
    const shuffled: CrawlResult = {
      ...crawl,
      captures: [...crawl.captures].reverse(),
      navigations: [...crawl.navigations].reverse(),
    };
    const first = reconcile(crawl);
    expect(reconcile(crawl)).toEqual(first);
    expect(reconcile(shuffled)).toEqual(first);
    expect(JSON.stringify(reconcile(shuffled))).toBe(JSON.stringify(first));
  });
});

describe('parseCrawl', () => {
  it('rejects a navigation naming a capture that is not listed', () => {
    const crawl = loggedOut();
    const navigations = crawl.navigations.map((navigation) =>
      navigation.seq === 1 ? { ...navigation, landing: { kind: 'captured' as const, capture: 7 } } : navigation,
    );
    expect(() => reconcile({ ...crawl, navigations })).toThrow(/names capture 7, which is not listed/);
  });

  it('rejects a landing that is not where the chain ends', () => {
    const crawl = loggedOut();
    const navigations = crawl.navigations.map((navigation) =>
      navigation.seq === 1 ? { ...navigation, redirects: [] } : navigation,
    );
    expect(() => reconcile({ ...crawl, navigations })).toThrow(/lands on .*\/login, but its chain ends at .*\/dashboard/);
  });

  it('rejects a duplicate seq', () => {
    const crawl = loggedOut();
    const navigations = crawl.navigations.map((navigation) => ({ ...navigation, seq: 0 }));
    expect(() => reconcile({ ...crawl, navigations })).toThrow(/seq 0 is listed twice/);
  });

  it('rejects an artifact outside the run directory', () => {
    const crawl = loggedOut();
    const captures = crawl.captures.map((capture) => ({ ...capture, screenshot: '../elsewhere.png' }));
    expect(() => reconcile({ ...crawl, captures })).toThrow(/not inside the run directory/);
  });
});

async function openFile(): Promise<{ store: GraphStore; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'nori-reconcile-'));
  tempDirs.push(dir);
  const path = join(dir, 'graph.db');
  const store = await GraphStore.open({ path });
  stores.push(store);
  return { store, path };
}

function countRows(path: string): unknown {
  const sqlite = new Database(path, { readonly: true });
  try {
    return ['runs', 'evidence', 'captures', 'navigations', 'transitions', 'observations'].map(
      (table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
    );
  } finally {
    sqlite.close();
  }
}

describe('reconcileRun into the store', () => {
  it('(g) loads observed, failed and inferred statuses and the runtime-only link; ingesting twice is ingesting once', async () => {
    const { store, path } = await openFile();
    await store.ingestStatic(analysis.ingestion);
    const runs = [reconcile(loggedOut()), reconcile(failures()), reconcile(loggedIn())];
    for (const run of runs) await store.ingestRun(run);
    const once = countRows(path);
    const graph = await store.loadBuildGraph({ buildId: analysis.ingestion.build.id });
    for (const run of runs) await store.ingestRun(run);
    expect(countRows(path)).toEqual(once);
    expect(await store.loadBuildGraph({ buildId: analysis.ingestion.build.id })).toEqual(graph);
    if (graph === null) throw new Error('build not loaded');

    expect(graph.runs.map((run) => run.id).sort()).toEqual(runs.map(({ run }) => run.id).sort());
    const screenStatus = (pattern: string) => graph.screens.find(({ screen }) => screen.id === screenOf(pattern))?.status;
    expect(screenStatus('/')).toBe('observed');
    expect(screenStatus('/login')).toBe('observed');
    expect(screenStatus('/dashboard')).toBe('observed');
    expect(screenStatus('/pricing')).toBe('failed');
    expect(screenStatus('/projects/[id]')).toBe('inferred');
    expect(screenStatus('/home')).toBe('inferred');
    expect(screenStatus('/about')).toBe('inferred');

    const transition = (id: TransitionId) => graph.transitions.find((loaded) => loaded.transition.id === id);
    expect(transition(edge('/', 'link', '/dashboard'))?.status).toBe('observed');
    expect(transition(edge('/dashboard', 'redirect', '/login'))?.status).toBe('observed');
    expect(transition(edge('/home', 'redirect', '/dashboard'))?.status).toBe('observed');
    expect(transition(edge('/', 'link', '/about'))?.status).toBe('inferred');
    expect(transition(edge('/', 'link', '/login'))?.status).toBe('inferred');

    const runtimeOnly = transition(edge('/dashboard', 'link', '/settings/billing'));
    expect(runtimeOnly?.status).toBe('observed');
    expect(runtimeOnly?.observations.map(({ evidence }) => evidence.kind)).toEqual(['navigation']);

    const feed = analysis.ingestion.transitions.find(
      ({ sourceStateId, target }) =>
        sourceStateId === stateOf('/dashboard') && target.kind === 'unresolved' && target.expression === 'item.href',
    );
    if (feed === undefined) throw new Error('the activity feed has no unresolved item.href link');
    expect(mayExplain(graph, edge('/dashboard', 'link', '/settings/billing'))).toEqual([feed.id]);
    expect(mayExplain(graph, edge('/', 'link', '/dashboard'))).toEqual([]);
  });
});
