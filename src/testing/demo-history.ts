import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const EXCLUDED = new Set(['node_modules', '.next']);

// Caller removes the returned directory.
export function demoHistory(name: string): { root: string; base: string; head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nori-history-')));
  cpSync(join(FIXTURES, 'demo'), root, { recursive: true, filter: (source) => !EXCLUDED.has(basename(source)) });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  cpSync(join(FIXTURES, 'diffs', name, 'files'), root, { recursive: true });
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return { root, base, head: git('rev-parse', 'HEAD') };
}
