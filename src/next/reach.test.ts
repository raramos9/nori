import { join } from 'node:path';
import ts from 'typescript6';
import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createProgram } from './program.js';
import { screenReach } from './reach.js';
import { redirectOnlyPages } from './redirect-pages.js';
import { discoverRoutes } from './routes.js';

function declaredNames(statement: ts.Statement): readonly string[] {
  if (ts.isExportAssignment(statement)) return ['default'];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => declaration.name.getText());
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return [statement.name?.text ?? 'default'];
  }
  return [];
}

function reach(files: Readonly<Record<string, string>>) {
  const sources = memoryFiles(files);
  const paths = sources.map((file) => file.path);
  const program = createProgram({ root: MEMORY_ROOT, files: sources });
  const table = discoverRoutes({ files: paths, appDir: 'app' });
  const redirectOnly = redirectOnlyPages({ program, root: MEMORY_ROOT, table });
  const screensOf = screenReach({ program, root: MEMORY_ROOT, table, files: paths, redirectOnly });
  const statementsOf = (file: string) => program.getSourceFile(join(MEMORY_ROOT, file))?.statements ?? [];
  const sorted = (statements: readonly ts.Statement[]) =>
    [...new Set(statements.flatMap((statement) => [...screensOf(statement)]))].sort();
  return {
    file: (file: string) => sorted(statementsOf(file)),
    declaration: (file: string, name: string) =>
      sorted(statementsOf(file).filter((statement) => declaredNames(statement).includes(name))),
    statement: (file: string, index: number) => sorted(statementsOf(file).slice(index, index + 1)),
  };
}

const PAGE = 'export default function Page() { return null; }\n';

