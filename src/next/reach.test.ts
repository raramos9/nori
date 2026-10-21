import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createProgram } from './program.js';
import { screensByFile } from './reach.js';
import { discoverRoutes } from './routes.js';

function reach(files: Readonly<Record<string, string>>): Record<string, string[]> {
  const sources = memoryFiles(files);
  const paths = sources.map((file) => file.path);
  const program = createProgram({ root: MEMORY_ROOT, files: sources });
  const table = discoverRoutes({ files: paths, appDir: 'app' });
  const result = screensByFile({ program, root: MEMORY_ROOT, table, files: paths });
  return Object.fromEntries([...result].map(([file, patterns]) => [file, [...patterns].sort()]));
}

const PAGE = 'export default function Page() { return null; }\n';

describe('screensByFile', () => {
  it('attributes a page file to its own screen', () => {
    expect(reach({ 'app/page.tsx': PAGE, 'app/about/page.tsx': PAGE })).toEqual({
      'app/page.tsx': ['/'],
      'app/about/page.tsx': ['/about'],
    });
  });

  it('attributes a component imported by a layout to every screen under it', () => {
    const graph = reach({
      'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
      'components/nav.tsx': 'export const Nav = () => null;\n',
      'app/page.tsx': PAGE,
      'app/(shop)/cart/template.tsx': PAGE,
      'app/(shop)/cart/page.tsx': PAGE,
      'app/@modal/login/page.tsx': PAGE,
    });
    expect(graph['components/nav.tsx']).toEqual(['/', '/cart', '/login']);
    expect(graph['app/(shop)/cart/template.tsx']).toEqual(['/cart']);
  });

  it('follows transitive, path-aliased and dynamic imports', () => {
    const graph = reach({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
      'app/page.tsx': "import { A } from '@/components/a';\nexport default A;\n",
      'components/a.tsx': "export { B as A } from './b';\n",
      'components/b.tsx': "export const B = () => import('./c');\n",
      'components/c.tsx': 'export const C = 1;\n',
    });
    expect(graph['components/c.tsx']).toEqual(['/']);
  });

  it('does not follow type-only imports', () => {
    const graph = reach({
      'app/page.tsx': "import type { T } from '../lib/types';\nimport { type U } from '../lib/more';\nexport default 1;\n",
      'lib/types.ts': 'export type T = string;\n',
      'lib/more.ts': 'export type U = string;\n',
    });
    expect(graph['lib/types.ts']).toBeUndefined();
    expect(graph['lib/more.ts']).toBeUndefined();
  });

  it('leaves a file no screen renders unattributed', () => {
    expect(reach({ 'app/page.tsx': PAGE, 'components/orphan.tsx': PAGE })['components/orphan.tsx']).toBeUndefined();
  });
});
