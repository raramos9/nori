import { z } from 'zod';
import type { BuildDiff, Change, DiffSide, Gap } from '../graph/diff.js';
import { sessionKey } from '../graph/ids.js';
import type { Analysis, AnalysisId, AnalyzerVersion, BuildGraph, BuildSummary } from '../graph/model.js';

export type BuildStore = {
  list(): Promise<readonly BuildSummary[]>;
  load(analysisId: AnalysisId): Promise<BuildGraph | null>;
};

export type Resolution =
  | { readonly kind: 'resolved'; readonly base: Analysis; readonly head: Analysis }
  | { readonly kind: 'unknown-snapshot'; readonly side: 'base' | 'head'; readonly id: string }
  | {
      readonly kind: 'no-shared-analyzer';
      readonly base: readonly AnalyzerVersion[];
      readonly head: readonly AnalyzerVersion[];
    };

const newestFirst = (a: Analysis, b: Analysis): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const versionsOf = (analyses: readonly Analysis[]): AnalyzerVersion[] => [
  ...new Set([...analyses].sort(newestFirst).map(({ analyzerVersion }) => analyzerVersion)),
];

export function resolveAnalyses({
  builds,
  base,
  head,
  served,
}: {
  builds: readonly BuildSummary[];
  base: string;
  head: string;
  served: string;
}): Resolution {
  const baseBuild = builds.find(({ snapshot }) => snapshot.id === base);
  if (baseBuild === undefined) return { kind: 'unknown-snapshot', side: 'base', id: base };
  const headBuild = builds.find(({ snapshot }) => snapshot.id === head);
  if (headBuild === undefined) return { kind: 'unknown-snapshot', side: 'head', id: head };

  const newestOf = (build: BuildSummary, version: AnalyzerVersion): Analysis | undefined =>
    [...build.analyses].sort(newestFirst).find(({ analyzerVersion }) => analyzerVersion === version);
  const baseVersions = versionsOf(baseBuild.analyses);
  const headVersions = versionsOf(headBuild.analyses);
  const shared = baseVersions.filter((version) => headVersions.includes(version));
  const version = shared.find((candidate) => candidate === served) ?? shared[0];
  const baseAnalysis = version === undefined ? undefined : newestOf(baseBuild, version);
  const headAnalysis = version === undefined ? undefined : newestOf(headBuild, version);
  if (baseAnalysis === undefined || headAnalysis === undefined) {
    return { kind: 'no-shared-analyzer', base: baseVersions, head: headVersions };
  }
  return { kind: 'resolved', base: baseAnalysis, head: headAnalysis };
}

const sessionSchema = z.string().describe("'anonymous' or 'storage-state:<label>'");

const subjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), id: z.string(), routePattern: z.string() }),
  z.object({
    kind: z.literal('transition'),
    id: z.string(),
    from: z.string().describe('Route pattern of the source screen'),
    trigger: z.object({ kind: z.enum(['link', 'router-push', 'router-replace', 'redirect']) }),
    to: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('route'), pattern: z.string() }),
      z.object({
        kind: z.literal('unresolved'),
        reason: z.string(),
        expression: z.string().describe('Source text of the navigation call the analysis could not pin to a route'),
      }),
    ]),
  }),
]);

const runtimeCiteSchema = z.object({
  id: z.string().describe('Evidence id of the capture or navigation'),
  runId: z.string(),
  kind: z.enum(['capture', 'navigation']),
  verdict: z.enum(['supports', 'contradicts']),
});
const citedSchema = z.object({
  static: z.array(z.string()).describe('Evidence ids of the static analysis'),
  runtime: z.array(runtimeCiteSchema),
});
const seenSchema = z.object({
  status: z.enum(['observed', 'failed']),
  evidence: z.array(runtimeCiteSchema),
});
const unseenSchema = z.object({
  witnesses: z
    .array(z.object({ runId: z.string(), sourceCapture: z.string().optional() }))
    .describe('Runs on this side that were in a position to see it and did not'),
});
const captureCiteSchema = z.object({
  evidenceId: z.string(),
  runId: z.string(),
  screenshot: z.string().describe('Absolute path to a PNG; Read it to see the page'),
  sha256: z.string(),
});

