import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { applicationId, buildId, evidenceId, runId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseArtifactPath,
  parseCommitSha,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  UNRESOLVED_REASONS,
  verdictOf,
  type Build,
  type CaptureEvidence,
  type NavigationEvidence,
  type RunIngestion,
  type Session,
  type TransitionMatch,
  type StaticEvidence,
  type Observation,
  type Screen,
  type StaticIngestion,
  type Transition,
} from '../graph/model.js';
import { runDirectories } from '../runtime/layout.js';
import { GraphStore } from './graph-store.js';
import { MIGRATIONS } from './migrations.js';

const rootPath = '/repo/web';
const SOURCE_HASH = 'f'.repeat(64);
const app = { id: applicationId({ rootPath }), rootPath, framework: 'next-app-router' } as const;

function screenFor(route: string): Screen {
  const routePattern = parseRoutePattern(route);
  return { id: screenId({ applicationId: app.id, routePattern }), applicationId: app.id, routePattern };
}

function defaultState(screen: Screen) {
  return stateId({ screenId: screen.id, key: DEFAULT_STATE_KEY });
}

function build(commit: string): Build {
  const commitSha = parseCommitSha(commit.repeat(40));
  return {
    id: buildId({ applicationId: app.id, commitSha, sourceHash: SOURCE_HASH, analyzerVersion: '1.0.0' }),
    applicationId: app.id,
    commitSha,
    sourceHash: SOURCE_HASH,
    branch: 'main',
    analyzerVersion: '1.0.0',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function staticEvidence(b: Build, file: string, line: number): StaticEvidence {
  const identity = {
    kind: 'static',
    buildId: b.id,
    span: { file, start: { line, column: 2 }, end: { line, column: 40 } },
    extractor: 'next-link',
  } as const;
  return { ...identity, id: evidenceId(identity) };
}

function supports(evidence: StaticEvidence, subject: Observation['subject']): Observation {
  return { evidenceId: evidence.id, subject, verdict: 'supports' };
}

function ingestionFor(commit: string, routes: readonly string[]): StaticIngestion {
  const b = build(commit);
  const screens = routes.map(screenFor);
  const evidence = screens.map((s, i) => staticEvidence(b, `app${s.routePattern}/page.tsx`, i + 1));
  const observations = screens.map((s, i) => {
    const e = evidence[i];
    if (e === undefined) throw new Error('fixture misaligned');
    return supports(e, { kind: 'screen', id: s.id });
  });
  return { application: app, build: b, screens, transitions: [], evidence, observations };
}

function withTransitions(base: StaticIngestion, transitions: readonly Transition[]): StaticIngestion {
  const evidence = transitions.map((_, i) => staticEvidence(base.build, 'app/page.tsx', 100 + i));
  const observations = transitions.map((t, i) => {
    const e = evidence[i];
    if (e === undefined) throw new Error('fixture misaligned');
    return supports(e, { kind: 'transition', id: t.id });
  });
  return {
    ...base,
    transitions,
    evidence: [...base.evidence, ...evidence],
    observations: [...base.observations, ...observations],
  };
}

function makeTransition(
  source: Screen,
  target: Transition['target'],
  trigger: Transition['trigger'] = { kind: 'link' },
): Transition {
  const sourceStateId = defaultState(source);
  return { id: transitionId({ sourceStateId, trigger, target }), sourceStateId, trigger, target };
}

const tempDirs: string[] = [];
const stores: GraphStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openMemory(): Promise<GraphStore> {
  const store = await GraphStore.open({ path: ':memory:' });
  stores.push(store);
  return store;
}

async function openFile(): Promise<{ store: GraphStore; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'nori-store-'));
  tempDirs.push(dir);
  const path = join(dir, 'graph.db');
  const store = await GraphStore.open({ path });
  stores.push(store);
  return { store, path };
}

const TABLES = [
  'applications',
  'builds',
  'screens',
  'ui_states',
  'transitions',
  'evidence',
  'observations',
  'runs',
  'captures',
  'navigations',
] as const;

function countRows(path: string): Record<string, number> {
  const sqlite = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(
      TABLES.map((table) => {
        const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        if (typeof row !== 'object' || row === null || !('n' in row) || typeof row.n !== 'number') {
          throw new Error(`unexpected count result for ${table}`);
        }
        return [table, row.n];
      }),
    );
  } finally {
    sqlite.close();
  }
}

