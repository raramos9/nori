import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOrigin, parsePageUrl, type Origin } from '../graph/model.js';
import { crawlSite } from './crawl.js';

const SECRET = 'hunter2-not-for-logs';

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe('crawl interactions against a live browser', () => {
  const posted: string[] = [];
  let origin: Origin;
  const app: Server = createServer((req, res) => {
    if (req.method !== 'GET') {
      posted.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      return res.end('{}');
    }
    res.setHeader('content-type', 'text/html');
    switch (req.url) {
      case '/form':
        return res.end(
          html(`
            <form id="f"><label>Token <input name="token"></label><button type="submit">Send</button></form>
            <script>
              document.getElementById('f').addEventListener('submit', async (event) => {
                event.preventDefault();
                await fetch('/api/ok', { method: 'POST' });
                await fetch('/api/other', { method: 'POST' }).catch(() => {});
                history.pushState({}, '', '/done');
                document.body.textContent = 'done';
              });
            </script>`),
        );
      case '/done':
        return res.end(html('done'));
      case '/idle':
        return res.end(html('<button type="button">Nothing</button>'));
      case '/private':
        res.writeHead(302, { location: '/form' });
        return res.end();
      default:
        return res.end(html('<a href="/form">form</a>'));
    }
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    origin = parseOrigin(`http://127.0.0.1:${(app.address() as AddressInfo).port}`);
  });
  afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

  it('walks the clicked edge with only the named write allowed, and never logs a field value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-interact-'));
    const page = (path: string) => parsePageUrl(origin, path);
    const result = await crawlSite({
      origin,
      session: { kind: 'anonymous' },
      seeds: [page('/')],
      budgets: { maxCaptures: 20, maxNavigations: 20, maxMillis: 60_000 },
      dir,
      interactions: [
        {
          page: page('/form'),
          fill: [{ label: 'Token', value: SECRET }],
          click: 'Send',
          allow: [{ method: 'POST', path: '/api/ok' }],
        },
        { page: page('/private'), fill: [], click: 'Send', allow: [{ method: 'POST', path: '/api/ok' }] },
        { page: page('/idle'), fill: [], click: 'Missing', allow: [{ method: 'POST', path: '/api/ok' }] },
      ],
    });

    const interact = result.navigations.filter(({ start }) => start.kind === 'action' && start.action.kind === 'interact');
    expect(interact).toHaveLength(1);
    expect(interact[0]).toMatchObject({
      requested: page('/done'),
      redirects: [],
      start: { action: { kind: 'interact', page: page('/form'), click: 'Send', fields: ['Token'] } },
    });
    const landing = interact[0]?.landing;
    expect(landing?.kind === 'captured' && result.captures.find(({ key }) => key === landing.capture)?.url).toBe(page('/done'));

    expect(posted).toEqual(['POST /api/ok']);

    const network = readFileSync(join(dir, 'network.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; url: string; decision: string });
    const writes = network.filter(({ method, decision }) => method !== 'GET' && decision !== 'refused').map(({ method, url, decision }) => `${method} ${new URL(url).pathname} ${decision}`);
    expect(writes).toEqual(['POST /api/ok allowlisted', 'POST /api/other blocked']);

    const actions = readFileSync(join(dir, 'actions.ndjson'), 'utf8');
    expect(actions).not.toContain(SECRET);
    expect(actions).toMatch(/"outcome":"skipped".*landed on/);
    expect(actions).toMatch(/"outcome":"failed"/);
  }, 90_000);
});
