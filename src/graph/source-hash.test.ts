import { describe, expect, it } from 'vitest';
import { sourceHash, type SourceFile } from './source-hash.js';

function file(path: string, content: string): SourceFile {
  return { path, content: Buffer.from(content) };
}

describe('sourceHash', () => {
  const a = file('app/a.tsx', 'a');
  const b = file('app/b.tsx', 'b');

  it('is independent of file order', () => {
    expect(sourceHash({ files: [a, b] })).toBe(sourceHash({ files: [b, a] }));
  });

  it('is a sha256 hex digest', () => {
    expect(sourceHash({ files: [a] })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with content, path, and the file set', () => {
    const base = sourceHash({ files: [a, b] });
    expect(sourceHash({ files: [a, file('app/b.tsx', 'changed')] })).not.toBe(base);
    expect(sourceHash({ files: [a, file('app/c.tsx', 'b')] })).not.toBe(base);
    expect(sourceHash({ files: [a] })).not.toBe(base);
  });

  it('does not let content bleed into the path', () => {
    expect(sourceHash({ files: [file('ab', 'c')] })).not.toBe(sourceHash({ files: [file('a', 'bc')] }));
  });
});