describe('GraphStore', () => {
  it('re-ingesting the same input leaves every table unchanged', async () => {
    const { store, path } = await openFile();
    const [a, b] = [screenFor('/a'), screenFor('/b')];
    const input = withTransitions(ingestionFor('a', ['/a', '/b']), [
      makeTransition(a, { kind: 'resolved', stateId: defaultState(b) }),
      makeTransition(a, { kind: 'unresolved', reason: 'dynamic-expression', expression: '`/u/${id}`' }),
    ]);

    await store.ingestStatic(input);
    const first = countRows(path);
    await store.ingestStatic(input);
    expect(countRows(path)).toEqual(first);
    expect(first).toEqual({
      applications: 1,
      builds: 1,
      screens: 2,
      ui_states: 2,
      transitions: 2,
      evidence: 4,
      observations: 4,
      runs: 0,
      captures: 0,
      navigations: 0,
    });
  });

  it('round-trips resolved and unresolved transitions with their union shape', async () => {
    const store = await openMemory();
    const [a, b] = [screenFor('/a'), screenFor('/b')];
    const resolved = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
    const unresolved = makeTransition(
      a,
      { kind: 'unresolved', reason: 'dynamic-expression', expression: 'href' },
      { kind: 'router-push' },
    );
    const input = withTransitions(ingestionFor('a', ['/a', '/b']), [resolved, unresolved]);
    await store.ingestStatic(input);

    const graph = await store.loadBuildGraph({ buildId: input.build.id });
    expect(graph?.build).toEqual(input.build);
    const loaded = graph?.transitions.map((t) => t.transition);
    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual(resolved);
    expect(loaded).toContainEqual(unresolved);
    expect(graph?.screens.map((s) => s.screen.routePattern).sort()).toEqual(['/a', '/b']);
    for (const s of graph?.screens ?? []) {
      expect(s.states[0].key).toBe(DEFAULT_STATE_KEY);
      expect(s.status).toBe('inferred');
    }
    for (const t of graph?.transitions ?? []) expect(t.status).toBe('inferred');
  });

  it('round-trips every unresolved reason', async () => {
    const store = await openMemory();
    const a = screenFor('/a');
    const transitions = UNRESOLVED_REASONS.map((reason) =>
      makeTransition(a, { kind: 'unresolved', reason, expression: `href-${reason}` }),
    );
    const input = withTransitions(ingestionFor('a', ['/a']), transitions);
    await store.ingestStatic(input);

    const graph = await store.loadBuildGraph({ buildId: input.build.id });
    expect(graph?.transitions.map((t) => t.transition)).toEqual(expect.arrayContaining(transitions));
    expect(graph?.transitions).toHaveLength(UNRESOLVED_REASONS.length);
  });

  it('keeps supporting and contradicting observations of one transition inspectable', async () => {
    const store = await openMemory();
    const [a, b] = [screenFor('/a'), screenFor('/b')];
    const transition = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
    const base = withTransitions(ingestionFor('a', ['/a', '/b']), [transition]);
    const contradicting = staticEvidence(base.build, 'app/other.tsx', 7);
    const input: StaticIngestion = {
      ...base,
      evidence: [...base.evidence, contradicting],
      observations: [
        ...base.observations,
        { evidenceId: contradicting.id, subject: { kind: 'transition', id: transition.id }, verdict: 'contradicts' },
      ],
    };
    await store.ingestStatic(input);

    const graph = await store.loadBuildGraph({ buildId: input.build.id });
    const loaded = graph?.transitions.find((t) => t.transition.id === transition.id);
    expect(loaded?.observations.map(verdictOf).sort()).toEqual(['contradicts', 'supports']);
    expect(loaded?.observations.map((o) => o.evidence.id)).toContain(contradicting.id);
  });

  it('shares screen ids across builds and scopes each load to its own evidence', async () => {
    const store = await openMemory();
    const one = ingestionFor('a', ['/a', '/b']);
    const two = ingestionFor('b', ['/a', '/c']);
    await store.ingestStatic(one);
    await store.ingestStatic(two);

    const graphOne = await store.loadBuildGraph({ buildId: one.build.id });
    const graphTwo = await store.loadBuildGraph({ buildId: two.build.id });
    const routes = (g: typeof graphOne) => g?.screens.map((s) => s.screen.routePattern).sort();
    expect(routes(graphOne)).toEqual(['/a', '/b']);
    expect(routes(graphTwo)).toEqual(['/a', '/c']);

    const idFor = (g: typeof graphOne, route: string) =>
      g?.screens.find((s) => s.screen.routePattern === route)?.screen.id;
    expect(idFor(graphOne, '/a')).toBe(idFor(graphTwo, '/a'));
    expect(idFor(graphOne, '/a')).toBe(screenFor('/a').id);
    for (const s of graphOne?.screens ?? []) {
      for (const o of s.observations) expect(o.evidence.buildId).toBe(one.build.id);
    }
  });

  it('returns null for an unknown build', async () => {
    const store = await openMemory();
    expect(await store.loadBuildGraph({ buildId: build('c').id })).toBeNull();
  });

  it('throws on a row whose columns do not match its kind', async () => {
    const { store, path } = await openFile();
    const [a, b] = [screenFor('/a'), screenFor('/b')];
    const input = withTransitions(ingestionFor('a', ['/a', '/b']), [
      makeTransition(a, { kind: 'resolved', stateId: defaultState(b) }),
    ]);
    await store.ingestStatic(input);

    const sqlite = new Database(path);
    sqlite.prepare('UPDATE transitions SET target_state_id = NULL').run();
    sqlite.close();

    await expect(store.loadBuildGraph({ buildId: input.build.id })).rejects.toThrow(
      /target_state_id \(target_kind 'resolved'\) must not be null/,
    );
  });
});

