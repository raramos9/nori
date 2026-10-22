import { describe, expect, it, vi } from 'vitest';
import type { ExplorerGraph } from '../explorer/view.js';
import { parseCommitSha } from '../graph/model.js';
import { createLiveSnapshot } from './live.js';
import { createSnapshot, type FreshnessKey, type Snapshot } from './snapshot.js';

const commitSha = parseCommitSha('a'.repeat(40));

function snapshotOf(sourceHash: string): Snapshot {
  const graph: ExplorerGraph = {
    root: '/repo',
    build: { id: `build-${sourceHash}`, commitSha, branch: 'main', createdAt: '2026-01-01T00:00:00.000Z', analyzerVersion: '0' },
    screens: [],
    transitions: [],
  };
  return createSnapshot({ graph, key: { commitSha, sourceHash } });
}

const keyOf = (sourceHash: string): FreshnessKey => ({ commitSha, sourceHash });

describe('live snapshot', () => {
  it('serves the initial snapshot without re-analysing while the key is unchanged', async () => {
    const initial = snapshotOf('one');
    const reanalyze = vi.fn(async () => snapshotOf('two'));
    const live = createLiveSnapshot({ initial, probe: async () => keyOf('one'), reanalyze });

    expect(await live.current()).toEqual({ snapshot: initial, refreshError: null });
    expect(reanalyze).not.toHaveBeenCalled();
  });

  it('shares one re-analysis between concurrent callers', async () => {
    const next = snapshotOf('two');
    const reanalyze = vi.fn(async () => next);
    const live = createLiveSnapshot({ initial: snapshotOf('one'), probe: async () => keyOf('two'), reanalyze });

    const served = await Promise.all([live.current(), live.current(), live.current()]);

    expect(reanalyze).toHaveBeenCalledTimes(1);
    for (const result of served) expect(result).toEqual({ snapshot: next, refreshError: null });
    await live.current();
    expect(reanalyze).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last good snapshot with the error, then recovers', async () => {
    const initial = snapshotOf('one');
    const next = snapshotOf('two');
    let failing = true;
    const reanalyze = vi.fn(async () => {
      if (failing) throw new Error('parse failed');
      return next;
    });
    const live = createLiveSnapshot({ initial, probe: async () => keyOf('two'), reanalyze });

    expect(await live.current()).toEqual({ snapshot: initial, refreshError: 'parse failed' });
    failing = false;
    expect(await live.current()).toEqual({ snapshot: next, refreshError: null });
    expect(reanalyze).toHaveBeenCalledTimes(2);
  });

  it('reports a failing probe the same way', async () => {
    const initial = snapshotOf('one');
    const live = createLiveSnapshot({
      initial,
      probe: async () => {
        throw new Error('git unavailable');
      },
      reanalyze: async () => snapshotOf('two'),
    });

    expect(await live.current()).toEqual({ snapshot: initial, refreshError: 'git unavailable' });
  });
});
