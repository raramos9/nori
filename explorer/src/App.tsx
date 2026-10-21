import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ExplorerGraph } from '../../src/explorer/view.js';
import type { EvidenceStatus, ScreenId } from '../../src/graph/model.js';
import { fetchGraph } from './api.js';
import {
  countTransitions,
  ghostId,
  indexGraph,
  matchingScreens,
  STATUSES,
  visibleGraph,
  type Filters,
  type Selection,
} from './flow.js';
import { GHOST_SIZE, layoutGraph, NODE_HEIGHT, screenWidth } from './layout.js';
import { NODE_TYPES, type GhostNodeType, type ScreenNodeType } from './nodes.js';
import { SidePanel } from './SidePanel.js';

const MAX_FIT_NODES = 300;

function miniMapClass(node: Node): string {
  return typeof node.data['status'] === 'string' ? `mini-${node.data['status']}` : 'mini-ghost';
}

function Header({ graph, filters, onFilters, query, onQuery, shown }: {
  graph: ExplorerGraph;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  query: string;
  onQuery: (query: string) => void;
  shown: { screens: number; matches: number };
}) {
  const { resolved, unresolved } = countTransitions(graph);
  const { build } = graph;
  const toggle = (status: EvidenceStatus) => {
    const statuses = new Set(filters.statuses);
    if (!statuses.delete(status)) statuses.add(status);
    onFilters({ ...filters, statuses });
  };
  return (
    <header className="top">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        <strong>nori</strong>
      </div>
      <div className="build mono" title={`${build.commitSha}\nanalyzer ${build.analyzerVersion}\n${build.createdAt}`}>
        <span className="sha">{build.commitSha.slice(0, 7)}</span>
        <span className="branch">{build.branch ?? 'detached HEAD'}</span>
      </div>
      <dl className="counts">
        <div>
          <dt>screens</dt>
          <dd>{graph.screens.length}</dd>
        </div>
        <div>
          <dt>resolved</dt>
          <dd>{resolved}</dd>
        </div>
        <div className="unresolved-count">
          <dt>unresolved</dt>
          <dd>{unresolved}</dd>
        </div>
      </dl>
      <div className="filters">
        {STATUSES.map((status) => (
          <label key={status} className={`chip status-${status}`}>
            <input type="checkbox" checked={filters.statuses.has(status)} onChange={() => toggle(status)} />
            {status}
          </label>
        ))}
        <label className="chip unresolved-chip">
          <input
            type="checkbox"
            checked={filters.showUnresolved}
            onChange={() => onFilters({ ...filters, showUnresolved: !filters.showUnresolved })}
          />
          unresolved
        </label>
      </div>
      <div className="search">
        <input
          type="search"
          placeholder="Find route…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          aria-label="Find route"
        />
        {query.trim() !== '' ? <span className="muted small">{shown.matches} / {shown.screens}</span> : null}
      </div>
    </header>
  );
}

