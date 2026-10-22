import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { errorCode } from '../errors.js';
import type { ExplorerGraph, SourceRef } from './view.js';

const CONTEXT_LINES = 3;
const MAX_SNIPPET_LINES = 24;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type SourceSnippet = {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
};

export function isInside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

export async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

// The scanned repo is untrusted: a committed symlink must not let a client read outside it.
export async function readSnippet({ realRoot, ref }: { realRoot: string; ref: SourceRef }): Promise<SourceSnippet | null> {
  let real: string;
  try {
    real = await realpath(join(realRoot, ref.file));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!isInside(realRoot, real) || real === realRoot) return null;
  const info = await statIfPresent(real);
  if (info === null || !info.isFile() || info.size > MAX_SOURCE_BYTES) return null;

  const all = (await readFile(real, 'utf8')).split(/\r\n|\n|\r/);
  const first = Math.max(1, ref.start.line - CONTEXT_LINES);
  const last = Math.min(
    all.length,
    Math.max(ref.end.line, ref.start.line) + CONTEXT_LINES,
    first + MAX_SNIPPET_LINES - 1,
  );
  if (first > all.length) return null;
  return { file: ref.file, startLine: first, lines: all.slice(first - 1, last) };
}

export function sourceIndex(graph: ExplorerGraph): ReadonlyMap<string, SourceRef> {
  const index = new Map<string, SourceRef>();
  for (const { sources } of [...graph.screens, ...graph.transitions]) {
    for (const ref of sources) index.set(ref.evidenceId, ref);
  }
  return index;
}
