import { describe, expect, it } from 'vitest';
import { parseOrigin, parsePageUrl } from '../graph/model.js';
import { buildRedirects, decideRequest, followLinks } from './crawl.js';

const origin = parseOrigin('http://127.0.0.1:3000');
const page = (path: string) => parsePageUrl(origin, path);

describe('decideRequest', () => {
  it.each([
    ['GET', 'http://127.0.0.1:3000/a', 'allowed'],
    ['HEAD', 'http://127.0.0.1:3000/a?x=1', 'allowed'],
    ['get', 'http://127.0.0.1:3000/a', 'allowed'],
    ['POST', 'http://127.0.0.1:3000/api/session', 'blocked'],
    ['PUT', 'http://127.0.0.1:3000/a', 'blocked'],
    ['DELETE', 'http://127.0.0.1:3000/a', 'blocked'],
    ['GET', 'https://example.com/', 'blocked'],
    ['GET', 'http://127.0.0.1:3001/a', 'blocked'],
    ['GET', 'http://localhost:3000/a', 'blocked'],
    ['GET', 'https://127.0.0.1:3000/a', 'blocked'],
    ['GET', 'http://127.0.0.1:3000@evil.test/a', 'blocked'],
    ['GET', 'data:text/plain,hi', 'internal'],
    ['GET', 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/main.js', 'internal'],
    ['GET', 'chrome://resources/css/text_defaults_md.css', 'internal'],
    ['POST', 'blob:http://127.0.0.1:3000/abc', 'internal'],
    ['GET', 'ftp://127.0.0.1:3000/a', 'blocked'],
    ['GET', 'not a url', 'blocked'],
  ])('%s %s is %s', (method, url, expected) => {
    expect(decideRequest(origin, method, url)).toBe(expected);
  });
});

describe('followLinks', () => {
  it('keeps same-origin links, resolves relative ones and drops fragments', () => {
    const links = followLinks(origin, [
      { href: 'http://127.0.0.1:3000/about#team', name: 'About' },
      { href: '/pricing', name: 'Pricing' },
      { href: 'https://example.com/', name: 'Elsewhere' },
      { href: 'mailto:a@b.c', name: null },
    ]);
    expect(links).toEqual([
      { kind: 'follow-link', href: page('/about'), name: 'About' },
      { kind: 'follow-link', href: page('/pricing'), name: 'Pricing' },
    ]);
  });

  it('dedupes by href and prefers the first non-null name', () => {
    const links = followLinks(origin, [
      { href: '/a', name: null },
      { href: '/a#x', name: 'A' },
      { href: '/a', name: 'Other' },
    ]);
    expect(links).toEqual([{ kind: 'follow-link', href: page('/a'), name: 'A' }]);
  });

  it('keeps query strings distinct', () => {
    expect(followLinks(origin, [{ href: '/p?x=1', name: null }, { href: '/p?x=2', name: null }])).toHaveLength(2);
  });
});

describe('buildRedirects', () => {
  const abs = (path: string) => `${origin}${path}`;

  it('is empty when nothing moved', () => {
    const redirects = buildRedirects({ origin, requested: page('/a'), httpUrls: [abs('/a')], navigatedUrls: [abs('/a')], landing: page('/a') });
    expect(redirects).toEqual([]);
  });

  it('reads http hops from the request chain', () => {
    const redirects = buildRedirects({
      origin,
      requested: page('/dashboard'),
      httpUrls: [abs('/dashboard'), abs('/login')],
      navigatedUrls: [abs('/login')],
      landing: page('/login'),
    });
    expect(redirects).toEqual([{ to: page('/login'), via: 'http' }]);
  });

  it('reads client hops after the commit and chains them behind http hops', () => {
    const redirects = buildRedirects({
      origin,
      requested: page('/home'),
      httpUrls: [abs('/home'), abs('/start')],
      navigatedUrls: [abs('/start'), abs('/dashboard')],
      landing: page('/dashboard'),
    });
    expect(redirects).toEqual([
      { to: page('/start'), via: 'http' },
      { to: page('/dashboard'), via: 'client' },
    ]);
  });

  it('appends the landing when the page moved without a navigation event', () => {
    const redirects = buildRedirects({ origin, requested: page('/a'), httpUrls: [abs('/a')], navigatedUrls: [], landing: page('/b') });
    expect(redirects).toEqual([{ to: page('/b'), via: 'client' }]);
  });

  it('ends at the landing and ignores fragment-only moves', () => {
    const redirects = buildRedirects({ origin, requested: page('/a'), httpUrls: [abs('/a')], navigatedUrls: [abs('/a#top'), abs('/b#x')], landing: page('/b') });
    expect([page('/a'), ...redirects.map((r) => r.to)].at(-1)).toBe(page('/b'));
    expect(redirects).toEqual([{ to: page('/b'), via: 'client' }]);
  });
});

