import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseCommitSha,
  parseRoutePattern,
  type Build,
  type BuildGraph,
  type StaticEvidence,
  type LoadedScreen,
  type LoadedTransition,
  type Transition,
} from '../graph/model.js';
import { toExplorerGraph } from './view.js';

const rootPath = '/repo/web';
const applicationIdValue = applicationId({ rootPath });
const commitSha = parseCommitSha('a'.repeat(40));
const build: Build = {
  id: buildId({ applicationId: applicationIdValue, commitSha, sourceHash: 'h', analyzerVersion: '1' }),
  applicationId: applicationIdValue,
  commitSha,
  sourceHash: 'h',
  branch: 'main',
  analyzerVersion: '1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function evidenceAt(file: string, line: number, extractor: string): StaticEvidence {
  const identity = {
    kind: 'static',
    buildId: build.id,
    span: { file, start: { line, column: 3 }, end: { line, column: 30 } },
    extractor,
  } as const;
  return { ...identity, id: evidenceId(identity) };
}

function loadedScreen(route: string): LoadedScreen {
  const routePattern = parseRoutePattern(route);
  const id = screenId({ applicationId: applicationIdValue, routePattern });
  const evidence = evidenceAt(`app${route === '/' ? '' : route}/page.tsx`, 1, 'next-page-file');
  return {
    screen: { id, applicationId: applicationIdValue, routePattern },
    states: [{ id: stateId({ screenId: id, key: DEFAULT_STATE_KEY }), screenId: id, key: DEFAULT_STATE_KEY }],
    observations: [{ evidence, verdict: 'supports' }],
    status: 'inferred',
  };
}

function loadedTransition(source: LoadedScreen, target: Transition['target'], line: number): LoadedTransition {
  const sourceStateId = source.states[0].id;
  const trigger = { kind: 'link' } as const;
  return {
    transition: { id: transitionId({ sourceStateId, trigger, target }), sourceStateId, trigger, target },
    observations: [{ evidence: evidenceAt('app/page.tsx', line, 'next-nav-ts'), verdict: 'supports' }],
    status: 'inferred',
  };
}

describe('toExplorerGraph', () => {
  const home = loadedScreen('/');
  const about = loadedScreen('/about');

  it('maps state ids to screen ids and keeps unresolved targets as they are', () => {
    const graph: BuildGraph = {
      build,
      runs: [],
      screens: [home, about],
      transitions: [
        loadedTransition(home, { kind: 'resolved', stateId: about.states[0].id }, 4),
        loadedTransition(about, { kind: 'unresolved', reason: 'dynamic-expression', expression: '`/${x}`' }, 9),
      ],
    };

    const view = toExplorerGraph({ root: rootPath, graph });

    expect(view.root).toBe(rootPath);
    expect(view.build).toEqual({
      id: build.id,
      commitSha,
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      analyzerVersion: '1',
    });
    expect(view.screens.map((s) => [s.route, s.status])).toEqual([
      ['/', 'inferred'],
      ['/about', 'inferred'],
    ]);
    expect(view.screens[0]?.sources[0]).toMatchObject({
      file: 'app/page.tsx',
      start: { line: 1, column: 3 },
      extractor: 'next-page-file',
    });
    expect(view.transitions.map((t) => [t.sourceScreenId, t.trigger, t.target])).toEqual([
      [home.screen.id, 'link', { kind: 'screen', screenId: about.screen.id }],
      [about.screen.id, 'link', { kind: 'unresolved', reason: 'dynamic-expression', expression: '`/${x}`' }],
    ]);
    expect(view.transitions[0]?.sources[0]?.extractor).toBe('next-nav-ts');
  });

  it('throws when a resolved target is not a state of the build', () => {
    const graph: BuildGraph = {
      build,
      runs: [],
      screens: [home],
      transitions: [loadedTransition(home, { kind: 'resolved', stateId: about.states[0].id }, 4)],
    };
    expect(() => toExplorerGraph({ root: rootPath, graph })).toThrow(/target state .* is not a state/);
  });

  it('throws when a source state is not a state of the build', () => {
    const graph: BuildGraph = {
      build,
      runs: [],
      screens: [home],
      transitions: [loadedTransition(about, { kind: 'resolved', stateId: home.states[0].id }, 4)],
    };
    expect(() => toExplorerGraph({ root: rootPath, graph })).toThrow(/source state .* is not a state/);
  });
});