const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), subject: subjectSchema, head: citedSchema }),
  z.object({ kind: z.literal('removed'), subject: subjectSchema, base: citedSchema }),
  z.object({ kind: z.literal('inference-gained'), subject: subjectSchema, base: citedSchema, head: citedSchema }),
  z.object({ kind: z.literal('inference-lost'), subject: subjectSchema, base: citedSchema, head: citedSchema }),
  z.object({ kind: z.literal('newly-unverified'), subject: subjectSchema, base: seenSchema, head: unseenSchema }),
  z.object({ kind: z.literal('newly-observed'), subject: subjectSchema, base: unseenSchema, head: seenSchema }),
  z.object({ kind: z.literal('status-changed'), subject: subjectSchema, base: seenSchema, head: seenSchema }),
  z.object({
    kind: z.literal('screenshot-changed'),
    subject: subjectSchema,
    session: sessionSchema,
    path: z.string().describe('Crawled page path whose screenshot differs'),
    base: captureCiteSchema,
    head: captureCiteSchema,
  }),
]);

const gapSchema = z.object({
  subject: subjectSchema,
  seenIn: z.enum(['base', 'head']),
  seen: seenSchema,
  sessions: z.array(sessionSchema),
  why: z.enum(['no-run-in-session', 'not-exhausted', 'source-not-captured', 'not-link-walked']),
});

const sideSchema = z.object({
  snapshot: z.object({ id: z.string(), commitSha: z.string(), branch: z.string().nullable() }),
  analysisId: z.string(),
  runs: z.array(z.object({ id: z.string(), session: sessionSchema })),
  unmatchedRuns: z
    .array(z.string())
    .describe('Runs of this snapshot that could not be matched to this analysis; their evidence is missing from the diff'),
});

export const diffOutputSchema = {
  appKey: z.string(),
  analyzerVersion: z.string().describe('The analyzer that read both sides'),
  base: sideSchema,
  head: sideSchema,
  changes: z
    .array(changeSchema)
    .describe(
      'added/removed: the screen or transition exists on one side only. inference-gained/lost: static analysis found it on one side only. newly-unverified/newly-observed: crawled on one side only while the other side had runs that should have seen it. status-changed: observed on both sides with a different outcome. screenshot-changed: the same page rendered differently; a changed picture is a fact, not a regression.',
    ),
  gaps: z
    .array(gapSchema)
    .describe('Seen on one side, not comparable: the other side lacks a run that could have seen it, so no change is claimed. why says what is missing.'),
};

export const listOutputSchema = {
  servedAnalyzerVersion: z
    .string()
    .describe('The analyzer this server runs now; only snapshots analysed by one analyzer version compare'),
  servedAnalysisId: z.string(),
  builds: z.array(
    z.object({
      snapshotId: z.string().describe('Pass to diff_builds as base or head'),
      commitSha: z.string(),
      branch: z.string().nullable(),
      worktree: z
        .enum(['clean', 'dirty'])
        .describe("'dirty' means uncommitted edits were analysed, so the commit does not fully identify the source"),
      sourceHash: z.string(),
      createdAt: z.string(),
      runCount: z.number().describe('Crawl runs recorded for this snapshot'),
      analyses: z.array(
        z.object({
          id: z.string(),
          analyzerVersion: z.string(),
          createdAt: z.string(),
          served: z.boolean().describe('Analysed by the version this server runs'),
        }),
      ),
    }),
  ),
};

function trimChange(change: Change): Record<string, unknown> {
  return change.kind === 'screenshot-changed' ? { ...change, session: sessionKey(change.session) } : change;
}

const trimSide = ({ snapshot, analysisId, runs, unmatchedRuns }: DiffSide) => ({
  snapshot: { id: snapshot.id, commitSha: snapshot.commitSha, branch: snapshot.branch },
  analysisId,
  runs: runs.map(({ id, session }) => ({ id, session: sessionKey(session) })),
  unmatchedRuns,
});

const trimGap = (gap: Gap) => ({ ...gap, sessions: gap.sessions.map(sessionKey) });

export function trimDiff(diff: BuildDiff): Record<string, unknown> {
  return {
    appKey: diff.appKey,
    analyzerVersion: diff.analyzerVersion,
    base: trimSide(diff.base),
    head: trimSide(diff.head),
    changes: diff.changes.map(trimChange),
    gaps: diff.gaps.map(trimGap),
  };
}
