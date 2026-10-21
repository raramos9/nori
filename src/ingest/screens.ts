import { evidenceId, screenId } from '../graph/ids.js';
import type {
  Application,
  Build,
  Evidence,
  Observation,
  RoutePattern,
  Screen,
  StaticIngestion,
} from '../graph/model.js';
import type { RouteTable } from '../next/routes.js';

export const PAGE_FILE_EXTRACTOR = 'next-app-page-file';

const FILE_START = { line: 1, column: 1 } as const;

export function screensIngestion({
  application,
  build,
  table,
}: {
  application: Application;
  build: Build;
  table: RouteTable;
}): StaticIngestion {
  const screens = new Map<RoutePattern, Screen>();
  const evidence: Evidence[] = [];
  const observations: Observation[] = [];

  for (const route of table.routes) {
    if (route.kind !== 'page') continue;
    let screen = screens.get(route.pattern);
    if (screen === undefined) {
      screen = {
        id: screenId({ applicationId: application.id, routePattern: route.pattern }),
        applicationId: application.id,
        routePattern: route.pattern,
      };
      screens.set(route.pattern, screen);
    }
    const identity = {
      kind: 'static',
      buildId: build.id,
      span: { file: route.file, start: FILE_START, end: FILE_START },
      extractor: PAGE_FILE_EXTRACTOR,
    } as const;
    const pageEvidence: Evidence = { ...identity, id: evidenceId(identity) };
    evidence.push(pageEvidence);
    observations.push({
      evidenceId: pageEvidence.id,
      subject: { kind: 'screen', id: screen.id },
      verdict: 'supports',
    });
  }

  return { application, build, screens: [...screens.values()], transitions: [], evidence, observations };
}
