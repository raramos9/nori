import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, NoriError } from '../errors.js';
import type { CommitSha } from '../graph/model.js';
import type { SourceFile } from '../graph/source-hash.js';
import { assertInsideWorkTree, listFiles, readHead } from '../repo/git.js';
import { APP_DIRS, type AppDir } from './routes.js';

export type NextProject = {
  readonly root: string;
  readonly appDir: AppDir;
  readonly commitSha: CommitSha;
  readonly branch: string | null;
  readonly files: readonly SourceFile[];
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    // Listed by git but gone from the working tree (deleted, or a submodule directory).
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

export async function resolveRoot(path: string): Promise<string> {
  try {
    const root = await realpath(path);
    if (await isDirectory(root)) return root;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  throw new NoriError(`${path} is not a directory`);
}

function hasDependency(manifest: unknown, name: string): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false;
  return ['dependencies', 'devDependencies'].some((section) => {
    const dependencies: unknown = Reflect.get(manifest, section);
    return typeof dependencies === 'object' && dependencies !== null && Object.hasOwn(dependencies, name);
  });
}

async function assertNextManifest({ root }: { root: string }): Promise<void> {
  const manifestPath = join(root, 'package.json');
  const text = await readFileIfPresent(manifestPath);
  if (text === null) throw new NoriError(`No package.json in ${root}. Run nori in a Next.js project.`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.toString('utf8'));
  } catch (error) {
    throw new NoriError(`${manifestPath} is not valid JSON`, { cause: error });
  }
  if (!hasDependency(manifest, 'next')) {
    throw new NoriError(`${manifestPath} does not list next in dependencies or devDependencies`);
  }
}

async function findAppDir({ root }: { root: string }): Promise<AppDir> {
  for (const appDir of APP_DIRS) {
    if (await isDirectory(join(root, appDir))) return appDir;
  }
  throw new NoriError(`No app directory in ${root} (looked for ${APP_DIRS.join(' and ')}).`);
}

export async function discoverProject({ path }: { path: string }): Promise<NextProject> {
  const root = await resolveRoot(path);
  await assertNextManifest({ root });
  const appDir = await findAppDir({ root });
  await assertInsideWorkTree({ root });
  const { commitSha, branch } = await readHead({ root });

  const files: SourceFile[] = [];
  for (const file of await listFiles({ root })) {
    const content = await readFileIfPresent(join(root, file));
    if (content !== null) files.push({ path: file, content });
  }
  return { root, appDir, commitSha, branch, files };
}