const origin = parseOrigin('http://localhost:3000');
const pageUrl = (path: string) => parsePageUrl(origin, path);

type RunFixture = { readonly ingestion: RunIngestion; readonly capture: (path: string) => CaptureEvidence };

function runFor(
  base: StaticIngestion,
  session: Session,
  startedAt: Date,
  pages: readonly { readonly path: string; readonly httpStatus: number }[],
): RunFixture {
  const id = runId({ buildId: base.build.id, origin, session, startedAt });
  const sealed = runDirectories(app.id, id).sealed;
  const captures = pages.map(({ path, httpStatus }): CaptureEvidence => {
    const identity = { kind: 'capture', buildId: base.build.id, runId: id, url: pageUrl(path) } as const;
    const evidenceIdValue = evidenceId(identity);
    return {
      ...identity,
      id: evidenceIdValue,
      httpStatus,
      screenshot: parseArtifactPath(join(sealed, 'captures', `${evidenceIdValue}.png`)),
      dom: parseArtifactPath(join(sealed, 'captures', `${evidenceIdValue}.html`)),
    };
  });
  const capture = (path: string) => {
    const found = captures.find((c) => c.url === pageUrl(path));
    if (found === undefined) throw new Error(`no capture of ${path}`);
    return found;
  };
  return {
    capture,
    ingestion: {
      run: {
        id,
        applicationId: app.id,
        buildId: base.build.id,
        origin,
        session,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1000),
        stop: 'frontier-exhausted',
        crawlerVersion: '1',
        reconcilerVersion: '1',
        requests: { allowed: 3, blocked: 0 },
      },
      captures: captures.map((evidence) => {
        const pattern = parseRoutePattern(new URL(evidence.url).pathname);
        return {
          evidence,
          match:
            evidence.httpStatus >= 500
              ? { verdict: 'contradicts', rule: 'server-error', url: evidence.url, pattern, httpStatus: evidence.httpStatus }
              : { verdict: 'supports', rule: 'rendered', url: evidence.url, pattern },
        };
      }),
      navigations: [],
      created: [],
      report: [],
    },
  };
}

function follow(
  fixture: RunFixture,
  from: string,
  to: string,
  logSeq: number,
): { evidence: NavigationEvidence; match: Omit<TransitionMatch, 'rule'> } {
  const source = fixture.capture(from);
  const landing = fixture.capture(to);
  const identity = {
    kind: 'navigation',
    buildId: source.buildId,
    runId: source.runId,
    requested: landing.url,
    start: {
      kind: 'action',
      from: { evidenceId: source.id, url: source.url },
      action: { kind: 'follow-link', href: landing.url, name: null },
    },
  } as const;
  const { url, httpStatus, screenshot, dom } = landing;
  return {
    evidence: { ...identity, id: evidenceId(identity), redirects: [], landing: { url, httpStatus, screenshot, dom, evidenceId: landing.id }, logSeq },
    match: {
      verdict: 'supports',
      sourceUrl: source.url,
      sourcePattern: parseRoutePattern(from),
      targetUrl: landing.url,
      targetPattern: parseRoutePattern(to),
      skipped: [],
      triggerCandidates: ['link'],
    },
  };
}

