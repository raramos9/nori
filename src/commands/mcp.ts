import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toExplorerGraph } from '../explorer/view.js';
import { sourceHash } from '../graph/source-hash.js';
import { discoverProject } from '../next/project.js';
import { createLiveSnapshot, type LiveSnapshot } from '../mcp/live.js';
import { createMcpServer } from '../mcp/server.js';
import { createSnapshot, type Snapshot } from '../mcp/snapshot.js';
import type { Command } from './command.js';
import { exploreGraph } from './explore.js';

// The SDK's stdio transport never notices the client hanging up, so watch stdin ourselves.
function untilClosed({ closed }: { closed: Promise<void> }): Promise<void> {
  return Promise.race([
    closed,
    new Promise<void>((resolve) => process.stdin.once('end', resolve)),
    new Promise<void>((resolve) => process.once('SIGINT', resolve)),
  ]);
}

// The key comes from the build that produced the graph, so an edit landing mid-analysis differs from it on the next probe.
async function analyzeSnapshot({ path }: { path: string }): Promise<Snapshot> {
  const { root, graph } = await exploreGraph({ path });
  return createSnapshot({
    graph: toExplorerGraph({ root, graph }),
    key: { commitSha: graph.snapshot.commitSha, sourceHash: graph.snapshot.sourceHash },
  });
}

export async function openLiveSnapshot({ path }: { path: string }): Promise<LiveSnapshot> {
  const initial = await analyzeSnapshot({ path });
  const { root } = initial.graph;
  return createLiveSnapshot({
    initial,
    probe: async () => {
      const project = await discoverProject({ path: root });
      return { commitSha: project.commitSha, sourceHash: sourceHash({ files: project.files }) };
    },
    reanalyze: () => analyzeSnapshot({ path: root }),
  });
}

export const mcpCommand: Command = {
  summary: 'serve the latest analysis to coding agents over MCP (stdio)',
  async run(argv) {
    const { positionals } = parseArgs({ args: [...argv], options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1) {
      process.stderr.write('nori mcp takes at most one path\n');
      return 2;
    }

    const live = await openLiveSnapshot({ path: positionals[0] ?? process.cwd() });
    const { snapshot: initial } = await live.current();
    const { root } = initial.graph;
    const server = createMcpServer({ current: live.current, realRoot: await realpath(root) });
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = resolve;
    });
    await server.connect(new StdioServerTransport());

    const { commitSha, branch } = initial.graph.build;
    process.stderr.write(
      `nori: serving ${commitSha.slice(0, 7)} on ${branch ?? 'detached HEAD'}: ${initial.graph.screens.length} screens, ${initial.graph.transitions.length} transitions\n`,
    );

    await untilClosed({ closed });
    await server.close();
    return 0;
  },
};
