import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, scan } from './commands/scan.js';
import { comparable, diffBuilds, type BuildDiff } from './graph/diff.js';
import type { BuildGraph } from './graph/model.js';
import { demoHistory } from './testing/demo-history.js';
import { addedOrRemovedEdges, addedOrRemovedScreens, expectedDiff, keys } from './testing/fixture-diff.js';
import { pairKey, resolvedPairs } from './testing/resolved-pairs.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CREATED_AT = new Date('2026-01-01T00:00:00Z');

const noScreenshots = (): never => {
  throw new Error('a build without captures has no screenshot to hash');
};

function diffOf(base: BuildGraph, head: BuildGraph): BuildDiff {
  const pair = comparable(base, head);
  if (pair.kind !== 'comparable') throw new Error(pair.kind);
  return diffBuilds(pair.pair, { screenshotDigest: noScreenshots });
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

describe('route-added-edge-removed fixture', () => {
  const expected = expectedDiff('route-added-edge-removed');
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
    expect(addedOrRemovedScreens(diff, 'added')).toEqual(expected.screens.added);
    expect(addedOrRemovedScreens(diff, 'removed')).toEqual(expected.screens.removed);
  });

  it('adds and removes exactly the planned edges', () => {
    const diff = diffOf(base, head);
    expect(addedOrRemovedEdges(diff, 'added', graphPairs(base))).toEqual(keys(expected.edges.added));
    expect(addedOrRemovedEdges(diff, 'removed', graphPairs(head))).toEqual(keys(expected.edges.removed));
  });

  it('reports nothing but additions and removals, and no coverage gaps', () => {
    const diff = diffOf(base, head);
    expect(diff.changes.every((change) => change.kind === 'added' || change.kind === 'removed')).toBe(true);
    expect(diff.gaps).toEqual([]);
    const planned = new Set([...keys(expected.edges.added), ...keys(expected.edges.removed)]);
    const transitionPairs = diff.changes.flatMap(({ subject }) =>
      subject.kind !== 'transition' ? [] : [subject.to.kind === 'route' ? pairKey({ from: subject.from, to: subject.to.pattern }) : subject.to.expression],
    );
    expect(transitionPairs.filter((pair) => !planned.has(pair))).toEqual([]);
  });

  it('finds nothing against itself', () => {
    expect(diffOf(head, head)).toMatchObject({ changes: [], gaps: [] });
  });
});
