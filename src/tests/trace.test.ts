import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { text, zip } from '../testing/zip-builder.js';
import { LIMITS } from './limits.js';
import { parseTraceLine, readTrace, stepsOf, type AttemptTrace, type TraceLine } from './trace.js';

const ORIGIN = 'http://app.test';
const PAGE = 'page@1';
const POPUP = 'page@2';
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'demo', 'e2e', 'artifacts');

const options = (baseURL: string | null = ORIGIN) => ({ type: 'context-options', version: 10, options: baseURL === null ? {} : { baseURL } });
const before = (callId: string, method: string, params: Record<string, unknown> = {}, parentId?: string) => ({
  type: 'before',
  callId,
  startTime: 0,
  class: 'Frame',
  method,
  params,
  ...(parentId === undefined ? {} : { parentId }),
});
const after = (callId: string, endTime: number, error?: string) => ({
  type: 'after',
  callId,
  endTime,
  ...(error === undefined ? {} : { error: { message: error } }),
});
const snapshot = (
  callId: string,
  phase: 'before' | 'action' | 'after',
  path: string,
  timestamp: number,
  { page = PAGE, html = ['HTML', {}] as unknown, url = `${ORIGIN}${path}` } = {},
) => ({
  type: 'frame-snapshot',
  snapshot: { callId, phase, pageId: page, frameId: 'frame@1', isMainFrame: true, frameUrl: url, timestamp, html },
});
const targetHtml = (tag: string, attributes: Record<string, string>) => ['HTML', {}, ['BODY', {}, [[1, 4]], [tag, { __playwright_target__: 'c', ...attributes }, 'go']]];

function lines(raw: readonly unknown[]): TraceLine[] {
  return raw.map((json) => {
    const parsed = parseTraceLine(json);
    if (parsed.kind !== 'line') throw new Error(`not a trace line: ${JSON.stringify(json)}`);
    return parsed.line;
  });
}

function trace({ runner = [], context }: { runner?: readonly unknown[]; context: readonly unknown[] }): AttemptTrace {
  const result = stepsOf({ runner: lines(runner), contexts: [lines(context)] });
  if (result.kind !== 'read') throw new Error(`rejected: ${JSON.stringify(result.why)}`);
  return result.trace;
}

const gotoHome = [
  options(),
  before('c@1', 'goto', { url: '/' }),
  snapshot('c@1', 'before', '', 1, { url: 'about:blank' }),
  after('c@1', 10),
  snapshot('c@1', 'after', '/', 11),
];

