import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  parseArtifactPath,
  type AppKey,
  type ArtifactPath,
  type RunId,
  type SnapshotId,
  type TestImportId,
} from '../graph/model.js';

const DATABASE_FILE = 'graph.db';
const RUNS_DIR = 'runs';
const IMPORTS_DIR = 'imports';
const STAGING_SUFFIX = '.partial';

export function appHome(appKey: AppKey): string {
  const home = process.env.NORI_HOME;
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.nori'), 'stores', appKey);
}

export function stateDatabasePath(appKey: AppKey): string {
  return join(appHome(appKey), DATABASE_FILE);
}

// Staging sits beside the sealed runs, on the same filesystem, so sealing is one rename.
export function stagingDirectory(appKey: AppKey): string {
  return join(appHome(appKey), RUNS_DIR, `${randomUUID()}${STAGING_SUFFIX}`);
}

export function snapshotRunsDirectory(appKey: AppKey, snapshotId: SnapshotId): string {
  return join(appHome(appKey), RUNS_DIR, snapshotId);
}

export function runDirectory(appKey: AppKey, snapshotId: SnapshotId, runId: RunId): string {
  return join(snapshotRunsDirectory(appKey, snapshotId), runId);
}

export function importStagingDirectory(appKey: AppKey): string {
  return join(appHome(appKey), IMPORTS_DIR, `${randomUUID()}${STAGING_SUFFIX}`);
}

export function snapshotImportsDirectory(appKey: AppKey, snapshotId: SnapshotId): string {
  return join(appHome(appKey), IMPORTS_DIR, snapshotId);
}

export function importDirectory(appKey: AppKey, snapshotId: SnapshotId, importId: TestImportId): string {
  return join(snapshotImportsDirectory(appKey, snapshotId), importId);
}

export function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

export function artifactPath(runDirectory: string, file: string): ArtifactPath {
  const path = resolve(runDirectory, file);
  if (!isInside(resolve(runDirectory), path)) {
    throw new Error(`Artifact ${JSON.stringify(file)} is not inside the run directory ${runDirectory}`);
  }
  return parseArtifactPath(path);
}
