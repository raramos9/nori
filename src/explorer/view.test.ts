import { describe, expect, it } from 'vitest';
import { evidenceId, runId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseArtifactPath,
  parseOrigin,
  parsePageUrl,
  parseRoutePattern,
  type CaptureEvidence,
  type NavigationEvidence,
  type Run,
  type BuildGraph,
  type StaticEvidence,
  type LoadedScreen,
  type LoadedTransition,
  type Transition,
} from '../graph/model.js';
import { TEST_APP, testAnalysis, testSnapshot } from '../testing/identity.js';
import { toExplorerGraph } from './view.js';

const rootPath = '/repo/web';
const appKey = TEST_APP.id;
const snapshot = testSnapshot();
const analysis = testAnalysis(snapshot, { analyzerVersion: '1' });
const { commitSha } = snapshot;
const build = { application: TEST_APP, snapshot, analysis };

function evidenceAt(file: string, line: number, extractor: string): StaticEvidence {
  const identity = {
    kind: 'static',
    analysisId: analysis.id,
    span: { file, start: { line, column: 3 }, end: { line, column: 30 } },
    extractor,
  } as const;
  return { ...identity, id: evidenceId(identity) };
}

function loadedScreen(route: string): LoadedScreen {
  const routePattern = parseRoutePattern(route);
  const id = screenId({ appKey, routePattern });
  const evidence = evidenceAt(`app${route === '/' ? '' : route}/page.tsx`, 1, 'next-page-file');
  return {
    screen: { id, appKey, routePattern },
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
      ...build,
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
      id: analysis.id,
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
      ...build,
      runs: [],
      screens: [home],
      transitions: [loadedTransition(home, { kind: 'resolved', stateId: about.states[0].id }, 4)],
    };
    expect(() => toExplorerGraph({ root: rootPath, graph })).toThrow(/target state .* is not a state/);
  });

  it('throws when a source state is not a state of the build', () => {
    const graph: BuildGraph = {
      ...build,
      runs: [],
      screens: [home],
      transitions: [loadedTransition(about, { kind: 'resolved', stateId: home.states[0].id }, 4)],
    };
    expect(() => toExplorerGraph({ root: rootPath, graph })).toThrow(/source state .* is not a state/);
  });

  describe('runtime evidence', () => {
    const origin = parseOrigin('http://localhost:3000');
    const session = { kind: 'storage-state', label: 'signed-in' } as const;
    const startedAt = new Date('2026-01-02T00:00:00.000Z');
    const run: Run = {
      id: runId({ snapshotId: snapshot.id, origin, session, startedAt }),
      snapshotId: snapshot.id,
      origin,
      session,
      environment: 'local',
      seededBy: analysis.analyzerVersion,
      startedAt,
      finishedAt: new Date('2026-01-02T00:01:00.000Z'),
      stop: 'frontier-exhausted',
      crawlerVersion: '1',
      requests: { allowed: 7, blocked: 1 },
    };

    function captureOf(path: string): CaptureEvidence {
      const identity = { kind: 'capture', runId: run.id, url: parsePageUrl(origin, path) } as const;
      return {
        ...identity,
        id: evidenceId(identity),
        httpStatus: 200,
        screenshot: parseArtifactPath(`/runs/${path.slice(1) || 'home'}.png`),
        dom: parseArtifactPath(`/runs/${path.slice(1) || 'home'}.html`),
      };
    }

    it('projects captures, walks, runs and the runtime-only siblings it may explain', () => {
      const homeCapture = captureOf('/');
      const aboutCapture = captureOf('/about');
      const requested = parsePageUrl(origin, '/about');
      const navIdentity = { kind: 'navigation', runId: run.id, start: { kind: 'entry' }, requested } as const;
      const navigation: NavigationEvidence = {
        ...navIdentity,
        id: evidenceId(navIdentity),
        redirects: [],
        landing: { evidenceId: aboutCapture.id, url: aboutCapture.url, httpStatus: 200, screenshot: aboutCapture.screenshot, dom: aboutCapture.dom },
        logSeq: 0,
      };
      const skipped = [{ url: parsePageUrl(origin, '/hop'), why: 'pass-through' }] as const;

      const observedHome: LoadedScreen = {
        ...home,
        observations: [
          ...home.observations,
          { evidence: homeCapture, match: { verdict: 'supports', rule: 'rendered', url: homeCapture.url, pattern: home.screen.routePattern } },
        ],
        status: 'observed',
      };
      const staticSibling = loadedTransition(home, { kind: 'unresolved', reason: 'dynamic-expression', expression: 'x' }, 7);
      const runtimeOnly: LoadedTransition = {
        ...loadedTransition(home, { kind: 'resolved', stateId: about.states[0].id }, 4),
        observations: [
          {
            evidence: navigation,
            match: {
              verdict: 'supports',
              rule: 'action-runtime-only',
              sourceUrl: homeCapture.url,
              sourcePattern: home.screen.routePattern,
              targetUrl: aboutCapture.url,
              targetPattern: about.screen.routePattern,
              skipped,
              triggerCandidates: ['link'],
            },
          },
        ],
        status: 'observed',
      };

      const view = toExplorerGraph({
        root: rootPath,
        graph: { ...build, runs: [run], screens: [observedHome, about], transitions: [staticSibling, runtimeOnly] },
      });

      expect(view.runs).toEqual([
        {
          id: run.id,
          session: 'signed-in',
          origin: 'http://localhost:3000',
          startedAt: '2026-01-02T00:00:00.000Z',
          finishedAt: '2026-01-02T00:01:00.000Z',
          stop: 'frontier-exhausted',
          requests: { allowed: 7, blocked: 1 },
        },
      ]);
      expect(view.screens[0]?.captures).toEqual([
        {
          evidenceId: homeCapture.id,
          runId: run.id,
          session: 'signed-in',
          url: homeCapture.url,
          httpStatus: 200,
          verdict: 'supports',
          screenshotPath: '/runs/home.png',
          domPath: '/runs/home.html',
        },
      ]);
      expect(view.screens[0]?.sources).toHaveLength(1);
      expect(view.screens[1]?.captures).toEqual([]);

      const [explained, walked] = view.transitions;
      expect(explained).toMatchObject({ runtimeOnly: false, walks: [], observedIn: [], mayExplain: [] });
      expect(walked).toMatchObject({
        runtimeOnly: true,
        observedIn: ['signed-in'],
        mayExplain: [staticSibling.transition.id],
        sources: [],
      });
      expect(walked?.walks).toEqual([
        {
          evidenceId: navigation.id,
          runId: run.id,
          session: 'signed-in',
          rule: 'action-runtime-only',
          hop: null,
          requested,
          redirects: [],
          skipped,
          landing: { evidenceId: aboutCapture.id, url: aboutCapture.url, screenshotPath: '/runs/about.png' },
        },
      ]);
    });
  });
});
