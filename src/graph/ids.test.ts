import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, screenId, stateId, transitionId } from './ids.js';
import { parseCommitSha, parseRoutePattern } from './model.js';

const app = applicationId({ rootPath: '/repo/web' });
const sha = parseCommitSha('a'.repeat(40));
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

  it('keys builds on commit and analyzer version', () => {
    const base = { applicationId: app, commitSha: sha, analyzerVersion: '1' };
    expect(buildId(base)).toBe(buildId({ ...base }));
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
    const build = buildId({ applicationId: app, commitSha: sha, analyzerVersion: '1' });
    const base = { kind: 'static', buildId: build, span, extractor: 'link' } as const;
    expect(evidenceId(base)).toBe(evidenceId({ ...base }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, extractor: 'router' }));
    expect(evidenceId(base)).not.toBe(
      evidenceId({ ...base, span: { ...span, end: { line: 1, column: 10 } } }),
    );
  });
});
