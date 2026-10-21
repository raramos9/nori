import ts from 'typescript6';
import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createProgram, isProgramFile } from './program.js';

function program(files: Readonly<Record<string, string>>) {
  return createProgram({ root: MEMORY_ROOT, files: memoryFiles(files) });
}

function importedFrom(p: ts.Program, file: string, name: string): string | undefined {
  const sourceFile = p.getSourceFile(`${MEMORY_ROOT}/${file}`);
  if (sourceFile === undefined) throw new Error(`${file} is not in the program`);
  const checker = p.getTypeChecker();
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.name.text === name) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) found = checker.getAliasedSymbol(symbol).declarations?.[0]?.getSourceFile().fileName;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('isProgramFile', () => {
  it('keeps code and drops declarations, tests, stories and e2e files', () => {
    expect(['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.mjs', 'f.cjs'].every(isProgramFile)).toBe(true);
    expect(
      ['x.d.ts', 'x.test.ts', 'x.spec.tsx', '__tests__/x.ts', 'e2e/x.ts', 'x.stories.tsx', 'x.css'].some(isProgramFile),
    ).toBe(false);
  });
});

describe('createProgram', () => {
  it('serves tracked files from memory', () => {
    const p = program({ 'app/page.tsx': 'export const answer = 42;\n' });
    expect(p.getSourceFile(`${MEMORY_ROOT}/app/page.tsx`)?.text).toBe('export const answer = 42;\n');
  });

  it('resolves relative imports', () => {
    const p = program({
      'app/page.tsx': "import { HOME } from '../lib/paths';\nexport default HOME;\n",
      'lib/paths.ts': "export const HOME = '/';\n",
    });
    expect(importedFrom(p, 'app/page.tsx', 'HOME')).toBe(`${MEMORY_ROOT}/lib/paths.ts`);
  });

  it('resolves tsconfig paths read from memory', () => {
    const p = program({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'src/app/page.tsx': "import { HOME } from '@/lib/paths';\nexport default HOME;\n",
      'src/lib/paths.ts': "export const HOME = '/';\n",
    });
    expect(importedFrom(p, 'src/app/page.tsx', 'HOME')).toBe(`${MEMORY_ROOT}/src/lib/paths.ts`);
  });

  it('resolves bare non-relative imports against the root by default', () => {
    const p = program({
      'app/page.tsx': "import { HOME } from 'lib/paths';\nexport default HOME;\n",
      'lib/paths.ts': "export const HOME = '/';\n",
    });
    expect(importedFrom(p, 'app/page.tsx', 'HOME')).toBe(`${MEMORY_ROOT}/lib/paths.ts`);
  });

  it('roots the program at code files only', () => {
    const p = program({ 'app/page.tsx': '', 'app/page.test.tsx': '', 'README.md': '' });
    expect(p.getRootFileNames()).toEqual([`${MEMORY_ROOT}/app/page.tsx`]);
  });
});
