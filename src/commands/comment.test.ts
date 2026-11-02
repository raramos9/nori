import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { COMMENT_LIMIT, MARKER, runComment } from './comment.js';

type Recorded = { method: string; url: string; authorization: string | undefined; body: string };
type StoredComment = { id: number; body: string };

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'ghs_testtoken';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

type Fake = {
  origin: string;
  readonly requests: Recorded[];
  readonly comments: StoredComment[];
  failWrites: number | undefined;
  close: () => Promise<void>;
};

async function startFake(): Promise<Fake> {
  const requests: Recorded[] = [];
  const comments: StoredComment[] = [];
  const fake: Fake = {
    origin: '',
    requests,
    comments,
    failWrites: undefined,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? '/', 'http://fake');
    requests.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== 'GET' && fake.failWrites !== undefined) return send(fake.failWrites, { message: 'nope' });
    const list = url.pathname.match(/^\/repos\/octo\/app\/issues\/7\/comments$/);
    const one = url.pathname.match(/^\/repos\/octo\/app\/issues\/comments\/(\d+)$/);
    if (request.method === 'GET' && list) {
      const perPage = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      const slice = comments.slice((page - 1) * perPage, page * perPage);
      const more = page * perPage < comments.length;
      return send(200, slice, more ? { Link: `<http://fake/next>; rel="next"` } : { Link: `<http://fake/first>; rel="first"` });
    }
    if (request.method === 'POST' && list) {
      const created = { id: 1000 + comments.length, body: (JSON.parse(body) as { body: string }).body };
      comments.push(created);
      return send(201, created);
    }
    if (request.method === 'PATCH' && one) {
      const found = comments.find(({ id }) => id === Number(one[1]));
      if (found === undefined) return send(404, { message: 'missing' });
      found.body = (JSON.parse(body) as { body: string }).body;
      return send(200, found);
    }
    return send(404, { message: 'no route' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

describe('nori comment', () => {
  let dir: string;
  let fake: Fake;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nori-comment-'));
    fake = await startFake();
  });

  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function env(event: unknown = { pull_request: { number: 7 } }): NodeJS.ProcessEnv {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, typeof event === 'string' ? event : JSON.stringify(event));
    return {
      GITHUB_TOKEN: TOKEN,
      GITHUB_API_URL: fake.origin,
      GITHUB_REPOSITORY: 'octo/app',
      GITHUB_EVENT_PATH: eventPath,
    };
  }

  async function post(markdown: string, environment = env()): Promise<number> {
    const file = join(dir, 'diff.md');
    writeFileSync(file, markdown);
    return runComment([file], environment);
  }

  const writes = () => fake.requests.filter(({ method }) => method !== 'GET');

  it('creates one marked comment on the first run', async () => {
    expect(await post('first diff')).toBe(0);
    expect(writes().map(({ method, url }) => `${method} ${url}`)).toEqual(['POST /repos/octo/app/issues/7/comments']);
    expect(fake.comments.map(({ body }) => body)).toEqual([`${MARKER}\nfirst diff`]);
  });

  it('edits the same comment in place on a second run', async () => {
    await post('first diff');
    const [created] = fake.comments;
    expect(await post('second diff')).toBe(0);
    expect(fake.comments).toEqual([{ id: created!.id, body: `${MARKER}\nsecond diff` }]);
    expect(writes().map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /repos/octo/app/issues/7/comments',
      `PATCH /repos/octo/app/issues/comments/${created!.id}`,
    ]);
  });

  it('finds the marker comment on a later page and leaves other comments alone', async () => {
    for (let i = 0; i < 100; i++) fake.comments.push({ id: i + 1, body: `chatter ${i}` });
    fake.comments.push({ id: 500, body: `${MARKER}\nold` });
    expect(await post('new')).toBe(0);
    expect(writes().map(({ method, url }) => `${method} ${url}`)).toEqual(['PATCH /repos/octo/app/issues/comments/500']);
    expect(fake.comments).toHaveLength(101);
    const pages = fake.requests.filter(({ method }) => method === 'GET').map(({ url }) => url);
    expect(pages).toEqual([
      '/repos/octo/app/issues/7/comments?per_page=100&page=1',
      '/repos/octo/app/issues/7/comments?per_page=100&page=2',
    ]);
  });

  it('is not a failure when the token is read-only', async () => {
    fake.failWrites = 403;
    expect(await post('diff')).toBe(0);
    expect(fake.comments).toEqual([]);
  });

  it('reports a server error with its status and body', async () => {
    fake.failWrites = 500;
    await expect(post('diff')).rejects.toThrow(/POST .* failed with 500: .*nope/);
  });

  it('truncates a body over the limit and points at the job summary', async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `| added | \`screen /r${i}\` |`);
    await post(rows.join('\n'));
    const [stored] = fake.comments;
    expect(stored!.body.length).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(stored!.body.startsWith(MARKER)).toBe(true);
    expect(stored!.body).toMatch(/job summary has the whole diff\._$/);
    expect(stored!.body).not.toMatch(/\| added \| `screen \/r\d*$/m);
  });

  it('sends the token to the fake origin only', async () => {
    await post('one');
    await post('two');
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url.startsWith('/repos/octo/app/issues')).toBe(true);
    }
  });

  it('names the problem for a malformed event file', async () => {
    await expect(post('diff', env('{not json'))).rejects.toThrow(NoriError);
    await expect(post('diff', env('{not json'))).rejects.toThrow(/is not JSON/);
    await expect(post('diff', env({ action: 'push' }))).rejects.toThrow(/not a pull_request event/);
    expect(fake.requests).toEqual([]);
  });

  it('names a missing variable', async () => {
    const { GITHUB_TOKEN: _token, ...rest } = env();
    await expect(post('diff', rest)).rejects.toThrow('GITHUB_TOKEN is not set');
  });
});

describe('action/action.yml', () => {
  const action = readFileSync(join(ROOT, 'action/action.yml'), 'utf8');

  it('never interpolates expressions into a run body', () => {
    const lines = action.split('\n');
    const bodies: string[] = [];
    lines.forEach((line, index) => {
      const run = line.match(/^(\s*)(?:- )?run:/);
      if (run === null) return;
      const indent = run[1]!.length;
      const body = [line.slice(line.indexOf('run:') + 4)];
      for (const next of lines.slice(index + 1)) {
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
        body.push(next);
      }
      bodies.push(body.join('\n'));
    });
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain('${{');
  });

  it('is a composite action that builds nori from its own checkout', () => {
    expect(action).toContain("using: composite");
    expect(action).toContain('github.action_path');
    expect(action).not.toContain('pull_request_target');
  });
});
