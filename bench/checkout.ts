import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SHORT_SHA = 12;

async function git({ cwd, args }: { cwd: string; args: readonly string[] }): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function checkout({
  cacheDir,
  repo,
  commit,
  remote = `https://github.com/${repo}.git`,
}: {
  cacheDir: string;
  repo: string;
  commit: string;
  remote?: string;
}): Promise<string> {
  const dir = join(cacheDir, `${repo.replace('/', '_')}@${commit.slice(0, SHORT_SHA)}`);
  if (await exists(dir)) {
    let head: string;
    try {
      head = await git({ cwd: dir, args: ['rev-parse', 'HEAD'] });
    } catch (error) {
      throw new Error(`${dir} exists but is not a git checkout; remove it and rerun`, { cause: error });
    }
    if (head !== commit) throw new Error(`${dir} is at ${head}, expected ${commit}; remove it and rerun`);
    return dir;
  }
  // Built aside and renamed in, so an interrupted fetch never leaves a half checkout at `dir`.
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  await git({ cwd: partial, args: ['init', '-q'] });
  await git({ cwd: partial, args: ['fetch', '-q', '--depth', '1', remote, commit] });
  await git({ cwd: partial, args: ['checkout', '-q', '--detach', 'FETCH_HEAD'] });
  await rename(partial, dir);
  return dir;
}
