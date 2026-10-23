import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Origin } from '../graph/model.js';

export type EgressDecision = { readonly method: string; readonly target: string; readonly allowed: boolean };

export type EgressProxy = { readonly server: string; readonly close: () => Promise<void> };

function hostPort(origin: Origin): { host: string; port: number } {
  const url = new URL(origin);
  return { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

// The browser's only route to the network. Chrome follows redirect hops and opens speculative
// connections (preconnect, prefetch) without asking Playwright's route handler, so the origin is
// enforced here, below the page, for every connection.
export async function startEgressProxy({
  origin,
  onDecision,
}: {
  origin: Origin;
  onDecision: (decision: EgressDecision) => void;
}): Promise<EgressProxy> {
  const allowed = hostPort(origin);
  const permits = (host: string, port: number) => host === allowed.host && port === allowed.port;
  const sockets = new Set<Socket>();

  const server = createServer((incoming: IncomingMessage, outgoing) => {
    let target: URL;
    try {
      target = new URL(incoming.url ?? '');
    } catch {
      outgoing.writeHead(400).end();
      return;
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const ok = target.protocol === 'http:' && permits(target.hostname, port);
    onDecision({ method: incoming.method ?? 'GET', target: target.href, allowed: ok });
    if (!ok) {
      outgoing.writeHead(403).end();
      return;
    }
    const upstream = httpRequest(
      { host: allowed.host, port: allowed.port, method: incoming.method, path: `${target.pathname}${target.search}`, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });

  server.on('connect', (incoming: IncomingMessage, client: Socket, head: Buffer) => {
    const [host = '', portText = ''] = (incoming.url ?? '').split(/:(?=\d+$)/);
    const port = Number(portText);
    const ok = permits(host.replace(/^\[|\]$/g, ''), port);
    onDecision({ method: 'CONNECT', target: incoming.url ?? '', allowed: ok });
    if (!ok) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(allowed.port, allowed.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  server.on('upgrade', (incoming: IncomingMessage, client: Socket) => {
    onDecision({ method: 'UPGRADE', target: incoming.url ?? '', allowed: false });
    client.destroy();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    // Chrome resets connections it abandons, and a refused CONNECT has no other listener to take the error.
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
