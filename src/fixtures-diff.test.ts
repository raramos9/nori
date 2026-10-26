import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyze, scan } from './commands/scan.js';
import { comparable, diffBuilds, type BuildDiff } from './graph/diff.js';
import type { BuildGraph } from './graph/model.js';
import { demoHistory } from './testing/demo-history.js';
import { pairKey, resolvedPairs } from './testing/resolved-pairs.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CREATED_AT = new Date('2026-01-01T00:00:00Z');

const edge = z.object({ from: z.string(), to: z.string() });
const expectedSchema = z.object({
  screens: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  edges: z.object({ added: z.array(edge), removed: z.array(edge) }),
});

const keys = (edges: { from: string; to: string }[]) => edges.map(pairKey).sort();

function diffOf(base: BuildGraph, head: BuildGraph): BuildDiff {
  const pair = comparable(base, head);
  if (pair.kind !== 'comparable') throw new Error(pair.kind);
  return diffBuilds(pair.pair);
}

function screens(diff: BuildDiff, kind: 'added' | 'removed'): string[] {
  return diff.changes
    .flatMap((change) => (change.kind === kind && change.subject.kind === 'screen' ? [change.subject.routePattern] : []))
    .sort();
}

function graphPairs(graph: BuildGraph): Set<string> {
  const patterns = new Map(graph.screens.flatMap(({ screen, states }) => states.map((state) => [state.id, screen.routePattern])));
  const pairs = new Set<string>();
  for (const { transition } of graph.transitions) {
    const from = patterns.get(transition.sourceStateId);
    if (from !== undefined && transition.target.kind === 'resolved') {
      const to = patterns.get(transition.target.stateId);
      if (to !== undefined) pairs.add(pairKey({ from, to }));
    }
  }
  return pairs;
}

function edges(diff: BuildDiff, kind: 'added' | 'removed', other: BuildGraph): string[] {
  const otherPairs = graphPairs(other);
  const pairs = diff.changes.flatMap((change) =>
    change.kind === kind && change.subject.kind === 'transition' && change.subject.to.kind === 'route'
      ? [pairKey({ from: change.subject.from, to: change.subject.to.pattern })]
      : [],
  );
  return [...new Set(pairs)].filter((pair) => !otherPairs.has(pair)).sort();
}

describe('route-added-edge-removed fixture', () => {
  const expected = expectedSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES, 'diffs', 'route-added-edge-removed', 'expected-diff.json'), 'utf8')),
  );
  const history = demoHistory('route-added-edge-removed');
  const baseRoot = `${history.root}-base`;
  const originalHome = process.env.NORI_HOME;
  const home = mkdtempSync(join(tmpdir(), 'nori-fixtures-diff-'));
  let base: BuildGraph;
  let head: BuildGraph;

  beforeAll(async () => {
    process.env.NORI_HOME = home;
    execFileSync('git', ['worktree', 'add', '-q', '--detach', baseRoot, history.base], { cwd: history.root });
    base = await scan({ path: baseRoot, createdAt: CREATED_AT });
    head = await scan({ path: history.root, createdAt: CREATED_AT });
  });

  afterAll(() => {
    process.env.NORI_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(baseRoot, { recursive: true, force: true });
    rmSync(history.root, { recursive: true, force: true });
  });

  it('starts from the demo as it is today', async () => {
    const today = async (path: string) => {
      const { ingestion } = await analyze({ path, createdAt: CREATED_AT });
      return { screens: ingestion.screens.map((screen) => screen.routePattern).sort(), pairs: resolvedPairs(ingestion) };
    };
    expect(await today(baseRoot)).toEqual(await today(join(FIXTURES, 'demo')));
  });

  it('adds and removes exactly the planned screens', () => {
    const diff = diffOf(base, head);
    expect(screens(diff, 'added')).toEqual(expected.screens.added);
    expect(screens(diff, 'removed')).toEqual(expected.screens.removed);
  });

  it('adds and removes exactly the planned edges', () => {
    const diff = diffOf(base, head);
    expect(edges(diff, 'added', base)).toEqual(keys(expected.edges.added));
    expect(edges(diff, 'removed', head)).toEqual(keys(expected.edges.removed));
  });

  it('reports nothing but additions and removals, and no coverage gaps', () => {
    const diff = diffOf(base, head);
    expect(diff.changes.every((change) => change.kind === 'added' || change.kind === 'removed')).toBe(true);
    expect(diff.gaps).toEqual([]);
  });

  it('finds nothing against itself', () => {
    expect(diffOf(head, head)).toMatchObject({ changes: [], gaps: [] });
  });
});