function Explorer({ graph }: { graph: ExplorerGraph }) {
  const { fitView } = useReactFlow();
  const [filters, setFilters] = useState<Filters>({ statuses: new Set(STATUSES), showUnresolved: true });
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selection, setSelection] = useState<Selection | null>(null);

  const index = useMemo(() => indexGraph(graph), [graph]);
  const visible = useMemo(() => visibleGraph(graph, filters), [graph, filters]);
  const boxes = useMemo(() => layoutGraph(visible), [visible]);
  const matches = useMemo(() => matchingScreens(visible.screens, deferredQuery), [visible, deferredQuery]);
  const linkById = useMemo(() => new Map(visible.links.map((link) => [link.id, link])), [visible]);
  const ghostById = useMemo(() => new Map(visible.ghosts.map((ghost) => [ghost.id, ghost])), [visible]);

  const searching = matches.size > 0;
  const focus = useMemo((): ReadonlySet<string> => {
    if (selection === null) return new Set();
    switch (selection.kind) {
      case 'screen':
        return new Set([selection.id]);
      case 'link': {
        const link = linkById.get(selection.id);
        return new Set(link === undefined ? [] : [link.source, link.target]);
      }
      case 'ghost': {
        const ghost = ghostById.get(selection.id);
        return new Set(ghost === undefined ? [] : [ghost.sourceScreenId, ghost.id]);
      }
      default: {
        const _exhaustive: never = selection;
        return _exhaustive;
      }
    }
  }, [selection, linkById, ghostById]);

  const nodes = useMemo((): Node[] => {
    const result: Node[] = [];
    for (const screen of visible.screens) {
      const box = boxes.get(screen.id);
      if (box === undefined) continue;
      const node: ScreenNodeType = {
        id: screen.id,
        type: 'screen',
        position: { x: box.x, y: box.y },
        width: screenWidth(screen.route),
        height: NODE_HEIGHT,
        selected: selection?.kind === 'screen' && selection.id === screen.id,
        data: {
          route: screen.route,
          status: screen.status,
          selfLoops: visible.selfLoops.get(screen.id)?.length ?? 0,
          dim: searching && !matches.has(screen.id),
          match: searching && matches.has(screen.id),
        },
      };
      result.push(node);
    }
    for (const ghost of visible.ghosts) {
      const box = boxes.get(ghost.id);
      if (box === undefined) continue;
      const node: GhostNodeType = {
        id: ghost.id,
        type: 'ghost',
        position: { x: box.x, y: box.y },
        width: GHOST_SIZE.width,
        height: GHOST_SIZE.height,
        selected: selection?.kind === 'ghost' && selection.id === ghost.id,
        data: { count: ghost.transitions.length, dim: searching && !matches.has(ghost.sourceScreenId) },
      };
      result.push(node);
    }
    return result;
  }, [visible, boxes, selection, searching, matches]);

  const edges = useMemo((): Edge[] => {
    const emphasised = (source: string, target: string) => focus.size > 0 && focus.has(source) && focus.has(target);
    const classFor = (base: string, source: string, target: string, dimmed: boolean) => {
      const classes = [base];
      if (emphasised(source, target)) classes.push('emphasis');
      else if (focus.size > 0 || dimmed) classes.push('faded');
      return classes.join(' ');
    };
    const result: Edge[] = [];
    for (const link of visible.links) {
      const count = link.transitions.length;
      result.push({
        id: link.id,
        source: link.source,
        target: link.target,
        label: count > 1 ? String(count) : undefined,
        className: classFor(`resolved status-${link.status}`, link.source, link.target, searching && !(matches.has(link.source) || matches.has(link.target))),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        selected: selection?.kind === 'link' && selection.id === link.id,
        interactionWidth: 16,
      });
    }
    for (const ghost of visible.ghosts) {
      const count = ghost.transitions.length;
      result.push({
        id: `edge:${ghost.id}`,
        source: ghost.sourceScreenId,
        target: ghost.id,
        label: count > 1 ? String(count) : undefined,
        className: classFor('unresolved', ghost.sourceScreenId, ghost.id, searching && !matches.has(ghost.sourceScreenId)),
        markerEnd: { type: MarkerType.Arrow, width: 12, height: 12 },
        selected: selection?.kind === 'ghost' && selection.id === ghost.id,
        interactionWidth: 16,
      });
    }
    return result;
  }, [visible, selection, focus, searching, matches]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ duration: 0, padding: 0.12 }));
    return () => cancelAnimationFrame(frame);
  }, [boxes, fitView]);

  useEffect(() => {
    if (matches.size === 0) return;
    const ids = [...matches].slice(0, MAX_FIT_NODES).map((id) => ({ id }));
    void fitView({ nodes: ids, duration: 300, padding: 0.3, maxZoom: 1.1 });
  }, [matches, fitView]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectScreen = (id: ScreenId) => {
    setSelection({ kind: 'screen', id });
    void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1, padding: 1.5 });
  };

  return (
    <div className="app">
      <Header
        graph={graph}
        filters={filters}
        onFilters={setFilters}
        query={query}
        onQuery={setQuery}
        shown={{ screens: visible.screens.length, matches: matches.size }}
      />
      <div className="stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          minZoom={0.02}
          maxZoom={2}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            const screen = visible.screens.find(({ id }) => id === node.id);
            if (screen !== undefined) setSelection({ kind: 'screen', id: screen.id });
            else if (ghostById.has(node.id)) setSelection({ kind: 'ghost', id: node.id });
          }}
          onEdgeClick={(_, edge) =>
            setSelection(
              edge.id.startsWith('edge:')
                ? { kind: 'ghost', id: edge.id.slice('edge:'.length) }
                : { kind: 'link', id: edge.id },
            )
          }
          onPaneClick={() => setSelection(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeClassName={miniMapClass} />
        </ReactFlow>
        {visible.screens.length === 0 ? <div className="empty">Nothing matches the current filters.</div> : null}
        {selection !== null ? (
          <SidePanel
            graph={graph}
            index={index}
            selection={selection}
            links={linkById}
            ghosts={ghostById}
            onSelectScreen={selectScreen}
            onClose={() => setSelection(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [graph, setGraph] = useState<ExplorerGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGraph().then(setGraph, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  if (error !== null) return <div className="status-page">Could not load the graph: {error}</div>;
  if (graph === null) return <div className="status-page">Loading graph…</div>;
  return (
    <ReactFlowProvider>
      <Explorer graph={graph} />
    </ReactFlowProvider>
  );
}
