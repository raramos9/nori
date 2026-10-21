import { describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, screenId } from '../graph/ids.js';
import { parseCommitSha, parseRoutePattern, type Application, type Build } from '../graph/model.js';
import { discoverRoutes } from '../next/routes.js';
import { PAGE_FILE_EXTRACTOR, screensIngestion } from './screens.js';

const rootPath = '/repo/web';
const application: Application = {
  id: applicationId({ rootPath }),
  rootPath,
  framework: 'next-app-router',
};
const commitSha = parseCommitSha('a'.repeat(40));
const sourceHash = 'b'.repeat(64);
const build: Build = {
  id: buildId({ applicationId: application.id, commitSha, sourceHash, analyzerVersion: '1' }),
  applicationId: application.id,
  commitSha,
  sourceHash,
  branch: 'main',
  analyzerVersion: '1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function ingest(files: readonly string[]) {
  return screensIngestion({ application, build, table: discoverRoutes({ files, appDir: 'app' }) });
}

describe('screensIngestion', () => {
  it('gives two page files with one pattern a single screen and two evidence records', () => {
    const ingestion = ingest(['app/about/page.tsx', 'app/(marketing)/about/page.tsx', 'app/about/@modal/page.tsx']);
    expect(ingestion.screens).toHaveLength(1);
    expect(ingestion.evidence.map((e) => e.span.file).sort()).toEqual([
      'app/(marketing)/about/page.tsx',
      'app/about/@modal/page.tsx',
      'app/about/page.tsx',
    ]);
    const [screen] = ingestion.screens;
    for (const observation of ingestion.observations) {
      expect(observation.subject).toEqual({ kind: 'screen', id: screen?.id });
      expect(observation.verdict).toBe('supports');
    }
    expect(ingestion.observations).toHaveLength(3);
  });

  it('produces no screens or evidence from handlers', () => {
    const ingestion = ingest(['app/api/auth/signin/route.ts', 'app/page.tsx']);
    expect(ingestion.screens.map((s) => s.routePattern)).toEqual(['/']);
    expect(ingestion.evidence.map((e) => e.span.file)).toEqual(['app/page.tsx']);
  });

  it('produces no transitions', () => {
    expect(ingest(['app/a/page.tsx', 'app/b/page.tsx']).transitions).toEqual([]);
  });

  it('points each evidence at the start of its page file', () => {
    const [evidence] = ingest(['app/page.tsx']).evidence;
    expect(evidence).toMatchObject({
      kind: 'static',
      buildId: build.id,
      extractor: PAGE_FILE_EXTRACTOR,
      span: { file: 'app/page.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    });
  });

  it('derives every id through ids.ts', () => {
    const ingestion = ingest(['app/page.tsx', 'app/users/[id]/page.tsx']);
    for (const screen of ingestion.screens) {
      expect(screen.id).toBe(screenId({ applicationId: application.id, routePattern: screen.routePattern }));
      expect(screen.applicationId).toBe(application.id);
    }
    expect(ingestion.screens.map((s) => s.id)).toContain(
      screenId({ applicationId: application.id, routePattern: parseRoutePattern('/users/[id]') }),
    );
    for (const evidence of ingestion.evidence) {
      const { id, ...identity } = evidence;
      expect(id).toBe(evidenceId(identity));
    }
  });

  it('keeps the application and build it was given', () => {
    const ingestion = ingest(['app/page.tsx']);
    expect(ingestion.application).toBe(application);
    expect(ingestion.build).toBe(build);
  });
});
