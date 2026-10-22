import { describe, expect, it } from 'vitest';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { createProgram } from './program.js';
import { redirectOnlyPages } from './redirect-pages.js';
import { discoverRoutes } from './routes.js';

function detect(files: Readonly<Record<string, string>>): string[] {
  const sources = memoryFiles(files);
  const program = createProgram({ root: MEMORY_ROOT, files: sources });
  const table = discoverRoutes({ files: sources.map((file) => file.path), appDir: 'app' });
  return [...redirectOnlyPages({ program, root: MEMORY_ROOT, table })].sort();
}

const IMPORT = "import { redirect } from 'next/navigation';\n";

describe('redirectOnlyPages', () => {
  it('detects a function declaration that only redirects', () => {
    expect(detect({ 'app/old/page.tsx': IMPORT + "export default function Page() { redirect('/new'); }\n" })).toEqual([
      '/old',
    ]);
  });

  it('follows a re-exported default through an import alias', () => {
    expect(
      detect({
        'app/settings/page.tsx': "import { SettingsPage } from '../../modules/settings';\nexport default SettingsPage;\n",
        'modules/settings.ts':
          IMPORT +
          'export const SettingsPage = async (props: { params: Promise<{ id: string }> }) => {\n' +
          '  const params = await props.params;\n' +
          '  return redirect(`/settings/${params.id}/general`);\n' +
          '};\n',
      }),
    ).toEqual(['/settings']);
  });

  it('follows export-from of a default and detects an anonymous arrow', () => {
    expect(
      detect({
        'app/a/page.tsx': "export { default } from '../../lib/go';\n",
        'lib/go.ts': "import { permanentRedirect } from 'next/navigation';\nexport default () => permanentRedirect('/b');\n",
      }),
    ).toEqual(['/a']);
  });

  it('counts a conditional redirect with no JSX', () => {
    expect(
      detect({
        'app/a/page.tsx':
          IMPORT + "declare const ok: boolean;\nexport default function Page() { if (ok) redirect('/b'); else redirect('/c'); return null; }\n",
      }),
    ).toEqual(['/a']);
  });

  it('does not count a guard redirect in front of rendered JSX', () => {
    expect(
      detect({
        'app/a/page.tsx':
          IMPORT +
          "declare const user: string | null;\ndeclare function X(): null;\nexport default function Page() {\n  if (!user) redirect('/login');\n  return <X />;\n}\n",
      }),
    ).toEqual([]);
  });

  it('does not count a guard redirect in front of a non-JSX render', () => {
    expect(
      detect({
        'app/report/page.tsx':
          IMPORT +
          "import { renderReport } from '../../lib/report';\n" +
          "export default async function Page() { const r = await load(); if (!r) redirect('/'); return renderReport(r); }\n" +
          'declare function load(): Promise<string | null>;\n',
        'lib/report.ts': 'export const renderReport = (r: string) => r;\n',
      }),
    ).toEqual([]);
  });

  it('ignores returns inside callbacks', () => {
    expect(
      detect({
        'app/go/page.tsx':
          IMPORT + "export default function Page() { [1].map((n) => n + 1); redirect('/'); }\n",
      }),
    ).toEqual(['/go']);
  });

  it('does not count a page with no redirect', () => {
    expect(detect({ 'app/a/page.tsx': 'export default function Page() { return null; }\n' })).toEqual([]);
  });

  it('needs every page file for a pattern to redirect', () => {
    expect(
      detect({
        'app/(x)/a/page.tsx': IMPORT + "export default function Page() { redirect('/b'); }\n",
        'app/@modal/a/page.tsx': 'export default function Page() { return <></>; }\n',
      }),
    ).toEqual([]);
  });
});
