import { describe, expect, it } from 'vitest';
import { evidenceId, runId } from './ids.js';
import { testAnalysis, testSnapshot } from '../testing/identity.js';
import {
  parseOrigin,
  parsePageUrl,
  deriveEvidenceStatus,
  parseCommitSha,
  parseRoutePattern,
  parseArtifactPath,
  type ScreenObservation,
} from './model.js';

describe('brand parsers', () => {
  it('accepts normalized route patterns', () => {
    for (const ok of ['/', '/settings', '/[workspaceSlug]/settings', '/docs/[...slug]']) {
      expect(parseRoutePattern(ok)).toBe(ok);
    }
  });

  it('rejects groups, slots, and malformed paths', () => {
    for (const bad of ['', 'settings', '/(app)/settings', '/@modal/photo', '/a/', '//a']) {
      expect(() => parseRoutePattern(bad)).toThrow(/RoutePattern/);
    }
  });

  it('rejects non-sha commits', () => {
    expect(() => parseCommitSha('main')).toThrow(/CommitSha/);
  });
});

describe('deriveEvidenceStatus', () => {
  const snapshot = testSnapshot();
  const analysis = testAnalysis(snapshot);
  const span = { file: 'a.tsx', start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
  const staticIdentity = { kind: 'static', analysisId: analysis.id, span, extractor: 'x' } as const;
  const staticEvidence = { ...staticIdentity, id: evidenceId(staticIdentity) };
  const origin = parseOrigin('http://localhost:3000');
  const url = parsePageUrl(origin, '/settings');
  const run = runId({ snapshotId: snapshot.id, origin, session: { kind: 'anonymous' }, startedAt: new Date(0) });
  const captureIdentity = { kind: 'capture', runId: run, url } as const;
  const capture = (httpStatus: number) => ({
    ...captureIdentity,
    id: evidenceId(captureIdentity),
    httpStatus,
    screenshot: parseArtifactPath('/home/runs/r/captures/a.png'),
    dom: parseArtifactPath('/home/runs/r/captures/a.html'),
  });
  const pattern = parseRoutePattern('/settings');

  const staticSupports: ScreenObservation = { evidence: staticEvidence, verdict: 'supports' };
  const staticContradicts: ScreenObservation = { evidence: staticEvidence, verdict: 'contradicts' };
  const rendered: ScreenObservation = {
    evidence: capture(200),
    match: { verdict: 'supports', rule: 'rendered', url, pattern },
  };
  const serverError: ScreenObservation = {
    evidence: capture(500),
    match: { verdict: 'contradicts', rule: 'server-error', url, pattern, httpStatus: 500 },
  };

  it.each([
    ['static only', [staticSupports], 'inferred'],
    ['static, including a contradiction', [staticSupports, staticContradicts], 'inferred'],
    ['runtime supports', [staticSupports, rendered], 'observed'],
    ['runtime supports with no static evidence', [rendered], 'observed'],
    ['a 5xx capture contradicts', [staticSupports, serverError], 'failed'],
    ['a 5xx capture beside a rendered one', [rendered, serverError, staticSupports], 'failed'],
  ] as const)('%s', (_, observations, expected) => {
    expect(deriveEvidenceStatus(observations)).toBe(expected);
  });
});

describe('runtime URL parsers', () => {
  it('keeps only the origin of an http(s) URL', () => {
    expect(parseOrigin('http://localhost:3000/dashboard?x=1')).toBe('http://localhost:3000');
    expect(() => parseOrigin('file:///etc/passwd')).toThrow();
    expect(() => parseOrigin('not a url')).toThrow();
  });

  it('resolves page URLs against the origin, cuts the fragment, and refuses other origins', () => {
    const origin = parseOrigin('http://localhost:3000');
    expect(parsePageUrl(origin, '/docs/a?b=1#top')).toBe('http://localhost:3000/docs/a?b=1');
    expect(() => parsePageUrl(origin, 'https://example.com/')).toThrow();
    expect(() => parsePageUrl(origin, 'http://localhost:3001/')).toThrow();
  });
});
