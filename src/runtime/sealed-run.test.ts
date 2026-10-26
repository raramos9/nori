import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runId } from '../graph/ids.js';
import { parseAnalyzerVersion, parseOrigin, parsePageUrl } from '../graph/model.js';
import { TEST_APP, testSnapshot } from '../testing/identity.js';
import type { CrawlResult } from './crawl-result.js';
import { runDirectory } from './layout.js';
import { CRAWL_FILE, listSealedRuns, parseSealedCrawl, readSealedCrawl, sealRun, type SealedCrawlV1 } from './sealed-run.js';

const tempDirs: string[] = [];
const originalHome = process.env.NORI_HOME;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nori-sealed-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.NORI_HOME = tempDir();
});
afterEach(() => {
  process.env.NORI_HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const origin = parseOrigin('http://localhost:3000');
const page = (path: string) => parsePageUrl(origin, path);
const snapshot = testSnapshot();

const crawl: CrawlResult = {
  origin,
  session: { kind: 'storage-state', label: 'signed-in' },
  startedAt: new Date('2026-03-01T10:00:00.000Z'),
  finishedAt: new Date('2026-03-01T10:01:00.000Z'),
  stop: 'budget',
  crawlerVersion: '1',
  requests: { allowed: 4, blocked: 1 },
  captures: [
    { key: 0, url: page('/'), httpStatus: 200, screenshot: 'captures/0.png', dom: 'captures/0.html' },
    { key: 1, url: page('/login?next=%2F'), httpStatus: 302, screenshot: 'captures/1.png', dom: 'captures/1.html' },
  ],
  navigations: [
    { seq: 0, start: { kind: 'entry' }, requested: page('/'), redirects: [], landing: { kind: 'captured', capture: 0 } },
    {
      seq: 1,
      start: { kind: 'action', from: 0, action: { kind: 'interact', page: page('/'), click: 'Sign in', fields: ['Email'] } },
      requested: page('/account'),
      redirects: [{ to: page('/login?next=%2F'), via: 'http' }],
      landing: { kind: 'captured', capture: 1 },
    },
    {
      seq: 2,
      start: { kind: 'action', from: 0, action: { kind: 'follow-link', href: page('/gone'), name: 'Gone' } },
      requested: page('/gone'),
      redirects: [],
      landing: { kind: 'aborted', error: 'net::ERR_ABORTED' },
    },
  ],
};

const sealed: SealedCrawlV1 = {
  format: 1,
  snapshotId: snapshot.id,
  environment: 'ci',
  seededBy: parseAnalyzerVersion('0.0.1+abc'),
  crawl,
};

const id = runId({ snapshotId: snapshot.id, origin, session: crawl.session, startedAt: crawl.startedAt });

async function sealed1(): Promise<string> {
  const staging = join(process.env.NORI_HOME ?? '', `${id}.partial`);
  mkdirSync(staging, { recursive: true });
  const directory = runDirectory(TEST_APP.id, snapshot.id, id);
  await sealRun({ staging, sealed: directory, crawl: sealed });
  return directory;
}

describe('sealed runs', () => {
  it('round-trips a crawl through crawl.json with dates and every union revived', () => {
    expect(parseSealedCrawl(JSON.stringify(sealed))).toEqual(sealed);
  });

  it('seals a staged run once, treats a second seal as done, and lists it under its snapshot', async () => {
    const root = tempDir();
    const staging = join(root, 'r.partial');
    const directory = join(root, snapshot.id, id);
    mkdirSync(staging);
    await sealRun({ staging, sealed: directory, crawl: sealed });
    await sealRun({ staging, sealed: directory, crawl: sealed });
    expect(existsSync(staging)).toBe(false);
    expect(parseSealedCrawl(readFileSync(join(directory, CRAWL_FILE), 'utf8'))).toEqual(sealed);

    const listed = await sealed1();
    expect(await listSealedRuns(TEST_APP.id, snapshot.id)).toEqual([{ runId: id, directory: listed }]);
    expect(await listSealedRuns(TEST_APP.id, testSnapshot({ commit: 'b' }).id)).toEqual([]);
  });

  it('refuses to seal when neither directory exists', async () => {
    const root = tempDir();
    await expect(sealRun({ staging: join(root, 'a.partial'), sealed: join(root, 'a'), crawl: sealed })).rejects.toThrow();
  });

  it('reads a sealed run only when the file agrees with its directory', async () => {
    const directory = await sealed1();
    expect(await readSealedCrawl({ directory, snapshotId: snapshot.id, runId: id })).toEqual(sealed);
    await expect(
      readSealedCrawl({ directory, snapshotId: testSnapshot({ commit: 'b' }).id, runId: id }),
    ).rejects.toThrow(/belongs to snapshot/);
    const other = runId({ snapshotId: snapshot.id, origin, session: { kind: 'anonymous' }, startedAt: crawl.startedAt });
    await expect(readSealedCrawl({ directory, snapshotId: snapshot.id, runId: other })).rejects.toThrow(/describes run/);
  });

  it('names an unknown format instead of guessing at it, and rejects a malformed V1', async () => {
    expect(() => parseSealedCrawl(JSON.stringify({ ...sealed, format: 2 }))).toThrow(/format 2, which this nori cannot read/);
    expect(() => parseSealedCrawl(JSON.stringify({ ...sealed, environment: 'staging' }))).toThrow(/environment/);
    const directory = await sealed1();
    writeFileSync(join(directory, CRAWL_FILE), JSON.stringify({ ...sealed, crawl: { ...crawl, origin: 'ftp://x' } }));
    await expect(readSealedCrawl({ directory, snapshotId: snapshot.id, runId: id })).rejects.toThrow(/Origin/);
  });
});
