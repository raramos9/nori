import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { NoriError } from '../errors.js';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { applicationId, buildId } from '../graph/ids.js';
import type { Application, Build, BuildGraph } from '../graph/model.js';
import { sourceHash } from '../graph/source-hash.js';
import { screensIngestion } from '../ingest/screens.js';
import { discoverProject } from '../next/project.js';
import { discoverRoutes } from '../next/routes.js';
import { GraphStore } from '../store/graph-store.js';
import { analyzerVersion as currentAnalyzerVersion } from '../version.js';
import type { Command } from './command.js';

const STATE_DIR = '.nori';
const DATABASE_FILE = 'graph.db';

async function isDirectory(path: string): Promise<boolean | null> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// The scanned repo is untrusted, so a committed symlink anywhere in .nori (including SQLite's
// journal and WAL side files) must not redirect our writes.
async function prepareStateDir(stateDir: string): Promise<void> {
  const directory = await isDirectory(stateDir);
  if (directory === null) await mkdir(stateDir);
  else if (!directory) throw new NoriError(`${stateDir} exists and is not a directory`);

  for (const entry of await readdir(stateDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      throw new NoriError(`${join(stateDir, entry.name)} is not a regular file; remove it and rescan`);
    }
  }
  await writeFile(join(stateDir, '.gitignore'), '*\n');
}

export async function scan({
  path,
  createdAt = new Date(),
}: {
  path: string;
  createdAt?: Date;
}): Promise<BuildGraph> {
  const project = await discoverProject({ path });
  const application: Application = {
    id: applicationId({ rootPath: project.root }),
    rootPath: project.root,
    framework: 'next-app-router',
  };
  const analyzerVersion = currentAnalyzerVersion();
  const hash = sourceHash({ files: project.files });
  const build: Build = {
    id: buildId({
      applicationId: application.id,
      commitSha: project.commitSha,
      sourceHash: hash,
      analyzerVersion,
    }),
    applicationId: application.id,
    commitSha: project.commitSha,
    sourceHash: hash,
    branch: project.branch,
    analyzerVersion,
    createdAt,
  };
  const table = discoverRoutes({
    files: project.files.map((file) => file.path),
    appDir: project.appDir,
  });

  const stateDir = join(project.root, STATE_DIR);
  await prepareStateDir(stateDir);

  const store = await GraphStore.open({ path: join(stateDir, DATABASE_FILE) });
  try {
    await store.ingestStatic(screensIngestion({ application, build, table }));
    const graph = await store.loadBuildGraph({ buildId: build.id });
    if (graph === null) throw new Error(`Build ${build.id} was not found after ingestion`);
    return graph;
  } finally {
    await store.close();
  }
}

export function formatScan({ build, screens }: BuildGraph): string {
  const patterns = screens.map(({ screen }) => screen.routePattern).sort();
  const branch = build.branch ?? 'detached HEAD';
  const count = patterns.length === 1 ? '1 screen' : `${patterns.length} screens`;
  return [
    `build ${build.commitSha.slice(0, 7)} on ${branch}, sources ${build.sourceHash.slice(0, 8)}`,
    ...patterns,
    count,
  ].join('\n');
}

export const scanCommand: Command = {
  summary: 'find the screens of a Next.js App Router project',
  async run(argv) {
    const { positionals } = parseArgs({ args: [...argv], options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1) {
      process.stderr.write('nori scan takes at most one path\n');
      return 2;
    }
    const graph = await scan({ path: positionals[0] ?? process.cwd() });
    process.stdout.write(`${formatScan(graph)}\n`);
    return 0;
  },
};
