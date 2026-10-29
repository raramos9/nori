import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildDiff, Change, Gap, ScreenSubject, TransitionSubject } from '../graph/diff.js';
import {
  parseAnalysisId,
  parseAnalyzerVersion,
  parseAppKey,
  parseArtifactPath,
  parseCommitSha,
  parseEvidenceId,
  parseOrigin,
  parseRoutePattern,
  parseRunId,
  parseScreenId,
  parseSnapshotId,
  parseTransitionId,
  type Run,
  type RunId,
  type Session,
} from '../graph/model.js';
import { demoHistory } from '../testing/demo-history.js';
import {
  addedOrRemovedEdges,
  addedOrRemovedScreens,
  diffViewSchema,
  expectedDiff,
  keys,
} from '../testing/fixture-diff.js';
import { formatDiff, formatDiffMarkdown } from './diff.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLOW = 60_000;

describe('nori diff CLI', () => {
  const expected = expectedDiff('route-added-edge-removed');
  const history = demoHistory('route-added-edge-removed');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nori-diff-home-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nori-diff-tmp-')));

  function git(...args: string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: history.root, encoding: 'utf8' },
    ).trim();
  }

  // TMPDIR points at `scratch` (tsx keeps its own cache there too), so a leftover nori-diff-* directory shows up in it.
  function runCli(...args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NORI_HOME: home, TMPDIR: scratch },
    });
  }

  const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));

  const leftovers = () => readdirSync(scratch).filter((name) => name.startsWith('nori-diff-'));

  let json: ReturnType<typeof runCli>;
  let text: ReturnType<typeof runCli>;

  beforeAll(() => {
    json = runCli('diff', history.base, history.head, history.root, '--json');
    text = runCli('diff', history.base, 'HEAD', history.root);
  }, SLOW);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(history.root, { recursive: true, force: true });
  });

  it('prints the planned screens and edges as JSON', () => {
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    const diff = diffViewSchema.parse(JSON.parse(json.stdout));
    expect(addedOrRemovedScreens(diff, 'added')).toEqual(expected.screens.added);
    expect(addedOrRemovedScreens(diff, 'removed')).toEqual(expected.screens.removed);
    expect(addedOrRemovedEdges(diff, 'added')).toEqual(keys(expected.edges.added));
    expect(addedOrRemovedEdges(diff, 'removed')).toEqual(keys(expected.edges.removed));
    expect(diff.changes.every(({ kind }) => kind === 'added' || kind === 'removed')).toBe(true);
    expect(diff.gaps).toEqual([]);
  });

  it('names each planned screen and edge in the text output', () => {
    expect(text.status).toBe(0);
    const lines = text.stdout.split('\n');
    expect(lines[0]).toMatch(/^diff app_[0-9a-f]{16}, analyzer /);
    expect(lines[1]).toBe(`base ${history.base} ${history.base.slice(0, 7)}, 0 runs`);
    expect(lines[2]).toBe(`head HEAD ${history.head.slice(0, 7)}, 0 runs`);
    for (const screen of expected.screens.added) expect(text.stdout).toContain(`added               screen ${screen}`);
    for (const { from, to } of expected.edges.added) {
      expect(text.stdout).toMatch(new RegExp(`added +transition ${from} -[a-z-]+-> ${to}$`, 'm'));
    }
    for (const { from, to } of expected.edges.removed) {
      expect(text.stdout).toMatch(new RegExp(`removed +transition ${from} -[a-z-]+-> ${to}$`, 'm'));
    }
    expect(text.stdout).not.toContain('coverage gap');
  });

  it('prints the markdown table', () => {
    const result = runCli('diff', history.base, history.head, history.root, '--markdown');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`### nori diff ${history.base} → ${history.head}`);
    expect(result.stdout).toContain('| Change | Subject |');
    expect(result.stdout).toContain('| added | `screen /changelog` |');
  }, SLOW);

  it('leaves only the main worktree and no temporary directory after a success', () => {
    expect(worktrees()).toEqual([`worktree ${history.root}`]);
    expect(leftovers()).toEqual([]);
  });

  it('removes the worktree and the temporary directory when the scan throws', () => {
    git('switch', '-q', '-c', 'broken');
    git('rm', '-rq', 'app');
    git('commit', '-q', '-m', 'delete the app');
    git('switch', '-q', 'main');

    const result = runCli('diff', history.head, 'broken', history.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^nori: /);
    expect(result.stderr).not.toMatch(/\bat .*\.ts/);
    expect(result.stdout).toBe('');
    expect(worktrees()).toEqual([`worktree ${history.root}`]);
    expect(leftovers()).toEqual([]);
  }, SLOW);

  it('exits 1 and names a ref that is not a commit', () => {
    const result = runCli('diff', history.base, 'no-such-ref', history.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no-such-ref');
    expect(result.stdout).toBe('');
    expect(worktrees()).toEqual([`worktree ${history.root}`]);
  }, SLOW);

  it('exits 2 on both format flags or the wrong number of refs', () => {
    const both = runCli('diff', history.base, history.head, history.root, '--json', '--markdown');
    expect(both.status).toBe(2);
    expect(both.stderr).toMatch(/^usage: nori diff/);
    expect(runCli('diff', history.base, '--json').status).toBe(2);
    expect(runCli('diff', 'a', 'b', history.root, 'd').status).toBe(2);
  }, SLOW);
});