describe('stepsOf', () => {
  it('attributes a URL first shown by a later expect to the click before it', () => {
    const { steps } = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click', { selector: 'internal:role=link[name="Docs"i]' }),
        snapshot('c@2', 'before', '/', 12),
        snapshot('c@2', 'action', '/', 13, { html: targetHtml('A', { href: '/docs' }) }),
        after('c@2', 14),
        snapshot('c@2', 'after', '/', 15),
        before('c@3', 'expect'),
        snapshot('c@3', 'before', '/', 16),
        after('c@3', 20),
        snapshot('c@3', 'after', '/docs', 21, { html: targetHtml('HTML', {}) }),
      ],
    });
    expect(steps).toEqual([
      {
        seq: 0,
        page: 0,
        at: 11,
        origin: ORIGIN,
        cause: { kind: 'navigate', method: 'goto', requested: `${ORIGIN}/` },
        from: null,
        chain: [`${ORIGIN}/`],
        assertions: 0,
      },
      {
        seq: 1,
        page: 0,
        at: 21,
        origin: ORIGIN,
        cause: { kind: 'input', method: 'click', selector: 'internal:role=link[name="Docs"i]', anchor: `${ORIGIN}/docs` },
        from: `${ORIGIN}/`,
        chain: [`${ORIGIN}/docs`],
        assertions: 0,
      },
    ]);
  });

  it('opens the window after the call that produced the previous URL, so an earlier goto never wins', () => {
    const { steps } = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click', { selector: 'b' }),
        snapshot('c@2', 'after', '/', 15),
        before('c@3', 'goto', { url: '/later' }),
        snapshot('c@3', 'before', '/docs', 16),
        snapshot('c@3', 'after', '/later', 18),
      ],
    });
    expect(steps.map(({ cause, chain }) => [cause.kind, chain])).toEqual([
      ['navigate', [`${ORIGIN}/`]],
      ['input', [`${ORIGIN}/docs`]],
      ['navigate', [`${ORIGIN}/later`]],
    ]);
  });

  it('extends the step of an already consumed cause with a client redirect', () => {
    const { steps } = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click', { selector: 'a' }),
        snapshot('c@2', 'after', '/old', 15),
        before('c@3', 'expect'),
        snapshot('c@3', 'after', '/new', 21),
      ],
    });
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ from: `${ORIGIN}/`, chain: [`${ORIGIN}/old`, `${ORIGIN}/new`], at: 21 });
  });

  it('records a URL change with no input or navigation call in its window as cause none', () => {
    const { steps } = trace({
      context: [options(), before('c@1', 'expect'), snapshot('c@1', 'after', '/', 5), snapshot('c@1', 'after', '/x', 6)],
    });
    expect(steps.map(({ cause }) => cause.kind)).toEqual(['none', 'none']);
  });

  it('reads the anchor only from the cause call action snapshot', () => {
    const button = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click', { selector: 'button' }),
        snapshot('c@2', 'action', '/', 13, { html: targetHtml('BUTTON', {}) }),
        snapshot('c@2', 'after', '/', 15, { html: targetHtml('A', { href: '/elsewhere' }) }),
        before('c@3', 'expect'),
        snapshot('c@3', 'action', '/', 16, { html: targetHtml('A', { href: '/elsewhere' }) }),
        snapshot('c@3', 'after', '/settings', 21, { html: targetHtml('A', { href: '/elsewhere' }) }),
      ],
    });
    expect(button.steps[1]?.cause).toEqual({ kind: 'input', method: 'click', selector: 'button', anchor: null });

    const offOrigin = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click'),
        snapshot('c@2', 'action', '/', 13, { html: targetHtml('A', { href: 'https://other.test/' }) }),
        snapshot('c@2', 'after', '/a', 15),
      ],
    });
    expect(offOrigin.steps[1]?.cause).toEqual({ kind: 'input', method: 'click', selector: null, anchor: null });
  });

  it('counts passing expects on the step whose landing they settled on', () => {
    const { steps, failures } = trace({
      runner: [
        options(null),
        before('c@1', 'pw:api'),
        after('c@1', 10),
        before('r@1', 'expect'),
        after('r@1', 11.5),
        before('c@2', 'pw:api'),
        after('c@2', 15),
        before('c@3', 'expect'),
        after('c@3', 22),
        before('c@4', 'expect'),
        after('c@4', 30),
        before('c@5', 'expect'),
        after('c@5', 40, 'Error: not visible'),
      ],
      context: [
        ...gotoHome,
        before('c@2', 'click'),
        snapshot('c@2', 'after', '/', 15),
        before('c@3', 'expect'),
        after('c@3', 20),
        snapshot('c@3', 'after', '/docs', 21),
        before('c@4', 'expect'),
        snapshot('c@4', 'after', '/docs', 31),
        before('c@5', 'expect'),
        snapshot('c@5', 'after', '/docs', 41),
      ],
    });
    expect(steps.map(({ assertions }) => assertions)).toEqual([1, 2]);
    expect(failures).toEqual([{ message: 'Error: not visible', step: 1 }]);
  });

  it('reports every failing soft assertion once, on the step it ran on, and none for the parent step', () => {
    const { failures } = trace({
      runner: [
        before('g@1', 'test.step'),
        before('s@1', 'expect', {}, 'g@1'),
        after('s@1', 12, '\u001b[31mError: first\u001b[39m'),
        before('s@2', 'expect', {}, 'g@1'),
        after('s@2', 13, 'Error: second'),
        after('g@1', 14, 'Error: first'),
        before('h@1', 'hook'),
        after('h@1', 50, 'Error: hook'),
      ],
      context: gotoHome,
    });
    expect(failures).toEqual([
      { message: 'Error: first', step: 0 },
      { message: 'Error: second', step: 0 },
    ]);
  });

  it('gives a popup its own page index and starts it with no source', () => {
    const { steps } = trace({
      context: [
        ...gotoHome,
        before('c@2', 'click'),
        snapshot('c@2', 'after', '/', 15),
        before('c@3', 'goto', { url: '/signup' }),
        snapshot('c@3', 'before', '', 16, { page: POPUP, url: 'about:blank' }),
        snapshot('c@3', 'after', '/signup', 17, { page: POPUP }),
        before('c@4', 'click'),
        snapshot('c@4', 'action', '/signup', 18, { page: POPUP, html: targetHtml('A', { href: '/welcome#top' }) }),
        snapshot('c@4', 'after', '/welcome#top', 19, { page: POPUP }),
        snapshot('c@4', 'after', '/welcome#other', 20, { page: POPUP }),
      ],
    });
    expect(steps.map(({ page, from, chain, cause }) => [page, from, chain, cause.kind])).toEqual([
      [0, null, [`${ORIGIN}/`], 'navigate'],
      [1, null, [`${ORIGIN}/signup`], 'navigate'],
      [1, `${ORIGIN}/signup`, [`${ORIGIN}/welcome`], 'input'],
    ]);
    expect(steps[2]?.cause).toMatchObject({ anchor: `${ORIGIN}/welcome` });
  });

  it('takes the origin from the first page URL when the context has no baseURL', () => {
    const { steps } = trace({ context: [options(null), before('c@1', 'goto'), snapshot('c@1', 'after', '/', 5, { url: 'http://localhost:3000/a' })] });
    expect(steps[0]).toMatchObject({ origin: 'http://localhost:3000', chain: ['http://localhost:3000/a'] });
  });
});

