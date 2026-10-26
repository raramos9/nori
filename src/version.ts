import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnalyzerVersion, type AnalyzerVersion } from './graph/model.js';
import { sourceHash } from './graph/source-hash.js';

export function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string') {
    return raw.version;
  }
  throw new Error('package.json has no string "version"');
}

const CODE_FILE = /\.(?:js|ts)$/;
const TEST_FILE = /\.test\.(?:js|ts)$/;

let memo: AnalyzerVersion | undefined;

export function analyzerVersion(): AnalyzerVersion {
  if (memo !== undefined) return memo;
  const codeDir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(codeDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => CODE_FILE.test(file) && !TEST_FILE.test(file))
    .map((file) => ({ path: file.split(sep).join('/'), content: readFileSync(join(codeDir, file)) }));
  memo = parseAnalyzerVersion(`${readVersion()}+${sourceHash({ files }).slice(0, 12)}`);
  return memo;
}
