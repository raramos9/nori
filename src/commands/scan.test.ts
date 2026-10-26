import Database from 'better-sqlite3';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { parseAnalyzerVersion, verdictOf, type AppKey } from '../graph/model.js';
import { stateDatabasePath } from '../runtime/layout.js';
import { inputsHash } from '../next/inputs.js';
import { record } from '../runtime/record.js';
import { openReadDatabase } from '../store/database.js';
import { listBuilds, loadBuild } from '../store/reads.js';
import { analyze, formatScan, scan } from './scan.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nori-scan-')));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
}

const NEXT_MANIFEST = JSON.stringify({ name: 'fixture', dependencies: { next: '15.0.0' } });
const PAGE = 'export default function Page() { return null; }\n';

function nextFixture(): string {
  const root = tempDir();
  write(root, {
    'package.json': NEXT_MANIFEST,
    'app/layout.tsx': PAGE,
    'app/page.tsx': PAGE,
    'app/(marketing)/about/page.tsx': PAGE,
    'app/@modal/about/page.tsx': PAGE,
    'app/users/[id]/page.tsx': PAGE,
    'app/_components/page.tsx': PAGE,
    'app/api/auth/signin/route.ts': 'export function GET() {}\n',
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

const TABLES = [
  'applications',
  'snapshots',
  'analyses',
  'screens',
  'ui_states',
  'transitions',
  'static_evidence',
  'static_observations',
] as const;

function countRows(appKey: AppKey): Record<string, number> {
  const sqlite = new Database(stateDatabasePath(appKey), { readonly: true });
  try {
    return Object.fromEntries(
      TABLES.map((table) => {
        const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        if (typeof row !== 'object' || row === null || !('n' in row) || typeof row.n !== 'number') {
          throw new Error(`unexpected count result for ${table}`);
        }
        return [table, row.n];
      }),
    );
  } finally {
    sqlite.close();
  }
}

const EXPECTED_PATTERNS = ['/', '/about', '/users/[id]'];

describe('scan', () => {
  it('stores the screens of an App Router project and is idempotent', async () => {
    const root = nextFixture();

    const first = await scan({ path: root });
    const afterFirst = countRows(first.application.id);
    const second = await scan({ path: root });

    expect(countRows(first.application.id)).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      applications: 1,
      snapshots: 1,
      analyses: 1,
      screens: 3,
      ui_states: 3,
      transitions: 0,
      static_evidence: 4,
      static_observations: 4,
    });
    expect(second).toEqual(first);
    expect(first.screens.map(({ screen }) => screen.routePattern).sort()).toEqual(EXPECTED_PATTERNS);
    expect(first.transitions).toEqual([]);
    expect(first.snapshot.branch).toBe('main');
    expect(first.snapshot.worktree).toBe('clean');
    expect(first.snapshot.commitSha).toBe(git(root, 'rev-parse', 'HEAD').trim());
  });

  it('links each screen to the page files that define it', async () => {
    const root = nextFixture();
    const graph = await scan({ path: root });
    const filesOf = (pattern: string) =>
      graph.screens
        .find(({ screen }) => screen.routePattern === pattern)
        ?.observations.flatMap(({ evidence }) => (evidence.kind === 'static' ? [evidence.span.file] : []))
        .sort();
    expect(filesOf('/about')).toEqual(['app/(marketing)/about/page.tsx', 'app/@modal/about/page.tsx']);
    expect(filesOf('/')).toEqual(['app/page.tsx']);
    for (const { observations, status } of graph.screens) {
      expect(status).toBe('inferred');
      for (const observation of observations) {
        expect(observation.evidence.kind).toBe('static');
        expect(verdictOf(observation)).toBe('supports');
      }
    }
  });

  it('keeps its database under NORI_HOME and leaves the repo untouched', async () => {
    const root = nextFixture();
    const graph = await scan({ path: root });
    expect(existsSync(join(root, '.nori'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(process.env.NORI_HOME!, 'stores', graph.application.id, 'graph.db'))).toBe(true);
  });

  it('neither reads nor touches a database committed in the repo', async () => {
    const root = nextFixture();
    const committed = join(root, '.nori', 'graph.db');
    mkdirSync(dirname(committed));
    writeFileSync(committed, 'not a database');
    const graph = await scan({ path: root });
    expect(graph.screens.length).toBeGreaterThan(0);
    expect(readFileSync(committed, 'utf8')).toBe('not a database');
  });

  it('gives an uncommitted edit a new dirty snapshot with the same screen ids', async () => {
    const root = nextFixture();
    const before = await scan({ path: root });
    write(root, { 'app/page.tsx': `${PAGE}// edited\n` });
    const after = await scan({ path: root });

    expect(after.snapshot.id).not.toBe(before.snapshot.id);
    expect(after.snapshot.commitSha).toBe(before.snapshot.commitSha);
    expect(after.snapshot.sourceHash).not.toBe(before.snapshot.sourceHash);
    expect([before.snapshot.worktree, after.snapshot.worktree]).toEqual(['clean', 'dirty']);
    const ids = (graph: typeof before) => graph.screens.map(({ screen }) => screen.id).sort();
    expect(ids(after)).toEqual(ids(before));
    expect(countRows(after.application.id)).toMatchObject({ snapshots: 2, analyses: 2, screens: 3, static_evidence: 8 });
  });

  it('gives an edit outside the app directory a new build', async () => {
    const root = nextFixture();
    write(root, { 'components/nav.tsx': 'export const Nav = () => null;\n' });
    const before = await scan({ path: root });
    write(root, { 'components/nav.tsx': 'export const Nav = () => null;\n// edited\n' });
    const after = await scan({ path: root });

    expect(after.snapshot.id).not.toBe(before.snapshot.id);
    expect(after.snapshot.sourceHash).not.toBe(before.snapshot.sourceHash);
  });

  it('picks up a new untracked page and ignores gitignored ones', async () => {
    const root = nextFixture();
    write(root, { '.gitignore': 'app/ignored/\n', 'app/new/page.tsx': PAGE, 'app/ignored/page.tsx': PAGE });
    const graph = await scan({ path: root });
    expect(graph.screens.map(({ screen }) => screen.routePattern).sort()).toEqual([
      '/',
      '/about',
      '/new',
      '/users/[id]',
    ]);
  });

  it('ignores a tracked page deleted from the working tree', async () => {
    const root = nextFixture();
    rmSync(join(root, 'app/users'), { recursive: true });
    const graph = await scan({ path: root });
    expect(graph.screens.map(({ screen }) => screen.routePattern).sort()).toEqual(['/', '/about']);
  });

  it('scans src/app and a subdirectory of a larger repository', async () => {
    const repo = tempDir();
    const web = join(repo, 'apps', 'web');
    write(web, { 'package.json': JSON.stringify({ devDependencies: { next: '15.0.0' } }), 'src/app/page.tsx': PAGE });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const graph = await scan({ path: web });
    expect(graph.screens.map(({ screen }) => screen.routePattern)).toEqual(['/']);
    expect(graph.application.subpath).toBe('apps/web');
    expect(existsSync(stateDatabasePath(graph.application.id))).toBe(true);
  });

  it('accepts next declared in a workspace root manifest', async () => {
    const repo = tempDir();
    write(repo, { 'package.json': JSON.stringify({ private: true, dependencies: { next: '16.0.0' } }) });
    const web = join(repo, 'apps', 'web');
    write(web, { 'package.json': JSON.stringify({ name: 'web' }), 'app/page.tsx': PAGE });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const graph = await scan({ path: web });
    expect(graph.screens.map(({ screen }) => screen.routePattern)).toEqual(['/']);
  });

  it('reports a detached HEAD without a branch', async () => {
    const root = nextFixture();
    git(root, 'checkout', '-q', '--detach');
    const graph = await scan({ path: root });
    expect(graph.snapshot.branch).toBeNull();
    expect(formatScan(graph).split('\n')[1]).toContain('detached HEAD');
  });
});

describe('scan navigation', () => {
  function linkedFixture(): string {
    const root = nextFixture();
    write(root, {
      'components/nav.tsx': "import Link from 'next/link';\nexport const Nav = () => <Link href='/about' />;\n",
      'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
      'app/users/[id]/page.tsx': "declare function go(): string;\nexport default () => <a href={go()} />;\n",
    });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'links');
    return root;
  }

  it('stores transitions with call-site evidence and is idempotent', async () => {
    const root = linkedFixture();
    const first = await scan({ path: root });
    const afterFirst = countRows(first.application.id);
    const second = await scan({ path: root });

    expect(countRows(first.application.id)).toEqual(afterFirst);
    expect(second).toEqual(first);
    expect(afterFirst).toMatchObject({ transitions: 4, static_evidence: 6, static_observations: 8 });
    expect(formatScan(first).split('\n').at(-1)).toBe('4 transitions (3 resolved, 1 unresolved)');
    const spans = first.transitions.flatMap(({ observations }) => observations.flatMap(({ evidence }) => (evidence.kind === 'static' ? [evidence.span] : [])));
    expect(spans).toContainEqual({
      file: 'components/nav.tsx',
      start: { line: 2, column: 32 },
      end: { line: 2, column: 45 },
    });
    expect(spans).toContainEqual({
      file: 'app/users/[id]/page.tsx',
      start: { line: 2, column: 25 },
      end: { line: 2, column: 36 },
    });
  });
});

describe('one store across checkouts', () => {
  const execFileAsync = promisify(execFile);

  function worktreePair(): { base: string; head: string } {
    const base = nextFixture();
    const head = join(tempDir(), 'head');
    git(base, 'worktree', 'add', '-q', '-b', 'head', head);
    write(head, { 'app/changelog/page.tsx': PAGE });
    git(head, 'add', '-A');
    git(head, 'commit', '-q', '-m', 'add changelog');
    return { base, head };
  }

  async function builds(appKey: AppKey) {
    const db = await openReadDatabase({ path: stateDatabasePath(appKey) });
    try {
      return await listBuilds(db);
    } finally {
      await db.destroy();
    }
  }

  it('scans two git worktree paths of one repo into one store with two snapshots', async () => {
    const { base, head } = worktreePair();
    const baseGraph = await scan({ path: base });
    const headGraph = await scan({ path: head });

    expect(headGraph.application).toEqual(baseGraph.application);
    const stored = await builds(baseGraph.application.id);
    expect(stored.map(({ snapshot }) => snapshot.commitSha).sort()).toEqual(
      [git(base, 'rev-parse', 'HEAD').trim(), git(head, 'rev-parse', 'HEAD').trim()].sort(),
    );
    const db = await openReadDatabase({ path: stateDatabasePath(baseGraph.application.id) });
    try {
      expect(await loadBuild(db, baseGraph.analysis.id)).toEqual(baseGraph);
      expect(await loadBuild(db, headGraph.analysis.id)).toEqual(headGraph);
    } finally {
      await db.destroy();
    }
    const routes = (graph: typeof baseGraph) => graph.screens.map(({ screen }) => screen.routePattern).sort();
    expect(routes(baseGraph)).toEqual(EXPECTED_PATTERNS);
    expect(routes(headGraph)).toEqual([...EXPECTED_PATTERNS, '/changelog'].sort());
    expect(headGraph.screens.find(({ screen }) => screen.routePattern === '/')?.screen.id).toBe(
      baseGraph.screens.find(({ screen }) => screen.routePattern === '/')?.screen.id,
    );
  });

  it('scans both worktrees from four processes at once into the same two snapshots', async () => {
    const { base, head } = worktreePair();
    const cli = (path: string) =>
      execFileAsync(process.execPath, ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), 'scan', path], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    const outputs = await Promise.all([cli(base), cli(head), cli(base), cli(head)]);
    const keys = new Set(outputs.map(({ stdout }) => stdout.split('\n')[0]));
    expect(keys.size).toBe(1);
    const appKey = (await scan({ path: base })).application.id;
    const stored = await builds(appKey);
    expect(stored).toHaveLength(2);
    expect(stored.map(({ analyses }) => analyses.length)).toEqual([1, 1]);
  }, 60_000);

  it('gives an edit to a file read outside the project a new analysis of the same snapshot', async () => {
    const repo = tempDir();
    const web = join(repo, 'apps', 'web');
    write(repo, { 'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true } }) });
    write(web, {
      'package.json': NEXT_MANIFEST,
      'tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
      'app/page.tsx': PAGE,
    });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const before = await analyze({ path: web, createdAt: new Date() });
    expect(before.inputs.paths).toContain(join(repo, 'tsconfig.base.json'));

    write(repo, { 'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: false } }) });
    expect(await inputsHash(before.inputs)).not.toBe(before.ingestion.analysis.inputsHash);
    const after = await analyze({ path: web, createdAt: new Date() });
    expect(after.ingestion.snapshot.id).toBe(before.ingestion.snapshot.id);
    expect(after.ingestion.analysis.id).not.toBe(before.ingestion.analysis.id);
  });

  it('keeps the analyses of two analyzer versions apart in one snapshot', async () => {
    const root = nextFixture();
    const old = await record(
      await analyze({ path: root, createdAt: new Date(), analyzerVersion: parseAnalyzerVersion('0.0.1+old') }),
    );
    const current = await record(await analyze({ path: root, createdAt: new Date() }));

    expect(current.graph.snapshot.id).toBe(old.graph.snapshot.id);
    expect(current.graph.analysis.id).not.toBe(old.graph.analysis.id);
    for (const { observations } of current.graph.screens) {
      for (const { evidence } of observations) expect(evidence).toMatchObject({ analysisId: current.graph.analysis.id });
    }
    expect(countRows(current.graph.application.id)).toMatchObject({ snapshots: 1, analyses: 2, static_evidence: 8 });
  });
});

describe('formatScan', () => {
  it('prints the app key source, the build line, sorted patterns, and a count', async () => {
    const root = nextFixture();
    const graph = await scan({ path: root });
    const lines = formatScan(graph).split('\n');
    expect(lines[0]).toBe(`app local:${root} (${graph.application.id})`);
    expect(lines[1]).toBe(
      `build ${graph.snapshot.commitSha.slice(0, 7)} on main, sources ${graph.snapshot.sourceHash.slice(0, 8)}`,
    );
    expect(lines.slice(2)).toEqual([...EXPECTED_PATTERNS, '3 screens', '0 transitions (0 resolved, 0 unresolved)']);
  });

  it('names the remote and the subpath when the key comes from them', async () => {
    const repo = tempDir();
    const web = join(repo, 'apps', 'web');
    write(web, { 'package.json': NEXT_MANIFEST, 'app/page.tsx': PAGE });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'https://x-access-token:secret@github.com/Acme/Web.git');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const graph = await scan({ path: web });
    expect(formatScan(graph).split('\n')[0]).toBe(`app remote:github.com/acme/web at apps/web (${graph.application.id})`);
  });
});

describe('scan failures', () => {
  async function failure(root: string): Promise<unknown> {
    return scan({ path: root }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
  }

  it('does not look for next above the repository root', async () => {
    const outer = tempDir();
    write(outer, { 'package.json': NEXT_MANIFEST });
    const repo = join(outer, 'repo');
    write(repo, { 'package.json': JSON.stringify({ name: 'web' }), 'app/page.tsx': PAGE });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const error = await failure(repo);
    expect(error).toHaveProperty('message', expect.stringMatching(/does not list next/));
  });

  it('names each missing prerequisite', async () => {
    const missingManifest = tempDir();
    const noNext = tempDir();
    write(noNext, { 'package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }), 'app/page.tsx': PAGE });
    const noAppDir = tempDir();
    write(noAppDir, { 'package.json': NEXT_MANIFEST });
    const notGit = tempDir();
    write(notGit, { 'package.json': NEXT_MANIFEST, 'app/page.tsx': PAGE });
    const noCommits = tempDir();
    write(noCommits, { 'package.json': NEXT_MANIFEST, 'app/page.tsx': PAGE });
    git(noCommits, 'init', '-q', '-b', 'main');

    const cases: readonly [string, RegExp][] = [
      [missingManifest, /No package\.json/],
      [noNext, /does not list next/],
      [noAppDir, /No app directory/],
      [notGit, /not inside a git repository/],
      [noCommits, /no commits yet/],
      [join(missingManifest, 'missing'), /is not a directory/],
    ];
    for (const [root, message] of cases) {
      const error = await failure(root);
      expect(error).toBeInstanceOf(NoriError);
      expect(error).toHaveProperty('message', expect.stringMatching(message));
    }
  });
});

describe('nori scan CLI', () => {
  function runCli(...args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  }

  it('prints the patterns and exits 0', () => {
    const root = nextFixture();
    const result = runCli('scan', root);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')[0]).toMatch(/^app local:.* \(app_[0-9a-f]{16}\)$/);
    expect(result.stdout.trim().split('\n').slice(2)).toEqual([
      ...EXPECTED_PATTERNS,
      '3 screens',
      '0 transitions (0 resolved, 0 unresolved)',
    ]);
    expect(result.stderr).toBe('');
  });

  it('exits 1 with the message and no stack trace when next is not a dependency', () => {
    const root = tempDir();
    write(root, { 'package.json': JSON.stringify({ dependencies: {} }), 'app/page.tsx': PAGE });
    const result = runCli('scan', root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not list next/);
    expect(result.stderr).not.toMatch(/\bat .*\.ts/);
    expect(result.stdout).toBe('');
  });

  it('lists scan in --help and reports the version', () => {
    expect(runCli('--help').stdout).toMatch(/^ {2}scan {2}/m);
    expect(runCli('--version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects an unknown command with exit 2', () => {
    const result = runCli('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown command/);
  });
});
