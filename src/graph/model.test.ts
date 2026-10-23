import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId } from './ids.js';
import {
  parseOrigin,
  parsePageUrl,
  deriveEvidenceStatus,
  parseCommitSha,
  parseRoutePattern,
  type EvidenceObservation,
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
  it('infers from static evidence, including when contradicted', () => {
    const app = applicationId({ rootPath: '/r' });
    const build = buildId({
      applicationId: app,
      commitSha: parseCommitSha('a'.repeat(40)),
      sourceHash: 'c'.repeat(64),
      analyzerVersion: '1',
    });
    const span = { file: 'a.tsx', start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
    const identity = { kind: 'static', buildId: build, span, extractor: 'x' } as const;
    const evidence = { ...identity, id: evidenceId(identity) };
    const supports: EvidenceObservation = { evidence, verdict: 'supports' };
    const contradicts: EvidenceObservation = { evidence, verdict: 'contradicts' };
    expect(deriveEvidenceStatus([supports])).toBe('inferred');
    expect(deriveEvidenceStatus([supports, contradicts])).toBe('inferred');
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
