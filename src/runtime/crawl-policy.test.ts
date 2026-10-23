import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { parseOrigin } from '../graph/model.js';
import { launchChrome, openContext, RunRecorder } from './crawl.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe('crawl origin policy against a live browser', () => {
  const outsideHits: string[] = [];
  const outside = createServer((req, res) => {
    outsideHits.push(`${req.method} ${req.url}`);
    res.end('outside');
  });
  outside.on('upgrade', (req, socket) => {
    outsideHits.push(`WEBSOCKET ${req.url}`);
    socket.destroy();
  });
  let outsidePort = 0;
  const app = createServer((req, res) => {
    if (req.url === '/away') {
      res.writeHead(302, { location: `http://127.0.0.1:${outsidePort}/redirected` });
      res.end();
      return;
    }
    if (req.url === '/here') {
      res.writeHead(302, { location: '/landed' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      req.url === '/'
        ? `<script>
            new WebSocket('ws://127.0.0.1:${outsidePort}/sock');
            fetch('http://127.0.0.1:${outsidePort}/fetch').catch(() => {});
            fetch('/api', { method: 'POST' }).catch(() => {});
            navigator.sendBeacon('http://127.0.0.1:${outsidePort}/beacon', 'x');
          </script><img src="/away">`
        : '<p>ok</p>',
    );
  });
  let appPort = 0;

  beforeAll(async () => {
    outsidePort = await listen(outside);
    appPort = await listen(app);
  });
  afterAll(() => {
    outside.close();
    app.close();
  });

  it('lets nothing reach another origin, and still follows same-origin redirects', async (test) => {
    const origin = parseOrigin(`http://127.0.0.1:${appPort}`);
    const dir = mkdtempSync(join(tmpdir(), 'nori-policy-'));
    const recorder = new RunRecorder(dir);
    const browser = await launchChrome().catch((error: unknown) => {
      if (error instanceof NoriError) test.skip('system Chrome is not installed');
      throw error;
    });
    try {
      const context = await openContext(browser, { origin, recorder });
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      await page.waitForTimeout(1000);
      await expect(page.goto(`${origin}/away`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      const next = await context.newPage();
      await next.goto(`${origin}/here`);
      expect(next.url()).toBe(`${origin}/landed`);
    } finally {
      await browser.close();
      await recorder.close();
    }
    expect(outsideHits).toEqual([]);
    const blocked = readFileSync(join(dir, 'network.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; url: string; decision: string })
      .filter(({ decision }) => decision === 'blocked')
      .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
    expect(blocked).toEqual(expect.arrayContaining(['WEBSOCKET /sock', 'GET /fetch', 'POST /api', 'GET /redirected']));
  }, 60_000);
});
