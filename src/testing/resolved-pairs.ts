import { screenId, stateId } from '../graph/ids.js';
import { DEFAULT_STATE_KEY, type StateId, type StaticIngestion } from '../graph/model.js';

export const pairKey = ({ from, to }: { from: string; to: string }) => `${from} -> ${to}`;

export function patternsByState({ application, screens }: StaticIngestion): Map<StateId, string> {
  return new Map(
    screens.map((screen) => [
      stateId({ screenId: screenId({ appKey: application.id, routePattern: screen.routePattern }), key: DEFAULT_STATE_KEY }),
      screen.routePattern,
    ]),
  );
}

export function resolvedPairs(ingestion: StaticIngestion): Set<string> {
  const patterns = patternsByState(ingestion);
  const pairs = new Set<string>();
  for (const { sourceStateId, target } of ingestion.transitions) {
    if (target.kind !== 'resolved') continue;
    const from = patterns.get(sourceStateId);
    const to = patterns.get(target.stateId);
    if (from === undefined || to === undefined) throw new Error('transition points at an unknown state');
    pairs.add(pairKey({ from, to }));
  }
  return pairs;
}
