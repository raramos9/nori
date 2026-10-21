#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `nori - behavioral map of a web application

Usage:
  nori [options]

Options:
  -v, --version  print the version
  -h, --help     show this help
`;

function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string') {
    return raw.version;
  }
  throw new Error('package.json has no string "version"');
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  process.stdout.write(HELP);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
