import { describe, expect, it } from 'vitest';
import type { PathTemplate } from './evaluate.js';
import { createMatcher, resolveTemplate, type Matcher, type MatchRoute } from './match.js';
import { discoverRoutes } from './routes.js';

function template(path: string): PathTemplate {
  return path.split(/(\*)/).flatMap((piece): PathTemplate => {
    if (piece === '*') return [{ kind: 'hole' }];
    return piece === '' ? [] : [{ kind: 'text', text: piece }];
  });
}

function matcherFor(files: readonly string[], adapters = true): Matcher {
  return createMatcher({ table: discoverRoutes({ files, appDir: 'app' }), files, adapters });
}

function sourceFor(matcher: Matcher, pattern: string): MatchRoute {
  const route = matcher.routes.find((candidate) => candidate.route.pattern === pattern);
  if (route === undefined) throw new Error(`no route ${pattern}`);
  return route;
}

function resolve(matcher: Matcher, path: string, source: MatchRoute | null = null) {
  return resolveTemplate({ matcher, template: template(path), source });
}

const screen = (pattern: string) => ({ kind: 'screen', pattern });

describe('resolveTemplate', () => {
  const blog = matcherFor([
    'app/page.tsx',
    'app/blog/page.tsx',
    'app/blog/about/page.tsx',
    'app/blog/[slug]/page.tsx',
    'app/docs/[...path]/page.tsx',
    'app/api/x/route.ts',
    'public/logo.png',
  ]);

  it('resolves a literal path to its page', () => {
    expect(resolve(blog, '/blog')).toEqual(screen('/blog'));
  });

  it('prefers a static segment over a dynamic one', () => {
    expect(resolve(blog, '/blog/about')).toEqual(screen('/blog/about'));
    expect(resolve(blog, '/blog/hello')).toEqual(screen('/blog/[slug]'));
  });

  it('lands a hole on the dynamic segment', () => {
    expect(resolve(blog, '/blog/*')).toEqual(screen('/blog/[slug]'));
  });

  it('treats a bracketed literal segment as a hole', () => {
    expect(resolve(blog, '/blog/[slug]')).toEqual(screen('/blog/[slug]'));
  });

  it('matches a catch-all', () => {
    expect(resolve(blog, '/docs/a/b/c')).toEqual(screen('/docs/[...path]'));
  });

  it('lands several holes on one catch-all', () => {
    expect(resolve(blog, '/docs/*/*')).toEqual(screen('/docs/[...path]'));
  });

  it('ignores the query and hash', () => {
    expect(resolve(blog, '/blog?page=2#top')).toEqual(screen('/blog'));
  });

  it('excludes external, same-page, asset and handler targets', () => {
    expect(resolve(blog, 'https://example.com/blog')).toEqual({ kind: 'excluded', why: 'external' });
    expect(resolve(blog, 'mailto:a@b.c')).toEqual({ kind: 'excluded', why: 'external' });
    expect(resolve(blog, '//cdn.example.com/x')).toEqual({ kind: 'excluded', why: 'external' });
    expect(resolve(blog, '#x')).toEqual({ kind: 'excluded', why: 'same-page' });
    expect(resolve(blog, '?q=1')).toEqual({ kind: 'excluded', why: 'same-page' });
    expect(resolve(blog, '')).toEqual({ kind: 'excluded', why: 'same-page' });
    expect(resolve(blog, '/logo.png')).toEqual({ kind: 'excluded', why: 'asset' });
    expect(resolve(blog, '/api/x')).toEqual({ kind: 'excluded', why: 'handler' });
  });

  it('reports a path no route serves', () => {
    expect(resolve(blog, '/nope')).toEqual({ kind: 'unresolved', reason: 'no-matching-route' });
    expect(resolve(blog, '/missing.png')).toEqual({ kind: 'unresolved', reason: 'no-matching-route' });
  });

  it('reports a leading hole as a dynamic expression', () => {
    expect(resolve(blog, '*/blog')).toEqual({ kind: 'unresolved', reason: 'dynamic-expression' });
  });

  it('reports a hole that only lands on static segments as ambiguous', () => {
    const matcher = matcherFor(['app/team/members/page.tsx', 'app/team/billing/page.tsx']);
    expect(resolve(matcher, '/team/*')).toEqual({ kind: 'unresolved', reason: 'ambiguous-route' });
  });
});

