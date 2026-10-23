import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { errorCode } from '../errors.js';
import { isInside, readSnippet, sourceIndex, statIfPresent } from './source.js';
import type { ExplorerGraph } from './view.js';

const LOOPBACK = '127.0.0.1';

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

type Artifacts = { readonly screenshotPath: string; readonly domPath: string | null };

function artifactIndex(graph: ExplorerGraph): ReadonlyMap<string, Artifacts> {
  const index = new Map<string, Artifacts>();
  for (const { captures } of graph.screens) {
    for (const capture of captures) {
      index.set(capture.evidenceId, { screenshotPath: capture.screenshotPath, domPath: capture.domPath });
    }
  }
  for (const { walks } of graph.transitions) {
    for (const { landing } of walks) {
      if (!index.has(landing.evidenceId)) index.set(landing.evidenceId, { screenshotPath: landing.screenshotPath, domPath: null });
    }
  }
  return index;
}

async function serveArtifact({
  artifacts,
  evidenceId,
  kind,
  response,
  head,
}: {
  artifacts: ReadonlyMap<string, Artifacts>;
  evidenceId: string;
  kind: string;
  response: ServerResponse;
  head: boolean;
}): Promise<void> {
  const entry = artifacts.get(evidenceId);
  const path = kind === 'screenshot' ? entry?.screenshotPath : kind === 'dom' ? entry?.domPath : undefined;
  if (path === undefined || path === null) return sendError(response, 404, 'no such artifact');
  const body = await readFile(path).catch((error: unknown) => {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  });
  if (body === null) return sendError(response, 404, 'no such artifact');

  // The DOM is the crawled app's own HTML. As text/html it would run that app's scripts on this origin,
  // next to /api/source.
  response.writeHead(200, {
    'content-type': kind === 'screenshot' ? 'image/png' : 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'no-cache',
  });
  response.end(head ? undefined : body);
}

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
  const artifacts = artifactIndex(graph);
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
      default: {
        const artifact = /^\/artifacts\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (artifact !== null) {
          return serveArtifact({
            artifacts,
            evidenceId: artifact[1] ?? '',
            kind: artifact[2] ?? '',
            response,
            head: request.method === 'HEAD',
          });
        }
        if (url.pathname.startsWith('/api/')) return sendError(response, 404, 'not found');
        return serveStatic({ uiDir: ui, pathname: url.pathname, response, head: request.method === 'HEAD' });
      }
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
