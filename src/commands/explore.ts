import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NoriError } from '../errors.js';
import { applicationId } from '../graph/ids.js';
import type { BuildGraph } from '../graph/model.js';
import { startExplorerServer } from '../explorer/server.js';
import { toExplorerGraph } from '../explorer/view.js';
import { resolveRoot } from '../next/project.js';
import type { Command } from './command.js';
import { openStateStore, scan } from './scan.js';

const UI_DIR = fileURLToPath(new URL('../ui', import.meta.url));

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new NoriError(`--port must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

async function latestGraph({ path }: { path: string }): Promise<{ root: string; graph: BuildGraph }> {
  const root = await resolveRoot(path);
  const store = await openStateStore({ root });
  let graph: BuildGraph | null = null;
  try {
    const build = await store.latestBuild({ applicationId: applicationId({ rootPath: root }) });
    if (build !== null) graph = await store.loadBuildGraph({ buildId: build.id });
  } finally {
    await store.close();
  }
  return { root, graph: graph ?? (await scan({ path: root })) };
}

function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (opener === null) {
    process.stderr.write(`nori: cannot open a browser on ${process.platform}; open ${url} yourself\n`);
    return;
  }
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write(`nori: could not run ${opener}; open ${url} yourself\n`));
  child.unref();
}

function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', resolve));
}

export const exploreCommand: Command = {
  summary: 'open the latest build as an interactive graph in the browser',
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1) {
      process.stderr.write('nori explore takes at most one path\n');
      return 2;
    }
    const port = parsePort(values.port);

    const { root, graph } = await latestGraph({ path: positionals[0] ?? process.cwd() });
    const view = toExplorerGraph({ root, graph });
    const server = await startExplorerServer({ graph: view, uiDir: UI_DIR, port });
    const { commitSha, branch } = view.build;
    process.stdout.write(
      `showing ${commitSha.slice(0, 7)} on ${branch ?? 'detached HEAD'}: ${view.screens.length} screens, ${view.transitions.length} transitions\n${server.url}\n`,
    );
    if (!values['no-open']) openBrowser(server.url);

    await untilInterrupted();
    await server.close();
    return 0;
  },
};
