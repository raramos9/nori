import { describe, expect, it } from 'vitest';
import { evidenceId, screenId } from '../graph/ids.js';
import { parseRoutePattern } from '../graph/model.js';
import { discoverRoutes } from '../next/routes.js';
import { TEST_APP as application, testAnalysis, testSnapshot } from '../testing/identity.js';
import { PAGE_FILE_EXTRACTOR, screensIngestion } from './screens.js';

const analysis = testAnalysis(testSnapshot());

function ingest(files: readonly string[]) {
  return screensIngestion({ application, analysis, table: discoverRoutes({ files, appDir: 'app' }) });
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

  it('points each evidence at the start of its page file', () => {
    const [evidence] = ingest(['app/page.tsx']).evidence;
    expect(evidence).toMatchObject({
      kind: 'static',
      analysisId: analysis.id,
      extractor: PAGE_FILE_EXTRACTOR,
      span: { file: 'app/page.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    });
  });

  it('derives every id through ids.ts', () => {
    const ingestion = ingest(['app/page.tsx', 'app/users/[id]/page.tsx']);
    for (const screen of ingestion.screens) {
      expect(screen.id).toBe(screenId({ appKey: application.id, routePattern: screen.routePattern }));
      expect(screen.appKey).toBe(application.id);
    }
    expect(ingestion.screens.map((s) => s.id)).toContain(
      screenId({ appKey: application.id, routePattern: parseRoutePattern('/users/[id]') }),
    );
    for (const evidence of ingestion.evidence) {
      const { id, ...identity } = evidence;
      expect(id).toBe(evidenceId(identity));
    }
  });
});
