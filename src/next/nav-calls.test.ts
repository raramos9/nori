import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { findNavCalls } from './nav-calls.js';
import { createProgram } from './program.js';

function calls(source: string) {
  const program = createProgram({ root: MEMORY_ROOT, files: memoryFiles({ 'app/page.tsx': source }) });
  const sourceFile = program.getSourceFile(`${MEMORY_ROOT}/app/page.tsx`);
  if (sourceFile === undefined) throw new Error('page is not in the program');
  return findNavCalls(sourceFile, 'app/page.tsx').map((call) => ({
    trigger: call.trigger.kind,
    target: call.expression.getText(sourceFile),
    span: call.span,
  }));
}

describe('findNavCalls', () => {
  it('finds Link, a, router and redirect calls with their triggers', () => {
    const found = calls(
      [
        "<Link href='/a' />;",
        "<NextLink href={'/b'}>b</NextLink>;",
        "<a href='/c'>c</a>;",
        "router.push('/d');",
        "useRouter().replace('/e');",
        "redirect('/f');",
        "permanentRedirect('/g');",
      ].join('\n'),
    );
    expect(found.map(({ trigger, target }) => [trigger, target])).toEqual([
      ['link', "'/a'"],
      ['link', "'/b'"],
      ['link', "'/c'"],
      ['router-push', "'/d'"],
      ['router-replace', "'/e'"],
      ['redirect', "'/f'"],
      ['redirect', "'/g'"],
    ]);
  });

  it('ignores prefetch, other tags, other attributes and empty hrefs', () => {
    expect(
      calls(
        [
          "router.prefetch('/a');",
          "<Button href='/b' />;",
          "<Link to='/c' />;",
          '<a href />;',
          "router.toString('/d');",
          "navigate('/e');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('spans the whole attribute or call, 1-based', () => {
    const [link, push] = calls("const x = 1;\n  <Link href={`/a/${x}`} />;\nrouter.push(\n  '/b',\n);\n");
    expect(link?.span).toEqual({ file: 'app/page.tsx', start: { line: 2, column: 9 }, end: { line: 2, column: 25 } });
    expect(push?.span).toEqual({ file: 'app/page.tsx', start: { line: 3, column: 1 }, end: { line: 5, column: 2 } });
  });
});
