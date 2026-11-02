import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ArtifactPath } from '../graph/model.js';

export const screenshotDigest = (path: ArtifactPath): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
