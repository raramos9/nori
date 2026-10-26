import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { boot, prepare } from './runtime.js';

const run = promisify(execFile);
const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo', 'e2e');
const ARTIFACTS = join(E2E, 'artifacts');
const MISSING_TRACE_SPEC = 'home-to-docs';

const attachmentSchema = z.object({ name: z.string(), path: z.string().optional() }).loose();
const resultSchema = z.object({ attachments: z.array(attachmentSchema) }).loose();
const testSchema = z.object({ results: z.array(resultSchema) }).loose();
const specSchema = z.object({ file: z.string(), tests: z.array(testSchema) }).loose();
type Suite = { specs?: z.infer<typeof specSchema>[] | undefined; suites?: Suite[] | undefined };
const suiteSchema: z.ZodType<Suite> = z.lazy(() =>
  z.object({ specs: z.array(specSchema).optional(), suites: z.array(suiteSchema).optional() }).loose(),
);
const reportSchema = z.object({ suites: z.array(suiteSchema) }).loose();
type Report = z.infer<typeof reportSchema>;

function specs(suites: readonly Suite[]): z.infer<typeof specSchema>[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
}

function attachments(report: Report): { slug: string; attachment: z.infer<typeof attachmentSchema> }[] {
  return specs(report.suites).flatMap((spec) =>
    spec.tests
      .flatMap((test) => test.results)
      .flatMap((result) => result.attachments)
      .filter((attachment) => attachment.path !== undefined)
      .map((attachment) => ({ slug: basename(spec.file, '.spec.ts'), attachment })),
  );
}

function scrub(text: string, roots: readonly string[]): string {
  return roots.reduce((acc, root) => acc.split(root).join('<root>'), text);
}

async function main(): Promise<void> {
  const dir = await prepare({ cacheDir: join(homedir(), '.cache', 'nori') });
  const work = join(dir, 'e2e');
  await rm(join(work, 'test-results'), { recursive: true, force: true });
  await rm(join(work, 'report.json'), { force: true });
  const server = await boot({ dir });
  try {
    await run(join(dir, 'node_modules', '.bin', 'playwright'), ['test', '-c', 'e2e/playwright.config.ts'], {
      cwd: dir,
      env: { ...process.env, NORI_E2E_BASE_URL: server.url },
      maxBuffer: 64 * 1024 * 1024,
    }).catch((error: { code?: number; stderr?: string }) => {
      if (error.code !== 1) throw error;
    });
  } finally {
    await server.stop();
  }

  const roots = [await realpath(dir), dir];
  const raw = await readFile(join(work, 'report.json'), 'utf8');
  const report = reportSchema.parse(JSON.parse(scrub(raw, roots)));
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(join(ARTIFACTS, 'missing-trace'), { recursive: true });

  for (const { slug, attachment } of attachments(report)) {
    const source = (attachment.path ?? '').replace('<root>', roots[0] ?? dir);
    const published = `traces/${slug}/${attachment.name === 'trace' ? 'trace.zip' : basename(source)}`;
    await mkdir(join(ARTIFACTS, 'traces', slug), { recursive: true });
    const target = join(ARTIFACTS, published);
    if (attachment.name === 'trace') await scrubZip(source, target, roots);
    else await writeFile(target, scrub(await readFile(source, 'utf8'), roots));
    attachment.path = published;
  }
  const missing = structuredClone(report);
  for (const { slug, attachment } of attachments(missing)) {
    const lost = slug === MISSING_TRACE_SPEC && attachment.name === 'trace';
    attachment.path = lost ? attachment.path : `../${attachment.path}`;
  }
  await writeFile(join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(ARTIFACTS, 'missing-trace', 'report.json'), `${JSON.stringify(missing, null, 2)}\n`);
  process.stdout.write(`wrote ${relative(process.cwd(), ARTIFACTS)}\n`);
}

async function scrubZip(source: string, target: string, roots: readonly string[]): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'nori-trace-'));
  try {
    await run('unzip', ['-q', source, '-d', tmp]);
    const names = (await run('unzip', ['-Z1', source])).stdout.split('\n').filter((name) => name !== '');
    for (const name of names) {
      const file = join(tmp, name);
      const text = (await readFile(file)).toString('latin1');
      await writeFile(file, Buffer.from(scrub(text, roots), 'latin1'));
    }
    await rm(target, { force: true });
    await run('zip', ['-q', '-X', '-9', target, ...names], { cwd: tmp });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
