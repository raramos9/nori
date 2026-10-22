import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toExplorerGraph } from '../explorer/view.js';
import { createMcpServer } from '../mcp/server.js';
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

export const mcpCommand: Command = {
  summary: 'serve the latest analysis to coding agents over MCP (stdio)',
  async run(argv) {
    const { positionals } = parseArgs({ args: [...argv], options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1) {
      process.stderr.write('nori mcp takes at most one path\n');
      return 2;
    }

    const { root, graph } = await exploreGraph({ path: positionals[0] ?? process.cwd() });
    const view = toExplorerGraph({ root, graph });
    const server = createMcpServer({ graph: view, realRoot: await realpath(root) });
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = resolve;
    });
    await server.connect(new StdioServerTransport());

    const { commitSha, branch } = view.build;
    process.stderr.write(
      `nori: serving ${commitSha.slice(0, 7)} on ${branch ?? 'detached HEAD'}: ${view.screens.length} screens, ${view.transitions.length} transitions\n`,
    );

    await untilClosed({ closed });
    await server.close();
    return 0;
  },
};
