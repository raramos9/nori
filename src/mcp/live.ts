import { sameKey, type FreshnessKey, type Snapshot } from './snapshot.js';

export type Served = {
  readonly snapshot: Snapshot;
  readonly refreshError: string | null;
};

export type LiveSnapshot = {
  current(): Promise<Served>;
};

export function createLiveSnapshot({
  initial,
  probe,
  reanalyze,
}: {
  initial: Snapshot;
  probe: () => Promise<FreshnessKey>;
  reanalyze: () => Promise<Snapshot>;
}): LiveSnapshot {
  let served: Served = { snapshot: initial, refreshError: null };
  let inflight: Promise<Served> | null = null;

  async function refresh(): Promise<Served> {
    try {
      const key = await probe();
      const snapshot = sameKey(key, served.snapshot.key) ? served.snapshot : await reanalyze();
      served = { snapshot, refreshError: null };
    } catch (error) {
      served = { snapshot: served.snapshot, refreshError: error instanceof Error ? error.message : String(error) };
    }
    return served;
  }

  return {
    current() {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
