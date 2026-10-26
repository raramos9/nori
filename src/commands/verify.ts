import { readFile, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runId } from '../graph/ids.js';
import { sourceHash } from '../graph/source-hash.js';
import {
  parseOrigin,
  parsePageUrl,
  type Environment,
  type Origin,
  type PageUrl,
  type RunId,
  type Session,
  type Snapshot,
  type StepOutcome,
} from '../graph/model.js';
import { NoriError } from '../errors.js';
import { inputsHash } from '../next/inputs.js';
import { resolveUrl } from '../next/match.js';
import { discoverProject } from '../next/project.js';
import { crawlSite, type Budgets } from '../runtime/crawl.js';
import { parseInteractions } from '../runtime/interactions.js';
import { runDirectory, stagingDirectory } from '../runtime/layout.js';
import { validateCrawl } from '../runtime/reconcile.js';
import { record, type RunOutcome } from '../runtime/record.js';
import { sealRun, type SealedCrawlV1 } from '../runtime/sealed-run.js';
import type { Command } from './command.js';
import { analyze, type Analyzed } from './scan.js';

export type StorageStateInput = { readonly label: string; readonly file: string };

export type VerifyOptions = {
  readonly path: string;
  readonly url: string;
  readonly storageStates: readonly StorageStateInput[];
  readonly anonymous: boolean;
  readonly interactionsFile?: string | undefined;
  readonly budgets: Budgets;
};

export type SourceChanged = {
  readonly kind: 'source-changed';
  readonly session: Session;
  readonly changed: 'sources' | 'inputs';
  readonly before: string;
  readonly after: string;
};

export type VerifyOutcome = RunOutcome | SourceChanged;

export type VerifyReport = { readonly snapshot: Snapshot; readonly runs: readonly VerifyOutcome[] };

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

export function currentEnvironment(env: NodeJS.ProcessEnv): Environment {
  return env.CI === 'true' ? 'ci' : 'local';
}

async function sourceChange(analyzed: Analyzed, session: Session, path: string): Promise<SourceChanged | null> {
  const { snapshot, analysis } = analyzed.ingestion;
  const after = sourceHash({ files: (await discoverProject({ path })).files });
  if (after !== snapshot.sourceHash) {
    return { kind: 'source-changed', session, changed: 'sources', before: snapshot.sourceHash, after };
  }
  const inputsAfter = await inputsHash(analyzed.inputs);
  if (inputsAfter !== analysis.inputsHash) {
    return { kind: 'source-changed', session, changed: 'inputs', before: analysis.inputsHash, after: inputsAfter };
  }
  return null;
}

export function outcomeRunId(outcome: RunOutcome): RunId {
  switch (outcome.kind) {
    case 'matched-now':
      return outcome.ingestion.run.id;
    case 'already-matched':
      return outcome.run.id;
    case 'failed':
      return outcome.runId;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const origin = parseVerifyOrigin(options.url);
  const sessions = plannedSessions(options);
  if (sessions.length === 0) throw new NoriError('nothing to verify: --no-anonymous needs at least one --storage-state');

  const interactions =
    options.interactionsFile === undefined
      ? []
      : parseInteractions(origin, await readFile(options.interactionsFile, 'utf8').catch(() => {
          throw new NoriError(`cannot read --interactions ${options.interactionsFile}`);
        }));

  const analyzed = await analyze({ path: options.path, createdAt: new Date() });
  const { ingestion } = analyzed;
  const { application, snapshot, analysis } = ingestion;
  const environment = currentEnvironment(process.env);
  const seeds: PageUrl[] = [
    ...new Set(['/', ...ingestion.screens.map(({ routePattern }) => routePattern as string).filter((pattern) => !pattern.includes('['))]),
  ].map((pattern) => parsePageUrl(origin, pattern));
  const screenKey = (url: PageUrl): string => {
    const resolution = resolveUrl({ matcher: analyzed.matcher, url });
    return resolution.kind === 'screen' ? resolution.pattern : url;
  };

  const planned: (SourceChanged | RunId)[] = [];
  for (const { session, storageStatePath } of sessions) {
    const staging = stagingDirectory(application.id);
    const discard = () => rm(staging, { recursive: true, force: true });
    const crawl = await crawlSite({ origin, session, storageStatePath, seeds, interactions, budgets: options.budgets, dir: staging, screenKey }).catch(
      async (error: unknown) => {
        await discard();
        throw error;
      },
    );
    const changed = await sourceChange(analyzed, session, options.path);
    if (changed !== null) {
      await discard();
      planned.push(changed);
      continue;
    }
    const sealed: SealedCrawlV1 = { format: 1, snapshotId: snapshot.id, environment, seededBy: analysis.analyzerVersion, crawl };
    const id = runId({ snapshotId: snapshot.id, origin, session, startedAt: crawl.startedAt });
    const directory = runDirectory(application.id, snapshot.id, id);
    try {
      validateCrawl(sealed, directory);
    } catch (error) {
      await discard();
      throw error;
    }
    await sealRun({ staging, sealed: directory, crawl: sealed });
    planned.push(id);
  }

  const { runs } = await record(analyzed);
  const byRun = new Map(runs.map((outcome) => [outcomeRunId(outcome), outcome]));
  return {
    snapshot,
    runs: planned.map((entry) => {
      if (typeof entry !== 'string') return entry;
      const outcome = byRun.get(entry);
      if (outcome === undefined) throw new Error(`Run ${entry} was sealed but not recorded`);
      return outcome;
    }),
  };
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

function formatOutcome(outcome: VerifyOutcome): string {
  switch (outcome.kind) {
    case 'source-changed':
      return `${sessionLabel(outcome.session)}: ${outcome.changed} changed during the crawl (${outcome.before.slice(0, 8)} -> ${outcome.after.slice(0, 8)}), run not ingested`;
    case 'matched-now': {
      const { run, report, captures, navigations } = outcome.ingestion;
      const counts = countOutcomes(report);
      return (
        `${sessionLabel(run.session)}: ${run.id} stopped on ${run.stop}, ${captures.length} captures, ${navigations.length} navigations, ` +
        `${counts.supports} supports, ${counts.contradicts} contradicts, ${counts.created} created, ${counts.ignored} ignored, ` +
        `requests ${run.requests.allowed} allowed ${run.requests.blocked} blocked`
      );
    }
    case 'already-matched': {
      const { run } = outcome;
      return `${sessionLabel(run.session)}: ${run.id} stopped on ${run.stop}, matched by another nori process, requests ${run.requests.allowed} allowed ${run.requests.blocked} blocked`;
    }
    case 'failed':
      return `${outcome.runId}: sealed but not matched: ${outcome.reason}`;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function formatVerify({ snapshot, runs }: VerifyReport): string {
  return [`build ${snapshot.commitSha.slice(0, 7)}, sources ${snapshot.sourceHash.slice(0, 8)}`, ...runs.map(formatOutcome)].join('\n');
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
        interactions: { type: 'string' },
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
      interactionsFile: values.interactions,
      budgets: {
        maxCaptures: positive('max-captures', values['max-captures']),
        maxNavigations: positive('max-navigations', values['max-navigations']),
        maxMillis: positive('max-seconds', values['max-seconds']) * 1000,
      },
    });
    process.stdout.write(`${formatVerify(report)}\n`);
    return report.runs.some(({ kind }) => kind === 'source-changed' || kind === 'failed') ? 1 : 0;
  },
};
