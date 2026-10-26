import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { errorCode, NoriError } from '../errors.js';
import { parseCommitSha, type CommitSha, type Worktree } from '../graph/model.js';

const execFileAsync = promisify(execFile);

export type GitHead = {
  readonly commitSha: CommitSha;
  readonly branch: string | null;
};

type GitResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly stderr: string };

// A remote URL in git's output can carry a token, as in https://x-access-token:T@github.com/o/r.
export function redactUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

async function runGit({ cwd, args }: { cwd: string; args: readonly string[] }): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
    return { kind: 'ok', stdout };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new NoriError('git was not found on PATH', { cause: error });
    if (typeof errorCode(error) === 'number') {
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
      return { kind: 'failed', stderr: redactUserinfo(stderr.trim()) };
    }
    throw error;
  }
}

async function runGitOrThrow({
  root,
  args,
  failure,
}: {
  root: string;
  args: readonly string[];
  failure: string;
}): Promise<string> {
  const result = await runGit({ cwd: root, args });
  switch (result.kind) {
    case 'ok':
      return result.stdout;
    case 'failed':
      throw new NoriError(result.stderr === '' ? failure : `${failure}: ${result.stderr}`);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export async function assertInsideWorkTree({ root }: { root: string }): Promise<void> {
  const result = await runGit({ cwd: root, args: ['rev-parse', '--is-inside-work-tree'] });
  if (result.kind === 'failed') throw new NoriError(`${root} is not inside a git repository`);
}

export async function showPrefix({ root }: { root: string }): Promise<string> {
  const stdout = await runGitOrThrow({
    root,
    args: ['rev-parse', '--show-prefix'],
    failure: 'git could not read the path prefix',
  });
  return stdout.trim().replace(/\/$/, '');
}

// Always absolute: git prints it relative to `root` for a main worktree.
export async function gitCommonDir({ root }: { root: string }): Promise<string | null> {
  const result = await runGit({ cwd: root, args: ['rev-parse', '--git-common-dir'] });
  return result.kind === 'ok' ? resolve(root, result.stdout.trim()) : null;
}

export async function originUrl({ root }: { root: string }): Promise<string | null> {
  const result = await runGit({ cwd: root, args: ['remote', 'get-url', 'origin'] });
  if (result.kind === 'failed') return null;
  const url = result.stdout.trim();
  return url === '' ? null : url;
}

export async function workTreeTop({ root }: { root: string }): Promise<string | null> {
  const result = await runGit({ cwd: root, args: ['rev-parse', '--show-toplevel'] });
  return result.kind === 'ok' ? result.stdout.trim() : null;
}

export async function worktreeState({ root }: { root: string }): Promise<Worktree> {
  const stdout = await runGitOrThrow({
    root,
    args: ['status', '--porcelain', '-z', '--', '.'],
    failure: 'git status failed',
  });
  return stdout === '' ? 'clean' : 'dirty';
}

// Paths come back relative to `root`, POSIX-separated. -z avoids git's quoting of unusual file names.
export async function listFiles({ root }: { root: string }): Promise<readonly string[]> {
  const stdout = await runGitOrThrow({
    root,
    args: ['ls-files', '-z', '-co', '--exclude-standard'],
    failure: 'git ls-files failed',
  });
  return [...new Set(stdout.split('\0').filter((file) => file !== ''))];
}

export async function readHead({ root }: { root: string }): Promise<GitHead> {
  const head = await runGit({ cwd: root, args: ['rev-parse', 'HEAD'] });
  if (head.kind === 'failed') {
    throw new NoriError(`The git repository at ${root} has no commits yet. Make a commit and run nori again.`);
  }
  const branch = (
    await runGitOrThrow({
      root,
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      failure: 'git could not read the current branch',
    })
  ).trim();
  return {
    commitSha: parseCommitSha(head.stdout.trim()),
    branch: branch === 'HEAD' ? null : branch,
  };
}
