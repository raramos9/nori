import { describe, expect, it } from 'vitest';
import { analysisId, appKey, evidenceId, runId, screenId, snapshotId, stateId, transitionId } from './ids.js';
import { parseAnalyzerVersion, parseCommitSha, parseOrigin, parsePageUrl, parseRoutePattern } from './model.js';

const app = appKey({ repoIdentity: 'remote:example.com/acme/web', subpath: '' });
const sha = parseCommitSha('a'.repeat(40));
const sourceHash = 'c'.repeat(64);
const version = parseAnalyzerVersion('1');
const span = { file: 'app/page.tsx', start: { line: 1, column: 0 }, end: { line: 1, column: 9 } };
const snapshot = snapshotId({ appKey: app, commitSha: sha, sourceHash });
const analysis = analysisId({ snapshotId: snapshot, analyzerVersion: version, inputsHash: 'i' });

describe('id derivation', () => {
  it('is stable for the same inputs', () => {
    const route = parseRoutePattern('/settings');
    expect(screenId({ appKey: app, routePattern: route })).toBe(screenId({ appKey: app, routePattern: route }));
  });

  it('differs for different route patterns and prefixes by type', () => {
    const a = screenId({ appKey: app, routePattern: parseRoutePattern('/a') });
    const b = screenId({ appKey: app, routePattern: parseRoutePattern('/b') });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scr_[0-9a-f]{16}$/);
  });

  it('keys snapshots on app, commit and source hash, never on the analyzer', () => {
    const base = { appKey: app, commitSha: sha, sourceHash };
    expect(snapshotId(base)).toMatch(/^snp_[0-9a-f]{16}$/);
    expect(snapshotId(base)).toBe(snapshotId({ ...base }));
    expect(snapshotId(base)).not.toBe(snapshotId({ ...base, sourceHash: 'd'.repeat(64) }));
    expect(snapshotId(base)).not.toBe(snapshotId({ ...base, commitSha: parseCommitSha('b'.repeat(40)) }));
    expect(snapshotId(base)).not.toBe(
      snapshotId({ ...base, appKey: appKey({ repoIdentity: 'remote:example.com/acme/web', subpath: 'apps/web' }) }),
    );
  });

  it('keys analyses on snapshot, analyzer version and inputs', () => {
    const base = { snapshotId: snapshot, analyzerVersion: version, inputsHash: 'i' };
    expect(analysisId(base)).toMatch(/^ana_[0-9a-f]{16}$/);
    expect(analysisId(base)).toBe(analysisId({ ...base }));
    expect(analysisId(base)).not.toBe(analysisId({ ...base, analyzerVersion: parseAnalyzerVersion('2') }));
    expect(analysisId(base)).not.toBe(analysisId({ ...base, inputsHash: 'j' }));
  });

  it('distinguishes transitions by trigger and target identity', () => {
    const scr = screenId({ appKey: app, routePattern: parseRoutePattern('/a') });
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

  it('keys static evidence on analysis, span and extractor', () => {
    const base = { kind: 'static', analysisId: analysis, span, extractor: 'link' } as const;
    expect(evidenceId(base)).toBe(evidenceId({ ...base }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, extractor: 'router' }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, span: { ...span, end: { line: 1, column: 10 } } }));
    const other = analysisId({ snapshotId: snapshot, analyzerVersion: parseAnalyzerVersion('2'), inputsHash: 'i' });
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, analysisId: other }));
  });

  it('keys runs on snapshot, origin, session and start time', () => {
    const base = {
      snapshotId: snapshot,
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
    const origin = parseOrigin('http://localhost:3000');
    const url = (path: string) => parsePageUrl(origin, path);
    const run = runId({ snapshotId: snapshot, origin, session: { kind: 'anonymous' }, startedAt: new Date(0) });
    const from = { evidenceId: evidenceId({ kind: 'capture', runId: run, url: url('/') }), url: url('/') };
    const follow = (name: string | null) =>
      ({
        kind: 'navigation',
        runId: run,
        requested: url('/home'),
        start: { kind: 'action', from, action: { kind: 'follow-link', href: url('/home'), name } },
      }) as const;
    expect(evidenceId(follow('Open app'))).toBe(evidenceId(follow(null)));
    expect(evidenceId(follow(null))).not.toBe(
      evidenceId({ kind: 'navigation', runId: run, requested: url('/home'), start: { kind: 'entry' } }),
    );
  });
});
