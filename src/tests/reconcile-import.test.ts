import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze, type Analyzed } from '../commands/scan.js';
import { testCaseKey, testImportId } from '../graph/ids.js';
import {
  parseArtifactPath,
  parseOrigin,
  parsePageUrl,
  type StepCause,
  type TestCase,
  type TestStep,
  type TestStepMatch,
} from '../graph/model.js';
import { reconcileImport } from './reconcile-import.js';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'demo');
const origin = parseOrigin('http://127.0.0.1:3000');
const click = (anchor: string | null): StepCause => ({
  kind: 'input',
  method: 'click',
  selector: null,
  anchor: anchor === null ? null : parsePageUrl(origin, anchor),
});

let analyzed: Analyzed;
beforeAll(async () => {
  analyzed = await analyze({ path: DEMO, createdAt: new Date() });
}, 60_000);

function matchOf(from: string | null, chain: [string, ...string[]], cause: StepCause): TestStepMatch {
  const step: TestStep = { seq: 0, page: 0, at: 0, origin, cause, from, chain, assertions: 0 };
  const testCase: TestCase = {
    key: testCaseKey({ file: 'a.spec.ts', titlePath: ['t'], project: '' }),
    title: 't',
    titlePath: ['t'],
    file: 'a.spec.ts',
    line: 1,
    project: '',
    expectedStatus: 'passed',
    outcome: 'passed',
    attempts: [
      {
        retry: 0,
        status: 'passed',
        trace: { kind: 'read', original: parseArtifactPath('/r/t.zip'), sealed: parseArtifactPath('/s/t.zip'), steps: [step] },
        failures: [],
      },
    ],
  };
  const { snapshot } = analyzed.ingestion;
  const testImport = {
    id: testImportId({ snapshotId: snapshot.id, sha256: 'a'.repeat(64) }),
    snapshotId: snapshot.id,
    environment: 'local',
    importedAt: new Date(0),
    report: {
      original: parseArtifactPath('/r/report.json'),
      sealed: parseArtifactPath('/s/report.json'),
      sha256: 'a'.repeat(64),
      playwrightVersion: '1.64.0',
      startedAt: new Date(0),
    },
  } as const;
  const [row] = reconcileImport({ staticSide: analyzed, sealed: { testImport, cases: [testCase] } }).matches;
  if (row === undefined) throw new Error('no match row');
  return row.match;
}

const url = (path: string) => `${origin}${path}`;

describe('reconcileImport', () => {
  it('matches an anchor click to the static link transition', () => {
    const match = matchOf(url('/'), [url('/docs')], click('/docs'));
    expect(match.kind).toBe('walked');
    const ids = new Set(analyzed.ingestion.transitions.map(({ id }) => id));
    expect(match.kind === 'walked' && ids.has(match.transitionId)).toBe(true);
  });

  it('names the transition a crawl would mint for an anchor walk the source does not know, and creates nothing', () => {
    const match = matchOf(url('/about'), [url('/settings/billing')], click('/settings/billing'));
    expect(match).toMatchObject({ kind: 'walked-runtime-only', search: { triggerCandidates: ['link'] } });
    const ids = new Set(analyzed.ingestion.transitions.map(({ id }) => id));
    expect(match.kind === 'walked-runtime-only' && ids.has(match.transitionId)).toBe(false);
  });

  it('keeps every client trigger open for a click on anything but an anchor, and names the id a crawled link walk mints', () => {
    const anchorWalk = matchOf(url('/about'), [url('/settings/billing')], click('/settings/billing'));
    expect(matchOf(url('/about'), [url('/settings/billing')], click(null))).toEqual({
      kind: 'walked-runtime-only',
      transitionId: anchorWalk.kind === 'walked-runtime-only' ? anchorWalk.transitionId : null,
      search: expect.objectContaining({ triggerCandidates: ['link', 'router-push', 'router-replace'] }),
    });
  });

  it('records entries, unattributed changes and off-origin walks without matching them', () => {
    expect(matchOf(null, [url('/docs')], click('/docs'))).toEqual({ kind: 'entry' });
    expect(matchOf(url('/'), [url('/docs')], { kind: 'navigate', method: 'goto', requested: null })).toEqual({ kind: 'entry' });
    expect(matchOf(url('/'), [url('/docs')], { kind: 'none' })).toEqual({ kind: 'unattributed' });
    expect(matchOf(url('/'), ['https://other.test/x'], click(null))).toEqual({ kind: 'off-origin', url: 'https://other.test/x' });
  });
});
