import { createHash } from 'node:crypto';

export type SourceFile = {
  readonly path: string;
  readonly content: Uint8Array;
};

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Hashing each file's content first keeps the outer JSON small and the (path, content) framing unambiguous.
export function sourceHash({ files }: { files: readonly SourceFile[] }): string {
  const entries = files
    .map(({ path, content }) => [path, createHash('sha256').update(content).digest('hex')] as const)
    .sort(([a], [b]) => compareCodeUnits(a, b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
