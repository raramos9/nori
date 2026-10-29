import { useEffect, useState } from 'react';
import type { ExplorerCapture, ExplorerGraph, ExplorerTransition, SourceRef } from '../../src/explorer/view.js';
import type { TestRef, TransitionTests } from '../../src/graph/tests.js';
import type { ScreenId } from '../../src/graph/model.js';
import { fetchSnippet, type SourceSnippet } from './api.js';
import type { Ghost, GraphIndex, Link, Selection } from './flow.js';

type Props = {
  graph: ExplorerGraph;
  index: GraphIndex;
  selection: Selection;
  links: ReadonlyMap<string, Link>;
  ghosts: ReadonlyMap<string, Ghost>;
  onSelectScreen: (id: ScreenId) => void;
  onClose: () => void;
};

function editorHref(root: string, ref: SourceRef): string {
  return `vscode://file${encodeURI(`${root}/${ref.file}`)}:${ref.start.line}:${ref.start.column}`;
}

type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; snippet: SourceSnippet }
  | { state: 'failed'; message: string };

function SourceRefRow({ root, source }: { root: string; source: SourceRef }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' });

  useEffect(() => {
    if (!open || loaded.state !== 'idle') return;
    setLoaded({ state: 'loading' });
    fetchSnippet(source.evidenceId).then(
      (snippet) => setLoaded({ state: 'ready', snippet }),
      (error: unknown) => setLoaded({ state: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );
  }, [open, loaded.state, source.evidenceId]);

  return (
    <div className="source">
      <div className="source-head">
        <button type="button" className="linkish mono" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          {source.file}:{source.start.line}
        </button>
        <a className="editor" href={editorHref(root, source)} title="Open in VS Code">
          vscode
        </a>
      </div>
      {open ? (
        <div className="snippet">
          {loaded.state === 'ready' ? (
            <pre>
              {loaded.snippet.lines.map((line, i) => {
                const number = loaded.snippet.startLine + i;
                const hot = number >= source.start.line && number <= source.end.line;
                return (
                  <div key={number} className={hot ? 'line hot' : 'line'}>
                    <span className="num">{number}</span>
                    <span>{line === '' ? ' ' : line}</span>
                  </div>
                );
              })}
            </pre>
          ) : loaded.state === 'failed' ? (
            <p className="muted">Could not load the snippet ({loaded.message}).</p>
          ) : (
            <p className="muted">Loading…</p>
          )}
          <p className="muted small">{source.extractor}</p>
        </div>
      ) : null}
    </div>
  );
}

function Sources({ root, sources }: { root: string; sources: readonly SourceRef[] }) {
  return (
    <div className="sources">
      {sources.map((source) => (
        <SourceRefRow key={source.evidenceId} root={root} source={source} />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

function Captures({ captures }: { captures: readonly ExplorerCapture[] }) {
  return (
    <div className="captures">
      {captures.map((capture) => (
        <figure key={capture.evidenceId} className="capture">
          <figcaption>
            <span className="badge">{capture.session}</span>
            {capture.verdict === 'contradicts' ? <span className="badge status-failed">{capture.httpStatus}</span> : null}
            <span className="mono small capture-url">{capture.url}</span>
            <a className="editor" href={`/artifacts/${capture.evidenceId}/dom`} target="_blank" rel="noreferrer">
              DOM
            </a>
          </figcaption>
          <img src={`/artifacts/${capture.evidenceId}/screenshot`} alt={`${capture.session} capture of ${capture.url}`} loading="lazy" />
        </figure>
      ))}
    </div>
  );
}

function Tests({ tests }: { tests: TransitionTests }) {
  const { passing, failing, walkedInFailing } = tests;
  if (passing.length + failing.length + walkedInFailing.length === 0) return null;
  const key = (ref: TestRef) => `${ref.importId} ${ref.caseKey} ${ref.retry} ${ref.seq}`;
  return (
    <div className="tests">
      <p className="muted small">Tests</p>
      <ul>
        {failing.map((ref) => (
          <li key={key(ref)} className="test-failed">
            failed in test {ref.title}
            <div className="mono small">{ref.message}</div>
          </li>
        ))}
        {passing.map((ref) => (
          <li key={key(ref)}>
            passed in test {ref.title} <span className="muted small">({ref.asserted ? 'asserted' : 'no assertions'})</span>
          </li>
        ))}
        {walkedInFailing.map((ref) => (
          <li key={key(ref)} className="muted">
            walked in failing test {ref.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TransitionCall({
  transition,
  root,
  expressions,
}: {
  transition: ExplorerTransition;
  root: string;
  expressions: ReadonlyMap<string, string>;
}) {
  const { target } = transition;
  return (
    <li className="call">
      <div className="call-head">
        <span className="trigger">{transition.trigger}</span>
        <StatusBadge status={transition.status} />
        {transition.runtimeOnly ? <span className="badge runtime-only">runtime only</span> : null}
      </div>
      {transition.observedIn.length > 0 ? (
        <p className="muted small">Observed in {transition.observedIn.join(', ')}</p>
      ) : null}
      {transition.runtimeOnly && transition.mayExplain.length > 0 ? (
        <div className="may-explain">
          <p className="muted small">May be one of these unresolved calls on the same screen</p>
          <ul>
            {transition.mayExplain.map((id) => (
              <li key={id}>
                <code className="expression">{expressions.get(id) ?? id}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {target.kind === 'unresolved' ? (
        <div className="unresolved-detail">
          <span className="reason">{target.reason}</span>
          <code className="expression">{target.expression}</code>
        </div>
      ) : null}
      <Tests tests={transition.tests} />
      <Sources root={root} sources={transition.sources} />
    </li>
  );
}

export function SidePanel({ graph, index, selection, links, ghosts, onSelectScreen, onClose }: Props) {
  const { root } = graph;
  const expressions = new Map(
    graph.transitions.flatMap(({ id, target }): [string, string][] => (target.kind === 'unresolved' ? [[id, target.expression]] : [])),
  );
  let body: React.ReactNode;
  let title: string;
  let kicker: string;

  switch (selection.kind) {
    case 'screen': {
      const screen = index.screens.get(selection.id);
      if (screen === undefined) return null;
      const outgoing = index.outgoing.get(screen.id) ?? [];
      kicker = 'Screen';
      title = screen.route;
      body = (
        <>
          <p>
            <StatusBadge status={screen.status} />
            <span className="muted"> · {index.incomingCount.get(screen.id) ?? 0} incoming</span>
          </p>
          <h3>Defined in</h3>
          <Sources root={root} sources={screen.sources} />
          {screen.captures.length > 0 ? (
            <>
              <h3>Captured ({screen.captures.length})</h3>
              <Captures captures={screen.captures} />
            </>
          ) : null}
          <h3>Outgoing ({outgoing.length})</h3>
          {outgoing.length === 0 ? <p className="muted">No navigation found on this screen.</p> : null}
          <ul className="calls">
            {outgoing.map((transition) => {
              const { target } = transition;
              const resolved = target.kind === 'screen' ? index.screens.get(target.screenId) : undefined;
              return (
                <li key={transition.id} className="outgoing">
                  {resolved !== undefined ? (
                    <button type="button" className="linkish mono target" onClick={() => onSelectScreen(resolved.id)}>
                      → {resolved.route}
                    </button>
                  ) : null}
                  <ul>
                    <TransitionCall
                      transition={transition}
                      root={root}
                      expressions={expressions}
                    />
                  </ul>
                </li>
              );
            })}
          </ul>
        </>
      );
      break;
    }
    case 'link': {
      const link = links.get(selection.id);
      const source = link === undefined ? undefined : index.screens.get(link.source);
      const target = link === undefined ? undefined : index.screens.get(link.target);
      if (link === undefined || source === undefined || target === undefined) return null;
      kicker = `Navigation · ${link.transitions.length} call${link.transitions.length === 1 ? '' : 's'}`;
      title = `${source.route} → ${target.route}`;
      body = (
        <>
          <p>
            <button type="button" className="linkish mono" onClick={() => onSelectScreen(source.id)}>
              {source.route}
            </button>
            <span className="muted"> → </span>
            <button type="button" className="linkish mono" onClick={() => onSelectScreen(target.id)}>
              {target.route}
            </button>
          </p>
          <ul className="calls">
            {link.transitions.map((transition) => (
              <TransitionCall
                key={transition.id}
                transition={transition}
                root={root}
                expressions={expressions}
              />
            ))}
          </ul>
        </>
      );
      break;
    }
    case 'ghost': {
      const ghost = ghosts.get(selection.id);
      const source = ghost === undefined ? undefined : index.screens.get(ghost.sourceScreenId);
      if (ghost === undefined || source === undefined) return null;
      kicker = 'Unresolved navigation';
      title = `${ghost.transitions.length} from ${source.route}`;
      body = (
        <>
          <p className="muted">
            Static analysis could not tell where these calls lead. They are drawn dashed and are not part of the
            resolved graph.
          </p>
          <ul className="calls">
            {ghost.transitions.map((transition) => (
              <TransitionCall
                key={transition.id}
                transition={transition}
                root={root}
                expressions={expressions}
              />
            ))}
          </ul>
        </>
      );
      break;
    }
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }

  return (
    <aside className="panel" aria-label="Details">
      <header>
        <div>
          <div className="kicker">{kicker}</div>
          <h2 className="mono">{title}</h2>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <div className="panel-body">{body}</div>
    </aside>
  );
}
