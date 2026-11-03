import { join } from 'node:path';
import ts from 'typescript6';
import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createGuardCheck } from './guards.js';
import type { MatchRoute, MatchSegment } from './match.js';
import { createProgram } from './program.js';
import type { RouteFile } from './routes.js';

const NAV = "import { usePathname, useParams } from 'next/navigation';\n";

function screenOf(pattern: string): MatchRoute {
  const segments: MatchSegment[] = pattern
    .split('/')
    .filter(Boolean)
    .map((part) => {
      const match = /^\[(\[)?(\.\.\.)?([^\]]+)\]{1,2}$/.exec(part);
      if (match === null) return { kind: 'static', value: part };
      const name = match[3]!;
      if (match[1] !== undefined) return match[2] === undefined ? { kind: 'optional-dynamic', name } : { kind: 'optional-catch-all', name };
      return match[2] === undefined ? { kind: 'dynamic', name } : { kind: 'catch-all', name };
    });
  return { route: { segments } as unknown as RouteFile, host: null, segments };
}

function mayRun(source: string, route: string): boolean {
  const files = memoryFiles({ 'a.tsx': source });
  const program = createProgram({ root: MEMORY_ROOT, files });
  const sourceFile = program.getSourceFile(join(MEMORY_ROOT, 'a.tsx'))!;
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'go') target = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return createGuardCheck(program)(target!, screenOf(route));
}

const inComponent = (body: string) => `${NAV}declare function go(): void;\nexport function C() {\n${body}\n}\n`;

