import type { EvidenceStatus, NonEmpty, ScreenId } from '../../src/graph/model.js';
import type { ExplorerGraph, ExplorerScreen, ExplorerTransition } from '../../src/explorer/view.js';

export const STATUSES = ['inferred', 'observed', 'verified', 'failed'] as const;
const _allStatusesListed: [Exclude<EvidenceStatus, (typeof STATUSES)[number]>] extends [never] ? true : never = true;

export type Filters = {
  readonly statuses: ReadonlySet<EvidenceStatus>;
  readonly showUnresolved: boolean;
};

export type Link = {
  readonly id: string;
  readonly source: ScreenId;
  readonly target: ScreenId;
  readonly transitions: NonEmpty<ExplorerTransition>;
  readonly status: EvidenceStatus | 'mixed';
};

export type Ghost = {
  readonly id: string;
  readonly sourceScreenId: ScreenId;
  readonly transitions: NonEmpty<ExplorerTransition>;
};

export type VisibleGraph = {
  readonly screens: readonly ExplorerScreen[];
  readonly links: readonly Link[];
  readonly ghosts: readonly Ghost[];
  readonly selfLoops: ReadonlyMap<ScreenId, readonly ExplorerTransition[]>;
};

export type GraphIndex = {
  readonly screens: ReadonlyMap<ScreenId, ExplorerScreen>;
  readonly outgoing: ReadonlyMap<ScreenId, readonly ExplorerTransition[]>;
  readonly incomingCount: ReadonlyMap<ScreenId, number>;
};

function appendTo<K, V>(groups: Map<K, [V, ...V[]]>, key: K, value: V): void {
  const existing = groups.get(key);
  if (existing === undefined) groups.set(key, [value]);
  else existing.push(value);
}

export function indexGraph(graph: ExplorerGraph): GraphIndex {
  const outgoing = new Map<ScreenId, ExplorerTransition[]>();
  const incomingCount = new Map<ScreenId, number>();
  for (const transition of graph.transitions) {
    const list = outgoing.get(transition.sourceScreenId);
    if (list === undefined) outgoing.set(transition.sourceScreenId, [transition]);
    else list.push(transition);
    if (transition.target.kind === 'screen') {
      incomingCount.set(transition.target.screenId, (incomingCount.get(transition.target.screenId) ?? 0) + 1);
    }
  }
  return { screens: new Map(graph.screens.map((screen) => [screen.id, screen])), outgoing, incomingCount };
}

export function countTransitions(graph: ExplorerGraph): { resolved: number; unresolved: number } {
  const resolved = graph.transitions.filter(({ target }) => target.kind === 'screen').length;
  return { resolved, unresolved: graph.transitions.length - resolved };
}

function linkStatus(transitions: NonEmpty<ExplorerTransition>): Link['status'] {
  const [first, ...rest] = transitions;
  return rest.every(({ status }) => status === first.status) ? first.status : 'mixed';
}

export function visibleGraph(graph: ExplorerGraph, filters: Filters): VisibleGraph {
  const screens = graph.screens.filter(({ status }) => filters.statuses.has(status));
  const shown = new Set(screens.map(({ id }) => id));

  const pairs = new Map<string, [ExplorerTransition, ...ExplorerTransition[]]>();
  const unresolved = new Map<ScreenId, [ExplorerTransition, ...ExplorerTransition[]]>();
  const selfLoops = new Map<ScreenId, ExplorerTransition[]>();
  for (const transition of graph.transitions) {
    if (!filters.statuses.has(transition.status) || !shown.has(transition.sourceScreenId)) continue;
    const { target } = transition;
    switch (target.kind) {
      case 'screen':
        if (!shown.has(target.screenId)) break;
        if (target.screenId === transition.sourceScreenId) {
          const loops = selfLoops.get(target.screenId);
          if (loops === undefined) selfLoops.set(target.screenId, [transition]);
          else loops.push(transition);
        } else {
          appendTo(pairs, `${transition.sourceScreenId}>${target.screenId}`, transition);
        }
        break;
      case 'unresolved':
        if (filters.showUnresolved) appendTo(unresolved, transition.sourceScreenId, transition);
        break;
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }

  const links = [...pairs].map(([id, transitions]): Link => {
    const [first] = transitions;
    if (first.target.kind !== 'screen') throw new Error(`Link ${id} holds an unresolved transition`);
    return { id, source: first.sourceScreenId, target: first.target.screenId, transitions, status: linkStatus(transitions) };
  });
  const ghosts = [...unresolved].map(
    ([sourceScreenId, transitions]): Ghost => ({ id: ghostId(sourceScreenId), sourceScreenId, transitions }),
  );
  return { screens, links, ghosts, selfLoops };
}

export function focusGraph(visible: VisibleGraph, center: ScreenId): VisibleGraph | null {
  if (!visible.screens.some(({ id }) => id === center)) return null;
  const links = visible.links.filter(({ source, target }) => source === center || target === center);
  const kept = new Set<ScreenId>([center]);
  for (const { source, target } of links) {
    kept.add(source);
    kept.add(target);
  }
  const loops = visible.selfLoops.get(center);
  return {
    screens: visible.screens.filter(({ id }) => kept.has(id)),
    links,
    ghosts: visible.ghosts.filter(({ sourceScreenId }) => sourceScreenId === center),
    selfLoops: loops === undefined ? new Map() : new Map([[center, loops]]),
  };
}

export function walk(trail: readonly ScreenId[], id: ScreenId): ScreenId[] {
  const at = trail.indexOf(id);
  return at === -1 ? [...trail, id] : trail.slice(0, at + 1);
}

export function ghostId(screenId: ScreenId): string {
  return `ghost:${screenId}`;
}

export function matchingScreens(screens: readonly ExplorerScreen[], query: string): ReadonlySet<ScreenId> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return new Set();
  return new Set(screens.filter(({ route }) => route.toLowerCase().includes(needle)).map(({ id }) => id));
}

export type Selection =
  | { readonly kind: 'screen'; readonly id: ScreenId }
  | { readonly kind: 'link'; readonly id: string }
  | { readonly kind: 'ghost'; readonly id: string };