describe('stepsOf on hostile traces', () => {
  it('walks 200k calls with 200k snapshots in linear time', () => {
    const lines: TraceLine[] = [{ type: 'context-options', version: 10, baseURL: ORIGIN }];
    for (let i = 0; i < 200_000; i++) {
      const callId = `c@${i}`;
      lines.push({ type: 'before', callId, parentId: null, method: i % 2 === 0 ? 'click' : 'expect', url: null, selector: null });
      const path = `/p${Math.floor(i / 20)}`;
      lines.push({ type: 'frame-snapshot', callId, phase: 'after', pageId: PAGE, isMainFrame: true, frameUrl: `${ORIGIN}${path}`, timestamp: i, target: null });
    }
    const started = performance.now();
    const result = stepsOf({ runner: [], contexts: [lines] });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ kind: 'read', trace: { steps: { length: 10_000 } } });
  });

  it('rejects a walk past the step budget, counting redirect hops', () => {
    const lines: TraceLine[] = [{ type: 'before', callId: 'c@0', parentId: null, method: 'click', url: null, selector: null }];
    for (let i = 0; i <= LIMITS.stepsPerAttempt; i++) {
      lines.push({ type: 'frame-snapshot', callId: 'c@0', phase: 'after', pageId: PAGE, isMainFrame: true, frameUrl: `${ORIGIN}/r${i}`, timestamp: i, target: null });
    }
    expect(stepsOf({ runner: [], contexts: [lines] })).toEqual({
      kind: 'rejected',
      why: { kind: 'too-many-steps', count: LIMITS.stepsPerAttempt + 1 },
    });
  });

  it('rejects an attempt with more failing calls than the failure cap', () => {
    const runner = Array.from({ length: LIMITS.failuresPerAttempt + 1 }, (_, i) => [before(`s@${i}`, 'expect'), after(`s@${i}`, i, 'Error: soft')]).flat();
    expect(stepsOf({ runner: lines(runner), contexts: [lines(gotoHome)] })).toEqual({
      kind: 'rejected',
      why: { kind: 'too-many-failures', count: LIMITS.failuresPerAttempt + 1 },
    });
  });

  it('ignores page, requested and anchor URLs longer than the URL cap', () => {
    const long = `/${'a'.repeat(LIMITS.urlChars)}`;
    const { steps } = trace({
      context: [
        options(),
        before('c@1', 'goto', { url: long }),
        snapshot('c@1', 'after', '/', 1),
        before('c@2', 'click'),
        snapshot('c@2', 'action', '/', 2, { html: targetHtml('A', { href: long }) }),
        snapshot('c@2', 'after', long, 3),
        snapshot('c@2', 'after', '/b', 4),
      ],
    });
    expect(steps.map(({ cause, chain }) => [cause, chain])).toEqual([
      [{ kind: 'navigate', method: 'goto', requested: null }, [`${ORIGIN}/`]],
      [{ kind: 'input', method: 'click', selector: null, anchor: null }, [`${ORIGIN}/b`]],
    ]);
  });

  it('gives up on the anchor of a snapshot node with a million children instead of throwing', () => {
    const html = ['HTML', {}, ...Array.from({ length: 1_000_000 }, () => 'x')];
    expect(parseTraceLine(snapshot('c@1', 'action', '/', 1, { html }))).toMatchObject({ kind: 'line', line: { target: null } });
  });

  it('cleans selectors and target tags and ignores a call whose method is not a name', () => {
    expect(parseTraceLine(before('c@1', 'click', { selector: 'a\u001b[2J\u0007b' }))).toMatchObject({ line: { selector: 'ab' } });
    expect(parseTraceLine(before('c@1', 'click\u001b[2J\u0007'))).toEqual({ kind: 'unknown' });
    expect(parseTraceLine(snapshot('c@1', 'action', '/', 1, { html: targetHtml('A\u001b[2J', { href: '/x' }) }))).toMatchObject({
      line: { target: { tag: 'A', href: '/x' } },
    });
  });
});

