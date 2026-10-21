import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseCommitSha,
  parseRoutePattern,
  type Build,
  type Evidence,
  type Observation,
  type Screen,
  type StaticIngestion,
  type Transition,
} from '../graph/model.js';
import { GraphStore } from './graph-store.js';

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

function staticEvidence(b: Build, file: string, line: number): Evidence {
  const identity = {
    kind: 'static',
    buildId: b.id,
    span: { file, start: { line, column: 2 }, end: { line, column: 40 } },
    extractor: 'next-link',
  } as const;
  return { ...identity, id: evidenceId(identity) };
}

function supports(evidence: Evidence, subject: Observation['subject']): Observation {
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
    expect(loaded?.observations.map((o) => o.verdict).sort()).toEqual(['contradicts', 'supports']);
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
