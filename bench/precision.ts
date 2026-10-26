import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../src/commands/scan.js';
import { screenId, stateId } from '../src/graph/ids.js';
import { DEFAULT_STATE_KEY } from '../src/graph/model.js';
import { checkout } from './checkout.js';
import { loadManifest, type BenchApp } from './manifest.js';

export type Edge = {
  readonly id: string;
  readonly app: string;
  readonly source: string;
  readonly target: string;
  readonly trigger: string;
  readonly file: string;
  readonly line: number;
  readonly code: string;
};

const USAGE =
  'usage: pnpm exec tsx bench/precision.ts --out <file> [--size 100] [--seed 1] [--cache <dir>]\n' +
  '       pnpm exec tsx bench/precision.ts --score <labelled.json> [--cache <dir>]\n';

export type Labelled = Edge & { readonly verdict: string; readonly cause?: string };

export function score(labelled: readonly Labelled[], current: ReadonlySet<string>): string {
  const surviving = labelled.filter(({ id }) => current.has(id));
  const decided = surviving.filter(({ verdict }) => verdict !== 'unclear');
  const correct = decided.filter(({ verdict }) => verdict === 'correct').length;
  const tally = (edges: readonly Labelled[]) => {
    const counts = new Map<string, number>();
    for (const { verdict, cause } of edges) counts.set(cause ?? verdict, (counts.get(cause ?? verdict) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `  ${key}: ${count}`);
  };
  return [
    `surviving ${surviving.length}/${labelled.length}`,
    `precision ${correct}/${decided.length} (${((100 * correct) / Math.max(decided.length, 1)).toFixed(1)}%)`,
    'surviving by cause:',
    ...tally(surviving),
    'gone by cause:',
    ...tally(labelled.filter(({ id }) => !current.has(id))),
    ...labelled.filter(({ id }) => !current.has(id)).map(({ id, verdict, cause }) => `  - ${id} ${cause ?? verdict}`),
  ].join('\n');
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(items: readonly T[], size: number, seed: number): T[] {
  const random = mulberry32(seed);
  const pool = [...items];
  const count = Math.min(size, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, count);
}

const label = ({ repo, root }: BenchApp): string => (root === '.' ? repo : `${repo}/${root}`);

async function resolvedEdges(app: BenchApp, path: string): Promise<Edge[]> {
  const { ingestion } = await analyze({ path, createdAt: new Date(0) });
  const stateToPattern = new Map(
    ingestion.screens.map(({ routePattern }) => [
      stateId({ screenId: screenId({ appKey: ingestion.application.id, routePattern }), key: DEFAULT_STATE_KEY }),
      routePattern,
    ]),
  );
  const spans = new Map(ingestion.evidence.map((evidence) => [evidence.id, evidence.span]));
  const transitions = new Map(ingestion.transitions.map((transition) => [transition.id, transition]));
  const lines = new Map<string, readonly string[]>();
  const edges: Edge[] = [];
  for (const { subject, evidenceId } of ingestion.observations) {
    if (subject.kind !== 'transition') continue;
    const transition = transitions.get(subject.id);
    const span = spans.get(evidenceId);
    if (transition === undefined || span === undefined || transition.target.kind !== 'resolved') continue;
    const source = stateToPattern.get(transition.sourceStateId);
    const target = stateToPattern.get(transition.target.stateId);
    if (source === undefined || target === undefined) throw new Error('transition points at an unknown state');
    if (!lines.has(span.file)) lines.set(span.file, (await readFile(join(path, span.file), 'utf8')).split('\n'));
    const code = (lines.get(span.file) ?? []).slice(span.start.line - 1, span.end.line).join('\n').trim();
    const key = [app.repo, app.commit, app.root, span.file, span.start.line, span.start.column, source, target].join('\0');
    edges.push({
      id: createHash('sha256').update(key).digest('hex').slice(0, 12),
      app: label(app),
      source,
      target,
      trigger: transition.trigger.kind,
      file: span.file,
      line: span.start.line,
      code: code.length > 400 ? `${code.slice(0, 400)}…` : code,
    });
  }
  return edges;
}

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    size: { type: 'string', default: '100' },
    seed: { type: 'string', default: '1' },
    score: { type: 'string' },
    cache: { type: 'string', default: join(homedir(), '.cache', 'nori', 'bench') },
  },
  allowPositionals: false,
  strict: true,
});

const size = Number(values.size);
const seed = Number(values.seed);
const modes = [values.out, values.score].filter((mode) => mode !== undefined).length;
if (modes !== 1 || !Number.isInteger(size) || size < 1 || !Number.isInteger(seed)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const manifest = await loadManifest({ path: new URL('./tuning.json', import.meta.url) });
const labelled: readonly Labelled[] | undefined =
  values.score === undefined ? undefined : JSON.parse(await readFile(values.score, 'utf8')).edges;
const wanted = labelled === undefined ? undefined : new Set(labelled.map(({ app }) => app));
const edges: Edge[] = [];
for (const app of manifest.apps) {
  if (wanted !== undefined && !wanted.has(label(app))) continue;
  process.stderr.write(`tuning ${label(app)}\n`);
  const dir = await checkout({ cacheDir: values.cache, repo: app.repo, commit: app.commit });
  edges.push(...(await resolvedEdges(app, join(dir, app.root))));
}
if (labelled !== undefined) {
  process.stdout.write(`${score(labelled, new Set(edges.map(({ id }) => id)))}\n`);
} else if (values.out !== undefined) {
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const picked = sample(edges, size, seed);
  process.stderr.write(`${edges.length} resolved edges, sampled ${picked.length} with seed ${seed}\n`);
  await writeFile(values.out, `${JSON.stringify(picked, null, 1)}\n`);
}
