import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createEvaluator, type Evaluated } from './evaluate.js';
import { findNavCalls } from './nav-calls.js';
import { createProgram } from './program.js';

type Shown = { readonly paths: readonly string[]; readonly fromBuilder: boolean } | { readonly unknown: string };

function show(evaluated: Evaluated): Shown {
  if (evaluated.kind === 'unknown') return { unknown: evaluated.why };
  const paths = evaluated.alternatives.map((template) =>
    template.map((part) => (part.kind === 'hole' ? '*' : part.text)).join(''),
  );
  return { paths, fromBuilder: evaluated.fromBuilder };
}

function evaluateIn(files: Readonly<Record<string, string>>, file = 'app/page.tsx'): readonly Shown[] {
  const program = createProgram({ root: MEMORY_ROOT, files: memoryFiles(files) });
  const sourceFile = program.getSourceFile(`${MEMORY_ROOT}/${file}`);
  if (sourceFile === undefined) throw new Error(`${file} is not in the program`);
  const evaluate = createEvaluator(program);
  return findNavCalls(sourceFile, file).map((call) => show(evaluate(call.expression)));
}

function evaluatePage(source: string): readonly Shown[] {
  return evaluateIn({ 'app/page.tsx': source });
}

const paths = (...values: string[]) => ({ paths: values, fromBuilder: false });

describe('createEvaluator', () => {
  it('evaluates a literal', () => {
    expect(evaluatePage("<Link href='/about' />;")).toEqual([paths('/about')]);
  });

  it('turns template substitutions into holes', () => {
    expect(evaluatePage('declare const slug: string;\n<Link href={`/blog/${slug}/edit`} />;')).toEqual([
      paths('/blog/*/edit'),
    ]);
  });

  it('concatenates with +', () => {
    expect(evaluatePage("declare const id: string;\nrouter.push('/u/' + id);")).toEqual([paths('/u/*')]);
  });

  it('follows a constant imported from another file', () => {
    expect(
      evaluateIn({
        'app/page.tsx': "import { HOME } from '../lib/routes';\nredirect(HOME);",
        'lib/routes.ts': "export const HOME = '/dashboard';",
      }),
    ).toEqual([paths('/dashboard')]);
  });

  it('follows an object property and an enum member', () => {
    expect(
      evaluatePage(
        "const ROUTES = { settings: '/settings' };\nenum R { Home = '/' }\n<Link href={ROUTES.settings} />;\n<Link href={R.Home} />;",
      ),
    ).toEqual([paths('/settings'), paths('/')]);
  });

  it('traces a prop back to every JSX call site', () => {
    expect(
      evaluateIn(
        {
          'components/nav-item.tsx': 'export function NavItem({ to }: { to: string }) { return <Link href={to} />; }',
          'app/page.tsx': "import { NavItem } from '../components/nav-item';\n<NavItem to='/a' />;\n<NavItem to='/b' />;",
        },
        'components/nav-item.tsx',
      ),
    ).toEqual([paths('/a', '/b')]);
  });

  it('evaluates .map over an array of href objects', () => {
    expect(
      evaluatePage(
        "const links = [{ href: '/a', label: 'A' }, { href: '/b', label: 'B' }];\nlinks.map((link) => <Link href={link.href} />);",
      ),
    ).toEqual([paths('/a', '/b')]);
  });

  it('gives a ternary both branches', () => {
    expect(evaluatePage("declare const ok: boolean;\nredirect(ok ? '/a' : '/b');")).toEqual([paths('/a', '/b')]);
  });

  it('evaluates a local helper with its arguments bound', () => {
    expect(evaluatePage("function post(id: string) { return `/posts/${id}`; }\nrouter.push(post('x'));")).toEqual([
      paths('/posts/x'),
    ]);
  });

  it('takes pathname from a URL object', () => {
    expect(evaluatePage("<Link href={{ pathname: '/search', query: { q: 'x' } }} />;")).toEqual([paths('/search')]);
  });

  it('falls back to a string literal union type', () => {
    expect(evaluatePage("declare const to: '/a' | '/b';\n<Link href={to} />;")).toEqual([paths('/a', '/b')]);
  });

  it('reports an unknown function call as unknown', () => {
    expect(evaluatePage('declare function docs(): string;\n<Link href={docs()} />;')).toEqual([{ unknown: 'call' }]);
  });

  it('uses a bracketed route-builder literal when the call cannot be evaluated', () => {
    expect(
      evaluatePage("declare function build(p: string, v: object): string;\nrouter.push(build('/[team]/settings', {}));"),
    ).toEqual([{ paths: ['/[team]/settings'], fromBuilder: true }]);
  });

  it('marks an unbound parameter as a passthrough', () => {
    expect(evaluatePage('export function Go({ to }: { to: string }) { return <Link href={to} />; }')).toEqual([
      { unknown: 'param' },
    ]);
  });
});
