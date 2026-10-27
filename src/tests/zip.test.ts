import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceRejection } from '../graph/model.js';
import { centralHeader, DEFLATED, localHeader, STORED, text, trace, zip, type Spec } from '../testing/zip-builder.js';
import { LIMITS } from './limits.js';
import { createCopier, readZip, type ZipRead } from './zip.js';

const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'demo', 'e2e', 'artifacts');
const FIXTURE_ZIPS = ['home-to-docs', 'pricing-to-signup'].map((slug) => join(ARTIFACTS, 'traces', slug, 'trace.zip'));

function fifield(): Buffer {
  const inner: Spec = { name: 'b.trace', data: text('payload'), method: STORED };
  const innerLocal = Buffer.concat([localHeader(inner, inner.data), inner.data]);
  const outer: Spec = { name: 'a.trace', data: innerLocal, method: STORED };
  const outerHeader = localHeader(outer, innerLocal);
  return zip([outer], { extraCentral: [centralHeader(inner, inner.data, outerHeader.length)] });
}

let parent: string;
let staging: string;

beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'nori-zip-')));
  staging = join(parent, 'staging');
  mkdirSync(staging);
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

async function read(bytes: Buffer, select: (name: string) => boolean = (name) => name.endsWith('.trace')) {
  const file = join(staging, 'trace.zip');
  writeFileSync(file, bytes);
  const visited: { name: string; bytes: Buffer }[] = [];
  const result = await readZip({ file, select, visit: (name, data) => (visited.push({ name, bytes: data }), null) });
  expect(readdirSync(parent)).toEqual(['staging']);
  expect(readdirSync(staging)).toEqual(['trace.zip']);
  return { result, visited };
}

const rejected = (why: TraceRejection): ZipRead => ({ kind: 'rejected', why });

