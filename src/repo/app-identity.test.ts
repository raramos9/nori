import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appKey } from '../graph/ids.js';
import { normalizeRemote, readAppIdentity } from './app-identity.js';

describe('normalizeRemote', () => {
  const network = (hostPath: string) => ({ kind: 'network', hostPath });
  const cases: readonly (readonly [string, string, unknown])[] = [
    ['scp form', 'git@github.com:raramos9/nori.git', network('github.com/raramos9/nori')],
    ['https without .git', 'https://github.com/raramos9/nori', network('github.com/raramos9/nori')],
    [
      'ssh with port and trailing slash',
      'ssh://git@github.com:22/Raramos9/nori.git/',
      network('github.com/raramos9/nori'),
    ],
    [
      'https with token and mixed case',
      'https://x-access-token:T@GitHub.com/RARAMOS9/nori.git',
      network('github.com/raramos9/nori'),
    ],
    ['repeated slashes', 'https://github.com//a///b.git', network('github.com/a/b')],
    ['git+ssh scheme', 'git+ssh://git@host.io/a/b.git', network('host.io/a/b')],
    ['ssh+git scheme', 'ssh+git://git@host.io/a/b.git', network('host.io/a/b')],
    ['git scheme', 'git://host.io:9418/a/b.git', network('host.io/a/b')],
    ['query and fragment dropped', 'https://host.io/a/b.git?x=1#frag', network('host.io/a/b')],
    ['only one .git is stripped', 'https://host.io/a/b.git.git', network('host.io/a/b.git')],
    ['scp shorthand alias yields host "gh"', 'gh:owner/repo', network('gh/owner/repo')],
    ['file URL', 'file:///tmp/x', { kind: 'local', path: '/tmp/x' }],
    ['absolute path', '/abs/path', { kind: 'local', path: '/abs/path' }],
    ['relative path', '../rel', { kind: 'local', path: '../rel' }],
    ['unknown scheme', 'ftp://host.io/a/b', null],
    ['network URL without a path', 'https://host.io', null],
    ['empty', '', null],
  ];

  it.each(cases)('%s', (_name, raw, expected) => {
    expect(normalizeRemote(raw)).toEqual(expected);
  });

  it('treats a non-default ssh port and https as the same repository', () => {
    expect(normalizeRemote('ssh://git@gitlab.acme.io:2222/team/app.git')).toEqual(
      normalizeRemote('https://gitlab.acme.io/team/app'),
    );
  });
});

describe('appKey', () => {
  it('freezes the key for one fixed identity', () => {
    expect(appKey({ repoIdentity: 'remote:github.com/raramos9/nori', subpath: '' })).toBe(
      'app_29cbc1f090c9c7c7',
    );
  });

  it('separates repo identity and subpath', () => {
    expect(appKey({ repoIdentity: 'remote:a/b', subpath: 'c' })).not.toBe(
      appKey({ repoIdentity: 'remote:a/b/c', subpath: '' }),
    );
  });
});

describe('readAppIdentity', () => {
  let scratch: string;
  let fixture: string;
  let remoteless: string;

  function git(cwd: string, ...args: readonly string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8' },
    );
  }

  function initRepo(path: string): void {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'a.txt'), 'a');
    mkdirSync(join(path, 'apps', 'web'), { recursive: true });
    writeFileSync(join(path, 'apps', 'web', 'b.txt'), 'b');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'init');
  }

  const keyOf = async (root: string) => (await readAppIdentity({ root })).appKey;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nori-app-identity-')));
    fixture = join(scratch, 'fixture');
    initRepo(fixture);
    git(fixture, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
    remoteless = join(scratch, 'remoteless');
    initRepo(remoteless);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('derives a remote identity and an empty subpath at the top level', async () => {
    const identity = await readAppIdentity({ root: fixture });
    expect(identity.repoIdentity).toBe('remote:github.com/o/r');
    expect(identity.subpath).toBe('');
    expect(identity.appKey).toBe(appKey({ repoIdentity: 'remote:github.com/o/r', subpath: '' }));
  });

  it('gives a worktree, a shallow file:// clone and a full local clone the same key', async () => {
    const expected = await keyOf(fixture);
    const worktree = join(scratch, 'wt');
    git(fixture, 'worktree', 'add', '-q', '--detach', worktree);
    const shallow = join(scratch, 'shallow');
    git(scratch, 'clone', '-q', '--depth', '1', `file://${fixture}`, shallow);
    const full = join(scratch, 'full');
    git(scratch, 'clone', '-q', fixture, full);

    expect(await keyOf(worktree)).toBe(expected);
    expect(await keyOf(shallow)).toBe(expected);
    expect(await keyOf(full)).toBe(expected);
  });

  it('gives a monorepo subdirectory a different key from the top', async () => {
    const sub = await readAppIdentity({ root: join(fixture, 'apps', 'web') });
    expect(sub.subpath).toBe('apps/web');
    expect(sub.appKey).not.toBe(await keyOf(fixture));
  });

  it('gives a remoteless repo and its worktree the same key', async () => {
    const worktree = join(scratch, 'remoteless-wt');
    git(remoteless, 'worktree', 'add', '-q', '--detach', worktree);
    const identity = await readAppIdentity({ root: remoteless });
    expect(identity.repoIdentity).toBe(`local:${remoteless}`);
    expect(await keyOf(worktree)).toBe(identity.appKey);
  });

  it('gives two unrelated remoteless repos different keys', async () => {
    const other = join(scratch, 'other');
    initRepo(other);
    expect(await keyOf(other)).not.toBe(await keyOf(remoteless));
  });

  it('follows a clone of a remoteless repo one hop to its common dir', async () => {
    const clone = join(scratch, 'remoteless-clone');
    git(scratch, 'clone', '-q', remoteless, clone);
    expect(await keyOf(clone)).toBe(await keyOf(remoteless));
  });

  it('uses the resolved path when the local origin no longer exists', async () => {
    const orphan = join(scratch, 'orphan');
    initRepo(orphan);
    git(orphan, 'remote', 'add', 'origin', '../gone');
    const identity = await readAppIdentity({ root: orphan });
    expect(identity.repoIdentity).toBe(`local:${join(scratch, 'gone')}`);
  });
});