describe('GraphStore runs', () => {
  const [a, b] = [screenFor('/a'), screenFor('/b')];
  const staticLink = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
  const runtimeLink = makeTransition(b, { kind: 'resolved', stateId: defaultState(a) });
  const base = withTransitions(ingestionFor('a', ['/a', '/b']), [staticLink]);

  function anonymousRun(): RunIngestion {
    const fixture = runFor(base, { kind: 'anonymous' }, new Date('2026-02-01T00:00:00.000Z'), [
      { path: '/a', httpStatus: 200 },
      { path: '/b', httpStatus: 200 },
    ]);
    const matched = follow(fixture, '/a', '/b', 1);
    const created = follow(fixture, '/b', '/a', 2);
    return {
      ...fixture.ingestion,
      navigations: [
        {
          evidence: matched.evidence,
          matches: [{ transitionId: staticLink.id, match: { ...matched.match, rule: 'action-matched-static' } }],
        },
        {
          evidence: created.evidence,
          matches: [{ transitionId: runtimeLink.id, match: { ...created.match, rule: 'action-runtime-only' } }],
        },
      ],
      created: [{ ...runtimeLink, target: { kind: 'resolved', stateId: defaultState(a) } }],
    };
  }

  function signedInRun(): RunIngestion {
    return runFor(base, { kind: 'storage-state', label: 'signed-in' }, new Date('2026-02-02T00:00:00.000Z'), [
      { path: '/a', httpStatus: 500 },
    ]).ingestion;
  }

  it('ingesting a run twice leaves every table as ingesting it once', async () => {
    const { store, path } = await openFile();
    await store.ingestStatic(base);
    await store.ingestRun(anonymousRun());
    const once = countRows(path);
    await store.ingestRun(anonymousRun());
    expect(countRows(path)).toEqual(once);
    expect(once).toMatchObject({ runs: 1, captures: 2, navigations: 2, transitions: 2, evidence: 7, observations: 7 });
  });

  it('loads runs, captures with absolute artifact paths and runtime-only transitions', async () => {
    const store = await openMemory();
    await store.ingestStatic(base);
    const run = anonymousRun();
    await store.ingestRun(run);

    const graph = await store.loadBuildGraph({ buildId: base.build.id });
    expect(graph?.runs).toEqual([run.run]);
    const screenA = graph?.screens.find((s) => s.screen.id === a.id);
    expect(screenA?.status).toBe('observed');
    const captured = screenA?.observations.flatMap((o) => (o.evidence.kind === 'capture' ? [o.evidence] : []));
    expect(captured).toEqual([run.captures[0]?.evidence]);
    expect(captured?.[0]?.screenshot.startsWith(runDirectories(app.id, run.run.id).sealed)).toBe(true);

    const byId = new Map(graph?.transitions.map((t) => [t.transition.id, t]));
    expect(byId.get(staticLink.id)?.status).toBe('observed');
    expect(byId.get(runtimeLink.id)?.transition).toEqual(runtimeLink);
    expect(byId.get(runtimeLink.id)?.status).toBe('observed');
    expect(byId.get(runtimeLink.id)?.observations).toEqual([
      { evidence: run.navigations[1]?.evidence, match: run.navigations[1]?.matches[0]?.match },
    ]);
  });

  it('keeps a run of a second session beside the first and lets its 5xx fail the screen', async () => {
    const store = await openMemory();
    await store.ingestStatic(base);
    const first = anonymousRun();
    const second = signedInRun();
    await store.ingestRun(first);
    await store.ingestRun(second);

    const graph = await store.loadBuildGraph({ buildId: base.build.id });
    expect(graph?.runs.map((run) => run.session)).toEqual([
      { kind: 'anonymous' },
      { kind: 'storage-state', label: 'signed-in' },
    ]);
    const screenA = graph?.screens.find((s) => s.screen.id === a.id);
    expect(screenA?.observations.map((o) => o.evidence.kind).sort()).toEqual(['capture', 'capture', 'static']);
    expect(screenA?.status).toBe('failed');
    expect(graph?.screens.find((s) => s.screen.id === b.id)?.status).toBe('observed');
  });

  it('refuses artifacts outside the sealed run directory and runs of an unknown build', async () => {
    const store = await openMemory();
    await expect(store.ingestRun(anonymousRun())).rejects.toThrow(/must be ingested first/);
    await store.ingestStatic(base);
    const run = anonymousRun();
    const [first, ...rest] = run.captures;
    if (first === undefined) throw new Error('fixture has no capture');
    const stray = { ...first, evidence: { ...first.evidence, dom: parseArtifactPath('/tmp/elsewhere.html') } };
    await expect(store.ingestRun({ ...run, captures: [stray, ...rest] })).rejects.toThrow(/not inside the sealed/);
  });

  it('rejects a navigation row whose start disagrees with its source and action', async () => {
    const { store, path } = await openFile();
    await store.ingestStatic(base);
    const run = anonymousRun();
    await store.ingestRun(run);
    const sqlite = new Database(path);
    try {
      expect(() =>
        sqlite.prepare("UPDATE navigations SET start_kind = 'entry' WHERE log_seq = 1").run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() => sqlite.prepare('UPDATE navigations SET action = NULL WHERE log_seq = 1').run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      sqlite.close();
    }
  });
});

describe('migration 002', () => {
  it('migrates a database created at 001 and loads its static build unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-store-'));
    tempDirs.push(dir);
    const path = join(dir, 'graph.db');
    const [a, b] = [screenFor('/a'), screenFor('/b')];
    const input = withTransitions(ingestionFor('a', ['/a', '/b']), [
      makeTransition(a, { kind: 'resolved', stateId: defaultState(b) }),
      makeTransition(a, { kind: 'unresolved', reason: 'dynamic-expression', expression: 'href' }, { kind: 'router-push' }),
    ]);

    const initial = MIGRATIONS['001_initial'];
    if (initial === undefined) throw new Error('001_initial is missing');
    const old = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(path) }) });
    const migrated = await new Migrator({
      db: old,
      provider: { getMigrations: async () => ({ '001_initial': initial }) },
    }).migrateToLatest();
    await old.destroy();
    expect(migrated.error).toBeUndefined();
    writeAt001(path, input);

    const store = await GraphStore.open({ path });
    stores.push(store);
    const fresh = await openMemory();
    await fresh.ingestStatic(input);
    const loaded = await store.loadBuildGraph({ buildId: input.build.id });
    expect(loaded).toEqual(await fresh.loadBuildGraph({ buildId: input.build.id }));
    expect(loaded?.transitions).toHaveLength(2);
    expect(loaded?.runs).toEqual([]);
  });
});

