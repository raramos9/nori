import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseOrigin, parsePageUrl, type Session } from '../src/graph/model.js';
import { crawlSite } from '../src/runtime/crawl.js';
import { boot, prepare } from './runtime.js';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo');
const expectedSchema = z.object({ screens: z.array(z.string()) });

async function nonEmpty(path: string): Promise<void> {
  assert.ok((await stat(path)).size > 0, `${path} is empty`);
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'nori-crawl-demo-'));
  const dir = await prepare({ cacheDir: join(homedir(), '.cache', 'nori') });
  const server = await boot({ dir });
  try {
    const origin = parseOrigin(server.url);
    const expected = expectedSchema.parse(JSON.parse(await readFile(join(DEMO, 'expected.json'), 'utf8')));
    const seeds = [...new Set(['/', ...expected.screens.filter((screen) => !screen.includes('['))])].map((path) => parsePageUrl(origin, path));
    const storageStatePath = join(scratch, 'storage-state.json');
    const host = new URL(origin).hostname;
    await writeFile(
      storageStatePath,
      JSON.stringify({ cookies: [{ name: 'uid', value: 'u1', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }),
    );

    const runs: { label: string; session: Session; storageStatePath?: string }[] = [
      { label: 'anonymous', session: { kind: 'anonymous' } },
      { label: 'signed-in', session: { kind: 'storage-state', label: 'u1' }, storageStatePath },
    ];
    for (const run of runs) {
      const runDir = join(scratch, run.label);
      const started = Date.now();
      const result = await crawlSite({
        origin,
        session: run.session,
        ...(run.storageStatePath === undefined ? {} : { storageStatePath: run.storageStatePath }),
        seeds,
        budgets: { maxCaptures: 100, maxNavigations: 600, maxMillis: 300_000 },
        dir: runDir,
      });
      const aborted = result.navigations.filter((nav) => nav.landing.kind === 'aborted');
      for (const capture of result.captures) {
        await nonEmpty(join(runDir, capture.screenshot));
        await nonEmpty(join(runDir, capture.dom));
      }
      const byKey = new Map(result.captures.map((capture) => [capture.key, capture]));
      const pairs = new Set<string>();
      for (const nav of result.navigations) {
        if (nav.landing.kind !== 'captured') continue;
        const landing = byKey.get(nav.landing.capture);
        assert.ok(landing, `navigation ${nav.seq} points at a missing capture`);
        assert.equal([nav.requested, ...nav.redirects.map((redirect) => redirect.to)].at(-1), landing.url, `chain of navigation ${nav.seq} does not end at its landing`);
        const from = nav.start.kind === 'entry' ? 'ENTRY' : new URL(byKey.get(nav.start.from)?.url ?? '').pathname;
        const hops = nav.redirects.map((redirect) => `${new URL(redirect.to).pathname}[${redirect.via}]`).join(' > ');
        pairs.add(`${from} -> ${new URL(nav.requested).pathname}${hops === '' ? '' : ` > ${hops}`}  => ${new URL(landing.url).pathname} (${landing.httpStatus})`);
      }
      console.log(`\n== ${run.label}: captures=${result.captures.length} navigations=${result.navigations.length} aborted=${aborted.length} requests=${JSON.stringify(result.requests)} stop=${result.stop} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
      for (const nav of aborted) if (nav.landing.kind === 'aborted') console.log(`   aborted ${nav.requested}: ${nav.landing.error}`);
      const blockedLines = new Set((await readFile(join(runDir, 'network.ndjson'), 'utf8')).split('\n').filter((line) => line.includes('"blocked"')));
      for (const line of blockedLines) console.log(`   blocked ${line}`);
      console.log(`   distinct (from -> requested > redirects => landing): ${pairs.size}`);
      for (const pair of [...pairs].sort()) console.log(`   ${pair}`);
    }

    console.log('\nOK');
  } finally {
    await server.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
