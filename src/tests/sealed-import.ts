import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { errorCode } from '../errors.js';
import { testImportId } from '../graph/ids.js';
import {
  parseArtifactPath,
  parseSnapshotId,
  parseTestImportId,
  type AppKey,
  type ArtifactPath,
  type Environment,
  type SnapshotId,
  type TestCase,
  type TestImport,
  type TestImportId,
} from '../graph/model.js';
import { artifactPath, snapshotImportsDirectory } from '../runtime/layout.js';
import { parseSealedCases, unsealCases, type SealedCase } from '../store/test-rows.js';

export const IMPORT_FILE = 'import.json';
export const REPORT_FILE = 'report.json';
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const IMPORT_DIRECTORY = /^imp_[0-9a-f]{16}$/;

export type SealedImportV1 = {
  readonly format: 1;
  readonly id: TestImportId;
  readonly snapshotId: SnapshotId;
  readonly environment: Environment;
  readonly importedAt: Date;
  readonly report: {
    readonly original: ArtifactPath;
    readonly sha256: string;
    readonly playwrightVersion: string;
    readonly startedAt: Date;
  };
  readonly cases: readonly SealedCase[];
};

const date = z.iso.datetime().transform((value) => new Date(value));

const sealedImportV1Schema: z.ZodType<SealedImportV1, unknown> = z.object({
  format: z.literal(1),
  id: z.string().transform(parseTestImportId),
  snapshotId: z.string().transform(parseSnapshotId),
  environment: z.enum(['local', 'ci']),
  importedAt: date,
  report: z.object({
    original: z.string().transform(parseArtifactPath),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    playwrightVersion: z.string(),
    startedAt: date,
  }),
  cases: z.unknown().transform((cases) => parseSealedCases(cases, `${IMPORT_FILE}: cases`)),
});

const formatSchema = z.object({ format: z.unknown() });

export function parseSealedImport(text: string): SealedImportV1 {
  const json: unknown = JSON.parse(text);
  const { format } = formatSchema.parse(json);
  if (format !== 1) throw new Error(`${IMPORT_FILE} has format ${JSON.stringify(format)}, which this nori cannot read`);
  const result = sealedImportV1Schema.safeParse(json);
  if (!result.success) throw new Error(`${IMPORT_FILE}: ${z.prettifyError(result.error)}`);
  return result.data;
}

export async function readSealedImport({
  directory,
  snapshotId,
  importId,
}: {
  directory: string;
  snapshotId: SnapshotId;
  importId: TestImportId;
}): Promise<{ readonly testImport: TestImport; readonly cases: readonly TestCase[] }> {
  const path = join(directory, IMPORT_FILE);
  const { size } = await stat(path);
  if (size > MAX_IMPORT_BYTES) throw new Error(`${path} is ${size} bytes, over the ${MAX_IMPORT_BYTES} byte limit`);
  const sealed = parseSealedImport(await readFile(path, 'utf8'));
  if (sealed.snapshotId !== snapshotId) throw new Error(`${path} belongs to snapshot ${sealed.snapshotId}, not ${snapshotId}`);
  const recomputed = testImportId({ snapshotId, sha256: sealed.report.sha256 });
  if (sealed.id !== importId || recomputed !== importId) {
    throw new Error(`${path} describes import ${sealed.id} (recomputed ${recomputed}), not ${importId}`);
  }
  const { report } = sealed;
  return {
    testImport: {
      id: sealed.id,
      snapshotId,
      environment: sealed.environment,
      importedAt: sealed.importedAt,
      report: {
        original: report.original,
        sealed: artifactPath(directory, REPORT_FILE),
        sha256: report.sha256,
        playwrightVersion: report.playwrightVersion,
        startedAt: report.startedAt,
      },
    },
    cases: unsealCases(directory, sealed.cases),
  };
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

const LOST_RENAME = new Set(['ENOTEMPTY', 'EEXIST']);

// A concurrent import of the same report that loses the rename sealed the same bytes as the winner.
export async function sealImport({
  staging,
  sealed,
  sealedImport,
}: {
  staging: string;
  sealed: string;
  sealedImport: SealedImportV1;
}): Promise<void> {
  if (existsSync(sealed) && !existsSync(staging)) return;
  await writeDurably(join(staging, IMPORT_FILE), `${JSON.stringify(sealedImport)}\n`);
  await mkdir(dirname(sealed), { recursive: true, mode: 0o700 });
  try {
    await rename(staging, sealed);
  } catch (error) {
    if (!LOST_RENAME.has(String(errorCode(error)))) throw error;
    await rm(staging, { recursive: true, force: true });
  }
}

export type SealedImportDir = { readonly importId: TestImportId; readonly directory: string };

export async function listSealedImports(appKey: AppKey, snapshotId: SnapshotId): Promise<readonly SealedImportDir[]> {
  const parent = snapshotImportsDirectory(appKey, snapshotId);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && IMPORT_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ importId: parseTestImportId(name), directory: join(parent, name) }));
}
