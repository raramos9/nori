import { describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { discoverRoutes, type AppDir } from './routes.js';

function summarize(files: readonly string[], appDir: AppDir = 'app') {
  return discoverRoutes({ files, appDir }).routes.map(({ kind, file, pattern }) => ({ kind, file, pattern }));
}

function patterns(files: readonly string[], appDir: AppDir = 'app'): string[] {
  return summarize(files, appDir).map((route) => route.pattern);
}

describe('discoverRoutes', () => {
  it('maps the root, static and nested pages', () => {
    expect(
      summarize(['app/page.tsx', 'app/about/page.tsx', 'app/settings/billing/page.js']),
    ).toEqual([
      { kind: 'page', file: 'app/about/page.tsx', pattern: '/about' },
      { kind: 'page', file: 'app/page.tsx', pattern: '/' },
      { kind: 'page', file: 'app/settings/billing/page.js', pattern: '/settings/billing' },
    ]);
  });

  it('keeps the segment structure', () => {
    const [route] = discoverRoutes({ files: ['app/a/[b]/[...c]/[[...d]]/page.tsx'], appDir: 'app' }).routes;
    expect(route?.segments).toEqual([
      { kind: 'static', value: 'a' },
      { kind: 'dynamic', name: 'b' },
      { kind: 'catch-all', name: 'c' },
      { kind: 'optional-catch-all', name: 'd' },
    ]);
  });

  it('adds no segment for route groups', () => {
    expect(patterns(['app/(marketing)/about/page.tsx', 'app/(a)/(b)/page.tsx'])).toEqual(['/', '/about']);
  });

  it('merges a slot page and a regular page into one pattern', () => {
    const table = discoverRoutes({
      files: ['app/photos/page.tsx', 'app/photos/@modal/page.tsx', 'app/@sidebar/photos/page.tsx'],
      appDir: 'app',
    });
    expect(table.routes.map((route) => route.pattern)).toEqual(['/photos', '/photos', '/photos']);
    expect(table.routes.map((route) => route.file)).toEqual([
      'app/@sidebar/photos/page.tsx',
      'app/photos/@modal/page.tsx',
      'app/photos/page.tsx',
    ]);
  });

  it('merges pages from different groups into one pattern', () => {
    expect(patterns(['app/(a)/x/page.tsx', 'app/(b)/x/page.tsx'])).toEqual(['/x', '/x']);
  });

  it('skips all four kinds of intercepting route', () => {
    expect(
      patterns([
        'app/feed/(.)photo/page.tsx',
        'app/feed/(..)photo/page.tsx',
        'app/feed/(..)(..)photo/page.tsx',
        'app/feed/(...)photo/page.tsx',
        'app/feed/(.)photo/deeper/page.tsx',
        'app/feed/page.tsx',
      ]),
    ).toEqual(['/feed']);
  });

  it('skips private folders at any depth', () => {
    expect(
      patterns(['app/_components/page.tsx', 'app/blog/_drafts/page.tsx', 'app/_a/b/page.tsx', 'app/blog/page.tsx']),
    ).toEqual(['/blog']);
  });

  it('maps dynamic, catch-all and optional catch-all segments', () => {
    expect(
      patterns([
        'app/[workspace]/settings/page.tsx',
        'app/docs/[...slug]/page.tsx',
        'app/shop/[[...filters]]/page.tsx',
      ]),
    ).toEqual(['/[workspace]/settings', '/docs/[...slug]', '/shop/[[...filters]]']);
  });

  it('accepts every page extension', () => {
    expect(patterns(['app/a/page.tsx', 'app/b/page.ts', 'app/c/page.jsx', 'app/d/page.js', 'app/e/page.mdx'])).toEqual(
      ['/a', '/b', '/c', '/d', '/e'],
    );
  });

  it('keeps handlers with kind handler', () => {
    expect(summarize(['app/api/auth/signin/route.ts', 'app/api/route.js', 'app/page.tsx'])).toEqual([
      { kind: 'handler', file: 'app/api/auth/signin/route.ts', pattern: '/api/auth/signin' },
      { kind: 'handler', file: 'app/api/route.js', pattern: '/api' },
      { kind: 'page', file: 'app/page.tsx', pattern: '/' },
    ]);
  });

  it('reads src/app and ignores files outside the app directory', () => {
    const files = ['src/app/page.tsx', 'src/app/team/page.tsx', 'src/pages/old.tsx', 'app/page.tsx'];
    expect(patterns(files, 'src/app')).toEqual(['/', '/team']);
    expect(patterns(files, 'app')).toEqual(['/']);
  });

  it('ignores files that are not pages or handlers', () => {
    expect(
      patterns([
        'app/layout.tsx',
        'app/loading.tsx',
        'app/error.tsx',
        'app/not-found.tsx',
        'app/template.tsx',
        'app/default.tsx',
        'app/page.css',
        'app/page.tsx.bak',
        'app/mypage.tsx',
        'app/route.json',
        'app/favicon.ico',
        'app/a/utils.ts',
      ]),
    ).toEqual([]);
  });

  it('is independent of input order', () => {
    const files = ['app/b/page.tsx', 'app/a/page.tsx', 'app/page.tsx'];
    expect(discoverRoutes({ files, appDir: 'app' })).toEqual(
      discoverRoutes({ files: files.toReversed(), appDir: 'app' }),
    );
  });

  it('rejects a directory name that cannot be a route pattern', () => {
    expect(() => discoverRoutes({ files: ['app/has space/page.tsx'], appDir: 'app' })).toThrow(NoriError);
  });
});
