import type { SourceFile } from '../graph/source-hash.js';

export const MEMORY_ROOT = '/nori-memory/app';

export function memoryFiles(files: Readonly<Record<string, string>>): readonly SourceFile[] {
  return Object.entries(files).map(([path, text]) => ({ path, content: Buffer.from(text) }));
}
