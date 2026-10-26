import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { errorCode } from '../errors.js';
import { sourceHash, type SourceFile } from '../graph/source-hash.js';

export type AnalysisInputs = {
  readonly top: string;
  readonly adapters: boolean;
  readonly paths: readonly string[];
};

const NODE_MODULES = `${sep}node_modules${sep}`;

const posix = (path: string) => path.split(sep).join('/');

function packageKey(path: string): string | null {
  const at = path.lastIndexOf(NODE_MODULES);
  return at === -1 ? null : posix(`node_modules${sep}${path.slice(at + NODE_MODULES.length)}`);
}

function repositoryKey(top: string, path: string): string | null {
  const key = relative(top, path);
  return key.startsWith(`..${sep}`) || isAbsolute(key) ? null : posix(key);
}

export function inputKey(top: string, path: string): string {
  return packageKey(path) ?? repositoryKey(top, path) ?? posix(path);
}

async function readInput(top: string, path: string): Promise<SourceFile> {
  const key = inputKey(top, path);
  try {
    return { path: key, content: await readFile(path) };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: `${key}\0missing`, content: new Uint8Array() };
    throw error;
  }
}

export async function inputsHash({ top, adapters, paths }: AnalysisInputs): Promise<string> {
  const files = await Promise.all(paths.map((path) => readInput(top, path)));
  return createHash('sha256')
    .update(JSON.stringify({ adapters, files: sourceHash({ files }) }))
    .digest('hex');
}
