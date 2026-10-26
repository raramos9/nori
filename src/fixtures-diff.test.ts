import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyze } from './commands/scan.js';
import { demoHistory } from './testing/demo-history.js';
import { pairKey, resolvedPairs } from './testing/resolved-pairs.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CREATED_AT = new Date('2026-01-01T00:00:00Z');

const edge = z.object({ from: z.string(), to: z.string() });
const expectedSchema = z.object({
  screens: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  edges: z.object({ added: z.array(edge), removed: z.array(edge) }),
});

const difference = (left: Set<string>, right: Set<string>) => [...left].filter((key) => !right.has(key)).sort();
const keys = (edges: { from: string; to: string }[]) => edges.map(pairKey).sort();

async function snapshot(path: string) {
  const { ingestion } = await analyze({ path, createdAt: CREATED_AT });
  return {
    screens: new Set(ingestion.screens.map((screen) => screen.routePattern)),
    pairs: resolvedPairs(ingestion),
  };
}

describe('route-added-edge-removed fixture', () => {
  const expected = expectedSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES, 'diffs', 'route-added-edge-removed', 'expected-diff.json'), 'utf8')),
  );
  const history = demoHistory('route-added-edge-removed');
  const baseRoot = `${history.root}-base`;
  let base: Awaited<ReturnType<typeof snapshot>>;
  let head: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    execFileSync('git', ['worktree', 'add', '-q', '--detach', baseRoot, history.base], { cwd: history.root });
    base = await snapshot(baseRoot);
    head = await snapshot(history.root);
  });

  afterAll(() => {
    rmSync(baseRoot, { recursive: true, force: true });
    rmSync(history.root, { recursive: true, force: true });
  });

  it('starts from the demo as it is today', async () => {
    expect(base).toEqual(await snapshot(join(FIXTURES, 'demo')));
  });

  it('adds and removes exactly the planned screens', () => {
    expect(difference(head.screens, base.screens)).toEqual(expected.screens.added);
    expect(difference(base.screens, head.screens)).toEqual(expected.screens.removed);
  });

  it('adds and removes exactly the planned edges', () => {
    expect(difference(head.pairs, base.pairs)).toEqual(keys(expected.edges.added));
    expect(difference(base.pairs, head.pairs)).toEqual(keys(expected.edges.removed));
  });
});
