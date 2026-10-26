import { parseArgs } from 'node:util';
import { analysisId, snapshotId } from '../graph/ids.js';
import type { Analysis, AnalyzerVersion, Application, BuildGraph, Snapshot } from '../graph/model.js';
import { sourceHash } from '../graph/source-hash.js';
import { navigationIngestion, type CallOutcome } from '../ingest/navigation.js';
import { screensIngestion } from '../ingest/screens.js';
import { inputsHash, type AnalysisInputs } from '../next/inputs.js';
import { createProgram } from '../next/program.js';
import { discoverProject } from '../next/project.js';
import { discoverRoutes } from '../next/routes.js';
import { readAppIdentity } from '../repo/app-identity.js';
import { record } from '../runtime/record.js';
import type { StaticSide } from '../runtime/reconcile.js';
import { analyzerVersion as currentAnalyzerVersion } from '../version.js';
import type { Command } from './command.js';

export type Analyzed = StaticSide & {
  readonly root: string;
  readonly inputs: AnalysisInputs;
  readonly outcomes: readonly CallOutcome[];
};

export async function analyze({
  path,
  createdAt,
  adapters = true,
  analyzerVersion = currentAnalyzerVersion(),
}: {
  path: string;
  createdAt: Date;
  adapters?: boolean;
  analyzerVersion?: AnalyzerVersion;
}): Promise<Analyzed> {
  const project = await discoverProject({ path });
  const identity = await readAppIdentity({ root: project.root });
  const application: Application = {
    id: identity.appKey,
    repoIdentity: identity.repoIdentity,
    subpath: identity.subpath,
    framework: 'next-app-router',
  };
  const hash = sourceHash({ files: project.files });
  const snapshot: Snapshot = {
    id: snapshotId({ appKey: application.id, commitSha: project.commitSha, sourceHash: hash }),
    appKey: application.id,
    commitSha: project.commitSha,
    sourceHash: hash,
    worktree: project.worktree,
    branch: project.branch,
    createdAt,
  };

  const reads = new Set<string>();
  const program = createProgram({ root: project.root, files: project.files, onDiskRead: (read) => reads.add(read) });
  const inputs: AnalysisInputs = { top: project.top, adapters, paths: [...reads].sort() };
  const inputsDigest = await inputsHash(inputs);
  const analysis: Analysis = {
    id: analysisId({ snapshotId: snapshot.id, analyzerVersion, inputsHash: inputsDigest }),
    snapshotId: snapshot.id,
    analyzerVersion,
    inputsHash: inputsDigest,
    createdAt,
  };

  const table = discoverRoutes({
    files: project.files.map((file) => file.path),
    appDir: project.appDir,
  });
  const screens = screensIngestion({ application, analysis, table });
  const navigation = navigationIngestion({
    application,
    analysis,
    program,
    root: project.root,
    files: project.files,
    table,
    adapters,
  });
  if (reads.size !== inputs.paths.length) {
    throw new Error(`The analysis of ${project.root} read a file after its inputs were hashed`);
  }
  return {
    root: project.root,
    inputs,
    ingestion: {
      application,
      snapshot,
      analysis,
      screens: screens.screens,
      transitions: navigation.transitions,
      evidence: [...screens.evidence, ...navigation.evidence],
      observations: [...screens.observations, ...navigation.observations],
    },
    matcher: navigation.matcher,
    passThrough: navigation.redirectOnly,
    outcomes: navigation.outcomes,
  };
}

export async function scan({
  path,
  createdAt = new Date(),
}: {
  path: string;
  createdAt?: Date;
}): Promise<BuildGraph> {
  return (await record(await analyze({ path, createdAt }))).graph;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatScan({ application, snapshot, screens, transitions }: BuildGraph): string {
  const patterns = screens.map(({ screen }) => screen.routePattern).sort();
  const branch = snapshot.branch ?? 'detached HEAD';
  const resolved = transitions.filter(({ transition }) => transition.target.kind === 'resolved').length;
  const subpath = application.subpath === '' ? '' : ` at ${application.subpath}`;
  return [
    `app ${application.repoIdentity}${subpath} (${application.id})`,
    `build ${snapshot.commitSha.slice(0, 7)} on ${branch}, sources ${snapshot.sourceHash.slice(0, 8)}`,
    ...patterns,
    plural(patterns.length, 'screen'),
    `${plural(transitions.length, 'transition')} (${resolved} resolved, ${transitions.length - resolved} unresolved)`,
  ].join('\n');
}

export const scanCommand: Command = {
  summary: 'find the screens and navigation of a Next.js App Router project',
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