describe('screenReach', () => {
  it('attributes a page file to its own screen', () => {
    const graph = reach({ 'app/page.tsx': PAGE, 'app/about/page.tsx': PAGE });
    expect(graph.file('app/page.tsx')).toEqual(['/']);
    expect(graph.file('app/about/page.tsx')).toEqual(['/about']);
  });

  it('attributes a component used by a layout to every screen under it', () => {
    const graph = reach({
      'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
      'components/nav.tsx': 'export const Nav = () => null;\n',
      'app/page.tsx': PAGE,
      'app/(shop)/cart/template.tsx': PAGE,
      'app/(shop)/cart/page.tsx': PAGE,
      'app/@modal/login/page.tsx': PAGE,
    });
    expect(graph.declaration('components/nav.tsx', 'Nav')).toEqual(['/', '/cart', '/login']);
    expect(graph.file('app/(shop)/cart/template.tsx')).toEqual(['/cart']);
  });

  it('follows transitive, path-aliased and dynamic imports through the declarations they bind', () => {
    const graph = reach({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
      'app/page.tsx': "import { A } from '@/components/a';\nexport default A;\n",
      'components/a.tsx': "export { B as A } from './b';\n",
      'components/b.tsx': "export const B = () => import('./c');\n",
      'components/c.tsx': 'export const C = 1;\n',
    });
    expect(graph.declaration('components/b.tsx', 'B')).toEqual(['/']);
    expect(graph.declaration('components/c.tsx', 'C')).toEqual(['/']);
  });

  it('does not follow lazy imports stored in a lookup table', () => {
    const graph = reach({
      'app/page.tsx': "import { demos } from '../lib/demos';\nexport default demos;\n",
      'lib/demos.ts':
        "export const demos = {\n  a: React.lazy(async () => ({ default: (await import('./a')).A })),\n  b: () => import('./b'),\n};\nexport const list = [() => import('./c')];\n",
      'lib/a.tsx': 'export const A = 1;\n',
      'lib/b.tsx': 'export const B = 1;\n',
      'lib/c.tsx': 'export const C = 1;\n',
    });
    expect(graph.declaration('lib/demos.ts', 'demos')).toEqual(['/']);
    expect(graph.file('lib/a.tsx')).toEqual([]);
    expect(graph.file('lib/b.tsx')).toEqual([]);
    expect(graph.file('lib/c.tsx')).toEqual([]);
  });

  it('does not follow type references', () => {
    const graph = reach({
      'app/page.tsx':
        "import type { T } from '../lib/types';\nimport { type U } from '../lib/more';\nimport { V } from '../lib/value';\nconst x: T | U | typeof V = 1 as T;\nexport default x;\n",
      'lib/types.ts': 'export type T = string;\nexport const unused = 1;\n',
      'lib/more.ts': 'export type U = string;\n',
      'lib/value.ts': 'export const V = 1;\n',
    });
    expect(graph.file('lib/types.ts')).toEqual([]);
    expect(graph.file('lib/more.ts')).toEqual([]);
    expect(graph.file('lib/value.ts')).toEqual([]);
  });

  it('seeds a redirect-only screen from its page alone, still following its references', () => {
    const graph = reach({
      'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
      'components/nav.tsx': 'export const Nav = () => null;\n',
      'app/page.tsx': PAGE,
      'app/old/page.tsx':
        "import { redirect } from 'next/navigation';\nimport { go } from '../../lib/go';\nexport default function Page() { go(); redirect('/'); }\n",
      'lib/go.ts': "import { redirect } from 'next/navigation';\nexport const go = () => redirect('/');\n",
    });
    expect(graph.file('components/nav.tsx')).toEqual(['/']);
    expect(graph.file('app/layout.tsx')).toEqual(['/']);
    expect(graph.declaration('lib/go.ts', 'go')).toEqual(['/old']);
  });

  it('leaves a file no screen renders unattributed', () => {
    expect(reach({ 'app/page.tsx': PAGE, 'components/orphan.tsx': PAGE }).file('components/orphan.tsx')).toEqual([]);
  });

  it('reaches only the exported function a page uses, not its siblings', () => {
    const graph = reach({
      'app/page.tsx': "import { signIn } from '../lib/actions';\nexport default function Page() { signIn(); }\n",
      'lib/actions.ts':
        "export function signIn() { redirect('/home'); }\nexport function deleteAccount() { redirect('/sign-in'); }\n",
    });
    expect(graph.declaration('lib/actions.ts', 'signIn')).toEqual(['/']);
    expect(graph.declaration('lib/actions.ts', 'deleteAccount')).toEqual([]);
  });

  it('follows references transitively from the used declaration only', () => {
    const graph = reach({
      'app/page.tsx': "import { first } from '../lib/a';\nexport default function Page() { first(); }\n",
      'lib/a.ts':
        "import { helpB } from './b';\nimport { helpC } from './c';\nexport const first = () => helpB();\nexport const second = () => helpC();\n",
      'lib/b.ts': 'export const helpB = () => 1;\n',
      'lib/c.ts': 'export const helpC = () => 1;\n',
    });
    expect(graph.declaration('lib/b.ts', 'helpB')).toEqual(['/']);
    expect(graph.file('lib/c.ts')).toEqual([]);
    expect(graph.declaration('lib/a.ts', 'second')).toEqual([]);
  });

  it('resolves names re-exported through a barrel to their declarations', () => {
    const graph = reach({
      'app/page.tsx': "import { One, Renamed } from '../lib';\nexport default function Page() { One(); Renamed(); }\n",
      'lib/index.ts': "export * from './one';\nexport { two as Renamed } from './two';\nexport { three } from './three';\n",
      'lib/one.ts': 'export const One = () => 1;\nexport const Other = () => 1;\n',
      'lib/two.ts': 'export const two = () => 2;\n',
      'lib/three.ts': 'export const three = () => 3;\n',
    });
    expect(graph.declaration('lib/one.ts', 'One')).toEqual(['/']);
    expect(graph.declaration('lib/one.ts', 'Other')).toEqual([]);
    expect(graph.declaration('lib/two.ts', 'two')).toEqual(['/']);
    expect(graph.file('lib/three.ts')).toEqual([]);
    expect(graph.file('lib/index.ts')).toEqual([]);
  });

  it('reaches every statement of a namespace import', () => {
    const graph = reach({
      'app/page.tsx': "import * as lib from '../lib/all';\nexport default function Page() { lib.a(); }\n",
      'lib/all.ts': 'export const a = () => 1;\nexport const b = () => 2;\n',
    });
    expect(graph.declaration('lib/all.ts', 'a')).toEqual(['/']);
    expect(graph.declaration('lib/all.ts', 'b')).toEqual(['/']);
  });

  it('reaches every statement of a dynamically imported module', () => {
    const graph = reach({
      'app/page.tsx': "export default function Page() { return import('../lib/lazy'); }\n",
      'lib/lazy.ts': 'export const a = () => 1;\nexport const b = () => 2;\n',
    });
    expect(graph.declaration('lib/lazy.ts', 'a')).toEqual(['/']);
    expect(graph.declaration('lib/lazy.ts', 'b')).toEqual(['/']);
  });

  it('reaches the side effects of an evaluated module and of its bare imports', () => {
    const graph = reach({
      'app/page.tsx': "import { a } from '../lib/effects';\nexport default function Page() { a(); }\n",
      'lib/effects.ts':
        "import './setup';\nexport const a = () => 1;\nexport const b = () => 2;\nregister(() => redirect('/x'));\n",
      'lib/setup.ts': "export const unused = () => 1;\nconfigure();\n",
    });
    expect(graph.declaration('lib/effects.ts', 'b')).toEqual([]);
    expect(graph.statement('lib/effects.ts', 3)).toEqual(['/']);
    expect(graph.statement('lib/setup.ts', 1)).toEqual(['/']);
    expect(graph.declaration('lib/setup.ts', 'unused')).toEqual([]);
  });

  it('follows class extends clauses and shorthand properties', () => {
    const graph = reach({
      'app/page.tsx':
        "import { Base } from '../lib/base';\nimport { handler } from '../lib/handler';\nclass Page extends Base {}\nexport default { Page, handler };\n",
      'lib/base.ts': 'export class Base {}\n',
      'lib/handler.ts': 'export const handler = () => 1;\n',
    });
    expect(graph.declaration('lib/base.ts', 'Base')).toEqual(['/']);
    expect(graph.declaration('lib/handler.ts', 'handler')).toEqual(['/']);
  });
});
