import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { errorCode } from '../errors.js';
import { runId } from '../graph/ids.js';
import {
  parseAnalyzerVersion,
  parseOrigin,
  parseRunId,
  parseSnapshotId,
  type AnalyzerVersion,
  type AppKey,
  type Environment,
  type Origin,
  type RunId,
  type SnapshotId,
} from '../graph/model.js';
import { actionSchema, pageUrlSchema, redirectsSchema } from '../store/rows.js';
import type { CrawlResult } from './crawl-result.js';
import { snapshotRunsDirectory } from './layout.js';

export const CRAWL_FILE = 'crawl.json';
const MAX_CRAWL_BYTES = 64 * 1024 * 1024;
const RUN_DIRECTORY = /^run_[0-9a-f]{16}$/;

export type SealedCrawlV1 = {
  readonly format: 1;
  readonly snapshotId: SnapshotId;
  readonly environment: Environment;
  readonly seededBy: AnalyzerVersion;
  readonly crawl: CrawlResult;
};

function canonicalOrigin(value: string): Origin {
  const origin = parseOrigin(value);
  if (origin !== value) throw new Error(`${JSON.stringify(value)} is not an origin`);
  return origin;
}

const date = z.iso.datetime().transform((value) => new Date(value));
const count = z.number().int().nonnegative();

const crawlSchema = z.object({
  origin: z.string().transform(canonicalOrigin),
  session: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('anonymous') }),
    z.object({ kind: z.literal('storage-state'), label: z.string().min(1) }),
  ]),
  startedAt: date,
  finishedAt: date,
  stop: z.enum(['frontier-exhausted', 'budget']),
  crawlerVersion: z.string(),
  requests: z.object({ allowed: count, blocked: count }),
  captures: z
    .array(z.object({ key: count, url: pageUrlSchema, httpStatus: z.number().int(), screenshot: z.string(), dom: z.string() }))
    .readonly(),
  navigations: z
    .array(
      z.object({
        seq: count,
        start: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('entry') }),
          z.object({ kind: z.literal('action'), from: count, action: actionSchema }),
        ]),
        requested: pageUrlSchema,
        redirects: redirectsSchema.readonly(),
        landing: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('captured'), capture: count }),
          z.object({ kind: z.literal('aborted'), error: z.string() }),
        ]),
      }),
    )
    .readonly(),
});

const sealedCrawlV1Schema: z.ZodType<SealedCrawlV1, unknown> = z.object({
  format: z.literal(1),
  snapshotId: z.string().transform(parseSnapshotId),
  environment: z.enum(['local', 'ci']),
  seededBy: z.string().transform(parseAnalyzerVersion),
  crawl: crawlSchema,
});

const formatSchema = z.object({ format: z.unknown() });

export function parseSealedCrawl(text: string): SealedCrawlV1 {
  const json: unknown = JSON.parse(text);
  const { format } = formatSchema.parse(json);
  if (format !== 1) throw new Error(`${CRAWL_FILE} has format ${JSON.stringify(format)}, which this nori cannot read`);
  const result = sealedCrawlV1Schema.safeParse(json);
  if (!result.success) throw new Error(`${CRAWL_FILE}: ${z.prettifyError(result.error)}`);
  return result.data;
}

export async function readSealedCrawl({
  directory,
  snapshotId,
  runId: expected,
}: {
  directory: string;
  snapshotId: SnapshotId;
  runId: RunId;
}): Promise<SealedCrawlV1> {
  const path = join(directory, CRAWL_FILE);
  const { size } = await stat(path);
  if (size > MAX_CRAWL_BYTES) throw new Error(`${path} is ${size} bytes, over the ${MAX_CRAWL_BYTES} byte limit`);
  const sealed = parseSealedCrawl(await readFile(path, 'utf8'));
  if (sealed.snapshotId !== snapshotId) {
    throw new Error(`${path} belongs to snapshot ${sealed.snapshotId}, not ${snapshotId}`);
  }
  const { origin, session, startedAt } = sealed.crawl;
  const recomputed = runId({ snapshotId, origin, session, startedAt });
  if (recomputed !== expected) throw new Error(`${path} describes run ${recomputed}, not ${expected}`);
  return sealed;
}

async function writeDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function sealRun({
  staging,
  sealed,
  crawl,
}: {
  staging: string;
  sealed: string;
  crawl: SealedCrawlV1;
}): Promise<void> {
  if (existsSync(sealed) && !existsSync(staging)) return;
  await writeDurably(join(staging, CRAWL_FILE), `${JSON.stringify(crawl)}\n`);
  await mkdir(dirname(sealed), { recursive: true, mode: 0o700 });
  await rename(staging, sealed);
}

export type SealedRun = { readonly runId: RunId; readonly directory: string };

export async function listSealedRuns(appKey: AppKey, snapshotId: SnapshotId): Promise<readonly SealedRun[]> {
  const parent = snapshotRunsDirectory(appKey, snapshotId);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ runId: parseRunId(name), directory: join(parent, name) }));
}