function writeAt001(path: string, ingestion: StaticIngestion): void {
  const sqlite = new Database(path);
  const insert = (table: string, row: Record<string, string | number | null>) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(row));
  };
  try {
    const { application, build: b } = ingestion;
    insert('applications', { id: application.id, root_path: application.rootPath, framework: application.framework });
    insert('builds', {
      id: b.id,
      application_id: b.applicationId,
      commit_sha: b.commitSha,
      source_hash: b.sourceHash,
      branch: b.branch,
      analyzer_version: b.analyzerVersion,
      created_at: b.createdAt.toISOString(),
    });
    for (const screen of ingestion.screens) {
      insert('screens', { id: screen.id, application_id: screen.applicationId, route_pattern: screen.routePattern });
      insert('ui_states', { id: defaultState(screen), screen_id: screen.id, key: DEFAULT_STATE_KEY });
    }
    for (const t of ingestion.transitions) {
      insert('transitions', {
        id: t.id,
        source_state_id: t.sourceStateId,
        trigger_kind: t.trigger.kind,
        target_kind: t.target.kind,
        target_state_id: t.target.kind === 'resolved' ? t.target.stateId : null,
        unresolved_reason: t.target.kind === 'unresolved' ? t.target.reason : null,
        unresolved_expression: t.target.kind === 'unresolved' ? t.target.expression : null,
      });
    }
    for (const e of ingestion.evidence) {
      insert('evidence', {
        id: e.id,
        build_id: e.buildId,
        kind: e.kind,
        extractor: e.extractor,
        span_file: e.span.file,
        span_start_line: e.span.start.line,
        span_start_column: e.span.start.column,
        span_end_line: e.span.end.line,
        span_end_column: e.span.end.column,
      });
    }
    for (const o of ingestion.observations) {
      insert('observations', {
        evidence_id: o.evidenceId,
        subject_kind: o.subject.kind,
        subject_id: o.subject.id,
        verdict: o.verdict,
      });
    }
  } finally {
    sqlite.close();
  }
}
