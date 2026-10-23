import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { parseOrigin } from '../graph/model.js';
import { launchIsolatedBrowser, openContext, RunRecorder } from './crawl.js';

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

const PROBES = ['/', '/meta', '/refresh', '/script', '/chain', '/here'] as const;

describe('crawl origin policy against a live browser', () => {
  const outsideConnections: string[] = [];
  const outside = createTcpServer((socket) => {
    outsideConnections.push('connect');
    socket.destroy();
  });
  let away = '';
  const page = (body: string) => `<!doctype html><html><head>${body}</head><body><a id="a" ping="${away}/ping" href="/landed">x</a></body></html>`;
  const app = createServer((req, res) => {
    const redirect = (location: string, status = 302) => {
      res.writeHead(status, { location });
      res.end();
    };
    res.setHeader('content-type', 'text/html');
    switch (req.url) {
      case '/chain':
        return redirect('/chain-2');
      case '/chain-2':
        return redirect(`${away}/chain`, 307);
      case '/here':
        return redirect('/landed');
      case '/meta':
        return res.end(page(`<meta http-equiv="refresh" content="0;url=${away}/meta">`));
      case '/refresh':
        res.setHeader('refresh', `0;url=${away}/refresh`);
        return res.end(page(''));
      case '/script':
        return res.end(page(`<script>location.href = '${away}/script'</script>`));
      case '/':
        return res.end(
          page(`
            <link rel="preconnect" href="${away}"><link rel="dns-prefetch" href="${away}">
            <link rel="prefetch" href="${away}/prefetch"><link rel="icon" href="${away}/icon.png">
            <style>@import url(${away}/style.css);</style>
            <script>
              new WebSocket('${away.replace('http', 'ws')}/socket');
              fetch('${away}/fetch').catch(() => {});
              fetch('/api', { method: 'POST' }).catch(() => {});
              navigator.sendBeacon('${away}/beacon', 'x');
              addEventListener('load', () => document.getElementById('a').click());
            </script>
            <iframe src="${away}/frame"></iframe>`),
        );
      default:
        return res.end(page(''));
    }
  });
  let appPort = 0;

  beforeAll(async () => {
    away = `http://127.0.0.1:${await listen(outside)}`;
    appPort = await listen(app);
  });
  afterAll(() => {
    outside.close();
    app.close();
  });

  it('opens no connection to another origin, and still follows same-origin redirects', async (test) => {
    const origin = parseOrigin(`http://127.0.0.1:${appPort}`);
    const dir = mkdtempSync(join(tmpdir(), 'nori-policy-'));
    const recorder = new RunRecorder(dir);
    const isolated = await launchIsolatedBrowser({ origin, recorder }).catch((error: unknown) => {
      if (error instanceof NoriError) test.skip('system Chrome is not installed');
      throw error;
    });
    let landed = '';
    try {
      const context = await openContext(isolated.browser, { origin, recorder });
      for (const path of PROBES) {
        const tab = await context.newPage();
        await tab.goto(`${origin}${path}`).catch(() => undefined);
        await tab.waitForTimeout(1500);
        if (path === '/here') landed = tab.url();
        await tab.close();
      }
    } finally {
      await isolated.close();
      await recorder.close();
    }
    expect(outsideConnections).toEqual([]);
    expect(landed).toBe(`${origin}/landed`);
    const entries = readFileSync(join(dir, 'network.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; url: string; decision: string });
    const blocked = entries
      .filter(({ decision }) => decision === 'blocked')
      .map(({ method }) => method);
    expect(blocked).toContain('POST');
    expect(entries.filter(({ decision }) => decision === 'refused').length).toBeGreaterThan(0);
  }, 120_000);
});
