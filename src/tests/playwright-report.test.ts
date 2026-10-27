import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoriError } from '../errors.js';
import { cleanText, LIMITS, oneLine } from './limits.js';
import { readReport } from './playwright-report.js';

const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'demo', 'e2e', 'artifacts');

const result = (overrides: Record<string, unknown> = {}) => ({
  retry: 0,
  status: 'passed',
  startTime: '2026-10-26T00:00:00.000Z',
  errors: [],
  attachments: [],
  ...overrides,
});
const spec = (title: string, results: readonly unknown[], status = 'expected') => ({
  title,
  file: 'a.spec.ts',
  line: 3,
  tests: [{ projectName: 'chromium', expectedStatus: 'passed', status, results }],
});
const report = (suites: readonly unknown[]) => ({
  config: { version: '1.64.0' },
  suites,
  stats: { startTime: '2026-10-26T00:00:00.000Z' },
});

describe('readReport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nori-report-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (json: unknown) => {
    const path = join(dir, 'report.json');
    writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
    return path;
  };

  it('reads the fixture report in order, with trace paths resolved against its directory', async () => {
    const parsed = await readReport(join(ARTIFACTS, 'report.json'));
    expect(parsed.playwrightVersion).toBe('1.64.0');
    expect(parsed.startedAt).toEqual(new Date('2026-10-26T00:21:12.529Z'));
    expect(parsed.cases.map(({ title, outcome, attempts }) => [title, outcome, attempts.map(({ trace }) => trace)])).toEqual([
      ['home: Docs link lists a changelog guide', 'failed', [join(ARTIFACTS, 'traces/home-to-docs/trace.zip')]],
      ['pricing: Get started opens the signup form', 'passed', [join(ARTIFACTS, 'traces/pricing-to-signup/trace.zip')]],
    ]);
    const [message] = parsed.cases[0]?.attempts[0]?.errors ?? [];
    expect(message).toContain('docs index has no changelog guide');
    expect(message).not.toMatch(/\u001b/);
  });

  it('puts describe titles before the test title and keeps every retry', async () => {
    const parsed = await readReport(
      write(
        report([
          {
            title: 'a.spec.ts',
            specs: [],
            suites: [
              {
                title: 'checkout',
                suites: [],
                specs: [spec('pays', [result({ retry: 1 }), result({ status: 'failed', errors: [{ message: 'boom' }] })], 'flaky')],
              },
            ],
          },
        ]),
      ),
    );
    expect(parsed.cases).toEqual([
      expect.objectContaining({
        title: 'pays',
        titlePath: ['checkout', 'pays'],
        project: 'chromium',
        outcome: 'flaky',
        attempts: [
          expect.objectContaining({ retry: 0, status: 'failed', errors: ['boom'], trace: null }),
          expect.objectContaining({ retry: 1, status: 'passed', errors: [] }),
        ],
      }),
    ]);
  });

  it('keeps every single-line display field on one line', async () => {
    const forged = 'x\n  passed  forged\r\tcase';
    const parsed = await readReport(
      write({
        config: { version: forged },
        stats: { startTime: '2026-10-26T00:00:00.000Z' },
        suites: [
          {
            title: forged,
            suites: [{ title: forged, specs: [{ ...spec(forged, [result()]), file: forged, tests: [{ ...spec('t', [result()]).tests[0], projectName: forged }] }] }],
          },
        ],
      }),
    );
    const [testCase] = parsed.cases;
    const fields = [parsed.playwrightVersion, testCase?.title, testCase?.file, testCase?.project, ...(testCase?.titlePath ?? [])];
    expect(fields).toEqual(Array.from({ length: 6 }, () => 'x passed forged case'));
  });

  it('reads only a zip trace attachment with a path', async () => {
    const attachments = [
      { name: 'trace', contentType: 'application/zip', body: 'aW5saW5l' },
      { name: 'screenshot', contentType: 'image/png', path: '/etc/passwd' },
      { name: 'trace', contentType: 'application/zip', path: '/abs/trace.zip' },
    ];
    const parsed = await readReport(write(report([{ title: 'a.spec.ts', specs: [spec('t', [result({ attachments })])] }])));
    expect(parsed.cases[0]?.attempts[0]?.trace).toBe('/abs/trace.zip');
  });

  it.each([
    ['not JSON', '{"suites": ['],
    ['a schema miss', report([{ title: 'a.spec.ts', specs: [{ title: 't' }] }])],
    ['a trace path with control characters', report([{ title: 'a.spec.ts', specs: [spec('t', [result({ attachments: [{ name: 'trace', contentType: 'application/zip', path: 'x\u001b[2J.zip' }] })])] }])],
    ['a repeated case', report([{ title: 'a.spec.ts', specs: [spec('t', [result()]), spec('t', [result()])] }])],
    ['a repeated retry', report([{ title: 'a.spec.ts', specs: [spec('t', [result({ retry: 1 }), result({ retry: 1 })], 'flaky')] }])],
    ['too many errors in one attempt', report([{ title: 'a.spec.ts', specs: [spec('t', [result({ status: 'failed', errors: Array.from({ length: LIMITS.failuresPerAttempt + 1 }, () => ({ message: 'x' })) })], 'unexpected')] }])],
    ['a trace path with a newline', report([{ title: 'a.spec.ts', specs: [spec('t', [result({ attachments: [{ name: 'trace', contentType: 'application/zip', path: 'x\nimported.zip' }] })])] }])],
    ['too many attempts', report([{ title: 'a.spec.ts', specs: [spec('t', Array.from({ length: LIMITS.attemptsPerCase + 1 }, (_, retry) => result({ retry })))] }])],
    [
      'suites nested too deep',
      report([Array.from({ length: LIMITS.reportDepth + 1 }).reduce<unknown>((inner) => ({ title: 'd', suites: [inner] }), { title: 'leaf' })]),
    ],
  ])('fails the command on %s', async (_name, json) => {
    await expect(readReport(write(json))).rejects.toThrow(NoriError);
  });

  it('fails the command on a missing report', async () => {
    await expect(readReport(join(dir, 'gone.json'))).rejects.toThrow(NoriError);
  });
});

describe('oneLine', () => {
  it('cleans and collapses line breaks and tabs into one space', () => {
    expect(oneLine('\u001b[31ma\u001b[39m\r\n\t b\nc')).toBe('a b c');
  });
});

describe('cleanText', () => {
  it('strips ANSI, control and bidi characters and caps the length', () => {
    expect(cleanText('\u001b[31mred\u001b[39m\u0007 ‮evil\ttab\nline')).toBe('red evil\ttab\nline');
    expect(cleanText('x'.repeat(LIMITS.textChars + 10))).toHaveLength(LIMITS.textChars);
  });
});
