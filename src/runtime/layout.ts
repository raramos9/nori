import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArtifactPath, type ApplicationId, type ArtifactPath, type RunId } from '../graph/model.js';

const DATABASE_FILE = 'graph.db';
const RUNS_DIR = 'runs';
const STAGING_SUFFIX = '.partial';

export function appHome(applicationId: ApplicationId): string {
  const home = process.env.NORI_HOME;
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.nori'), 'apps', applicationId);
}

export function stateDatabasePath(applicationId: ApplicationId): string {
  return join(appHome(applicationId), DATABASE_FILE);
}

export type RunDirectories = { readonly staging: string; readonly sealed: string };

export function runDirectories(applicationId: ApplicationId, runId: RunId): RunDirectories {
  const sealed = join(appHome(applicationId), RUNS_DIR, runId);
  return { staging: `${sealed}${STAGING_SUFFIX}`, sealed };
}

export async function sealRunDirectory({ staging, sealed }: RunDirectories): Promise<void> {
  try {
    await rename(staging, sealed);
  } catch (error) {
    if (existsSync(sealed) && !existsSync(staging)) return;
    throw error;
  }
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
