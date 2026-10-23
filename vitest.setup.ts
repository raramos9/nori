import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NORI_HOME = mkdtempSync(join(tmpdir(), 'nori-home-'));