describe('readZip on hostile archives', () => {
  const bomb = Buffer.alloc(10 * 1024 * 1024);
  const cases: readonly [string, () => Buffer, ZipRead][] = [
    ['a bomb declared small that inflates large', () => zip([{ name: 'test.trace', data: bomb, declaredSize: 100, crc: 0 }]), rejected({ kind: 'size-mismatch', entry: 'test.trace' })],
    ['20k entries', () => zip(Array.from({ length: 20_000 }, (_, i) => ({ name: `resources/${i}`, data: text('x'), method: STORED }))), rejected({ kind: 'too-many-entries', count: 20_000 })],
    ['a ../ name', () => zip([trace(), { name: '../../etc/passwd', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: '../../etc/passwd' })],
    ['a nested .. segment', () => zip([{ name: 'resources/../../x', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: 'resources/../../x' })],
    ['an absolute name', () => zip([{ name: '/etc/passwd', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: '/etc/passwd' })],
    ['a backslash name', () => zip([{ name: '..\\evil', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: '..\\evil' })],
    ['a drive letter name', () => zip([{ name: 'C:/evil', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: 'C:/evil' })],
    ['a NUL in a name', () => zip([{ name: 'test.trace\u0000.png', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: 'test.trace.png' })],
    ['an escape sequence in a name', () => zip([{ name: 'x\u001b[2J\u0007.trace', data: text('x') }]), rejected({ kind: 'unsafe-name', entry: 'x.trace' })],
    ['the encrypted bit', () => zip([{ ...trace(), flags: 0x0001 }]), rejected({ kind: 'encrypted' })],
    ['a ZIP64 size sentinel', () => zip([{ ...trace(), centralSizes: 0xffffffff }]), rejected({ kind: 'zip64' })],
    ['a ZIP64 end locator', () => zip([trace()], { zip64Locator: true }), rejected({ kind: 'zip64' })],
    ['a ZIP64 entry count sentinel', () => zip([trace()], { end: (record) => record.writeUInt16LE(0xffff, 10) }), rejected({ kind: 'zip64' })],
    ['a second disk', () => zip([trace()], { end: (record) => record.writeUInt16LE(1, 4) }), rejected({ kind: 'multi-disk' })],
    ['a central directory running past the end record', () => zip([trace()], { end: (record) => record.writeUInt32LE(record.readUInt32LE(12) + 10, 12) }), rejected({ kind: 'truncated' })],
    ['a central directory claiming more entries than it holds', () => zip([trace()], { end: (record) => { record.writeUInt16LE(2, 8); record.writeUInt16LE(2, 10); } }), rejected({ kind: 'truncated' })],
    ['a file cut before its end record', () => zip([trace()]).subarray(0, 60), rejected({ kind: 'not-a-zip' })],
    ['bytes that are not a zip', () => text('PK not really a zip, just text'), rejected({ kind: 'not-a-zip' })],
    ['overlapping entries (Fifield)', fifield, rejected({ kind: 'overlapping-entries' })],
    ['a local name that differs from the central one', () => zip([{ ...trace(), localName: 'other.trace' }]), rejected({ kind: 'header-mismatch', entry: 'test.trace' })],
    ['duplicate names', () => zip([trace(), trace()]), rejected({ kind: 'duplicate-name', entry: 'test.trace' })],
    ['an unsupported method', () => zip([{ ...trace(), method: 12 }]), rejected({ kind: 'unsupported-method', entry: 'test.trace', method: 12 })],
    ['a stored entry whose sizes disagree', () => zip([{ ...trace(), method: STORED }], { central: (_, header) => header.writeUInt32LE(3, 24) }), rejected({ kind: 'size-mismatch', entry: 'test.trace' })],
    ['a wrong CRC', () => zip([{ ...trace(), crc: 1 }]), rejected({ kind: 'crc-mismatch', entry: 'test.trace' })],
    ['corrupt deflate data', () => zip([{ ...trace(), compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]) }]), rejected({ kind: 'inflate-failed', entry: 'test.trace' })],
    ['a method that differs between the local and central headers', () => zip([{ ...trace(), method: STORED }], { central: (_, header) => header.writeUInt16LE(DEFLATED, 10) }), rejected({ kind: 'header-mismatch', entry: 'test.trace' })],
  ];

  it.each(cases)('%s', async (_name, build, expected) => {
    expect((await read(build())).result).toEqual(expected);
  });

  it('rejects a selected entry declared over the entry limit before inflating it', async () => {
    const bytes = zip([trace()], { central: (_, header) => header.writeUInt32LE(LIMITS.entryBytes + 1, 24) });
    expect((await read(bytes)).result).toEqual(rejected({ kind: 'entry-too-large', entry: 'test.trace', bytes: LIMITS.entryBytes + 1 }));
  });

  it('rejects a selected entry whose compressed size is over the entry limit before reading it', async () => {
    const bytes = zip([{ ...trace(), declaredSize: 10, crc: 0, compressed: Buffer.alloc(LIMITS.entryBytes + 1) }]);
    expect((await read(bytes)).result).toEqual(rejected({ kind: 'entry-too-large', entry: 'test.trace', bytes: LIMITS.entryBytes + 1 }));
  });

  it('rejects selected entries whose declared sizes add up past the total limit', async () => {
    const declared = LIMITS.entryBytes;
    const count = LIMITS.totalBytes / declared + 1;
    const bytes = zip(
      Array.from({ length: count }, (_, i) => ({ name: `${i}-trace.trace`, data: text('x') })),
      { central: (_, header) => header.writeUInt32LE(declared, 24) },
    );
    expect((await read(bytes)).result).toEqual(rejected({ kind: 'total-too-large', bytes: declared * count }));
  });

  it('never inflates an unselected entry, so a bomb in a resource costs nothing', async () => {
    const bytes = zip([trace(), { name: 'resources/bomb', data: bomb, declaredSize: 1, crc: 0 }]);
    const { result, visited } = await read(bytes);
    expect(result).toEqual({ kind: 'read' });
    expect(visited.map(({ name }) => name)).toEqual(['test.trace']);
  });

  it('reads an entry written with a data descriptor and zeroed local sizes', async () => {
    const data = '{"type":"before","callId":"c@1"}\n'.repeat(50);
    const { result, visited } = await read(zip([{ name: '1-trace.trace', data: text(data), descriptor: true }]));
    expect(result).toEqual({ kind: 'read' });
    expect(visited.map(({ name, bytes }) => [name, bytes.toString()])).toEqual([['1-trace.trace', data]]);
  });

  it('turns anything visit throws into a rejection of that entry', async () => {
    const file = join(staging, 'trace.zip');
    writeFileSync(file, zip([trace()]));
    const visit = () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    expect(await readZip({ file, select: () => true, visit })).toEqual(rejected({ kind: 'bad-trace-entry', entry: 'test.trace' }));
  });

  it('passes a rejection from visit through', async () => {
    const file = join(staging, 'trace.zip');
    writeFileSync(file, zip([trace()]));
    const why: TraceRejection = { kind: 'bad-trace-line', entry: 'test.trace', line: 1 };
    expect(await readZip({ file, select: () => true, visit: () => why })).toEqual(rejected(why));
  });

  it.each(FIXTURE_ZIPS)('reads the fixture %s', async (fixture) => {
    const { result, visited } = await read(readFileSync(fixture));
    expect(result).toEqual({ kind: 'read' });
    expect(visited.map(({ name }) => name).sort()).toEqual(['0-trace.trace', '1-trace.trace', 'test.trace']);
    expect(visited.find(({ name }) => name === '1-trace.trace')?.bytes.toString()).toContain('"type":"frame-snapshot"');
  });
});

describe('createCopier', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = join(parent, 'repo');
    outside = join(parent, 'elsewhere');
    mkdirSync(join(root, 'test-results'), { recursive: true });
    mkdirSync(outside);
  });

  const copy = (path: string) => createCopier({ root }).copy(path, join(staging, 'copy.zip'));

  it('copies a regular file inside the root into staging', async () => {
    const path = join(root, 'test-results', 'trace.zip');
    writeFileSync(path, 'zip bytes');
    expect(await copy(path)).toEqual({ kind: 'opened', copy: join(staging, 'copy.zip'), bytes: 9 });
    expect(readFileSync(join(staging, 'copy.zip'), 'utf8')).toBe('zip bytes');
  });

  it('reports a missing file as missing, even outside the root', async () => {
    expect(await copy(join(outside, 'gone.zip'))).toEqual({ kind: 'refused', reason: { kind: 'missing', path: join(outside, 'gone.zip') } });
  });

  it.each([
    ['an absolute path elsewhere', () => join(outside, 'secret')],
    ['a ../ escape', () => join(root, 'test-results', '..', '..', 'elsewhere', 'secret')],
    ['a symlink out of the root', () => {
      symlinkSync(join(outside, 'secret'), join(root, 'test-results', 'link.zip'));
      return join(root, 'test-results', 'link.zip');
    }],
  ])('refuses %s without copying it', async (_name, pathOf) => {
    writeFileSync(join(outside, 'secret'), 'private key');
    const path = pathOf();
    expect(await copy(path)).toEqual({ kind: 'refused', reason: { kind: 'outside-root', path, root } });
    expect(readdirSync(staging)).toEqual([]);
  });

  it('reports a dangling symlink as missing', async () => {
    const path = join(root, 'test-results', 'dangling.zip');
    symlinkSync(join(root, 'test-results', 'gone.zip'), path);
    expect(await copy(path)).toEqual({ kind: 'refused', reason: { kind: 'missing', path } });
  });

  it('refuses a hard-linked file, whose other names realpath cannot see', async () => {
    writeFileSync(join(outside, 'secret'), 'private key');
    const path = join(root, 'test-results', 'linked.zip');
    linkSync(join(outside, 'secret'), path);
    expect(await copy(path)).toEqual({ kind: 'refused', reason: { kind: 'hard-linked', path } });
    expect(readdirSync(staging)).toEqual([]);
  });

  it('refuses a FIFO without blocking and a directory', async () => {
    const fifo = join(root, 'test-results', 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(await copy(fifo)).toEqual({ kind: 'refused', reason: { kind: 'not-a-file', path: fifo } });
    expect(await copy(join(root, 'test-results'))).toEqual({
      kind: 'refused',
      reason: { kind: 'not-a-file', path: join(root, 'test-results') },
    });
    expect(readdirSync(staging)).toEqual([]);
  });

  it('refuses a file over the trace size limit before reading it', async () => {
    const path = join(root, 'test-results', 'huge.zip');
    writeFileSync(path, '');
    truncateSync(path, LIMITS.traceFileBytes + 1);
    expect(await copy(path)).toEqual({
      kind: 'refused',
      reason: { kind: 'too-large', path, bytes: LIMITS.traceFileBytes + 1, limit: LIMITS.traceFileBytes },
    });
    expect(readdirSync(staging)).toEqual([]);
  });

  it('copies one file once however many paths name it', async () => {
    const path = join(root, 'test-results', 'trace.zip');
    writeFileSync(path, 'zip bytes');
    symlinkSync(path, join(root, 'test-results', 'alias.zip'));
    const copier = createCopier({ root });
    const first = await copier.copy(path, join(staging, 'a.zip'));
    expect(await copier.copy(path, join(staging, 'b.zip'))).toEqual(first);
    expect(await copier.copy(join(root, 'test-results', 'alias.zip'), join(staging, 'c.zip'))).toEqual(first);
    expect(readdirSync(staging)).toEqual(['a.zip']);
  });

  it('refuses a file past the import byte budget, counting earlier copies', async () => {
    const [a, b] = ['a.zip', 'b.zip'].map((name) => join(root, 'test-results', name));
    writeFileSync(a ?? '', '123456');
    writeFileSync(b ?? '', '654321');
    const copier = createCopier({ root, budget: 10 });
    expect(await copier.copy(a ?? '', join(staging, 'a.zip'))).toMatchObject({ kind: 'opened', bytes: 6 });
    expect(await copier.copy(b ?? '', join(staging, 'b.zip'))).toEqual({
      kind: 'refused',
      reason: { kind: 'over-budget', path: b, bytes: 6, limit: 10 },
    });
    expect(readdirSync(staging)).toEqual(['a.zip']);
  });
});
