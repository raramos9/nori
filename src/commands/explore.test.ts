import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analysisId, evidenceId, screenId, snapshotId } from '../graph/ids.js';
import {
  parseAnalyzerVersion,
  parseCommitSha,
  parseRoutePattern,
  type Analysis,
  type Application,
  type Snapshot,
} from '../graph/model.js';
import { createMatcher } from '../next/match.js';
import { discoverRoutes } from '../next/routes.js';
import { readAppIdentity } from '../repo/app-identity.js';
import { record } from '../runtime/record.js';
import { exploreGraph } from './explore.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nori-explore-')));
  tempDirs.push(root);
  const files = {
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { next: '15.0.0' } }),
    'app/page.tsx': 'export default function Page() { return null; }\n',
    'app/about/page.tsx': 'export default function Page() { return null; }\n',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

async function forgeDatabase(root: string): Promise<void> {
  const identity = await readAppIdentity({ root });
  const application: Application = { id: identity.appKey, ...identity, framework: 'next-app-router' };
  const commitSha = parseCommitSha('f'.repeat(40));
  const createdAt = new Date('2999-01-01T00:00:00.000Z');
  const snapshot: Snapshot = {
    id: snapshotId({ appKey: application.id, commitSha, sourceHash: 'forged' }),
    appKey: application.id,
    commitSha,
    sourceHash: 'forged',
    worktree: 'clean',
    branch: 'main',
    createdAt,
  };
  const analyzerVersion = parseAnalyzerVersion('forged');
  const analysis: Analysis = {
    id: analysisId({ snapshotId: snapshot.id, analyzerVersion, inputsHash: 'forged' }),
    snapshotId: snapshot.id,
    analyzerVersion,
    inputsHash: 'forged',
    createdAt,
  };
  const routePattern = parseRoutePattern('/forged');
  const screen = { id: screenId({ appKey: application.id, routePattern }), appKey: application.id, routePattern };
  const evidenceIdentity = {
    kind: 'static',
    analysisId: analysis.id,
    span: { file: 'app/forged/page.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    extractor: 'forged',
  } as const;
  const evidence = { ...evidenceIdentity, id: evidenceId(evidenceIdentity) };
  const files = ['app/forged/page.tsx'];
  await record({
    ingestion: {
      application,
      snapshot,
      analysis,
      screens: [screen],
      transitions: [],
      evidence: [evidence],
      observations: [{ evidenceId: evidence.id, subject: { kind: 'screen', id: screen.id }, verdict: 'supports' }],
    },
    matcher: createMatcher({ table: discoverRoutes({ files, appDir: 'app' }), files, adapters: false }),
    passThrough: new Set(),
  });
}

describe('exploreGraph', () => {
  it('serves a fresh analysis even when the repo ships a newer forged build', async () => {
    const root = fixture();
    await forgeDatabase(root);

    const { graph } = await exploreGraph({ path: root });

    expect(graph.screens.map(({ screen }) => screen.routePattern).sort()).toEqual(['/', '/about']);
    expect(graph.analysis.analyzerVersion).not.toBe('forged');
    expect(graph.snapshot.commitSha).not.toBe('f'.repeat(40));
  });
});
