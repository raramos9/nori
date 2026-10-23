import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openLiveSnapshot } from '../commands/mcp.js';
import { exploreGraph } from '../commands/explore.js';
import { toExplorerGraph, type ExplorerCapture, type ExplorerGraph, type ExplorerWalk } from '../explorer/view.js';
import { parseCommitSha, parseEvidenceId, parseRunId } from '../graph/model.js';
import { gitFixture } from '../testing/git-fixture.js';
import { createMcpServer } from './server.js';
import { createSnapshot } from './snapshot.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect({ graph, realRoot }: { graph: ExplorerGraph; realRoot: string }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const snapshot = createSnapshot({
    graph,
    key: { commitSha: parseCommitSha(graph.build.commitSha), sourceHash: '' },
  });
  await createMcpServer({ current: async () => ({ snapshot, refreshError: null }), realRoot }).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function analyze(): Promise<{ root: string; graph: ExplorerGraph }> {
  const root = gitFixture();
  tempDirs.push(root);
  const scanned = await exploreGraph({ path: root });
  return { root, graph: toExplorerGraph({ root, graph: scanned.graph }) };
}

describe('nori MCP server', () => {
  it('lets an agent go from the screen list to a transition to its source span', async () => {
    const { root, graph } = await analyze();
    const client = await connect({ graph, realRoot: root });

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual(['get_screen', 'list_screens', 'read_source']);
    for (const tool of tools.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

    const list = await client.callTool({ name: 'list_screens' });
    const listed = list.structuredContent as {
      build: { id: string; commitSha: string };
      screens: { id: string; route: string; status: string; outgoing: number; unresolvedOutgoing: number }[];
    };
    expect(JSON.parse((list.content as { text: string }[])[0]!.text)).toEqual(list.structuredContent);
    expect(listed.build).toMatchObject({ id: graph.build.id, commitSha: graph.build.commitSha });
    expect(listed.screens.map(({ route, outgoing, unresolvedOutgoing }) => ({ route, outgoing, unresolvedOutgoing }))).toEqual([
      { route: '/', outgoing: 2, unresolvedOutgoing: 1 },
      { route: '/about', outgoing: 1, unresolvedOutgoing: 0 },
    ]);
    expect(listed.screens.every(({ status }) => status === 'inferred')).toBe(true);
    expect(listed.screens[0]).not.toHaveProperty('sources');

    const home = listed.screens[0]!;
    const about = listed.screens[1]!;
    const homeResult = await client.callTool({ name: 'get_screen', arguments: { screenId: home.id } });
    const detail = homeResult.structuredContent as {
      outgoing: { status: string; target: Record<string, string>; sources: { evidenceId: string }[] }[];
      incoming: { sourceRoute: string }[];
    };
    const resolved = detail.outgoing.find(({ target }) => target.kind === 'screen')!;
    expect(resolved).toMatchObject({ status: 'inferred', target: { screenId: about.id, route: '/about' } });
    const unresolved = detail.outgoing.find(({ target }) => target.kind === 'unresolved')!;
    expect(unresolved).toMatchObject({ status: 'inferred', target: { expression: 'target' } });
    expect(detail.incoming.map(({ sourceRoute }) => sourceRoute)).toEqual(['/about']);

    const source = await client.callTool({
      name: 'read_source',
      arguments: { evidenceId: unresolved.sources[0]!.evidenceId },
    });
    const snippet = source.structuredContent as { file: string; extractor: string; startLine: number; lines: string[] };
    expect(snippet.file).toBe('app/page.tsx');
    expect(snippet.lines.join('\n')).toContain('<Link href={target}>');
  });

  it('surfaces captures, sessions and the screenshot path of runtime evidence', async () => {
    const { root, graph } = await analyze();
    const runId = parseRunId('run_0000000000000001');
    const captureFor = (n: number, session: string, verdict: ExplorerCapture['verdict']): ExplorerCapture => ({
      evidenceId: parseEvidenceId(`evd_00000000000000${n}0`),
      runId,
      session,
      url: 'http://localhost:3000/',
      httpStatus: 200,
      verdict,
      screenshotPath: `/runs/${session}-${n}.png`,
      domPath: `/runs/${session}-${n}.html`,
    });
    const walk = (session: string): ExplorerWalk => ({
      evidenceId: parseEvidenceId('evd_0000000000000099'),
      runId,
      session,
      rule: 'action-runtime-only',
      hop: null,
      requested: 'http://localhost:3000/about',
      redirects: [],
      skipped: [],
      landing: { evidenceId: parseEvidenceId('evd_0000000000000098'), url: 'http://localhost:3000/about', screenshotPath: '/runs/landing.png' },
    });
    const unresolved = graph.transitions.find(({ target }) => target.kind === 'unresolved')!;
    const forged: ExplorerGraph = {
      ...graph,
      screens: graph.screens.map((screen) =>
        screen.route === '/'
          ? {
              ...screen,
              captures: [captureFor(3, 'signed-in', 'supports'), captureFor(2, 'anonymous', 'contradicts'), captureFor(1, 'anonymous', 'supports')],
            }
          : screen,
      ),
      transitions: graph.transitions.map((transition) =>
        transition.id === unresolved.id
          ? transition
          : transition.sourceScreenId === unresolved.sourceScreenId
            ? { ...transition, runtimeOnly: true, observedIn: ['anonymous', 'signed-in'], walks: [walk('anonymous'), walk('signed-in')], mayExplain: [unresolved.id] }
            : transition,
      ),
    };
    const client = await connect({ graph: forged, realRoot: root });

    const listed = (await client.callTool({ name: 'list_screens' })).structuredContent as {
      screens: { route: string; screenshotPath: string | null }[];
    };
    expect(listed.screens.map(({ route, screenshotPath }) => [route, screenshotPath])).toEqual([
      ['/', '/runs/anonymous-1.png'],
      ['/about', null],
    ]);
    expect(listed.screens[0]).not.toHaveProperty('captures');

    const home = forged.screens.find(({ route }) => route === '/')!;
    const detail = (await client.callTool({ name: 'get_screen', arguments: { screenId: home.id } })).structuredContent as {
      screen: { captures: { session: string; screenshotPath: string }[] };
      outgoing: { id: string; runtimeOnly: boolean; observedIn: string[]; mayExplain?: string[] }[];
    };
    expect(detail.screen.captures.map(({ session }) => session)).toEqual(['signed-in', 'anonymous', 'anonymous']);
    const runtimeOnly = detail.outgoing.find(({ runtimeOnly: only }) => only)!;
    expect(runtimeOnly).toMatchObject({ observedIn: ['anonymous', 'signed-in'], mayExplain: [unresolved.id] });
    expect(runtimeOnly).not.toHaveProperty('walks');
    const explained = detail.outgoing.find(({ id }) => id === unresolved.id)!;
    expect(explained).toMatchObject({ runtimeOnly: false, observedIn: [] });
    expect(explained).not.toHaveProperty('mayExplain');
  });

  it('shows the linking screen as incoming on the target', async () => {
    const { root, graph } = await analyze();
    const client = await connect({ graph, realRoot: root });
    const about = graph.screens.find(({ route }) => route === '/about')!;

    const result = await client.callTool({ name: 'get_screen', arguments: { screenId: about.id } });
    const { incoming } = result.structuredContent as {
      incoming: { sourceRoute: string; status: string }[];
    };
    expect(incoming).toMatchObject([{ sourceRoute: '/', status: 'inferred' }]);
  });

  it('reports unknown ids as tool errors naming the id', async () => {
    const { root, graph } = await analyze();
    const client = await connect({ graph, realRoot: root });

    const screen = await client.callTool({ name: 'get_screen', arguments: { screenId: 'nope' } });
    expect(screen.isError).toBe(true);
    expect(JSON.stringify(screen.content)).toContain('nope');

    const evidence = await client.callTool({ name: 'read_source', arguments: { evidenceId: 'missing' } });
    expect(evidence.isError).toBe(true);
    expect(JSON.stringify(evidence.content)).toContain('missing');
  });

  it('refuses a source file that is a symlink out of the repo', async () => {
    const { root, graph } = await analyze();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nori-mcp-outside-')));
    tempDirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.tsx'));
    const forged: ExplorerGraph = {
      ...graph,
      screens: graph.screens.map((screen) => ({
        ...screen,
        sources: screen.sources.map((ref) => ({ ...ref, file: 'leak.tsx' })),
      })),
    };
    const client = await connect({ graph: forged, realRoot: root });

    const evidenceId = forged.screens[0]!.sources[0]!.evidenceId;
    const result = await client.callTool({ name: 'read_source', arguments: { evidenceId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('serves a fresh graph after an uncommitted edit', async () => {
    const root = gitFixture();
    tempDirs.push(root);
    const live = await openLiveSnapshot({ path: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ current: live.current, realRoot: root }).connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    type Listed = { build: { id: string; refreshError: string | null }; screens: { route: string }[] };

    const before = (await client.callTool({ name: 'list_screens' })).structuredContent as Listed;
    expect(before.screens.map(({ route }) => route)).toEqual(['/', '/about']);
    const again = (await client.callTool({ name: 'list_screens' })).structuredContent as Listed;
    expect(again.build.id).toBe(before.build.id);

    mkdirSync(join(root, 'app/pricing'));
    writeFileSync(join(root, 'app/pricing/page.tsx'), 'export default function Page() {\n  return null;\n}\n');

    const after = (await client.callTool({ name: 'list_screens' })).structuredContent as Listed;
    expect(after.screens.map(({ route }) => route)).toEqual(['/', '/about', '/pricing']);
    expect(after.build.id).not.toBe(before.build.id);
    expect(after.build.refreshError).toBeNull();
  });
});
