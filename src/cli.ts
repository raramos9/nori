#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { errorCode, NoriError } from './errors.js';
import type { Command } from './commands/command.js';
import { scanCommand } from './commands/scan.js';
import { readVersion } from './version.js';

const COMMANDS: ReadonlyMap<string, Command> = new Map([['scan', scanCommand]]);

function help(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
  const commands = [...COMMANDS].map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`);
  return `nori - behavioral map of a web application

Usage:
  nori <command> [options]

Commands:
${commands.join('\n')}

Options:
  -v, --version  print the version
  -h, --help     show this help
`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (command !== undefined) return command.run(rest);

  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) {
    process.stderr.write(`Unknown command ${JSON.stringify(positionals[0])}\n\n${help()}`);
    return 2;
  }
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  process.stdout.write(help());
  return 0;
}

function isUsageError(error: unknown): error is Error {
  const code = errorCode(error);
  return error instanceof Error && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof NoriError) {
    process.stderr.write(`nori: ${error.message}\n`);
    process.exitCode = 1;
  } else if (isUsageError(error)) {
    process.stderr.write(`nori: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
