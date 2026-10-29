import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NoriError } from '../errors.js';
import {
  comparable,
  diffBuilds,
  type BuildDiff,
  type Change,
  type DiffSide,
  type Gap,
  type Subject,
} from '../graph/diff.js';
import { sessionKey } from '../graph/ids.js';
import type { ArtifactPath, BuildGraph, CommitSha } from '../graph/model.js';
import { resolveRoot } from '../next/project.js';
import { addDetachedWorktree, removeWorktree, resolveCommit, showPrefix } from '../repo/git.js';
import type { Command } from './command.js';
import { scan } from './scan.js';

type Side = { readonly ref: string; readonly commitSha: CommitSha };

type DiffRequest = {
  readonly root: string;
  readonly prefix: string;
  readonly base: Side;
  readonly head: Side;
};

type Format = 'text' | 'json' | 'markdown';

type Refs = { readonly base: string; readonly head: string };

const USAGE = 'usage: nori diff <base> <head> [path] [--json | --markdown]\n';

// Every side gets a fresh worktree so the scan reads the committed tree, never the user's dirty files.
async function scanCommit({
  root,
  prefix,
  commitSha,
}: {
  root: string;
  prefix: string;
  commitSha: CommitSha;
}): Promise<BuildGraph> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nori-diff-')));
  try {
    await addDetachedWorktree({ root, dir, commitSha });
    try {
      return await scan({ path: join(dir, prefix) });
    } finally {
      await removeWorktree({ root, dir });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const screenshotDigest = (path: ArtifactPath): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function diffCommits({ root, prefix, base, head }: DiffRequest): Promise<BuildDiff> {
  const baseGraph = await scanCommit({ root, prefix, commitSha: base.commitSha });
  const headGraph = await scanCommit({ root, prefix, commitSha: head.commitSha });
  const pair = comparable(baseGraph, headGraph);
  switch (pair.kind) {
    case 'comparable':
      return diffBuilds(pair.pair, { screenshotDigest });
    case 'different-apps':
      throw new NoriError(`${base.ref} and ${head.ref} are different apps: ${pair.base.id} and ${pair.head.id}`);
    case 'different-analyzers':
      throw new NoriError(
        `${base.ref} and ${head.ref} were read by different analyzers: ${pair.base} and ${pair.head}`,
      );
    default: {
      const _exhaustive: never = pair;
      return _exhaustive;
    }
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

function subjectText(subject: Subject): string {
  switch (subject.kind) {
    case 'screen':
      return `screen ${subject.routePattern}`;
    case 'transition': {
      const { to } = subject;
      const target = to.kind === 'route' ? to.pattern : `? ${flat(to.expression)} (${to.reason})`;
      return `transition ${subject.from} -${subject.trigger.kind}-> ${target}`;
    }
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

function kindWord(kind: Change['kind']): string {
  switch (kind) {
    case 'added':
    case 'removed':
      return kind;
    case 'inference-gained':
      return 'inference gained';
    case 'inference-lost':
      return 'inference lost';
    case 'newly-unverified':
      return 'newly unverified';
    case 'newly-observed':
      return 'newly observed';
    case 'status-changed':
      return 'status changed';
    case 'screenshot-changed':
      return 'screenshot differs';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

const KIND_WIDTH = 'screenshot differs'.length;

function runList(witnesses: readonly { readonly runId: string }[]): string {
  return witnesses.map(({ runId }) => runId).join(', ');
}

function missedText(
  { subject }: Change,
  side: 'base' | 'head',
  witnesses: readonly { readonly runId: string }[],
): string {
  const action = subject.kind === 'transition' ? `walked ${subject.from} and missed it` : 'followed links and never reached it';
  return `${side} runs ${runList(witnesses)} ${action}`;
}

function changeDetail(change: Change): string {
  switch (change.kind) {
    case 'added':
    case 'removed':
    case 'inference-gained':
    case 'inference-lost':
      return '';
    case 'newly-unverified':
      return ` (observed in base; ${missedText(change, 'head', change.head.witnesses)})`;
    case 'newly-observed':
      return ` (observed in head; ${missedText(change, 'base', change.base.witnesses)})`;
    case 'status-changed':
      return ` (${change.base.status} -> ${change.head.status})`;
    case 'screenshot-changed':
      return ` (${sessionKey(change.session)} ${change.path}: ${change.base.evidenceId} -> ${change.head.evidenceId})`;
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

function otherSide(seenIn: Gap['seenIn']): Gap['seenIn'] {
  return seenIn === 'base' ? 'head' : 'base';
}

function gapReason({ why, seenIn }: Gap): string {
  const other = otherSide(seenIn);
  switch (why) {
    case 'no-run-in-session':
      return `no ${other} run in that session`;
    case 'not-exhausted':
      return `the ${other} runs in that session stopped before the frontier was exhausted`;
    case 'source-not-captured':
      return `no ${other} run captured the source screen`;
    case 'not-link-walked':
      return 'reached only by an interaction or a seed, which a later crawl may not repeat';
    default: {
      const _exhaustive: never = why;
      return _exhaustive;
    }
  }
}

const sessionsText = ({ sessions }: Gap) => sessions.map(sessionKey).join(', ');

function unmatchedWarnings(diff: BuildDiff): string[] {
  const sides: readonly (readonly ['base' | 'head', DiffSide])[] = [
    ['base', diff.base],
    ['head', diff.head],
  ];
  return sides.flatMap(([name, side]) =>
    side.unmatchedRuns.length === 0
      ? []
      : [`${side.unmatchedRuns.length} ${name} runs did not match this analysis: ${side.unmatchedRuns.join(', ')}`],
  );
}

const sha7 = (side: DiffSide) => side.snapshot.commitSha.slice(0, 7);

export function formatDiff({ diff, refs }: { diff: BuildDiff; refs: Refs }): string {
  const lines = [
    `diff ${diff.appKey}, analyzer ${diff.analyzerVersion}`,
    `base ${refs.base} ${sha7(diff.base)}, ${plural(diff.base.runs.length, 'run')}`,
    `head ${refs.head} ${sha7(diff.head)}, ${plural(diff.head.runs.length, 'run')}`,
    ...unmatchedWarnings(diff).map((warning) => `warning: ${warning}`),
    '',
  ];
  if (diff.changes.length === 0) {
    lines.push('no changes');
  } else {
    lines.push(plural(diff.changes.length, 'change'));
    for (const change of diff.changes) {
      lines.push(`  ${kindWord(change.kind).padEnd(KIND_WIDTH)}  ${subjectText(change.subject)}${changeDetail(change)}`);
    }
  }
  if (diff.gaps.length > 0) {
    lines.push('', `${plural(diff.gaps.length, 'coverage gap')} (seen on one side, not comparable)`);
    for (const gap of diff.gaps) {
      lines.push(`  ${subjectText(gap.subject)} seen in ${gap.seenIn} (${sessionsText(gap)}): ${gapReason(gap)}`);
    }
  }
  return lines.join('\n');
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

const cell = (text: string) => text.replace(/\|/g, '\\|');
const subjectCell = (subject: Subject) => cell(codeSpan(subjectText(subject)));

export function formatDiffMarkdown({ diff, refs }: { diff: BuildDiff; refs: Refs }): string {
  const lines = [
    `### nori diff ${refs.base} → ${refs.head}`,
    '',
    `App ${codeSpan(diff.appKey)}, analyzer ${codeSpan(diff.analyzerVersion)}, ` +
      `base ${plural(diff.base.runs.length, 'run')}, head ${plural(diff.head.runs.length, 'run')}.`,
    ...unmatchedWarnings(diff).map((warning) => `\nWarning: ${warning}.`),
    '',
  ];
  if (diff.changes.length === 0) {
    lines.push('No changes.');
  } else {
    lines.push('| Change | Subject |', '| --- | --- |');
    for (const change of diff.changes) {
      const detail = change.kind === 'screenshot-changed' ? ` ${cell(codeSpan(changeDetail(change).trim()))}` : '';
      lines.push(`| ${kindWord(change.kind)} | ${subjectCell(change.subject)}${detail} |`);
    }
  }
  if (diff.gaps.length > 0) {
    lines.push(
      '',
      '<details>',
      `<summary>${plural(diff.gaps.length, 'coverage gap')}</summary>`,
      '',
      '| Subject | Seen in | Why not compared |',
      '| --- | --- | --- |',
    );
    for (const gap of diff.gaps) {
      lines.push(
        `| ${subjectCell(gap.subject)} | ${cell(`${gap.seenIn} (${sessionsText(gap)})`)} | ${cell(gapReason(gap))} |`,
      );
    }
    lines.push('', '</details>');
  }
  return lines.join('\n');
}

function render({ diff, refs, format }: { diff: BuildDiff; refs: Refs; format: Format }): string {
  switch (format) {
    case 'text':
      return formatDiff({ diff, refs });
    case 'markdown':
      return formatDiffMarkdown({ diff, refs });
    case 'json':
      return JSON.stringify(diff, null, 2);
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

export const diffCommand: Command = {
  summary: 'compare the behavioral map of two commits',
  async run(argv) {
    const { positionals, values } = parseArgs({
      args: [...argv],
      options: { json: { type: 'boolean' }, markdown: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    const [baseRef, headRef, path, ...extra] = positionals;
    if (baseRef === undefined || headRef === undefined || extra.length > 0 || (values.json && values.markdown)) {
      process.stderr.write(USAGE);
      return 2;
    }
    const format: Format = values.json ? 'json' : values.markdown ? 'markdown' : 'text';
    const root = await resolveRoot(path ?? process.cwd());
    const resolve = async (ref: string): Promise<Side> => ({ ref, commitSha: await resolveCommit({ root, ref }) });
    const diff = await diffCommits({
      root,
      prefix: await showPrefix({ root }),
      base: await resolve(baseRef),
      head: await resolve(headRef),
    });
    process.stdout.write(`${render({ diff, refs: { base: baseRef, head: headRef }, format })}\n`);
    return 0;
  },
};