describe('hostname folders', () => {
  const hosted = matcherFor(['app/app.acme.com/settings/page.tsx', 'app/admin.acme.com/settings/page.tsx']);

  it("scopes matching to the source screen's host", () => {
    const source = sourceFor(hosted, '/admin.acme.com/settings');
    expect(resolve(hosted, '/settings', source)).toEqual(screen('/admin.acme.com/settings'));
  });

  it("never resolves to a route under another host than the source screen's", () => {
    const matcher = matcherFor(['app/app.acme.com/page.tsx', 'app/admin.acme.com/login/page.tsx']);
    const source = sourceFor(matcher, '/app.acme.com');
    expect(resolve(matcher, '/login', source)).toEqual({ kind: 'unresolved', reason: 'no-matching-route' });
  });

  it("prefers the source screen's host over a hostless locale route", () => {
    const matcher = matcherFor(['app/[lang]/page.tsx', 'app/app.acme.com/page.tsx', 'app/app.acme.com/settings/page.tsx']);
    const source = sourceFor(matcher, '/app.acme.com/settings');
    expect(resolve(matcher, '/', source)).toEqual(screen('/app.acme.com'));
  });

  it('reports a path served under several hosts as ambiguous without a host', () => {
    expect(resolve(hosted, '/settings')).toEqual({ kind: 'unresolved', reason: 'ambiguous-route' });
  });

  it('keeps the host folder as a path segment with adapters off', () => {
    const raw = matcherFor(['app/app.acme.com/settings/page.tsx'], false);
    expect(resolve(raw, '/settings', sourceFor(raw, '/app.acme.com/settings'))).toEqual({
      kind: 'unresolved',
      reason: 'no-matching-route',
    });
    expect(resolve(raw, '/app.acme.com/settings')).toEqual(screen('/app.acme.com/settings'));
  });

  it('treats a dotted folder with only a handler as a path, not a host', () => {
    const matcher = matcherFor(['app/page.tsx', 'app/rss.xml/route.ts']);
    expect(resolve(matcher, '/')).toEqual(screen('/'));
    expect(resolve(matcher, '/rss.xml')).toEqual({ kind: 'excluded', why: 'handler' });
  });
});

describe('locale segment', () => {
  const localized = matcherFor(['app/[locale]/about/page.tsx']);

  it('matches with and without the locale prefix', () => {
    expect(resolve(localized, '/about')).toEqual(screen('/[locale]/about'));
    expect(resolve(localized, '/en/about')).toEqual(screen('/[locale]/about'));
  });

  it('lands a locale hole on the locale segment, not a later dynamic one', () => {
    const matcher = matcherFor(['app/[lang]/about/page.tsx', 'app/[lang]/blog/page.tsx', 'app/[lang]/blog/[slug]/page.tsx']);
    expect(resolve(matcher, '/*/about')).toEqual(screen('/[lang]/about'));
    expect(resolve(matcher, '/*/blog')).toEqual(screen('/[lang]/blog'));
    expect(resolve(matcher, '/*/blog/*')).toEqual(screen('/[lang]/blog/[slug]'));
  });

  it('requires the locale with adapters off', () => {
    const raw = matcherFor(['app/[locale]/about/page.tsx'], false);
    expect(resolve(raw, '/about')).toEqual({ kind: 'unresolved', reason: 'no-matching-route' });
    expect(resolve(raw, '/en/about')).toEqual(screen('/[locale]/about'));
  });

  it('reads a bracketed segment as a hole only with adapters on', () => {
    const files = ['app/acme/settings/page.tsx'];
    expect(resolve(matcherFor(files), '/[team]/settings')).toEqual({ kind: 'unresolved', reason: 'ambiguous-route' });
    expect(resolve(matcherFor(files, false), '/[team]/settings')).toEqual({
      kind: 'unresolved',
      reason: 'no-matching-route',
    });
  });
});

describe('relative links', () => {
  const nested = matcherFor([
    'app/page.tsx',
    'app/monitors/page.tsx',
    'app/monitors/[id]/page.tsx',
    'app/monitors/[id]/logs/page.tsx',
  ]);

  it("resolves against the source URL's directory, as a browser does", () => {
    const list = sourceFor(nested, '/monitors');
    expect(resolve(nested, './monitors/*', list)).toEqual(screen('/monitors/[id]'));
    expect(resolve(nested, 'monitors/*', list)).toEqual(screen('/monitors/[id]'));
    const detail = sourceFor(nested, '/monitors/[id]');
    expect(resolve(nested, './', detail)).toEqual(screen('/monitors'));
    expect(resolve(nested, '../', detail)).toEqual(screen('/'));
    expect(resolve(nested, './*/logs', detail)).toEqual(screen('/monitors/[id]/logs'));
  });

  it('is a dynamic expression without a source screen', () => {
    expect(resolve(nested, './child')).toEqual({ kind: 'unresolved', reason: 'dynamic-expression' });
  });
});
