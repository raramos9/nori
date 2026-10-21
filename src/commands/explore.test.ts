import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationId, buildId, evidenceId, screenId } from '../graph/ids.js';
import { parseCommitSha, parseRoutePattern, type Build, type StaticIngestion } from '../graph/model.js';
import { GraphStore } from '../store/graph-store.js';
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
  const application = { id: applicationId({ rootPath: root }), rootPath: root, framework: 'next-app-router' } as const;
  const commitSha = parseCommitSha('f'.repeat(40));
  const build: Build = {
    id: buildId({ applicationId: application.id, commitSha, sourceHash: 'forged', analyzerVersion: 'forged' }),
    applicationId: application.id,
    commitSha,
    sourceHash: 'forged',
    branch: 'main',
    analyzerVersion: 'forged',
    createdAt: new Date('2999-01-01T00:00:00.000Z'),
  };
  const routePattern = parseRoutePattern('/forged');
  const screen = { id: screenId({ applicationId: application.id, routePattern }), applicationId: application.id, routePattern };
  const identity = {
    kind: 'static',
    buildId: build.id,
    span: { file: 'app/forged/page.tsx', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    extractor: 'forged',
  } as const;
  const evidence = { ...identity, id: evidenceId(identity) };
  const ingestion: StaticIngestion = {
    application,
    build,
    screens: [screen],
    transitions: [],
    evidence: [evidence],
    observations: [{ evidenceId: evidence.id, subject: { kind: 'screen', id: screen.id }, verdict: 'supports' }],
  };
  mkdirSync(join(root, '.nori'), { recursive: true });
  const store = await GraphStore.open({ path: join(root, '.nori', 'graph.db') });
  try {
    await store.ingestStatic(ingestion);
  } finally {
    await store.close();
  }
}

describe('exploreGraph', () => {
  it('serves a fresh analysis even when the repo ships a newer forged build', async () => {
    const root = fixture();
    await forgeDatabase(root);

    const { graph } = await exploreGraph({ path: root });

    expect(graph.screens.map(({ screen }) => screen.routePattern).sort()).toEqual(['/', '/about']);
    expect(graph.build.analyzerVersion).not.toBe('forged');
    expect(graph.build.commitSha).not.toBe('f'.repeat(40));
  });
});
