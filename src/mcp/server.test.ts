import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openLiveSnapshot, readOnlyBuildStore } from '../commands/mcp.js';
import { exploreGraph } from '../commands/explore.js';
import { toExplorerGraph, type ExplorerCapture, type ExplorerGraph, type ExplorerWalk } from '../explorer/view.js';
import { scan } from '../commands/scan.js';
import { evidenceId, runId } from '../graph/ids.js';
import {
  deriveEvidenceStatus,
  parseAnalyzerVersion,
  parseArtifactPath,
  parseCommitSha,
  parseEvidenceId,
  parseOrigin,
  parsePageUrl,
  parseRunId,
  type BuildGraph,
  type CaptureEvidence,
  type LoadedScreen,
} from '../graph/model.js';
import { demoHistory } from '../testing/demo-history.js';
import { gitFixture } from '../testing/git-fixture.js';
import { createMcpServer } from './server.js';
import type { BuildStore } from './builds.js';
import { createSnapshot } from './snapshot.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NO_BUILDS: BuildStore = { list: async () => [], load: async () => null };

async function connect({ graph, realRoot }: { graph: ExplorerGraph; realRoot: string }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const snapshot = createSnapshot({
    graph,
    key: { commitSha: parseCommitSha(graph.build.commitSha), sourceHash: '' },
  });
  await createMcpServer({
    current: async () => ({ snapshot, refreshError: null }),
    realRoot,
    builds: NO_BUILDS,
  }).connect(serverTransport);
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
    expect(tools.tools.map(({ name }) => name).sort()).toEqual(['diff_builds', 'get_screen', 'list_builds', 'list_screens', 'read_source']);
    for (const tool of tools.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

    const list = await client.callTool({ name: 'list_screens' });
    const listed = list.structuredContent as {
      build: { id: string; commitSha: string };
      coverage: { denominator: string; inferred: number; observed: number; exercisedByPassingTest: number };
      screens: { id: string; route: string; status: string; outgoing: number; unresolvedOutgoing: number }[];
    };
    expect(JSON.parse((list.content as { text: string }[])[0]!.text)).toEqual(list.structuredContent);
    expect(listed.build).toMatchObject({ id: graph.build.id, commitSha: graph.build.commitSha });
    expect(listed.screens.map(({ route, outgoing, unresolvedOutgoing }) => ({ route, outgoing, unresolvedOutgoing }))).toEqual([
      { route: '/', outgoing: 2, unresolvedOutgoing: 1 },
      { route: '/about', outgoing: 1, unresolvedOutgoing: 0 },
    ]);
    expect(listed.coverage).toEqual(graph.coverage);
    expect(listed.coverage).toMatchObject({ inferred: 3, observed: 0, exercisedByPassingTest: 0 });
    expect(listed.coverage.denominator).toMatch(/^candidate transitions in snapshot /);
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
    await createMcpServer({ current: live.current, realRoot: root, builds: readOnlyBuildStore(live.appKey) }).connect(serverTransport);
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

describe('nori MCP build tools', () => {
  const history = demoHistory('route-added-edge-removed');
  const baseRoot = `${history.root}-base`;
  const shots = mkdtempSync(join(tmpdir(), 'nori-mcp-shots-'));
  const origin = parseOrigin('http://localhost:3000');
  let base: BuildGraph;
  let head: BuildGraph;
  let live: Awaited<ReturnType<typeof openLiveSnapshot>>;

  beforeAll(async () => {
    execFileSync('git', ['worktree', 'add', '-q', '--detach', baseRoot, history.base], { cwd: history.root });
    base = await scan({ path: baseRoot, createdAt: new Date('2026-01-01T00:00:00Z') });
    head = await scan({ path: history.root, createdAt: new Date('2026-01-02T00:00:00Z') });
    live = await openLiveSnapshot({ path: history.root });
  });

  afterAll(() => {
    for (const dir of [baseRoot, history.root, shots]) rmSync(dir, { recursive: true, force: true });
  });

  async function serve(builds: BuildStore): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ current: live.current, realRoot: history.root, builds }).connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  const diffOf = (client: Client, from: BuildGraph, to: BuildGraph) =>
    client.callTool({ name: 'diff_builds', arguments: { base: from.snapshot.id, head: to.snapshot.id } });

  // A crawl of the home page in each snapshot; the PNG bytes decide whether the screenshot changed.
  function withCrawledHome(graph: BuildGraph, png: string): BuildGraph {
    const session = { kind: 'anonymous' } as const;
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const run = runId({ snapshotId: graph.snapshot.id, origin, session, startedAt });
    const file = join(shots, `${graph.snapshot.id}.png`);
    writeFileSync(file, png);
    const url = parsePageUrl(origin, '/');
    const identity = { kind: 'capture', runId: run, url } as const;
    const capture: CaptureEvidence = {
      ...identity,
      id: evidenceId(identity),
      httpStatus: 200,
      screenshot: parseArtifactPath(file),
      dom: parseArtifactPath(file),
    };
    return {
      ...graph,
      runs: [
        {
          id: run,
          snapshotId: graph.snapshot.id,
          origin,
          session,
          environment: 'local',
          seededBy: graph.analysis.analyzerVersion,
          startedAt,
          finishedAt: startedAt,
          stop: 'frontier-exhausted',
          crawlerVersion: 'test',
          requests: { allowed: 0, blocked: 0 },
        },
      ],
      screens: graph.screens.map((loaded) => {
        if (loaded.screen.routePattern !== '/') return loaded;
        const observations: LoadedScreen['observations'] = [
          ...loaded.observations,
          {
            evidence: capture,
            match: { verdict: 'supports', rule: 'rendered', url, pattern: loaded.screen.routePattern },
          },
        ];
        return { ...loaded, observations, status: deriveEvidenceStatus(observations) };
      }),
    };
  }

  it('lists snapshots newest first with their analyses and the served analyzer', async () => {
    const client = await serve(readOnlyBuildStore(live.appKey));
    const result = await client.callTool({ name: 'list_builds' });
    const listed = result.structuredContent as {
      servedAnalyzerVersion: string;
      servedAnalysisId: string;
      builds: { snapshotId: string }[];
    };
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(result.structuredContent);
    expect(listed.servedAnalysisId).toBe(head.analysis.id);
    expect(listed.servedAnalyzerVersion).toBe(head.analysis.analyzerVersion);
    expect(listed.builds.map(({ snapshotId }) => snapshotId)).toEqual([head.snapshot.id, base.snapshot.id]);
    expect(listed.builds[0]).toMatchObject({
      commitSha: head.snapshot.commitSha,
      worktree: 'clean',
      runCount: 0,
      analyses: [{ id: head.analysis.id, analyzerVersion: head.analysis.analyzerVersion, served: true }],
    });
  });

  it('diffs two snapshots and stays small enough to return inline', async () => {
    const client = await serve(readOnlyBuildStore(live.appKey));
    const result = await diffOf(client, base, head);
    const diff = result.structuredContent as {
      base: { snapshot: { id: string }; analysisId: string };
      head: { analysisId: string };
      changes: { kind: string }[];
    };
    expect(diff.base).toMatchObject({ snapshot: { id: base.snapshot.id }, analysisId: base.analysis.id });
    expect(diff.head.analysisId).toBe(head.analysis.id);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.changes.every(({ kind }) => kind === 'added' || kind === 'removed')).toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(8_000);
  });

  it('reports a screenshot change using the same digest as nori diff', async () => {
    const real = readOnlyBuildStore(live.appKey);
    const pngs = new Map([
      [base.analysis.id, 'before'],
      [head.analysis.id, 'after'],
    ]);
    const client = await serve({
      list: real.list,
      load: async (id) => {
        const graph = await real.load(id);
        return graph === null ? null : withCrawledHome(graph, pngs.get(id) ?? '');
      },
    });
    const result = await diffOf(client, base, head);
    const { changes } = result.structuredContent as { changes: { kind: string }[] };
    expect(changes.filter(({ kind }) => kind === 'screenshot-changed')).toMatchObject([
      {
        subject: { kind: 'screen', routePattern: '/' },
        session: 'anonymous',
        path: '/',
        base: { sha256: createHash('sha256').update('before').digest('hex') },
        head: { sha256: createHash('sha256').update('after').digest('hex') },
      },
    ]);
  });

  it('names both analyzer versions when the snapshots share none', async () => {
    const real = readOnlyBuildStore(live.appKey);
    const client = await serve({
      list: async () =>
        (await real.list()).map((build) =>
          build.snapshot.id === base.snapshot.id
            ? { ...build, analyses: [{ ...build.analyses[0], analyzerVersion: parseAnalyzerVersion('0.0.1-old') }] }
            : build,
        ),
      load: real.load,
    });
    const result = await diffOf(client, base, head);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('0.0.1-old');
    expect(text).toContain(head.analysis.analyzerVersion);
    expect(text).toContain('nori diff <base> <head>');
  });

  it('reports an unknown snapshot id as a tool error naming it', async () => {
    const client = await serve(readOnlyBuildStore(live.appKey));
    const result = await client.callTool({ name: 'diff_builds', arguments: { base: 'snap_nope', head: head.snapshot.id } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('snap_nope');
  });
});
