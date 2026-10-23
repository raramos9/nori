import { type ChildProcess, spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { scan } from '../src/commands/scan.js';
import { formatVerify, verify, DEFAULT_BUDGETS } from '../src/commands/verify.js';
import { formatScore, score } from './runtime-score.js';

const run = promisify(execFile);
const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo');
const BOOT_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;
const INSTALL_HASH_FILE = '.nori-install-hash';
const USAGE = 'usage: pnpm exec tsx bench/runtime.ts [--cache <dir>] [--keep-alive]\n';

const expectedSchema = z.object({ edges: z.array(z.object({ from: z.string(), to: z.string() })) });

const SNAPSHOT_IGNORE = ['.next/', 'node_modules/', 'next-env.d.ts', 'package-lock.json', INSTALL_HASH_FILE, ''].join('\n');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function prepare({ cacheDir }: { cacheDir: string }): Promise<string> {
  const dir = join(cacheDir, 'runtime', 'demo');
  await mkdir(dir, { recursive: true });
  await cp(DEMO, dir, {
    recursive: true,
    filter: (source) => !/(^|\/)(\.nori|node_modules)$/.test(source),
  });
  const git = (...args: string[]) => run('git', ['-c', 'user.name=nori', '-c', 'user.email=nori@localhost', ...args], { cwd: dir });
  if (!existsSync(join(dir, '.git'))) await git('init', '-q');
  await writeFile(join(dir, '.gitignore'), SNAPSHOT_IGNORE);
  await git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '.next', 'next-env.d.ts', 'package-lock.json', INSTALL_HASH_FILE);
  await git('add', '-A');
  const clean = await git('diff', '--cached', '--quiet').then(() => true, () => false);
  if (!clean) await git('commit', '-q', '-m', 'fixture snapshot');
  const hash = sha256(await readFile(join(dir, 'package.json'), 'utf8'));
  const stored = await readFile(join(dir, INSTALL_HASH_FILE), 'utf8').catch(() => null);
  if (stored !== hash) {
    await rm(join(dir, INSTALL_HASH_FILE), { force: true });
    await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    await writeFile(join(dir, INSTALL_HASH_FILE), hash);
  }
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port assigned'));
        else resolvePort(address.port);
      });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

export type Server = { readonly url: string; readonly stop: () => Promise<void> };

export async function boot({ dir }: { dir: string }): Promise<Server> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(join(dir, 'node_modules', '.bin', 'next'), ['dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  let exited = false;
  const closed = new Promise<void>((done) => {
    child.once('exit', () => {
      exited = true;
      done();
    });
  });
  const stop = async () => {
    signalGroup(child, 'SIGTERM');
    await Promise.race([closed, sleep(KILL_GRACE_MS)]);
    signalGroup(child, 'SIGKILL');
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`next dev exited during boot\n${stderr}`);
    try {
      await fetch(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      return { url, stop };
    } catch {
      await sleep(500);
    }
  }
  await stop();
  throw new Error(`next dev did not answer GET / within ${BOOT_TIMEOUT_MS / 1000}s\n${stderr}`);
}

type StorageState = {
  readonly cookies: readonly { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' }[];
  readonly origins: readonly [];
};

function signedInStorageState(url: string): StorageState {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: new URL(url).hostname,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  });
  return { cookies: [cookie('uid', 'u_1'), cookie('name', 'Ada')], origins: [] };
}

const DEMO_PASSWORD = 'correct-horse-battery';

const DEMO_INTERACTIONS = {
  interactions: [
    { page: '/login', fill: { Email: 'demo@example.com', Password: DEMO_PASSWORD }, click: 'Log in', allow: ['POST /api/session'] },
    { page: '/signup', fill: { 'Work email': 'demo@example.com', Password: DEMO_PASSWORD }, click: 'Create account', allow: ['POST /api/account'] },
    { page: '/projects/new', fill: { 'Project name': 'Apollo' }, click: 'Create project', allow: ['POST /api/projects'] },
    { page: '/projects/apollo', click: 'Sign out', allow: ['DELETE /api/session'] },
  ],
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { cache: { type: 'string' }, 'keep-alive': { type: 'boolean', default: false } },
    strict: true,
  });
  const cacheDir = resolve(values.cache ?? join(homedir(), '.cache', 'nori'));
  const ownsHome = process.env.NORI_HOME === undefined || process.env.NORI_HOME === '';
  const noriHome = ownsHome ? await mkdtemp(join(tmpdir(), 'nori-runtime-')) : null;
  if (noriHome !== null) process.env.NORI_HOME = noriHome;

  const dir = await prepare({ cacheDir });
  const server = await boot({ dir });
  const cleanup = async () => {
    await server.stop();
    if (noriHome !== null) await rm(noriHome, { recursive: true, force: true });
  };
  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const storageState = join(noriHome ?? cacheDir, 'signed-in.json');
    await writeFile(storageState, JSON.stringify(signedInStorageState(server.url)));
    const interactionsFile = join(noriHome ?? cacheDir, 'interactions.json');
    await writeFile(interactionsFile, JSON.stringify(DEMO_INTERACTIONS));
    const report = await verify({
      path: dir,
      url: server.url,
      storageStates: [{ label: 'signed-in', file: storageState }],
      anonymous: true,
      interactionsFile,
      budgets: DEFAULT_BUDGETS,
    });
    process.stdout.write(`${formatVerify(report)}\n`);
    const graph = await scan({ path: dir });
    const expected = expectedSchema.parse(JSON.parse(await readFile(join(DEMO, 'expected.json'), 'utf8')));
    process.stdout.write(`${formatScore(score(graph, expected))}\n`);
    if (values['keep-alive']) {
      process.stdout.write(`${server.url}\n`);
      await new Promise<void>(() => undefined);
    }
    return 0;
  } finally {
    await cleanup();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
      process.exit(1);
    },
  );
}
