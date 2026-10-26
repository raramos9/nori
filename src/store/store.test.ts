import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evidenceId, runId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  UNRESOLVED_REASONS,
  verdictOf,
  type Observation,
  type Screen,
  type Session,
  type Snapshot,
  type StaticEvidence,
  type Transition,
} from '../graph/model.js';
import { createMatcher } from '../next/match.js';
import { discoverRoutes } from '../next/routes.js';
import type { CrawlResult } from '../runtime/crawl-result.js';
import { runDirectory, stagingDirectory, stateDatabasePath } from '../runtime/layout.js';
import { record, type RunOutcome } from '../runtime/record.js';
import type { StaticSide } from '../runtime/reconcile.js';
import { CRAWL_FILE, sealRun } from '../runtime/sealed-run.js';
import { TEST_APP, testAnalysis, testSnapshot } from '../testing/identity.js';
import { openReadDatabase, openWriteDatabase } from './database.js';
import { listBuilds, loadBuild } from './reads.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = TEST_APP.id;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const originalHome = process.env.NORI_HOME;
beforeEach(() => {
  process.env.NORI_HOME = tempDir('nori-store-');
});
afterEach(() => {
  process.env.NORI_HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function screenFor(route: string): Screen {
  const routePattern = parseRoutePattern(route);
  return { id: screenId({ appKey: app, routePattern }), appKey: app, routePattern };
}

function defaultState(screen: Screen) {
  return stateId({ screenId: screen.id, key: DEFAULT_STATE_KEY });
}

function makeTransition(
  source: Screen,
  target: Transition['target'],
  trigger: Transition['trigger'] = { kind: 'link' },
): Transition {
  const sourceStateId = defaultState(source);
  return { id: transitionId({ sourceStateId, trigger, target }), sourceStateId, trigger, target };
}

type SideOptions = {
  readonly commit?: string;
  readonly routes: readonly string[];
  readonly transitions?: readonly Transition[];
  readonly analyzerVersion?: string;
  readonly worktree?: Snapshot['worktree'];
};

function staticSide({ commit = 'a', routes, transitions = [], analyzerVersion, worktree }: SideOptions): StaticSide {
  const snapshot = testSnapshot({ commit, ...(worktree === undefined ? {} : { worktree }) });
  const analysis = testAnalysis(snapshot, analyzerVersion === undefined ? {} : { analyzerVersion });
  const staticEvidence = (file: string, line: number): StaticEvidence => {
    const identity = {
      kind: 'static',
      analysisId: analysis.id,
      span: { file, start: { line, column: 2 }, end: { line, column: 40 } },
      extractor: 'next-link',
    } as const;
    return { ...identity, id: evidenceId(identity) };
  };
  const screens = routes.map(screenFor);
  const subjects: { evidence: StaticEvidence; subject: Observation['subject'] }[] = [
    ...screens.map((screen, i) => ({
      evidence: staticEvidence(`app${screen.routePattern}/page.tsx`, i + 1),
      subject: { kind: 'screen', id: screen.id } as const,
    })),
    ...transitions.map((transition, i) => ({
      evidence: staticEvidence('app/page.tsx', 100 + i),
      subject: { kind: 'transition', id: transition.id } as const,
    })),
  ];
  const files = routes.map((route) => `app${route === '/' ? '' : route}/page.tsx`);
  const table = discoverRoutes({ files, appDir: 'app' });
  return {
    ingestion: {
      application: TEST_APP,
      snapshot,
      analysis,
      screens,
      transitions,
      evidence: subjects.map(({ evidence }) => evidence),
      observations: subjects.map(({ evidence, subject }) => ({ evidenceId: evidence.id, subject, verdict: 'supports' })),
    },
    matcher: createMatcher({ table, files, adapters: false }),
    passThrough: new Set(),
  };
}

const TABLES = [
  'applications',
  'snapshots',
  'analyses',
  'screens',
  'ui_states',
  'transitions',
  'static_evidence',
  'static_observations',
  'runs',
  'captures',
  'navigations',
  'matches',
  'screen_matches',
  'transition_matches',
  'match_failures',
] as const;

function countRows(): Record<string, number> {
  const sqlite = new Database(stateDatabasePath(app), { readonly: true });
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

function writeSql(statements: (sqlite: Database.Database) => void): void {
  const sqlite = new Database(stateDatabasePath(app));
  try {
    statements(sqlite);
  } finally {
    sqlite.close();
  }
}

async function readStore<T>(read: (db: Awaited<ReturnType<typeof openReadDatabase>>) => Promise<T>): Promise<T> {
  const db = await openReadDatabase({ path: stateDatabasePath(app) });
  try {
    return await read(db);
  } finally {
    await db.destroy();
  }
}

const kinds = (outcomes: readonly RunOutcome[]) => outcomes.map(({ kind }) => kind);

describe('record and loadBuild', () => {
  const [a, b] = [screenFor('/a'), screenFor('/b')];

  it('re-recording an analysis leaves every table unchanged', async () => {
    const side = staticSide({
      routes: ['/a', '/b'],
      transitions: [
        makeTransition(a, { kind: 'resolved', stateId: defaultState(b) }),
        makeTransition(a, { kind: 'unresolved', reason: 'dynamic-expression', expression: '`/u/${id}`' }),
      ],
    });
    const first = await record(side);
    const counts = countRows();
    const second = await record(side);
    expect(countRows()).toEqual(counts);
    expect(second.graph).toEqual(first.graph);
    expect(counts).toEqual({
      applications: 1,
      snapshots: 1,
      analyses: 1,
      screens: 2,
      ui_states: 2,
      transitions: 2,
      static_evidence: 4,
      static_observations: 4,
      runs: 0,
      captures: 0,
      navigations: 0,
      matches: 0,
      screen_matches: 0,
      transition_matches: 0,
      match_failures: 0,
    });
  });

  it('round-trips the identity rows and both transition shapes', async () => {
    const resolved = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
    const unresolved = makeTransition(
      a,
      { kind: 'unresolved', reason: 'dynamic-expression', expression: 'href' },
      { kind: 'router-push' },
    );
    const side = staticSide({ routes: ['/a', '/b'], transitions: [resolved, unresolved] });
    const { graph } = await record(side);

    expect(graph.application).toEqual(TEST_APP);
    expect(graph.snapshot).toEqual(side.ingestion.snapshot);
    expect(graph.analysis).toEqual(side.ingestion.analysis);
    const loaded = graph.transitions.map((t) => t.transition);
    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual(resolved);
    expect(loaded).toContainEqual(unresolved);
    expect(graph.screens.map((s) => s.screen.routePattern).sort()).toEqual(['/a', '/b']);
    for (const s of graph.screens) {
      expect(s.states[0].key).toBe(DEFAULT_STATE_KEY);
      expect(s.status).toBe('inferred');
    }
    for (const t of graph.transitions) expect(t.status).toBe('inferred');
  });

  it('round-trips every unresolved reason', async () => {
    const transitions = UNRESOLVED_REASONS.map((reason) =>
      makeTransition(a, { kind: 'unresolved', reason, expression: `href-${reason}` }),
    );
    const { graph } = await record(staticSide({ routes: ['/a'], transitions }));
    expect(graph.transitions.map((t) => t.transition)).toEqual(expect.arrayContaining(transitions));
    expect(graph.transitions).toHaveLength(UNRESOLVED_REASONS.length);
  });

  it('keeps supporting and contradicting observations of one transition inspectable', async () => {
    const transition = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
    const side = staticSide({ routes: ['/a', '/b'], transitions: [transition] });
    const identity = {
      kind: 'static',
      analysisId: side.ingestion.analysis.id,
      span: { file: 'app/other.tsx', start: { line: 7, column: 1 }, end: { line: 7, column: 9 } },
      extractor: 'next-link',
    } as const;
    const contradicting: StaticEvidence = { ...identity, id: evidenceId(identity) };
    const { graph } = await record({
      ...side,
      ingestion: {
        ...side.ingestion,
        evidence: [...side.ingestion.evidence, contradicting],
        observations: [
          ...side.ingestion.observations,
          { evidenceId: contradicting.id, subject: { kind: 'transition', id: transition.id }, verdict: 'contradicts' },
        ],
      },
    });
    const loaded = graph.transitions.find((t) => t.transition.id === transition.id);
    expect(loaded?.observations.map(verdictOf).sort()).toEqual(['contradicts', 'supports']);
    expect(loaded?.observations.map((o) => o.evidence.id)).toContain(contradicting.id);
  });

  it('shares screen ids across snapshots and scopes each load to its own analysis', async () => {
    const one = await record(staticSide({ commit: 'a', routes: ['/a', '/b'] }));
    const two = await record(staticSide({ commit: 'b', routes: ['/a', '/c'] }));
    const routes = (graph: typeof one.graph) => graph.screens.map((s) => s.screen.routePattern).sort();
    expect(routes(one.graph)).toEqual(['/a', '/b']);
    expect(routes(two.graph)).toEqual(['/a', '/c']);

    const idFor = (graph: typeof one.graph, route: string) =>
      graph.screens.find((s) => s.screen.routePattern === route)?.screen.id;
    expect(idFor(one.graph, '/a')).toBe(idFor(two.graph, '/a'));
    expect(idFor(one.graph, '/a')).toBe(screenFor('/a').id);
    for (const s of one.graph.screens) {
      for (const o of s.observations) expect(o.evidence).toMatchObject({ analysisId: one.graph.analysis.id });
    }
    const builds = await readStore(listBuilds);
    expect(builds.map(({ snapshot }) => snapshot.id).sort()).toEqual(
      [one.graph.snapshot.id, two.graph.snapshot.id].sort(),
    );
  });

  it('writes a new analysis for a changed analyzer version and never reads the old rows through it', async () => {
    const old = await record(staticSide({ routes: ['/a', '/old'], analyzerVersion: '1.0.0' }));
    const current = await record(staticSide({ routes: ['/a'], analyzerVersion: '2.0.0' }));

    expect(current.graph.snapshot.id).toBe(old.graph.snapshot.id);
    expect(current.graph.analysis.id).not.toBe(old.graph.analysis.id);
    expect(current.graph.screens.map((s) => s.screen.routePattern)).toEqual(['/a']);
    for (const { observations } of current.graph.screens) {
      for (const { evidence } of observations) expect(evidence).toMatchObject({ analysisId: current.graph.analysis.id });
    }
    const [summary, ...others] = await readStore(listBuilds);
    expect(others).toEqual([]);
    expect(summary?.analyses.map(({ analyzerVersion }) => analyzerVersion).sort()).toEqual(['1.0.0', '2.0.0']);
    expect(countRows()).toMatchObject({ analyses: 2, static_evidence: 3 });
    expect((await readStore((db) => loadBuild(db, old.graph.analysis.id)))?.screens).toHaveLength(2);
  });

  it('moves a snapshot from dirty to clean and never back', async () => {
    const worktree = () => readStore(async (db) => (await listBuilds(db))[0]?.snapshot.worktree);
    await record(staticSide({ routes: ['/a'], worktree: 'dirty' }));
    expect(await worktree()).toBe('dirty');
    await record(staticSide({ routes: ['/a'], worktree: 'clean' }));
    expect(await worktree()).toBe('clean');
    await record(staticSide({ routes: ['/a'], worktree: 'dirty' }));
    expect(await worktree()).toBe('clean');
    await record(staticSide({ routes: ['/a'], worktree: 'dirty', analyzerVersion: '2.0.0' }));
    expect(await worktree()).toBe('clean');
  });

  it('returns null for an analysis it never recorded', async () => {
    await record(staticSide({ routes: ['/a'] }));
    const unknown = staticSide({ routes: ['/a'], analyzerVersion: '9.9.9' }).ingestion.analysis.id;
    expect(await readStore((db) => loadBuild(db, unknown))).toBeNull();
  });

  it('throws on a row whose columns do not match its kind', async () => {
    await record(
      staticSide({ routes: ['/a', '/b'], transitions: [makeTransition(a, { kind: 'resolved', stateId: defaultState(b) })] }),
    );
    writeSql((sqlite) => {
      sqlite.pragma('ignore_check_constraints = ON');
      sqlite.prepare('UPDATE transitions SET target_state_id = NULL').run();
    });
    const analysis = staticSide({ routes: ['/a'] }).ingestion.analysis.id;
    await expect(readStore((db) => loadBuild(db, analysis))).rejects.toThrow(
      /target_state_id \(target_kind 'resolved'\) must not be null/,
    );
  });
});

const origin = parseOrigin('http://localhost:3000');
const page = (path: string) => parsePageUrl(origin, path);

function crawlOf(
  session: Session,
  startedAt: string,
  captures: readonly (readonly [path: string, httpStatus: number])[],
  links: readonly (readonly [from: number, to: number])[],
): CrawlResult {
  return {
    origin,
    session,
    startedAt: new Date(startedAt),
    finishedAt: new Date(new Date(startedAt).getTime() + 1000),
    stop: 'frontier-exhausted',
    crawlerVersion: '1',
    requests: { allowed: 3, blocked: 0 },
    captures: captures.map(([path, httpStatus], key) => ({
      key,
      url: page(path),
      httpStatus,
      screenshot: `captures/${key}.png`,
      dom: `captures/${key}.html`,
    })),
    navigations: [
      { seq: 0, start: { kind: 'entry' }, requested: page(captures[0]?.[0] ?? '/'), redirects: [], landing: { kind: 'captured', capture: 0 } },
      ...links.map(([from, to], i) => {
        const target = page(captures[to]?.[0] ?? '/');
        return {
          seq: i + 1,
          start: { kind: 'action', from, action: { kind: 'follow-link', href: target, name: null } },
          requested: target,
          redirects: [],
          landing: { kind: 'captured', capture: to },
        } as const;
      }),
    ],
  };
}

async function seal(side: StaticSide, crawl: CrawlResult): Promise<string> {
  const { snapshot, analysis } = side.ingestion;
  const staging = stagingDirectory(app);
  mkdirSync(staging, { recursive: true });
  const id = runId({ snapshotId: snapshot.id, origin, session: crawl.session, startedAt: crawl.startedAt });
  const sealed = runDirectory(app, snapshot.id, id);
  await sealRun({
    staging,
    sealed,
    crawl: { format: 1, snapshotId: snapshot.id, environment: 'local', seededBy: analysis.analyzerVersion, crawl },
  });
  return sealed;
}

describe('record runs', () => {
  const [a, b] = [screenFor('/a'), screenFor('/b')];
  const staticLink = makeTransition(a, { kind: 'resolved', stateId: defaultState(b) });
  const runtimeLink = makeTransition(b, { kind: 'resolved', stateId: defaultState(a) });
  const side = (analyzerVersion?: string) =>
    staticSide({ routes: ['/a', '/b'], transitions: [staticLink], ...(analyzerVersion === undefined ? {} : { analyzerVersion }) });
  const anonymous = () =>
    crawlOf({ kind: 'anonymous' }, '2026-02-01T00:00:00.000Z', [['/a', 200], ['/b', 200]], [[0, 1], [1, 0]]);
  const signedIn = () =>
    crawlOf({ kind: 'storage-state', label: 'signed-in' }, '2026-02-02T00:00:00.000Z', [['/a', 500]], []);

  it('matches a sealed run once and reports it as already matched after that', async () => {
    await seal(side(), anonymous());
    const first = await record(side());
    expect(kinds(first.runs)).toEqual(['matched-now']);
    const once = countRows();
    const second = await record(side());
    expect(kinds(second.runs)).toEqual(['already-matched']);
    expect(countRows()).toEqual(once);
    expect(second.graph).toEqual(first.graph);
    expect(once).toMatchObject({ runs: 1, captures: 2, navigations: 3, transitions: 2, matches: 1, screen_matches: 2, transition_matches: 2 });
  });

  it('loads runs, captures with absolute artifact paths and runtime-only transitions', async () => {
    const sealed = await seal(side(), anonymous());
    const { graph, runs } = await record(side());
    const [outcome] = runs;
    if (outcome?.kind !== 'matched-now') throw new Error('the run was not matched');
    expect(graph.runs).toEqual([outcome.ingestion.run]);
    expect(graph.runs[0]).toMatchObject({ environment: 'local', seededBy: '1.0.0' });
    const screenA = graph.screens.find((s) => s.screen.id === a.id);
    expect(screenA?.status).toBe('observed');
    const captured = screenA?.observations.flatMap((o) => (o.evidence.kind === 'capture' ? [o.evidence] : []));
    expect(captured).toEqual([outcome.ingestion.captures.find(({ evidence }) => evidence.url === page('/a'))?.evidence]);
    expect(captured?.[0]?.screenshot.startsWith(sealed)).toBe(true);

    const byId = new Map(graph.transitions.map((t) => [t.transition.id, t]));
    expect(byId.get(staticLink.id)?.status).toBe('observed');
    expect(byId.get(runtimeLink.id)?.transition).toEqual(runtimeLink);
    expect(byId.get(runtimeLink.id)?.status).toBe('observed');
    expect(byId.get(runtimeLink.id)?.observations.map(({ evidence }) => evidence.kind)).toEqual(['navigation']);
  });

  it('keeps a run of a second session beside the first and lets its 5xx fail the screen', async () => {
    await seal(side(), anonymous());
    await seal(side(), signedIn());
    const { graph } = await record(side());
    expect(graph.runs.map((run) => run.session)).toEqual([
      { kind: 'anonymous' },
      { kind: 'storage-state', label: 'signed-in' },
    ]);
    const screenA = graph.screens.find((s) => s.screen.id === a.id);
    expect(screenA?.observations.map((o) => o.evidence.kind).sort()).toEqual(['capture', 'capture', 'static']);
    expect(screenA?.status).toBe('failed');
    expect(graph.screens.find((s) => s.screen.id === b.id)?.status).toBe('observed');
  });

  it('matches a run sealed under one analysis again under a newer one', async () => {
    await seal(side('1.0.0'), anonymous());
    const old = await record(side('1.0.0'));
    const current = await record(side('2.0.0'));
    expect(kinds(current.runs)).toEqual(['matched-now']);
    expect(current.graph.runs.map(({ id }) => id)).toEqual(old.graph.runs.map(({ id }) => id));
    expect(current.graph.runs[0]?.seededBy).toBe('1.0.0');
    expect(countRows()).toMatchObject({ runs: 1, captures: 2, matches: 2, screen_matches: 4 });
  });

  it('records a run it cannot match as failed, once per analysis, without failing the static graph', async () => {
    const broken = anonymous();
    const sealed = await seal(side(), { ...broken, navigations: [{ ...broken.navigations[0]!, landing: { kind: 'captured', capture: 7 } }] });
    const first = await record(side());
    expect(first.runs).toEqual([{ kind: 'failed', runId: expect.any(String), reason: expect.stringMatching(/names capture 7/) }]);
    expect(first.graph.screens).toHaveLength(2);
    expect(first.graph.unmatchedRuns).toEqual(first.runs.flatMap((run) => (run.kind === 'failed' ? [run.runId] : [])));
    expect(first.graph.runs).toEqual([]);

    writeFileSync(join(sealed, CRAWL_FILE), 'not json');
    expect((await record(side())).runs).toEqual(first.runs);
    const retried = await record(side('2.0.0'));
    expect(retried.runs).toEqual([{ kind: 'failed', runId: expect.any(String), reason: expect.stringMatching(/JSON/) }]);
    expect(countRows()).toMatchObject({ runs: 0, match_failures: 2 });
  });

  it('lets an unreadable crawl.json fail the record and records a missing one as a match failure', async () => {
    const sealed = await seal(side(), anonymous());
    chmodSync(join(sealed, CRAWL_FILE), 0o000);
    try {
      await expect(record(side())).rejects.toThrow(/EACCES/);
      expect(countRows()).toMatchObject({ match_failures: 0 });
    } finally {
      chmodSync(join(sealed, CRAWL_FILE), 0o600);
    }
    rmSync(join(sealed, CRAWL_FILE));
    const { runs } = await record(side());
    expect(runs).toEqual([{ kind: 'failed', runId: expect.any(String), reason: expect.stringMatching(/ENOENT/) }]);
    expect(countRows()).toMatchObject({ match_failures: 1 });
  });

  it('rejects a navigation row whose start disagrees with its source and action', async () => {
    await seal(side(), anonymous());
    await record(side());
    writeSql((sqlite) => {
      expect(() => sqlite.prepare("UPDATE navigations SET start_kind = 'entry' WHERE log_seq = 1").run()).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => sqlite.prepare('UPDATE navigations SET action = NULL WHERE log_seq = 1').run()).toThrow(
        /CHECK constraint failed/,
      );
    });
  });

  it('refuses a match that pairs a run with another snapshot analysis', async () => {
    await seal(side(), anonymous());
    await record(side());
    const other = await record(staticSide({ commit: 'b', routes: ['/a'] }));
    writeSql((sqlite) => {
      sqlite.pragma('foreign_keys = ON');
      const run = sqlite.prepare('SELECT id, snapshot_id FROM runs').get() as { id: string; snapshot_id: string };
      const insert = sqlite.prepare(
        'INSERT INTO matches (snapshot_id, run_id, analysis_id, created_at) VALUES (?, ?, ?, ?)',
      );
      expect(() => insert.run(run.snapshot_id, run.id, other.graph.analysis.id, 'now')).toThrow(/FOREIGN KEY/);
      expect(() => insert.run(other.graph.snapshot.id, run.id, other.graph.analysis.id, 'now')).toThrow(/FOREIGN KEY/);
    });
  });
});

describe('store files', () => {
  it('creates exactly the final table set', async () => {
    await record(staticSide({ routes: ['/a'] }));
    const sqlite = new Database(stateDatabasePath(app), { readonly: true });
    try {
      const names = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(names).toEqual([...TABLES].sort());
      expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      sqlite.close();
    }
  });

  it('never migrates on a read-only open and asks for a scan instead', async () => {
    const path = stateDatabasePath(app);
    await expect(openReadDatabase({ path })).rejects.toThrow(/Run nori scan first/);
    mkdirSync(dirname(path), { recursive: true });
    new Database(path).close();
    await expect(openReadDatabase({ path })).rejects.toThrow(/Run nori scan first/);
    const sqlite = new Database(path, { readonly: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it('migrates a fresh store and serializes read-then-write transactions from four processes at once', async () => {
    const path = join(tempDir('nori-concurrent-'), 'graph.db');
    const writer = join(repoRoot, 'src', 'testing', 'concurrent-writer.ts');
    const ITERATIONS = 75;
    const startAt = String(Date.now() + 8_000);
    const run = (label: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', writer, path, label, String(ITERATIONS), startAt], {
          cwd: repoRoot,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(run));
    expect(results).toEqual(Array(4).fill({ code: 0, stderr: '' }));
    const sqlite = new Database(path, { readonly: true });
    try {
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 4 * ITERATIONS });
    } finally {
      sqlite.close();
    }
  }, 60_000);
});
