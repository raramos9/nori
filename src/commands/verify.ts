import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { runId } from '../graph/ids.js';
import { sourceHash } from '../graph/source-hash.js';
import {
  parseOrigin,
  parsePageUrl,
  type Build,
  type Origin,
  type PageUrl,
  type Run,
  type RunIngestion,
  type Session,
  type StepOutcome,
} from '../graph/model.js';
import { NoriError } from '../errors.js';
import { discoverProject } from '../next/project.js';
import { crawlSite, type Budgets } from '../runtime/crawl.js';
import { appHome, runDirectories, sealRunDirectory, stateDatabasePath } from '../runtime/layout.js';
import { reconcileRun } from '../runtime/reconcile.js';
import { GraphStore } from '../store/graph-store.js';
import type { Command } from './command.js';
import { analyze } from './scan.js';

export type StorageStateInput = { readonly label: string; readonly file: string };

export type VerifyOptions = {
  readonly path: string;
  readonly url: string;
  readonly storageStates: readonly StorageStateInput[];
  readonly anonymous: boolean;
  readonly budgets: Budgets;
};

export type RunOutcome =
  | { readonly kind: 'ingested'; readonly run: Run; readonly ingestion: RunIngestion }
  | { readonly kind: 'source-changed'; readonly session: Session; readonly before: string; readonly after: string };

export type VerifyReport = { readonly build: Build; readonly runs: readonly RunOutcome[] };

export const DEFAULT_BUDGETS: Budgets = { maxCaptures: 200, maxNavigations: 1000, maxMillis: 5 * 60_000 };

