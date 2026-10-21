import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { errorCode } from '../errors.js';
import type { ExplorerGraph, SourceRef } from './view.js';

const LOOPBACK = '127.0.0.1';
const CONTEXT_LINES = 3;
const MAX_SNIPPET_LINES = 24;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export type SourceSnippet = {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
};

export type ExplorerServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

function isInside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

// The scanned repo is untrusted: a committed symlink must not let the browser read outside it.
async function readSnippet({ realRoot, ref }: { realRoot: string; ref: SourceRef }): Promise<SourceSnippet | null> {
  let real: string;
  try {
    real = await realpath(join(realRoot, ref.file));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!isInside(realRoot, real) || real === realRoot) return null;
  const info = await statIfPresent(real);
  if (info === null || !info.isFile() || info.size > MAX_SOURCE_BYTES) return null;

  const all = (await readFile(real, 'utf8')).split(/\r\n|\n|\r/);
  const first = Math.max(1, ref.start.line - CONTEXT_LINES);
  const last = Math.min(
    all.length,
    Math.max(ref.end.line, ref.start.line) + CONTEXT_LINES,
    first + MAX_SNIPPET_LINES - 1,
  );
  if (first > all.length) return null;
  return { file: ref.file, startLine: first, lines: all.slice(first - 1, last) };
}

function sourceIndex(graph: ExplorerGraph): ReadonlyMap<string, SourceRef> {
  const index = new Map<string, SourceRef>();
  for (const { sources } of [...graph.screens, ...graph.transitions]) {
    for (const ref of sources) index.set(ref.evidenceId, ref);
  }
  return index;
}

async function serveStatic({
  uiDir,
  pathname,
  response,
  head,
}: {
  uiDir: string;
  pathname: string;
  response: ServerResponse;
  head: boolean;
}): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendError(response, 400, 'bad path');
  }
  if (decoded.includes('\0')) return sendError(response, 400, 'bad path');

  const candidate = resolve(uiDir, `.${decoded}`);
  if (!isInside(uiDir, candidate)) return sendError(response, 404, 'not found');

  const info = await statIfPresent(candidate);
  const file = info?.isFile() ? candidate : join(uiDir, 'index.html');
  const body = await readFile(file).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (body === null) return sendError(response, 404, 'the explorer UI is not built; run pnpm build');

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  response.end(head ? undefined : body);
}

export async function startExplorerServer({
  graph,
  uiDir,
  port = 0,
}: {
  graph: ExplorerGraph;
  uiDir: string;
  port?: number;
}): Promise<ExplorerServer> {
  const realRoot = await realpath(graph.root);
  const sources = sourceIndex(graph);
  const ui = resolve(uiDir);
  let allowedHosts: ReadonlySet<string> = new Set();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase();
    if (host === undefined || !allowedHosts.has(host)) return sendError(response, 403, 'forbidden host');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return sendError(response, 405, 'method not allowed');
    }

    const url = new URL(request.url ?? '/', `http://${host}`);
    switch (url.pathname) {
      case '/api/graph':
        return sendJson(response, 200, graph);
      case '/api/source': {
        const evidence = url.searchParams.get('evidence');
        const ref = evidence === null ? undefined : sources.get(evidence);
        const snippet = ref === undefined ? null : await readSnippet({ realRoot, ref });
        if (snippet === null) return sendError(response, 404, 'no such source');
        return sendJson(response, 200, snippet);
      }
      default:
        if (url.pathname.startsWith('/api/')) return sendError(response, 404, 'not found');
        return serveStatic({ uiDir: ui, pathname: url.pathname, response, head: request.method === 'HEAD' });
    }
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      process.stderr.write(`nori: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!response.headersSent) sendError(response, 500, 'internal error');
      else response.destroy();
    });
  });

  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Explorer server has no TCP address');
  const boundPort = address.port;
  allowedHosts = new Set([`${LOOPBACK}:${boundPort}`, `localhost:${boundPort}`]);

  return {
    url: `http://${LOOPBACK}:${boundPort}/`,
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        server.close((error) => (error === undefined ? resolveClosed() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
