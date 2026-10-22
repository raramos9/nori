import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../src/commands/scan.js';
import { checkout } from './checkout.js';
import { loadManifest, type BenchApp } from './manifest.js';
import { row, tally, type Row, type Tally } from './rate.js';

const FLOOR = 50;
const TARGET = 60;
const SETS = ['tuning', 'held-out'] as const;
type SetName = (typeof SETS)[number];

type Scored = { readonly app: string; readonly raw: Tally; readonly adapters: Tally };

const USAGE =
  'usage: pnpm exec tsx bench/run.ts [--set tuning|held-out|all] [--cache <dir>] [--only <repo[/root]>]... [--rows <file>]\n';

const percent = ({ internal, resolved }: Tally): number | null => (internal === 0 ? null : (100 * resolved) / internal);

function cell(tally: Tally): string {
  const value = percent(tally);
  return value === null ? '-' : `${value.toFixed(1)}% (${tally.resolved}/${tally.internal})`;
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  const low = sorted[middle - 1];
  if (high === undefined) return null;
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}

function pooled(tallies: readonly Tally[]): Tally {
  return {
    internal: tallies.reduce((sum, t) => sum + t.internal, 0),
    resolved: tallies.reduce((sum, t) => sum + t.resolved, 0),
  };
}

function medianText(tallies: readonly Tally[]): string {
  const value = median(tallies.map(percent).filter((v): v is number => v !== null));
  return value === null ? '-' : `${value.toFixed(1)}%`;
}

function report(set: SetName, scored: readonly Scored[]): string {
  const raw = scored.map((s) => s.raw);
  const adapters = scored.map((s) => s.adapters);
  const lines = [
    `## ${set}`,
    '',
    '| app | raw | adapters |',
    '| --- | --- | --- |',
    ...scored.map((s) => `| ${s.app} | ${cell(s.raw)} | ${cell(s.adapters)} |`),
    `| **total (pooled)** | ${cell(pooled(raw))} | ${cell(pooled(adapters))} |`,
    '',
    `Median per app: raw ${medianText(raw)}, adapters ${medianText(adapters)}`,
  ];
  if (set === 'held-out') {
    const verdict = (name: string, threshold: number, tally: Tally) => {
      const value = percent(tally);
      return `${name} >= ${threshold}%: ${value !== null && value >= threshold ? 'PASS' : 'FAIL'}`;
    };
    lines.push(
      '',
      `PRD §11 floor, ${verdict('raw total', FLOOR, pooled(raw))}`,
      `PRD §11 target, ${verdict('adapters total', TARGET, pooled(adapters))}`,
    );
  }
  return lines.join('\n');
}

const label = ({ repo, root }: BenchApp): string => (root === '.' ? repo : `${repo}/${root}`);

const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'all' },
    cache: { type: 'string', default: join(homedir(), '.cache', 'nori', 'bench') },
    only: { type: 'string', multiple: true, default: [] },
    rows: { type: 'string' },
  },
  allowPositionals: false,
  strict: true,
});

if (values.set !== 'all' && values.set !== 'tuning' && values.set !== 'held-out') {
  process.stderr.write(USAGE);
  process.exit(2);
}
const selectedSets: readonly SetName[] = values.set === 'all' ? SETS : [values.set];

const selection = await Promise.all(
  selectedSets.map(async (set) => {
    const manifest = await loadManifest({ path: new URL(`./${set}.json`, import.meta.url) });
    const apps = manifest.apps.filter((app) => values.only.length === 0 || values.only.some((o) => label(app).includes(o)));
    return { set, apps };
  }),
);

if (values.rows !== undefined && selection.some(({ set, apps }) => set === 'held-out' && apps.length > 0)) {
  process.stderr.write('--rows is not allowed when a held-out app is selected\n');
  process.exit(2);
}

const rows: Row[] = [];
const sections: string[] = [];
for (const { set, apps } of selection) {
  const scored: Scored[] = [];
  for (const app of apps) {
    process.stderr.write(`${set} ${label(app)}\n`);
    const dir = await checkout({ cacheDir: values.cache, repo: app.repo, commit: app.commit });
    const path = join(dir, app.root);
    const createdAt = new Date();
    const off = await analyze({ path, createdAt, adapters: false });
    const raw = tally(off.outcomes);
    const on = await analyze({ path, createdAt, adapters: true });
    scored.push({ app: label(app), raw, adapters: tally(on.outcomes) });
    if (values.rows !== undefined) rows.push(...on.outcomes.map((outcome) => row(label(app), outcome)));
  }
  if (apps.length > 0) sections.push(report(set, scored));
}

process.stdout.write(`${sections.join('\n\n')}\n`);
if (values.rows !== undefined) await writeFile(values.rows, `${JSON.stringify(rows, null, 1)}\n`);