export function parseVerifyOrigin(value: string): Origin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NoriError(`--url ${JSON.stringify(value)} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NoriError(`--url must be http or https, got ${url.protocol}`);
  }
  if (url.hostname === '') throw new NoriError('--url needs a host');
  if (url.username !== '' || url.password !== '') throw new NoriError('--url must not carry credentials');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new NoriError(`--url must be an origin without a path, query or fragment, got ${JSON.stringify(value)}`);
  }
  return parseOrigin(value);
}

export function parseStorageState(value: string): StorageStateInput {
  const split = value.indexOf('=');
  const label = split === -1 ? '' : value.slice(0, split);
  const file = split === -1 ? '' : value.slice(split + 1);
  if (label === '' || file === '') throw new NoriError(`--storage-state takes label=file, got ${JSON.stringify(value)}`);
  return { label, file };
}

type PlannedSession = { readonly session: Session; readonly storageStatePath: string | undefined };

function plannedSessions({ anonymous, storageStates }: Pick<VerifyOptions, 'anonymous' | 'storageStates'>): PlannedSession[] {
  const labels = new Set<string>();
  for (const { label } of storageStates) {
    if (label === 'anonymous' || labels.has(label)) throw new NoriError(`storage-state label ${JSON.stringify(label)} is reserved or repeated`);
    labels.add(label);
  }
  return [
    ...(anonymous ? [{ session: { kind: 'anonymous' } as Session, storageStatePath: undefined }] : []),
    ...storageStates.map(({ label, file }) => ({ session: { kind: 'storage-state', label } as Session, storageStatePath: file })),
  ];
}

export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const origin = parseVerifyOrigin(options.url);
  const sessions = plannedSessions(options);
  if (sessions.length === 0) throw new NoriError('nothing to verify: --no-anonymous needs at least one --storage-state');

  const analysis = await analyze({ path: options.path, createdAt: new Date() });
  const { ingestion } = analysis;
  const { build, application } = ingestion;
  const seeds: PageUrl[] = [
    ...new Set(['/', ...ingestion.screens.map(({ routePattern }) => routePattern as string).filter((pattern) => !pattern.includes('['))]),
  ].map((pattern) => parsePageUrl(origin, pattern));

  const databasePath = stateDatabasePath(application.id);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const store = await GraphStore.open({ path: databasePath });
  try {
    await store.ingestStatic(ingestion);
    const runs: RunOutcome[] = [];
    for (const { session, storageStatePath } of sessions) {
      const pending = join(appHome(application.id), 'runs', `${randomUUID()}.partial`);
      const crawl = await crawlSite({ origin, session, storageStatePath, seeds, budgets: options.budgets, dir: pending }).catch(
        async (error: unknown) => {
          await rm(pending, { recursive: true, force: true });
          throw error;
        },
      );
      const project = await discoverProject({ path: options.path });
      const after = sourceHash({ files: project.files });
      if (after !== build.sourceHash) {
        await rm(pending, { recursive: true, force: true });
        runs.push({ kind: 'source-changed', session, before: build.sourceHash, after });
        continue;
      }
      const directories = runDirectories(
        application.id,
        runId({ buildId: build.id, origin, session, startedAt: crawl.startedAt }),
      );
      const result = reconcileRun({ staticSide: analysis, crawl, runDirectory: directories.sealed });
      await writeFile(join(pending, 'reconcile.json'), `${JSON.stringify(result.report, null, 2)}\n`);
      await sealRunDirectory({ staging: pending, sealed: directories.sealed });
      await store.ingestRun(result);
      runs.push({ kind: 'ingested', run: result.run, ingestion: result });
    }
    return { build, runs };
  } finally {
    await store.close();
  }
}

export type OutcomeCounts = Readonly<Record<StepOutcome['kind'], number>>;

export function countOutcomes(report: readonly StepOutcome[]): OutcomeCounts {
  const counts = { supports: 0, contradicts: 0, created: 0, ignored: 0 };
  for (const { kind } of report) counts[kind] += 1;
  return counts;
}

function sessionLabel(session: Session): string {
  return session.kind === 'anonymous' ? 'anonymous' : session.label;
}

export function formatVerify({ build, runs }: VerifyReport): string {
  const lines = [`build ${build.commitSha.slice(0, 7)}, sources ${build.sourceHash.slice(0, 8)}`];
  for (const outcome of runs) {
    if (outcome.kind === 'source-changed') {
      lines.push(
        `${sessionLabel(outcome.session)}: sources changed during the crawl (${outcome.before.slice(0, 8)} -> ${outcome.after.slice(0, 8)}), run not ingested`,
      );
      continue;
    }
    const { run, ingestion } = outcome;
    const counts = countOutcomes(ingestion.report);
    lines.push(
      `${sessionLabel(run.session)}: ${run.id} stopped on ${run.stop}, ${ingestion.captures.length} captures, ${ingestion.navigations.length} navigations, ` +
        `${counts.supports} supports, ${counts.contradicts} contradicts, ${counts.created} created, ${counts.ignored} ignored, ` +
        `requests ${run.requests.allowed} allowed ${run.requests.blocked} blocked`,
    );
  }
  return lines.join('\n');
}

export const verifyCommand: Command = {
  summary: 'drive a running app in an isolated browser and mark the edges it walks observed',
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        url: { type: 'string' },
        'storage-state': { type: 'string', multiple: true, default: [] },
        'no-anonymous': { type: 'boolean', default: false },
        'max-captures': { type: 'string', default: String(DEFAULT_BUDGETS.maxCaptures) },
        'max-navigations': { type: 'string', default: String(DEFAULT_BUDGETS.maxNavigations) },
        'max-seconds': { type: 'string', default: String(DEFAULT_BUDGETS.maxMillis / 1000) },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1) {
      process.stderr.write('nori verify takes at most one path\n');
      return 2;
    }
    if (values.url === undefined) {
      process.stderr.write('nori verify needs --url <origin>\n');
      return 2;
    }
    const positive = (flag: string, raw: string): number => {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) throw new NoriError(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
      return value;
    };
    const report = await verify({
      path: positionals[0] ?? process.cwd(),
      url: values.url,
      storageStates: values['storage-state'].map(parseStorageState),
      anonymous: !values['no-anonymous'],
      budgets: {
        maxCaptures: positive('max-captures', values['max-captures']),
        maxNavigations: positive('max-navigations', values['max-navigations']),
        maxMillis: positive('max-seconds', values['max-seconds']) * 1000,
      },
    });
    process.stdout.write(`${formatVerify(report)}\n`);
    return report.runs.some(({ kind }) => kind === 'source-changed') ? 1 : 0;
  },
};
