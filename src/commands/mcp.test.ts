import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { gitFixture } from '../testing/git-fixture.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('nori mcp', () => {
  it('speaks only MCP on stdout and closes cleanly', { timeout: 60_000 }, async () => {
    const root = gitFixture();
    try {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: `${ROOT}node_modules/.bin/tsx`,
          args: [`${ROOT}src/cli.ts`, 'mcp', root],
          stderr: 'pipe',
        }),
      );

      const result = await client.callTool({ name: 'list_screens' });
      const { screens } = result.structuredContent as { screens: { route: string }[] };
      expect(screens.map(({ route }) => route)).toEqual(['/', '/about']);

      await client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
