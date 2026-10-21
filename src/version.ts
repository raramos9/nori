import { readFileSync } from 'node:fs';

export function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string') {
    return raw.version;
  }
  throw new Error('package.json has no string "version"');
}
