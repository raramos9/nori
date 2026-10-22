import { describe, expect, it } from 'vitest';
import { applicationId, buildId, screenId, stateId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  parseCommitSha,
  parseRoutePattern,
  type Application,
  type Build,
  type StateId,
} from '../graph/model.js';
import { discoverRoutes } from '../next/routes.js';
import { MEMORY_ROOT, memoryFiles } from '../testing/memory-project.js';
import { navigationIngestion } from './navigation.js';

const application: Application = {
  id: applicationId({ rootPath: MEMORY_ROOT }),
  rootPath: MEMORY_ROOT,
  framework: 'next-app-router',
};
const commitSha = parseCommitSha('a'.repeat(40));
const build: Build = {
  id: buildId({ applicationId: application.id, commitSha, sourceHash: 'h', analyzerVersion: '1' }),
  applicationId: application.id,
  commitSha,
  sourceHash: 'h',
  branch: 'main',
  analyzerVersion: '1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const patternOf = new Map<StateId, string>();

function state(pattern: string): StateId {
  const id = stateId({
    screenId: screenId({ applicationId: application.id, routePattern: parseRoutePattern(pattern) }),
    key: DEFAULT_STATE_KEY,
  });
  patternOf.set(id, pattern);
  return id;
}

function ingest(files: Readonly<Record<string, string>>, adapters = true) {
  const sources = memoryFiles(files);
  const table = discoverRoutes({ files: sources.map((file) => file.path), appDir: 'app' });
  for (const route of table.routes) state(route.pattern);
  return navigationIngestion({ application, build, root: MEMORY_ROOT, files: sources, table, adapters });
}

function edges(files: Readonly<Record<string, string>>): readonly string[] {
  return ingest(files)
    .transitions.map(({ sourceStateId, trigger, target }) => {
      const to =
        target.kind === 'resolved'
          ? patternOf.get(target.stateId)
          : `unresolved ${target.reason} ${JSON.stringify(target.expression)}`;
      return `${patternOf.get(sourceStateId)} ${trigger.kind} ${to}`;
    })
    .sort();
}

const PAGE = 'export default function Page() { return null; }\n';
const pageWith = (body: string) => `export default function Page() {\n  return ${body};\n}\n`;
const redirectTo = (to: string) =>
  `import { redirect } from 'next/navigation';\nexport default function Page() {\n  redirect(${to});\n}\n`;

describe('navigationIngestion', () => {
  it('resolves a literal Link to the target screen', () => {
    expect(edges({ 'app/page.tsx': pageWith("<Link href='/about' />"), 'app/about/page.tsx': PAGE })).toEqual([
      '/ link /about',
    ]);
  });

  it('resolves a template with a dynamic segment to the dynamic page', () => {
    expect(
      edges({
        'app/page.tsx': 'declare const slug: string;\n' + pageWith('<Link href={`/blog/${slug}`} />'),
        'app/blog/[slug]/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /blog/[slug]']);
  });

  it('resolves a constant imported from another file', () => {
    expect(
      edges({
        'app/page.tsx': "import { redirect } from 'next/navigation';\nimport { HOME } from '../lib/routes';\nexport default function Page() { redirect(HOME); }\n",
        'lib/routes.ts': "export const HOME = '/home';\n",
        'app/home/page.tsx': PAGE,
      }),
    ).toEqual(['/ redirect /home']);
  });

  it('resolves a prop passed from a JSX call site', () => {
    expect(
      edges({
        'components/item.tsx': 'export function Item({ to }: { to: string }) { return <Link href={to} />; }\n',
        'app/page.tsx': "import { Item } from '../components/item';\n" + pageWith("<Item to='/a' />"),
        'app/a/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /a']);
  });

  it('resolves .map over an array of href objects', () => {
    expect(
      edges({
        'app/page.tsx':
          "const links = [{ href: '/a' }, { href: '/b' }];\n" + pageWith('links.map((l) => <Link href={l.href} />)'),
        'app/a/page.tsx': PAGE,
        'app/b/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /a', '/ link /b']);
  });

  it('makes no transition for external, same-page, asset and handler targets', () => {
    const ingestion = ingest({
      'app/page.tsx': pageWith(
        "<>{[<a href='https://x.com' />, <Link href='#x' />, <Link href='?q=1' />, <a href='/logo.png' />, <a href='/api/x' />]}</>",
      ),
      'public/logo.png': 'png',
      'app/api/x/route.ts': 'export function GET() {}\n',
    });
    expect(ingestion.transitions).toEqual([]);
    expect(ingestion.evidence).toEqual([]);
    expect(ingestion.outcomes.map((o) => o.contexts[0]?.classification)).toEqual([
      { kind: 'excluded', why: 'external' },
      { kind: 'excluded', why: 'same-page' },
      { kind: 'excluded', why: 'same-page' },
      { kind: 'excluded', why: 'asset' },
      { kind: 'excluded', why: 'handler' },
    ]);
  });

  it('records an unknown function call as a dynamic expression', () => {
    expect(
      edges({ 'app/page.tsx': 'declare function docs(): string;\n' + pageWith('<Link href={docs(  )} />') }),
    ).toEqual(['/ link unresolved dynamic-expression "docs( )"']);
  });

  it('records a path no route serves as no-matching-route', () => {
    expect(edges({ 'app/page.tsx': pageWith("<Link href='/nope' />") })).toEqual([
      '/ link unresolved no-matching-route "\'/nope\'"',
    ]);
  });

  it("picks the source screen's host", () => {
    expect(
      edges({
        'app/app.acme.com/page.tsx': pageWith("<Link href='/settings' />"),
        'app/app.acme.com/settings/page.tsx': PAGE,
        'app/admin.acme.com/settings/page.tsx': PAGE,
      }),
    ).toEqual(['/app.acme.com link /app.acme.com/settings']);
  });

  it('matches a locale route with and without the prefix', () => {
    expect(
      edges({
        'app/page.tsx': pageWith("<><Link href='/about' /><Link href='/en/about' /></>"),
        'app/[locale]/about/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /[locale]/about']);
  });

  it('resolves a route-builder literal', () => {
    expect(
      edges({
        'app/page.tsx':
          'declare function route(p: string, v: object): string;\n' +
          pageWith("<Link href={route('/[team]/settings', {})} />"),
        'app/[team]/settings/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /[team]/settings']);
  });

  it('leaves a route-builder call unresolved with adapters off', () => {
    const files = {
      'app/page.tsx':
        'declare function route(p: string, v: object): string;\n' +
        pageWith("<Link href={route('/[team]/settings', {})} />"),
      'app/[team]/settings/page.tsx': PAGE,
    };
    const classes = (adapters: boolean) =>
      ingest(files, adapters).outcomes.flatMap(({ contexts }) => contexts.map(({ classification }) => classification.kind));
    expect(classes(true)).toEqual(['resolved']);
    expect(classes(false)).toEqual(['unresolved']);
  });

  it('resolves a relative link against the source screen', () => {
    expect(
      edges({ 'app/a/[id]/page.tsx': pageWith("<Link href='./' />"), 'app/a/page.tsx': PAGE }),
    ).toEqual(['/a/[id] link /a']);
  });

  it("attributes a layout component's call to every screen under the layout", () => {
    expect(
      edges({
        'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
        'components/nav.tsx': "export const Nav = () => <Link href='/' />;\n",
        'app/page.tsx': PAGE,
        'app/about/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /', '/about link /']);
  });

  it('gives a ternary two transitions backed by one evidence row', () => {
    const ingestion = ingest({
      'app/page.tsx': 'declare const ok: boolean;\n' + pageWith("<Link href={ok ? '/a' : '/b'} />"),
      'app/a/page.tsx': PAGE,
      'app/b/page.tsx': PAGE,
    });
    expect(ingestion.transitions).toHaveLength(2);
    expect(ingestion.evidence).toHaveLength(1);
    expect(ingestion.observations.map((o) => o.evidenceId)).toEqual([
      ingestion.evidence[0]?.id,
      ingestion.evidence[0]?.id,
    ]);
    expect(new Set(ingestion.observations.map((o) => o.subject.id))).toEqual(
      new Set(ingestion.transitions.map((t) => t.id)),
    );
  });

  it('merges two calls with the same source, trigger and target into one transition', () => {
    const ingestion = ingest({
      'app/page.tsx': pageWith("<><Link href='/a' /><Link href='/a' /></>"),
      'app/a/page.tsx': PAGE,
    });
    expect(ingestion.transitions).toHaveLength(1);
    expect(ingestion.evidence).toHaveLength(2);
    expect(ingestion.observations).toHaveLength(2);
  });

  it('points evidence at the call', () => {
    const [evidence] = ingest({ 'app/page.tsx': pageWith("<Link href='/' />") }).evidence;
    expect(evidence).toMatchObject({
      extractor: 'next-nav-ts',
      span: { file: 'app/page.tsx', start: { line: 2, column: 16 }, end: { line: 2, column: 24 } },
    });
  });

  it('forwards a link to a redirect-only screen to where it redirects', () => {
    expect(
      edges({
        'app/layout.tsx': "import { Nav } from '../components/nav';\nexport default Nav;\n",
        'components/nav.tsx': "export const Nav = () => <Link href='/new' />;\n",
        'app/page.tsx': pageWith("<Link href='/old' />"),
        'app/old/page.tsx': redirectTo("'/new'"),
        'app/new/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /new', '/new link /new', '/old redirect /new']);
  });

  it('keeps the edge to redirect-only screens that redirect to each other', () => {
    expect(
      edges({
        'app/page.tsx': pageWith("<Link href='/a' />"),
        'app/a/page.tsx': redirectTo("'/b'"),
        'app/b/page.tsx': redirectTo("'/a'"),
      }),
    ).toEqual(['/ link /a', '/a redirect /b', '/b redirect /a']);
  });

  it('leaves a link unresolved when the redirect-only screen it reaches redirects somewhere unknown', () => {
    expect(
      edges({
        'app/page.tsx': pageWith("<Link href='/old' />"),
        'app/old/page.tsx': 'declare const to: string;\n' + redirectTo('to'),
      }),
    ).toEqual([`/ link unresolved dynamic-expression "'/old'"`, '/old redirect unresolved dynamic-expression "to"']);
  });

  it('drops a link to a redirect-only screen that leaves the app', () => {
    expect(
      edges({
        'app/page.tsx': pageWith("<Link href='/cal' />"),
        'app/cal/page.tsx': redirectTo("'https://cal.com/team'"),
      }),
    ).toEqual([]);
  });

  it('forwards through a chain of redirect-only screens', () => {
    expect(
      edges({
        'app/page.tsx': pageWith("<Link href='/a' />"),
        'app/a/page.tsx': redirectTo("'/b'"),
        'app/b/page.tsx': redirectTo("'/c'"),
        'app/c/page.tsx': PAGE,
      }),
    ).toEqual(['/ link /c', '/a redirect /c', '/b redirect /c']);
  });

  it('classifies a call to a redirect-only screen as it was written', () => {
    const ingestion = ingest({
      'app/page.tsx': pageWith("<Link href='/old' />"),
      'app/old/page.tsx': redirectTo("'/new'"),
      'app/new/page.tsx': PAGE,
    });
    expect(ingestion.outcomes.map((o) => o.contexts)).toEqual([
      [{ source: '/', classification: { kind: 'resolved' } }],
      [{ source: '/old', classification: { kind: 'resolved' } }],
    ]);
  });

  it('makes no transition for a call no screen renders, and reports it', () => {
    const ingestion = ingest({
      'app/page.tsx': PAGE,
      'components/orphan.tsx': "export const Orphan = () => <Link href='/' />;\n",
    });
    expect(ingestion.transitions).toEqual([]);
    expect(ingestion.outcomes.map((o) => o.contexts)).toEqual([
      [{ source: null, classification: { kind: 'resolved' } }],
    ]);
  });
});
