import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId } from './ids.js';
import {
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
    const build = buildId({ applicationId: app, commitSha: parseCommitSha('a'.repeat(40)), analyzerVersion: '1' });
    const span = { file: 'a.tsx', start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
    const identity = { kind: 'static', buildId: build, span, extractor: 'x' } as const;
    const evidence = { ...identity, id: evidenceId(identity) };
    const supports: EvidenceObservation = { evidence, verdict: 'supports' };
    const contradicts: EvidenceObservation = { evidence, verdict: 'contradicts' };
    expect(deriveEvidenceStatus([supports])).toBe('inferred');
    expect(deriveEvidenceStatus([supports, contradicts])).toBe('inferred');
  });
});
