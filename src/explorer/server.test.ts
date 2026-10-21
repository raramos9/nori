import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEvidenceId, parseRoutePattern, parseScreenId } from '../graph/model.js';
import { startExplorerServer, type ExplorerServer } from './server.js';
import type { ExplorerGraph, SourceRef } from './view.js';

const tempDirs: string[] = [];
const servers: ExplorerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nori-explorer-')));
  tempDirs.push(dir);
  return dir;
}

const EVIDENCE = {
  ok: 'evd_0000000000000001',
  top: 'evd_0000000000000002',
  symlinkFile: 'evd_0000000000000003',
  symlinkDir: 'evd_0000000000000004',
  dotdot: 'evd_0000000000000005',
  missing: 'evd_0000000000000006',
  unknown: 'evd_00000000000000ff',
} as const;

function ref(id: string, file: string, line: number): SourceRef {
  return {
    evidenceId: parseEvidenceId(id),
    file,
    start: { line, column: 1 },
    end: { line, column: 5 },
    extractor: 'test',
  };
}

type Fixture = { readonly server: ExplorerServer; readonly origin: string; readonly port: number };

async function fixture(): Promise<Fixture> {
  const root = tempDir();
  const outside = tempDir();
  const uiDir = tempDir();
  writeFileSync(join(root, 'page.tsx'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(outside, join(root, 'linked'));
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>explorer</title>');
  mkdirSync(join(uiDir, 'assets'));
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(outside, 'index.html'), 'outside');

  const graph = {
    root,
    build: { id: 'b', commitSha: 'a'.repeat(40), branch: 'main', createdAt: '2026-01-01T00:00:00.000Z', analyzerVersion: '1' },
    screens: [
      {
        id: parseScreenId('scr_0000000000000001'),
        route: parseRoutePattern('/'),
        status: 'inferred',
        sources: [
          ref(EVIDENCE.ok, 'page.tsx', 10),
          ref(EVIDENCE.top, 'page.tsx', 1),
          ref(EVIDENCE.symlinkFile, 'leak.txt', 1),
          ref(EVIDENCE.symlinkDir, 'linked/secret.txt', 1),
          ref(EVIDENCE.dotdot, '../../../../etc/hosts', 1),
          ref(EVIDENCE.missing, 'gone.tsx', 1),
        ],
      },
    ],
    transitions: [],
  } satisfies ExplorerGraph;

  const server = await startExplorerServer({ graph, uiDir });
  servers.push(server);
  const url = new URL(server.url);
  return { server, origin: server.url, port: Number(url.port) };
}

type Reply = { readonly status: number; readonly body: string };

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('explorer server', () => {
  it('binds to loopback and serves the graph', async () => {
    const { origin } = await fixture();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const reply = await get(`${origin}api/graph`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ build: { branch: 'main' }, transitions: [] });
  });

  it('returns a snippet around the span', async () => {
    const { origin } = await fixture();
    const reply = await get(`${origin}api/source?evidence=${EVIDENCE.ok}`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      file: 'page.tsx',
      startLine: 7,
      lines: ['line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13'],
    });
    const top = JSON.parse((await get(`${origin}api/source?evidence=${EVIDENCE.top}`)).body);
    expect(top.startLine).toBe(1);
  });

  it.each(['unknown', 'symlinkFile', 'symlinkDir', 'dotdot', 'missing'] as const)(
    'refuses source for evidence %s',
    async (evidence) => {
      const { origin } = await fixture();
      expect((await get(`${origin}api/source?evidence=${EVIDENCE[evidence]}`)).status).toBe(404);
    },
  );

  it('refuses a source request without an evidence id', async () => {
    const { origin } = await fixture();
    expect((await get(`${origin}api/source`)).status).toBe(404);
  });

  it('rejects requests whose Host is not the loopback origin', async () => {
    const { origin, port } = await fixture();
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      expect((await get(`${origin}api/graph`, { host })).status).toBe(403);
    }
    expect((await get(`${origin}api/graph`, { host: `localhost:${port}` })).status).toBe(200);
  });

  it('serves static files, falls back to index.html, and does not escape the UI directory', async () => {
    const { origin, port } = await fixture();
    expect((await get(`${origin}assets/app.js`)).body).toBe('console.log(1);');
    expect((await get(`${origin}some/client/route`)).body).toContain('<title>explorer</title>');
    expect((await get(`${origin}api/nope`)).status).toBe(404);

    const raw = await new Promise<Reply>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/..%2f/secret.txt' }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, body: '' });
      });
      req.on('error', reject);
      req.end();
    });
    expect(raw.status).not.toBe(200);
  });

  it('rejects methods other than GET and HEAD', async () => {
    const { origin } = await fixture();
    expect((await get(`${origin}api/graph`, {}, 'POST')).status).toBe(405);
  });
});
