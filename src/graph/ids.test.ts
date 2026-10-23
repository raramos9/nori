import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, runId, screenId, stateId, transitionId } from './ids.js';
import { parseCommitSha, parseOrigin, parsePageUrl, parseRoutePattern } from './model.js';

const app = applicationId({ rootPath: '/repo/web' });
const sha = parseCommitSha('a'.repeat(40));
const sourceHash = 'c'.repeat(64);
const span = { file: 'app/page.tsx', start: { line: 1, column: 0 }, end: { line: 1, column: 9 } };

describe('id derivation', () => {
  it('is stable for the same inputs', () => {
    const route = parseRoutePattern('/settings');
    expect(screenId({ applicationId: app, routePattern: route })).toBe(
      screenId({ applicationId: app, routePattern: route }),
    );
    expect(applicationId({ rootPath: '/repo/web' })).toBe(app);
  });

  it('differs for different route patterns and prefixes by type', () => {
    const a = screenId({ applicationId: app, routePattern: parseRoutePattern('/a') });
    const b = screenId({ applicationId: app, routePattern: parseRoutePattern('/b') });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scr_[0-9a-f]{16}$/);
  });

  it('keys builds on commit, source hash and analyzer version', () => {
    const base = { applicationId: app, commitSha: sha, sourceHash, analyzerVersion: '1' };
    expect(buildId(base)).toBe(buildId({ ...base }));
    expect(buildId(base)).not.toBe(buildId({ ...base, sourceHash: 'd'.repeat(64) }));
    expect(buildId(base)).not.toBe(buildId({ ...base, analyzerVersion: '2' }));
    expect(buildId(base)).not.toBe(buildId({ ...base, commitSha: parseCommitSha('b'.repeat(40)) }));
  });

  it('distinguishes transitions by trigger and target identity', () => {
    const scr = screenId({ applicationId: app, routePattern: parseRoutePattern('/a') });
    const source = stateId({ screenId: scr, key: 'default' });
    const unresolved = (expression: string) =>
      ({ kind: 'unresolved', reason: 'dynamic-expression', expression }) as const;
    const link = { kind: 'link' } as const;
    const push = { kind: 'router-push' } as const;
    const base = transitionId({ sourceStateId: source, trigger: link, target: unresolved('x') });
    expect(base).toBe(transitionId({ sourceStateId: source, trigger: link, target: unresolved('x') }));
    expect(base).not.toBe(transitionId({ sourceStateId: source, trigger: push, target: unresolved('x') }));
    expect(base).not.toBe(transitionId({ sourceStateId: source, trigger: link, target: unresolved('y') }));
    expect(base).not.toBe(
      transitionId({ sourceStateId: source, trigger: link, target: { kind: 'resolved', stateId: source } }),
    );
  });

  it('keys evidence on build, span and extractor', () => {
    const build = buildId({ applicationId: app, commitSha: sha, sourceHash, analyzerVersion: '1' });
    const base = { kind: 'static', buildId: build, span, extractor: 'link' } as const;
    expect(evidenceId(base)).toBe(evidenceId({ ...base }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, extractor: 'router' }));
    expect(evidenceId(base)).not.toBe(
      evidenceId({ ...base, span: { ...span, end: { line: 1, column: 10 } } }),
    );
  });

  it('keys runs on build, origin, session and start time', () => {
    const build = buildId({ applicationId: app, commitSha: sha, sourceHash, analyzerVersion: '1' });
    const base = {
      buildId: build,
      origin: parseOrigin('http://localhost:3000'),
      session: { kind: 'anonymous' } as const,
      startedAt: new Date(0),
    };
    expect(runId(base)).toMatch(/^run_[0-9a-f]{16}$/);
    expect(runId(base)).toBe(runId({ ...base, startedAt: new Date(0) }));
    expect(runId(base)).not.toBe(runId({ ...base, startedAt: new Date(1) }));
    expect(runId(base)).not.toBe(runId({ ...base, origin: parseOrigin('http://localhost:3001') }));
    expect(runId(base)).not.toBe(runId({ ...base, session: { kind: 'storage-state', label: 'anonymous' } }));
  });

  it('keys navigations on where they started and what they requested, not on the link name', () => {
    const build = buildId({ applicationId: app, commitSha: sha, sourceHash, analyzerVersion: '1' });
    const origin = parseOrigin('http://localhost:3000');
    const url = (path: string) => parsePageUrl(origin, path);
    const run = runId({ buildId: build, origin, session: { kind: 'anonymous' }, startedAt: new Date(0) });
    const from = { evidenceId: evidenceId({ kind: 'capture', buildId: build, runId: run, url: url('/') }), url: url('/') };
    const follow = (name: string | null) =>
      ({
        kind: 'navigation',
        buildId: build,
        runId: run,
        requested: url('/home'),
        start: { kind: 'action', from, action: { kind: 'follow-link', href: url('/home'), name } },
      }) as const;
    expect(evidenceId(follow('Open app'))).toBe(evidenceId(follow(null)));
    expect(evidenceId(follow(null))).not.toBe(
      evidenceId({ kind: 'navigation', buildId: build, runId: run, requested: url('/home'), start: { kind: 'entry' } }),
    );
  });
});