describe('createGuardCheck', () => {
  describe('guard sites', () => {
    it('blocks the right operand of && when the left is never', () => {
      const code = inComponent("const p = usePathname();\nreturn p.startsWith('/x') && go();");
      expect(mayRun(code, '/y')).toBe(false);
      expect(mayRun(code, '/x/a')).toBe(true);
    });

    it('blocks the right operand of || when the left is always', () => {
      const code = inComponent("const p = usePathname();\nreturn p.startsWith('/x') || go();");
      expect(mayRun(code, '/x')).toBe(false);
      expect(mayRun(code, '/y')).toBe(true);
    });

    it('blocks the branch of ?: the condition rules out', () => {
      const whenTrue = inComponent("const p = usePathname();\nreturn p === '/x' ? go() : null;");
      const whenFalse = inComponent("const p = usePathname();\nreturn p === '/x' ? null : go();");
      expect(mayRun(whenTrue, '/y')).toBe(false);
      expect(mayRun(whenTrue, '/x')).toBe(true);
      expect(mayRun(whenFalse, '/x')).toBe(false);
      expect(mayRun(whenFalse, '/y')).toBe(true);
    });

    it('blocks the branch of if the condition rules out', () => {
      const code = inComponent("const p = usePathname();\nif (p === '/x') { go(); } else { void 0; }");
      const otherwise = inComponent("const p = usePathname();\nif (p === '/x') { void 0; } else { go(); }");
      expect(mayRun(code, '/y')).toBe(false);
      expect(mayRun(code, '/x')).toBe(true);
      expect(mayRun(otherwise, '/x')).toBe(false);
      expect(mayRun(otherwise, '/y')).toBe(true);
    });

    it('blocks code after an early return whose condition is always', () => {
      const code = inComponent("const p = usePathname();\nif (p === '/x') { return null; }\nreturn go();");
      expect(mayRun(code, '/x')).toBe(false);
      expect(mayRun(code, '/y')).toBe(true);
    });

    it('ignores a return inside a nested function when looking for an early return', () => {
      const code = inComponent("const p = usePathname();\nif (p === '/x') { const f = () => { return 1; }; f(); }\nreturn go();");
      expect(mayRun(code, '/x')).toBe(true);
    });

    it('crosses function boundaries up to the file', () => {
      const code = `${NAV}declare function go(): void;\nconst p = usePathname();\nexport const C = () => p === '/x' && (() => go())();\n`;
      expect(mayRun(code, '/y')).toBe(false);
    });

    it('does not block the condition itself', () => {
      const code = inComponent("const p = usePathname();\nreturn go() && p === '/x';");
      expect(mayRun(code, '/y')).toBe(true);
    });
  });

  describe('truth rules', () => {
    const guarded = (condition: string) =>
      inComponent(`const p = usePathname();\nconst { slug } = useParams();\nreturn ${condition} && go();`);

    it.each([
      ["p === '/x'", '/x', true],
      ["p == '/x'", '/y', false],
      ["p !== '/x'", '/x', false],
      ["p != '/x'", '/y', true],
      ["p.includes('/b/')", '/a/b/c', true],
      ["p.includes('/b/')", '/a/c', false],
      ["p.startsWith('/a')", '/a/b', true],
      ["p.startsWith('/a')", '/b/a', false],
      ["p.endsWith('/b')", '/a/b', true],
      ["p.endsWith('/b')", '/b/a', false],
      ["p?.startsWith('/a')", '/b', false],
      ["'/x' === p", '/y', false],
      ["!p.startsWith('/a')", '/a', false],
      ["!p.startsWith('/a')", '/b', true],
      ["(p as string).startsWith('/a')", '/b', false],
      ["p!.startsWith('/a')", '/b', false],
      ["p.startsWith('/a') && p.endsWith('/z')", '/a/b', false],
      ["p.startsWith('/a') || p.startsWith('/b')", '/b', true],
      ["p.startsWith('/a') || p.startsWith('/b')", '/c', false],
      ["p.startsWith(`/${slug}/links`)", '/[slug]/settings', false],
      ["!p.startsWith(`/${slug}/links`)", '/[slug]/links', true],
      ["p.startsWith(`${slug}/links`)", '/a/b/links', true],
    ])('%s on %s -> may run: %s', (condition, route, expected) => {
      expect(mayRun(guarded(condition), route)).toBe(expected);
    });

    it('fills a dynamic segment with a value no literal equals', () => {
      const code = inComponent("const p = usePathname();\nreturn p === '/x/y' && go();");
      expect(mayRun(code, '/x/[id]')).toBe(false);
    });

    it('treats path tests as unknown when the screen has a catch-all or optional segment', () => {
      const code = inComponent("const p = usePathname();\nreturn p.startsWith('/x') && go();");
      expect(mayRun(code, '/y/[...rest]')).toBe(true);
      expect(mayRun(code, '/y/[[...rest]]')).toBe(true);
      expect(mayRun(code, '/y/[[lang]]')).toBe(true);
    });

    it('decides param truthiness from the screen segments', () => {
      const dotted = inComponent("const params = useParams();\nreturn params.slug && go();");
      const destructured = inComponent("const { slug: s } = useParams();\nreturn s && go();");
      for (const code of [dotted, destructured]) {
        expect(mayRun(code, '/a/[slug]')).toBe(true);
        expect(mayRun(code, '/a/[...slug]')).toBe(true);
        expect(mayRun(code, '/a/[[...slug]]')).toBe(true);
        expect(mayRun(code, '/a/[[slug]]')).toBe(true);
      }
      expect(mayRun(dotted, '/a')).toBe(false);
      expect(mayRun(destructured, '/a/[other]')).toBe(false);
      expect(mayRun(inComponent("const params = useParams();\nreturn !params.slug && go();"), '/a/[slug]')).toBe(false);
    });

    it('resolves a const alias of a guard through the type checker', () => {
      const code = inComponent("const p = usePathname();\nconst onLinks = p.startsWith('/x/links');\nreturn onLinks && go();");
      expect(mayRun(code, '/x/settings')).toBe(false);
      expect(mayRun(code, '/x/links')).toBe(true);
    });

    it('follows an aliased import of the hook', () => {
      const code = `import { usePathname as currentPath } from 'next/navigation';\ndeclare function go(): void;\nexport const C = () => currentPath().startsWith('/x') && go();\n`;
      expect(mayRun(code, '/y')).toBe(false);
    });
  });

  describe('unknown passes', () => {
    it('lets through hooks that do not come from next/navigation', () => {
      const code = `import { usePathname } from './my-hooks';\ndeclare function go(): void;\nexport const C = () => usePathname().startsWith('/x') && go();\n`;
      expect(mayRun(code, '/y')).toBe(true);
    });

    it('lets through a hook imported from another package', () => {
      const code = `import { usePathname } from 'next/router';\ndeclare function go(): void;\nexport const C = () => usePathname().startsWith('/x') && go();\n`;
      expect(mayRun(code, '/y')).toBe(true);
    });

    it('lets through a let binding, an unresolvable value and an unsupported operator', () => {
      expect(mayRun(inComponent("let p = usePathname();\nreturn p.startsWith('/x') && go();"), '/y')).toBe(true);
      expect(mayRun(inComponent("declare const q: string;\nreturn q === '/x' && go();"), '/y')).toBe(true);
      expect(mayRun(inComponent("const p = usePathname();\nreturn p > '/x' && go();"), '/y')).toBe(true);
      expect(mayRun(inComponent("const p = usePathname();\nreturn p.startsWith(prefix()) && go();"), '/y')).toBe(true);
    });

    it('lets through an unguarded call', () => {
      expect(mayRun(inComponent('go();'), '/y')).toBe(true);
    });

    it('lets through when one operand is unknown and the other does not decide', () => {
      const code = inComponent("const p = usePathname();\ndeclare const ready: boolean;\nreturn (ready && p.startsWith('/x')) && go();");
      expect(mayRun(code, '/x')).toBe(true);
      expect(mayRun(code, '/y')).toBe(false);
      const either = inComponent("const p = usePathname();\ndeclare const ready: boolean;\nreturn (ready || p.startsWith('/x')) && go();");
      expect(mayRun(either, '/y')).toBe(true);
    });
  });
});
