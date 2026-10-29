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
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Coverage, ExplorerGraph } from '../../src/explorer/view.js';
import type { EvidenceStatus, ScreenId } from '../../src/graph/model.js';
import { fetchGraph } from './api.js';
import {
  countTransitions,
  focusGraph,
  ghostId,
  hasFailingTest,
  indexGraph,
  matchingScreens,
  STATUSES,
  visibleGraph,
  walk,
  type Filters,
  type GraphIndex,
  type Selection,
} from './flow.js';
import { GHOST_SIZE, isBackward, layoutFocused, layoutGraph, NODE_HEIGHT, screenWidth } from './layout.js';
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

function CoverageBlock({ coverage }: { coverage: Coverage }) {
  const { denominator, inferred } = coverage;
  const rows = [
    ['inferred', inferred],
    ['observed', coverage.observed],
    ['exercised by a passing test', coverage.exercisedByPassingTest],
  ] as const;
  return (
    <section className="coverage" aria-label="Coverage">
      <ul>
        {rows.map(([label, count]) => (
          <li key={label}>
            {label}: {count} of {inferred} {denominator}
          </li>
        ))}
      </ul>
      <p className="muted small">Behavior nori did not discover is not counted.</p>
    </section>
  );
}

function Breadcrumbs({ trail, screens, onAll, onCrumb }: {
  trail: readonly ScreenId[];
  screens: GraphIndex['screens'];
  onAll: () => void;
  onCrumb: (id: ScreenId) => void;
}) {
  return (
    <nav className="crumbs" aria-label="Focus trail">
      <button type="button" className="crumb" onClick={onAll}>All screens</button>
      {trail.map((id, position) => {
        const current = position === trail.length - 1;
        return (
          <Fragment key={id}>
            <span className="sep" aria-hidden="true">›</span>
            <button
              type="button"
              className={current ? 'crumb mono current' : 'crumb mono'}
              aria-current={current ? 'location' : undefined}
              onClick={() => onCrumb(id)}
            >
              {screens.get(id)?.route ?? id}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

function Explorer({ graph }: { graph: ExplorerGraph }) {
  const { fitView } = useReactFlow();
  const [filters, setFilters] = useState<Filters>({ statuses: new Set(STATUSES), showUnresolved: true });
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trail, setTrail] = useState<readonly ScreenId[]>([]);

  const index = useMemo(() => indexGraph(graph), [graph]);
  const visible = useMemo(() => visibleGraph(graph, filters), [graph, filters]);
  const center = trail.at(-1);
  const rendered = useMemo(
    () => (center === undefined ? visible : (focusGraph(visible, center) ?? visible)),
    [visible, center],
  );
  const focused = rendered === visible ? undefined : center;
  const boxes = useMemo(
    () =>
      focused !== undefined
        ? layoutFocused(rendered, focused)
        : layoutGraph(rendered, rendered.screens.find(({ route }) => route === '/')?.id),
    [rendered, focused],
  );
  const matches = useMemo(() => matchingScreens(rendered.screens, deferredQuery), [rendered, deferredQuery]);
  const linkById = useMemo(() => new Map(rendered.links.map((link) => [link.id, link])), [rendered]);
  const ghostById = useMemo(() => new Map(rendered.ghosts.map((ghost) => [ghost.id, ghost])), [rendered]);

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
    for (const screen of rendered.screens) {
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
          selfLoops: rendered.selfLoops.get(screen.id)?.length ?? 0,
          dim: searching && !matches.has(screen.id),
          match: searching && matches.has(screen.id),
        },
      };
      result.push(node);
    }
    for (const ghost of rendered.ghosts) {
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
  }, [rendered, boxes, selection, searching, matches]);

  const edges = useMemo((): Edge[] => {
    const emphasised = (source: string, target: string) =>
      selection?.kind === 'screen' ? source === selection.id || target === selection.id : focus.has(source) && focus.has(target);
    const classFor = (base: string, source: string, target: string, dimmed: boolean) => {
      const classes = [base];
      if (emphasised(source, target)) classes.push('emphasis');
      else if (focus.size > 0 || dimmed) classes.push('faded');
      return classes.join(' ');
    };
    const result: Edge[] = [];
    for (const link of rendered.links) {
      const count = link.transitions.length;
      const from = boxes.get(link.source);
      const to = boxes.get(link.target);
      const backward = from !== undefined && to !== undefined && isBackward(from, to);
      result.push({
        id: link.id,
        source: link.source,
        target: link.target,
        sourceHandle: backward ? 'out-back' : 'out',
        targetHandle: backward ? 'in-back' : 'in',
        label: count > 1 ? String(count) : undefined,
        className: classFor(`resolved status-${link.status}${hasFailingTest(link.transitions) ? ' test-failed' : ''}`, link.source, link.target, searching && !(matches.has(link.source) || matches.has(link.target))),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        selected: selection?.kind === 'link' && selection.id === link.id,
        interactionWidth: 16,
      });
    }
    for (const ghost of rendered.ghosts) {
      const count = ghost.transitions.length;
      result.push({
        id: `edge:${ghost.id}`,
        source: ghost.sourceScreenId,
        sourceHandle: 'out',
        target: ghost.id,
        label: count > 1 ? String(count) : undefined,
        className: classFor(hasFailingTest(ghost.transitions) ? 'unresolved test-failed' : 'unresolved', ghost.sourceScreenId, ghost.id, searching && !matches.has(ghost.sourceScreenId)),
        markerEnd: { type: MarkerType.Arrow, width: 12, height: 12 },
        selected: selection?.kind === 'ghost' && selection.id === ghost.id,
        interactionWidth: 16,
      });
    }
    return result;
  }, [rendered, boxes, selection, focus, searching, matches]);

  const flowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = flowRef.current;
    if (element === null) return;
    let frame = 0;
    // React Flow measures its pane in its own ResizeObserver; fitting earlier uses the old size.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ duration: 0, padding: 0.12 }));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [boxes, fitView]);

  useEffect(() => {
    if (matches.size === 0) return;
    const ids = [...matches].slice(0, MAX_FIT_NODES).map((id) => ({ id }));
    void fitView({ nodes: ids, duration: 300, padding: 0.3, maxZoom: 1.1 });
  }, [matches, fitView]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelection(null);
      setTrail([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectScreen = (id: ScreenId) => {
    setSelection({ kind: 'screen', id });
    setTrail((current) => walk(current, id));
  };

  return (
    <div className="app">
      <Header
        graph={graph}
        filters={filters}
        onFilters={setFilters}
        query={query}
        onQuery={setQuery}
        shown={{ screens: rendered.screens.length, matches: matches.size }}
      />
      <CoverageBlock coverage={graph.coverage} />
      <div className="stage">
        <div className="canvas">
          {trail.length > 0 ? (
            <Breadcrumbs
              trail={trail}
              screens={index.screens}
              onAll={() => setTrail([])}
              onCrumb={selectScreen}
            />
          ) : null}
          <div className="flow" ref={flowRef}>
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
                const screen = rendered.screens.find(({ id }) => id === node.id);
                if (screen !== undefined) selectScreen(screen.id);
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
              {focused === undefined ? <MiniMap pannable zoomable nodeClassName={miniMapClass} /> : null}
            </ReactFlow>
            {visible.screens.length === 0 ? <div className="empty">Nothing matches the current filters.</div> : null}
          </div>
        </div>
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
