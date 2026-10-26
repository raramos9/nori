import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pairKey } from './resolved-pairs.js';

const DIFFS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'diffs');

const edge = z.object({ from: z.string(), to: z.string() });
const expectedSchema = z.object({
  screens: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  edges: z.object({ added: z.array(edge), removed: z.array(edge) }),
});

export function expectedDiff(name: string) {
  return expectedSchema.parse(JSON.parse(readFileSync(join(DIFFS, name, 'expected-diff.json'), 'utf8')));
}

export const keys = (edges: { from: string; to: string }[]) => edges.map(pairKey).sort();

// The part of a BuildDiff the fixture assertions read, so it also types a diff parsed from `nori diff --json`.
const subjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), routePattern: z.string() }),
  z.object({
    kind: z.literal('transition'),
    from: z.string(),
    to: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('route'), pattern: z.string() }),
      z.object({ kind: z.literal('unresolved') }),
    ]),
  }),
]);
export const diffViewSchema = z.object({
  changes: z.array(z.object({ kind: z.string(), subject: subjectSchema })),
  gaps: z.array(z.unknown()),
});
export type DiffView = z.infer<typeof diffViewSchema>;
type ChangesView = { readonly changes: readonly DiffView['changes'][number][] };
type ChangeKind = 'added' | 'removed';

export function addedOrRemovedScreens(diff: ChangesView, kind: ChangeKind): string[] {
  return diff.changes
    .flatMap((change) => (change.kind === kind && change.subject.kind === 'screen' ? [change.subject.routePattern] : []))
    .sort();
}

// A pair another transition on the far side still makes is not an edge change, so `otherPairs` drops it.
export function addedOrRemovedEdges(
  diff: ChangesView,
  kind: ChangeKind,
  otherPairs: ReadonlySet<string> = new Set(),
): string[] {
  const pairs = diff.changes.flatMap((change) =>
    change.kind === kind && change.subject.kind === 'transition' && change.subject.to.kind === 'route'
      ? [pairKey({ from: change.subject.from, to: change.subject.to.pattern })]
      : [],
  );
  return [...new Set(pairs)].filter((pair) => !otherPairs.has(pair)).sort();
}