describe('diff renderers', () => {
  const id = (n: number) => n.toString(16).padStart(16, '0');
  const run = (n: number): RunId => parseRunId(`run_${id(n)}`);
  const pattern = parseRoutePattern;
  const anonymous: Session = { kind: 'anonymous' };
  const signedIn: Session = { kind: 'storage-state', label: 'signed-in' };

  const runRecord = (n: number): Run => ({
    id: run(n),
    snapshotId: parseSnapshotId(`snp_${id(1)}`),
    origin: parseOrigin('http://localhost:3000'),
    session: anonymous,
    environment: 'local',
    seededBy: parseAnalyzerVersion('1.0.0'),
    startedAt: new Date(0),
    finishedAt: new Date(0),
    stop: 'frontier-exhausted',
    crawlerVersion: '1',
    requests: { allowed: 0, blocked: 0 },
  });

  const side = (sha: string, runs: number[], unmatchedRuns: RunId[] = []) => ({
    snapshot: {
      id: parseSnapshotId(`snp_${id(1)}`),
      appKey: parseAppKey(`app_${id(1)}`),
      commitSha: parseCommitSha(sha.repeat(40)),
      sourceHash: 'h',
      worktree: 'clean' as const,
      branch: null,
      createdAt: new Date(0),
    },
    analysisId: parseAnalysisId(`ana_${id(1)}`),
    runs: runs.map(runRecord),
    unmatchedRuns,
  });

  const screen = (route: string): ScreenSubject => ({
    kind: 'screen',
    id: parseScreenId(`scr_${id(2)}`),
    routePattern: pattern(route),
  });
  const transition = (from: string, to: TransitionSubject['to']): TransitionSubject => ({
    kind: 'transition',
    id: parseTransitionId(`trn_${id(3)}`),
    from: pattern(from),
    trigger: { kind: 'router-push' },
    to,
  });
  const cite = (n: number, verdict: 'supports' | 'contradicts') => ({
    id: parseEvidenceId(`evd_${id(n)}`),
    runId: run(n),
    kind: 'capture' as const,
    verdict,
  });
  const seen = (status: 'observed' | 'failed', n: number) => ({
    status,
    evidence: [cite(n, status === 'observed' ? 'supports' : 'contradicts')] as const,
  });
  const gap = (why: Gap['why'], seenIn: Gap['seenIn'], subject: Gap['subject'], sessions: Gap['sessions']): Gap => ({
    subject,
    seenIn,
    seen: seen('observed', 5),
    sessions,
    why,
  });

  const unresolved = transition('/b', { kind: 'unresolved', reason: 'dynamic-expression', expression: 'a | b ? `x` : y' });
  const changes: Change[] = [
    { kind: 'added', subject: screen('/reports'), head: { static: [parseEvidenceId(`evd_${id(9)}`)], runtime: [] } },
    {
      kind: 'newly-unverified',
      subject: transition('/a', { kind: 'route', pattern: pattern('/b') }),
      base: seen('observed', 5),
      head: { witnesses: [{ runId: run(1), sourceCapture: parseEvidenceId(`evd_${id(1)}`) }, { runId: run(2), sourceCapture: parseEvidenceId(`evd_${id(2)}`) }] },
    },
    { kind: 'status-changed', subject: screen('/login'), base: seen('observed', 5), head: seen('failed', 6) },
    {
      kind: 'screenshot-changed',
      subject: screen('/settings'),
      session: signedIn,
      path: '/settings',
      base: { evidenceId: parseEvidenceId(`evd_${id(5)}`), runId: run(1), screenshot: parseArtifactPath('/a.png'), sha256: 'aa' },
      head: { evidenceId: parseEvidenceId(`evd_${id(6)}`), runId: run(3), screenshot: parseArtifactPath('/b.png'), sha256: 'bb' },
    },
    { kind: 'newly-observed', subject: unresolved, base: { witnesses: [{ runId: run(7), sourceCapture: parseEvidenceId(`evd_${id(7)}`) }] }, head: seen('observed', 8) },
  ];
  const gaps: Gap[] = [
    gap('no-run-in-session', 'base', screen('/x'), [anonymous, signedIn]),
    gap('not-exhausted', 'head', screen('/y'), [signedIn]),
    gap('source-not-captured', 'base', unresolved, [anonymous]),
    gap('not-link-walked', 'head', screen('/z'), [anonymous]),
  ];
  const diff: BuildDiff = {
    appKey: parseAppKey(`app_${id(1)}`),
    analyzerVersion: parseAnalyzerVersion('1.0.0'),
    base: side('a', [1, 2], [run(11), run(12)]),
    head: side('b', [3]),
    changes,
    gaps,
  };
  const refs = { base: 'main', head: 'feature' };

  it('renders every change kind, gap reason, the unresolved target and the unmatched-run warning as text', () => {
    expect(formatDiff({ diff, refs }).split('\n')).toEqual([
      `diff app_${id(1)}, analyzer 1.0.0`,
      'base main aaaaaaa, 2 runs',
      'head feature bbbbbbb, 1 run',
      `warning: 2 base runs did not match this analysis: run_${id(11)}, run_${id(12)}`,
      '',
      '5 changes',
      '  added               screen /reports',
      `  newly unverified    transition /a -router-push-> /b (observed in base; head runs run_${id(1)}, run_${id(2)} walked /a and missed it)`,
      '  status changed      screen /login (observed -> failed)',
      `  screenshot differs  screen /settings (storage-state:signed-in /settings: evd_${id(5)} -> evd_${id(6)})`,
      `  newly observed      transition /b -router-push-> ? a | b ? \`x\` : y (dynamic-expression) (observed in head; base runs run_${id(7)} walked /b and missed it)`,
      '',
      '4 coverage gaps (seen on one side, not comparable)',
      '  screen /x seen in base (anonymous, storage-state:signed-in): no head run in that session',
      '  screen /y seen in head (storage-state:signed-in): the base runs in that session stopped before the frontier was exhausted',
      '  transition /b -router-push-> ? a | b ? `x` : y (dynamic-expression) seen in base (anonymous): no head run captured the source screen',
      '  screen /z seen in head (anonymous): reached only by an interaction or a seed, which a later crawl may not repeat',
    ]);
  });

  it('keeps a crawled page path that looks like markdown inside a code span', () => {
    const hostile = changes.map((change) =>
      change.kind === 'screenshot-changed' ? { ...change, path: '/a|b[click](https://x)?q=`y`' } : change,
    );
    const lines = formatDiffMarkdown({ diff: { ...diff, changes: hostile }, refs }).split('\n');
    expect(lines).toContain(
      `| screenshot differs | \`screen /settings\` \`\` (storage-state:signed-in /a\\|b[click](https://x)?q=\`y\`: evd_${id(5)} -> evd_${id(6)}) \`\` |`,
    );
  });

  it('prints no changes and no gap section for an empty diff', () => {
    const empty = { ...diff, base: side('a', []), head: side('b', []), changes: [], gaps: [] };
    expect(formatDiff({ diff: empty, refs }).split('\n').slice(3)).toEqual(['', 'no changes']);
  });

  it('renders markdown with subjects in code spans, escaped pipes and a details block for gaps', () => {
    const lines = formatDiffMarkdown({ diff, refs }).split('\n');
    expect(lines[0]).toBe('### nori diff main → feature');
    expect(lines).toContain('Warning: 2 base runs did not match this analysis: ' + `run_${id(11)}, run_${id(12)}.`);
    expect(lines).toContain('| Change | Subject |');
    expect(lines).toContain('| added | `screen /reports` |');
    expect(lines).toContain('| status changed | `screen /login` |');
    expect(lines).toContain(`| screenshot differs | \`screen /settings\` \`(storage-state:signed-in /settings: evd_${id(5)} -> evd_${id(6)})\` |`);
    expect(lines).toContain('| newly observed | ``` transition /b -router-push-> ? a \\| b ? `x` : y (dynamic-expression) ``` |'.replace('```', '``').replace('```', '``'));
    expect(lines).toContain('<summary>4 coverage gaps</summary>');
    expect(lines).toContain('| Subject | Seen in | Why not compared |');
    expect(lines).toContain('| `screen /x` | base (anonymous, storage-state:signed-in) | no head run in that session |');
    expect(lines.at(-1)).toBe('</details>');
    for (const line of lines.filter((l) => l.startsWith('| ') && l.includes('?'))) {
      expect(line.replace(/\\\|/g, '').split('|')).toHaveLength(line.startsWith('| newly') ? 4 : 5);
    }
  });

  it('says so when markdown has no changes', () => {
    const empty = { ...diff, changes: [], gaps: [] };
    expect(formatDiffMarkdown({ diff: empty, refs })).toContain('No changes.');
    expect(formatDiffMarkdown({ diff: empty, refs })).not.toContain('<details>');
  });
});