describe('readTrace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nori-trace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const traceZip = (entries: Record<string, string>) => {
    const file = join(dir, 'trace.zip');
    writeFileSync(file, zip(Object.entries(entries).map(([name, data]) => ({ name, data: text(data) }))));
    return readTrace(file);
  };
  const jsonl = (raw: readonly unknown[]) => raw.map((line) => JSON.stringify(line)).join('\n');

  it('reads the fixture failure on the docs step', async () => {
    const result = await readTrace(join(ARTIFACTS, 'traces', 'home-to-docs', 'trace.zip'));
    if (result.kind !== 'read') throw new Error(`rejected: ${JSON.stringify(result.why)}`);
    expect(result.trace.steps.map(({ chain, assertions }) => [chain, assertions])).toEqual([
      [['http://127.0.0.1:49403/'], 0],
      [['http://127.0.0.1:49403/docs'], 1],
    ]);
    expect(result.trace.failures).toEqual([{ message: expect.stringContaining('docs index has no changelog guide'), step: 1 }]);
  });

  it('tolerates a torn last line', async () => {
    const result = await traceZip({ '1-trace.trace': `${jsonl(gotoHome)}\n{"type":"before","call` });
    expect(result).toMatchObject({ kind: 'read', trace: { steps: [{ chain: [`${ORIGIN}/`] }] } });
  });

  it('rejects a bad line that is not the last', async () => {
    expect(await traceZip({ '1-trace.trace': `${jsonl(gotoHome.slice(0, 2))}\n{not json\n${jsonl(gotoHome.slice(2))}` })).toEqual({
      kind: 'rejected',
      why: { kind: 'bad-trace-line', entry: '1-trace.trace', line: 3 },
    });
  });

  it('rejects a known line type that misses its schema', async () => {
    expect(await traceZip({ 'test.trace': jsonl([options(), { type: 'after', callId: 'c@1' }, options()]) })).toEqual({
      kind: 'rejected',
      why: { kind: 'bad-trace-line', entry: 'test.trace', line: 2 },
    });
  });

  it('rejects a trace whose entries together pass the line budget, at the first line past it', async () => {
    const half = '{"type":"x"}\n'.repeat(LIMITS.linesPerTrace / 2 + 1);
    expect(await traceZip({ '1-trace.trace': half, '2-trace.trace': half })).toEqual({
      kind: 'rejected',
      why: { kind: 'too-many-lines', entry: '2-trace.trace', count: LIMITS.linesPerTrace + 1 },
    });
  });

  it('walks while it parses, so the call cap refuses a trace before a later bad line is reached', async () => {
    const calls = Array.from({ length: LIMITS.callsPerAttempt + 1 }, (_, i) => `{"type":"before","callId":"c@${i}","method":"click"}`);
    expect(await traceZip({ '1-trace.trace': `${calls.join('\n')}\n{not json\n${jsonl(gotoHome)}` })).toEqual({
      kind: 'rejected',
      why: { kind: 'too-many-calls', count: LIMITS.callsPerAttempt + 1 },
    });
  });

  it('rejects an unsupported trace version and a zip with no trace entries', async () => {
    expect(await traceZip({ '0-trace.trace': jsonl([{ ...options(), version: 11 }]) })).toEqual({
      kind: 'rejected',
      why: { kind: 'unsupported-trace-version', version: 11 },
    });
    expect(await traceZip({ 'resources/a.html': '<html>' })).toEqual({ kind: 'rejected', why: { kind: 'no-trace-entries' } });
  });
});
