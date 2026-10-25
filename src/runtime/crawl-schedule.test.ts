import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOrigin, parsePageUrl, type Origin, type PageUrl } from '../graph/model.js';
import { crawlSite } from './crawl.js';

const links = (...hrefs: string[]) => hrefs.map((href) => `<a href="${href}">${href}</a>`).join('');

describe('crawl scheduling', () => {
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const path = req.url ?? '/';
    const body =
      path === '/' ? links('/item/1', '/item/2', '/item/3', '/item/4', '/about') : path.startsWith('/item/') ? links(`/deep/${path.slice(6)}`) : '';
    res.end(`<!doctype html><html><body>${body}</body></html>`);
  });
  let origin: Origin;

  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    origin = parseOrigin(`http://127.0.0.1:${(app.address() as AddressInfo).port}`);
  });
  afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

  it('walks each new screen-to-screen link before repeating one, so a tight budget reaches every screen', async () => {
    const screenKey = (url: PageUrl) => new URL(url).pathname.replace(/\/\d+$/, '/[n]');
    const result = await crawlSite({
      origin,
      session: { kind: 'anonymous' },
      seeds: [parsePageUrl(origin, '/')],
      budgets: { maxCaptures: 4, maxNavigations: 100, maxMillis: 60_000 },
      dir: mkdtempSync(join(tmpdir(), 'nori-schedule-')),
      screenKey,
    });

    expect(result.stop).toBe('budget');
    expect(result.captures.map(({ url }) => new URL(url).pathname)).toEqual(['/', '/item/1', '/about', '/deep/1']);
  });
});
