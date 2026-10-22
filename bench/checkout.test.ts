import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitFixture } from '../src/testing/git-fixture.js';
import { checkout } from './checkout.js';

let source: string;
let cacheDir: string;
let commit: string;

beforeEach(() => {
  source = gitFixture();
  execFileSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: source });
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'nori-bench-')));
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('checkout', () => {
  it('fetches the commit into a directory named for the repo and short sha', async () => {
    const dir = await checkout({ cacheDir, repo: 'acme/site', commit, remote: source });
    expect(dir).toBe(join(cacheDir, `acme_site@${commit.slice(0, 12)}`));
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(commit);
  });

  it('reuses an existing checkout without fetching', async () => {
    const dir = await checkout({ cacheDir, repo: 'acme/site', commit, remote: source });
    const again = await checkout({ cacheDir, repo: 'acme/site', commit, remote: join(cacheDir, 'missing') });
    expect(again).toBe(dir);
  });

  it('throws when the directory is at another commit', async () => {
    const dir = await checkout({ cacheDir, repo: 'acme/site', commit, remote: source });
    execFileSync('git', ['-c', 'user.name=n', '-c', 'user.email=n@e.x', 'commit', '-q', '--allow-empty', '-m', 'x'], {
      cwd: dir,
    });
    await expect(checkout({ cacheDir, repo: 'acme/site', commit, remote: source })).rejects.toThrow(/expected/);
  });
});
