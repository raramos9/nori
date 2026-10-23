import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { applicationId } from '../graph/ids.js';
import { appHome, runDirectories, stateDatabasePath } from '../runtime/layout.js';
import { GraphStore } from '../store/graph-store.js';
import { DEFAULT_BUDGETS, parseStorageState, parseVerifyOrigin, verify } from './verify.js';

describe('parseVerifyOrigin', () => {
  it('accepts http and https origins and drops the trailing slash', () => {
    expect(parseVerifyOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(parseVerifyOrigin('https://staging.example.com/')).toBe('https://staging.example.com');
  });

  it.each([
    ['not a url', 'localhost:3000/x y'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://example.com'],
    ['no host', 'http://'],
    ['credentials', 'http://user:pass@example.com'],
    ['a path', 'http://example.com/app'],
    ['a query', 'http://example.com/?a=1'],
    ['a fragment', 'http://example.com/#top'],
    ['empty', ''],
  ])('rejects %s', (_name, value) => {
    expect(() => parseVerifyOrigin(value)).toThrow(NoriError);
  });
});

describe('parseStorageState', () => {
  it('splits label=file at the first equals sign', () => {
    expect(parseStorageState('admin=/tmp/a=b.json')).toEqual({ label: 'admin', file: '/tmp/a=b.json' });
  });

  it.each(['admin', '=file.json', 'admin='])('rejects %s', (value) => {
    expect(() => parseStorageState(value)).toThrow(NoriError);
  });
});

const PAGE = 'export default function Page() { return null; }\n';
const tempDirs: string[] = [];
let sourceToTouch: string | null = null;
let touched = false;

const html = (links: readonly string[]) =>
  `<!doctype html><title>t</title><body>${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</body>`;

const app: Server = createServer((request, response) => {
  if (request.url === '/about' && sourceToTouch !== null && !touched) {
    touched = true;
    writeFileSync(sourceToTouch, `${PAGE}// edited mid-crawl\n`);
  }
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/about' ? html(['/']) : html(['/about']));
});
app.on('connection', (socket) => socket.on('error', () => undefined));
let origin = '';

beforeAll(async () => {
  await new Promise<void>((done) => app.listen(0, '127.0.0.1', done));
  const address = app.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => {
  app.closeAllConnections();
  app.close();
});
afterEach(() => {
  sourceToTouch = null;
  touched = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function nextProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nori-verify-')));
  tempDirs.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { next: '15.0.0' } }),
    'app/layout.tsx': PAGE,
    'app/page.tsx': `import Link from 'next/link';\nexport default function Page() { return <Link href="/about">about</Link>; }\n`,
    'app/about/page.tsx': PAGE,
    'app/users/[id]/page.tsx': PAGE,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

const options = (path: string) => ({
  path,
  url: origin,
  storageStates: [],
  anonymous: true,
  budgets: { ...DEFAULT_BUDGETS, maxMillis: 30_000 },
});

describe('verify', { timeout: 60_000 }, () => {
  it('rejects a bad origin and an empty session plan before touching the app', async () => {
    const root = nextProject();
    await expect(verify({ ...options(root), url: 'file:///x' })).rejects.toThrow(NoriError);
    await expect(verify({ ...options(root), anonymous: false })).rejects.toThrow(/nothing to verify/);
    await expect(
      verify({ ...options(root), storageStates: [{ label: 'anonymous', file: '/x.json' }] }),
    ).rejects.toThrow(/reserved or repeated/);
  });

  it('crawls, seals the run directory, and ingests observed evidence', async (test) => {
    const root = nextProject();
    const report = await verify(options(root)).catch((error: unknown) => {
      if (error instanceof NoriError && /Chrome is not installed/.test(error.message)) test.skip('system Chrome is not installed');
      throw error;
    });
    const [outcome] = report.runs;
    if (outcome?.kind !== 'ingested') throw new Error('expected an ingested run');
    expect(outcome.ingestion.captures.map(({ evidence }) => evidence.url).sort()).toEqual([`${origin}/`, `${origin}/about`]);

    const { sealed, staging } = runDirectories(report.build.applicationId, outcome.run.id);
    expect(existsSync(join(sealed, 'reconcile.json'))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(join(appHome(report.build.applicationId), 'runs'))).toEqual([outcome.run.id]);

    const store = await GraphStore.open({ path: stateDatabasePath(report.build.applicationId) });
    try {
      const graph = await store.loadBuildGraph({ buildId: report.build.id });
      expect(graph?.runs.map((run) => run.id)).toEqual([outcome.run.id]);
      const observed = graph?.transitions.filter(({ status }) => status === 'observed') ?? [];
      expect(observed.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it('does not ingest a run whose sources changed during the crawl', async (test) => {
    const root = nextProject();
    sourceToTouch = join(root, 'app/about/page.tsx');
    const report = await verify(options(root)).catch((error: unknown) => {
      if (error instanceof NoriError && /Chrome is not installed/.test(error.message)) test.skip('system Chrome is not installed');
      throw error;
    });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.kind).toBe('source-changed');

    const store = await GraphStore.open({ path: stateDatabasePath(report.build.applicationId) });
    try {
      const graph = await store.loadBuildGraph({ buildId: report.build.id });
      expect(graph?.runs).toEqual([]);
    } finally {
      await store.close();
    }
    const runsDirectory = join(appHome(report.build.applicationId), 'runs');
    expect(readdirSync(runsDirectory)).toEqual([]);
  });
});
