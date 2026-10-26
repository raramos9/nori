import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyze } from './commands/scan.js';
import type { StaticIngestion } from './graph/model.js';
import { pairKey, patternsByState, resolvedPairs } from './testing/resolved-pairs.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const edge = z.object({ from: z.string(), to: z.string() });
const adapterEdge = edge.extend({ adapter: z.enum(['host', 'locale', 'builder']) });
const expectedSchema = z.object({
  screens: z.array(z.string()),
  edges: z.array(edge),
  missed: z.array(edge.extend({ why: z.string() })),
  open: z.array(z.object({ from: z.string(), why: z.string() })),
  adapterEdges: z.array(adapterEdge).default([]),
});

const CREATED_AT = new Date('2026-01-01T00:00:00Z');

describe.each(['demo', 'adapters'])('%s fixture ground truth', (name) => {
  const root = join(FIXTURES, name);
  const expected = expectedSchema.parse(JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')));
  let ingestion: StaticIngestion;

  beforeAll(async () => {
    ingestion = (await analyze({ path: root, createdAt: CREATED_AT })).ingestion;
  });

  it('lists only edges between expected screens', () => {
    const screens = new Set(expected.screens);
    for (const { from, to } of expected.edges) {
      expect(screens.has(from), from).toBe(true);
      expect(screens.has(to), to).toBe(true);
    }
    const edges = new Set(expected.edges.map(pairKey));
    for (const missed of expected.missed) expect(edges.has(pairKey(missed)), pairKey(missed)).toBe(true);
  });

  it('finds every route and nothing else', () => {
    expect(ingestion.screens.map((screen) => screen.routePattern).sort()).toEqual([...expected.screens].sort());
  });

  it('resolves exactly the edges static analysis can know', () => {
    const missed = new Set(expected.missed.map(pairKey));
    const knowable = expected.edges.map(pairKey).filter((key) => !missed.has(key));
    expect([...resolvedPairs(ingestion)].sort()).toEqual(knowable.sort());
  });

  it('labels the unknowable calls instead of dropping them', () => {
    const patterns = patternsByState(ingestion);
    const unresolvedFrom = new Set<string>();
    for (const { sourceStateId, target } of ingestion.transitions) {
      const from = patterns.get(sourceStateId);
      if (target.kind === 'unresolved' && from !== undefined) unresolvedFrom.add(from);
    }
    for (const { from } of [...expected.missed, ...expected.open]) expect(unresolvedFrom.has(from), from).toBe(true);
  });

  it('backs every screen and transition with evidence inside the fixture', () => {
    const files = new Map(ingestion.evidence.map((evidence) => [evidence.id, evidence.span.file]));
    const subjects = new Map<string, string[]>();
    for (const { subject, evidenceId } of ingestion.observations) {
      const file = files.get(evidenceId);
      if (file !== undefined) subjects.set(subject.id, [...(subjects.get(subject.id) ?? []), file]);
    }
    for (const id of [...ingestion.screens.map((s) => s.id), ...ingestion.transitions.map((t) => t.id)]) {
      const backing = subjects.get(id) ?? [];
      expect(backing.length, id).toBeGreaterThan(0);
      for (const file of backing) expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('resolves each adapter edge only with adapters on', async () => {
    const without = resolvedPairs((await analyze({ path: root, createdAt: CREATED_AT, adapters: false })).ingestion);
    const resolved = resolvedPairs(ingestion);
    for (const adapterEdge of expected.adapterEdges) {
      expect(resolved.has(pairKey(adapterEdge)), `${pairKey(adapterEdge)} (${adapterEdge.adapter})`).toBe(true);
      expect(without.has(pairKey(adapterEdge)), `${pairKey(adapterEdge)} (${adapterEdge.adapter})`).toBe(false);
    }
  });
});
