import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { formatScan, scan } from './scan.js';

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

const TABLES = ['applications', 'builds', 'screens', 'ui_states', 'transitions', 'evidence', 'observations'] as const;

function countRows(root: string): Record<string, number> {
  const sqlite = new Database(join(root, '.nori', 'graph.db'), { readonly: true });
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
    const afterFirst = countRows(root);
    const second = await scan({ path: root });

    expect(countRows(root)).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      applications: 1,
      builds: 1,
      screens: 3,
      ui_states: 3,
      transitions: 0,
      evidence: 4,
      observations: 4,
    });
    expect(second).toEqual(first);
    expect(first.screens.map(({ screen }) => screen.routePattern).sort()).toEqual(EXPECTED_PATTERNS);
    expect(first.transitions).toEqual([]);
    expect(first.build.branch).toBe('main');
    expect(first.build.commitSha).toBe(git(root, 'rev-parse', 'HEAD').trim());
  });

  it('links each screen to the page files that define it', async () => {
    const root = nextFixture();
    const graph = await scan({ path: root });
    const filesOf = (pattern: string) =>
      graph.screens
        .find(({ screen }) => screen.routePattern === pattern)
        ?.observations.map(({ evidence }) => evidence.span.file)
        .sort();
    expect(filesOf('/about')).toEqual(['app/(marketing)/about/page.tsx', 'app/@modal/about/page.tsx']);
    expect(filesOf('/')).toEqual(['app/page.tsx']);
    for (const { observations, status } of graph.screens) {
      expect(status).toBe('inferred');
      for (const { evidence, verdict } of observations) {
        expect(evidence.kind).toBe('static');
        expect(verdict).toBe('supports');
      }
    }
  });

  it('keeps the database out of git status', async () => {
    const root = nextFixture();
    await scan({ path: root });
    expect(readFileSync(join(root, '.nori', '.gitignore'), 'utf8')).toBe('*\n');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('gives an uncommitted edit a new build with the same screen ids', async () => {
    const root = nextFixture();
    const before = await scan({ path: root });
    write(root, { 'app/page.tsx': `${PAGE}// edited\n` });
    const after = await scan({ path: root });

    expect(after.build.id).not.toBe(before.build.id);
    expect(after.build.commitSha).toBe(before.build.commitSha);
    expect(after.build.sourceHash).not.toBe(before.build.sourceHash);
    const ids = (graph: typeof before) => graph.screens.map(({ screen }) => screen.id).sort();
    expect(ids(after)).toEqual(ids(before));
    expect(countRows(root)).toMatchObject({ builds: 2, screens: 3, evidence: 8 });
  });

  it('gives an edit outside the app directory a new build', async () => {
    const root = nextFixture();
    write(root, { 'components/nav.tsx': 'export const Nav = () => null;\n' });
    const before = await scan({ path: root });
    write(root, { 'components/nav.tsx': 'export const Nav = () => null;\n// edited\n' });
    const after = await scan({ path: root });

    expect(after.build.id).not.toBe(before.build.id);
    expect(after.build.sourceHash).not.toBe(before.build.sourceHash);
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
    expect(existsSync(join(web, '.nori', 'graph.db'))).toBe(true);
  });

  it('reports a detached HEAD without a branch', async () => {
    const root = nextFixture();
    git(root, 'checkout', '-q', '--detach');
    const graph = await scan({ path: root });
    expect(graph.build.branch).toBeNull();
    expect(formatScan(graph).split('\n')[0]).toContain('detached HEAD');
  });
});

describe('scan state directory', () => {
  it('refuses a .nori symlink instead of writing through it', async () => {
    const root = nextFixture();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(root, '.nori'));

    await expect(scan({ path: root })).rejects.toThrow(NoriError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses symlinked files inside .nori', async () => {
    for (const name of ['.gitignore', 'graph.db', 'graph.db-journal', 'graph.db-wal']) {
      const root = nextFixture();
      const target = join(tempDir(), 'victim');
      writeFileSync(target, 'keep me');
      mkdirSync(join(root, '.nori'));
      symlinkSync(target, join(root, '.nori', name));

      await expect(scan({ path: root })).rejects.toThrow(NoriError);
      expect(readFileSync(target, 'utf8')).toBe('keep me');
    }
  });
});

describe('formatScan', () => {
  it('prints the build line, sorted patterns, and a count', async () => {
    const root = nextFixture();
    const graph = await scan({ path: root });
    const lines = formatScan(graph).split('\n');
    expect(lines[0]).toBe(
      `build ${graph.build.commitSha.slice(0, 7)} on main, sources ${graph.build.sourceHash.slice(0, 8)}`,
    );
    expect(lines.slice(1)).toEqual([...EXPECTED_PATTERNS, '3 screens']);
  });
});

describe('scan failures', () => {
  async function failure(root: string): Promise<unknown> {
    return scan({ path: root }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
  }

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
    expect(result.stdout.trim().split('\n').slice(1)).toEqual([...EXPECTED_PATTERNS, '3 screens']);
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
