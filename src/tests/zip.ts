import { constants } from 'node:fs';
import { lstat, open, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import { errorCode } from '../errors.js';
import type { TraceRejection, TracelessReason } from '../graph/model.js';
import { isInside } from '../runtime/layout.js';
import { LIMITS, oneLine } from './limits.js';

export type Untrusted =
  | { readonly kind: 'opened'; readonly copy: string; readonly bytes: number }
  | { readonly kind: 'refused'; readonly reason: TracelessReason };

const COPY_CHUNK = 1024 * 1024;
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

function ioCode(error: unknown): string | null {
  const code = errorCode(error);
  return typeof code === 'string' ? code : null;
}

const refused = (reason: TracelessReason) => ({ kind: 'refused', reason }) as const;

type Opened = { readonly kind: 'open'; readonly handle: FileHandle; readonly identity: string; readonly size: number };

// realpath confines the name; the descriptor's device and inode must still be the file that name
// stated, and a file with a second link may have that link anywhere on the device.
async function openConfined(path: string, root: string): Promise<Opened | ReturnType<typeof refused>> {
  try {
    await lstat(path);
  } catch (error) {
    const code = ioCode(error);
    if (code === null) throw error;
    return refused(MISSING.has(code) ? { kind: 'missing', path } : { kind: 'unreadable', path, why: { kind: 'io-error', code } });
  }
  let handle: FileHandle;
  let expected: string;
  try {
    const real = await realpath(path);
    if (!isInside(root, real)) return refused({ kind: 'outside-root', path, root });
    const named = await stat(real, { bigint: true });
    expected = `${named.dev}:${named.ino}`;
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = ioCode(error);
    if (code === null) throw error;
    if (MISSING.has(code)) return refused({ kind: 'missing', path });
    return refused(code === 'ELOOP' ? { kind: 'not-a-file', path } : { kind: 'unreadable', path, why: { kind: 'io-error', code } });
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const identity = `${stats.dev}:${stats.ino}`;
    const reason: TracelessReason | null = !stats.isFile()
      ? { kind: 'not-a-file', path }
      : identity !== expected
        ? { kind: 'changed', path }
        : stats.nlink > 1n
          ? { kind: 'hard-linked', path }
          : null;
    if (reason === null) return { kind: 'open', handle, identity, size: Number(stats.size) };
    await handle.close();
    return refused(reason);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyBounded(source: FileHandle, path: string, destination: string, budget: number): Promise<Untrusted> {
  const limit = Math.min(LIMITS.traceFileBytes, budget);
  const target = await open(destination, 'wx', 0o600);
  try {
    const buffer = Buffer.alloc(COPY_CHUNK);
    let bytes = 0;
    for (;;) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await source.read(buffer, 0, COPY_CHUNK, bytes));
      } catch (error) {
        const code = ioCode(error);
        if (code === null) throw error;
        return refused({ kind: 'unreadable', path, why: { kind: 'io-error', code } });
      }
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) return refused(tooBig(path, bytes, budget));
      await target.write(buffer, 0, bytesRead);
    }
    await target.sync();
    return { kind: 'opened', copy: destination, bytes };
  } finally {
    await target.close();
  }
}

function tooBig(path: string, bytes: number, budget: number): TracelessReason {
  return bytes > LIMITS.traceFileBytes
    ? { kind: 'too-large', path, bytes, limit: LIMITS.traceFileBytes }
    : { kind: 'over-budget', path, bytes, limit: budget };
}

export type Copier = { readonly copy: (path: string, destination: string) => Promise<Untrusted> };

// One import's copies. Each distinct file (by device and inode of the opened descriptor) is copied once
// and every later path naming it gets that copy, and all copies draw on one byte budget. Existence is
// checked before confinement, so a missing file reports the path as written. Everything after the open
// reads the descriptor, and the copy in nori's staging directory is what gets parsed and kept.
export function createCopier({ root, budget = LIMITS.importTraceBytes }: { root: string; budget?: number }): Copier {
  const copies = new Map<string, Untrusted>();
  let spent = 0;
  const copy = async (path: string, destination: string): Promise<Untrusted> => {
    const opened = await openConfined(path, root);
    if (opened.kind === 'refused') return opened;
    const { handle, identity, size } = opened;
    try {
      const earlier = copies.get(identity);
      if (earlier?.kind === 'refused' && 'path' in earlier.reason) return refused({ ...earlier.reason, path });
      if (earlier !== undefined) return earlier;
      const left = budget - spent;
      if (size > LIMITS.traceFileBytes || size > left) return refused(tooBig(path, size, budget));
      const copied = await copyBounded(handle, path, destination, left);
      if (copied.kind === 'refused') await rm(destination, { force: true });
      else spent += copied.bytes;
      copies.set(identity, copied);
      return copied;
    } finally {
      await handle.close();
    }
  };
  return { copy };
}

export type ZipRead = { readonly kind: 'read' } | { readonly kind: 'rejected'; readonly why: TraceRejection };

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_BYTES = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_BYTES = 30;
const U16_SENTINEL = 0xffff;
const U32_SENTINEL = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const STORED = 0;
const DEFLATED = 8;

type Entry = {
  readonly name: string;
  readonly rawName: Buffer;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
};

type Located = Entry & { readonly dataStart: number };

class Rejected extends Error {
  constructor(readonly why: TraceRejection) {
    super(why.kind);
  }
}

const reject = (why: TraceRejection): never => {
  throw new Rejected(why);
};

const NAMES = new TextDecoder('utf-8', { fatal: true });

function decodeName(raw: Buffer): string | null {
  try {
    return NAMES.decode(raw);
  } catch {
    return null;
  }
}

// A safe name is one oneLine leaves unchanged, so every name a rejection reports is clean.
function isSafeName(name: string): boolean {
  return (
    name !== '' &&
    oneLine(name) === name &&
    !/[\u0000-\u001f\\]/.test(name) &&
    !name.startsWith('/') &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split('/').includes('..')
  );
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) reject({ kind: 'truncated' });
  return buffer;
}

function findEndRecord(tail: Buffer): number {
  for (let at = tail.length - EOCD_BYTES; at >= 0; at--) {
    if (tail.readUInt32LE(at) === EOCD_SIGNATURE && at + EOCD_BYTES + tail.readUInt16LE(at + 20) === tail.length) {
      return at;
    }
  }
  return reject({ kind: 'not-a-zip' });
}

async function centralDirectory(handle: FileHandle, size: number): Promise<{ entries: Entry[]; end: number }> {
  if (size < EOCD_BYTES) reject({ kind: 'not-a-zip' });
  const tailStart = Math.max(0, size - EOCD_BYTES - MAX_COMMENT);
  const tail = await readAt(handle, tailStart, size - tailStart);
  const at = findEndRecord(tail);
  const eocdOffset = tailStart + at;
  const disk = tail.readUInt16LE(at + 4);
  const cdDisk = tail.readUInt16LE(at + 6);
  const diskEntries = tail.readUInt16LE(at + 8);
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  const locator = eocdOffset >= ZIP64_LOCATOR_BYTES ? await readAt(handle, eocdOffset - ZIP64_LOCATOR_BYTES, 4) : null;
  if (
    locator?.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE ||
    [disk, cdDisk, diskEntries, count].includes(U16_SENTINEL) ||
    [cdSize, cdOffset].includes(U32_SENTINEL)
  ) {
    reject({ kind: 'zip64' });
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) reject({ kind: 'multi-disk' });
  if (count > LIMITS.entries) reject({ kind: 'too-many-entries', count });
  if (cdOffset + cdSize > eocdOffset || cdSize > LIMITS.centralDirectoryBytes) reject({ kind: 'truncated' });

  const cd = await readAt(handle, cdOffset, cdSize);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_BYTES > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) reject({ kind: 'truncated' });
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const diskStart = cd.readUInt16LE(p + 34);
    const localOffset = cd.readUInt32LE(p + 42);
    const next = p + CENTRAL_BYTES + nameLength + extraLength + commentLength;
    if (next > cd.length) reject({ kind: 'truncated' });
    const rawName = cd.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nameLength);
    const name = decodeName(rawName);
    const shown = oneLine(name ?? rawName.toString('latin1'));
    if (name === null || !isSafeName(name)) reject({ kind: 'unsafe-name', entry: shown });
    if (seen.has(shown)) reject({ kind: 'duplicate-name', entry: shown });
    seen.add(shown);
    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) reject({ kind: 'encrypted' });
    if ([compressedSize, uncompressedSize, localOffset].includes(U32_SENTINEL) || diskStart === U16_SENTINEL) {
      reject({ kind: 'zip64' });
    }
    if (method !== STORED && method !== DEFLATED) reject({ kind: 'unsupported-method', entry: shown, method });
    if (method === STORED && compressedSize !== uncompressedSize) reject({ kind: 'size-mismatch', entry: shown });
    entries.push({ name: shown, rawName, method, crc, compressedSize, uncompressedSize, localOffset });
    p = next;
  }
  if (p !== cd.length) reject({ kind: 'truncated' });
  return { entries, end: cdOffset };
}

// Sizes and CRC come from the central header: with a data descriptor (bit 3) the local ones are zero.
async function locate(handle: FileHandle, entries: readonly Entry[], end: number): Promise<readonly Located[]> {
  const located: Located[] = [];
  for (const entry of entries) {
    if (entry.localOffset + LOCAL_BYTES > end) reject({ kind: 'truncated' });
    const local = await readAt(handle, entry.localOffset, LOCAL_BYTES);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const dataStart = entry.localOffset + LOCAL_BYTES + nameLength + extraLength;
    if (dataStart + entry.compressedSize > end) reject({ kind: 'truncated' });
    const name = await readAt(handle, entry.localOffset + LOCAL_BYTES, nameLength);
    if (
      local.readUInt32LE(0) !== LOCAL_SIGNATURE ||
      local.readUInt16LE(8) !== entry.method ||
      !name.equals(entry.rawName)
    ) {
      reject({ kind: 'header-mismatch', entry: entry.name });
    }
    located.push({ ...entry, dataStart });
  }
  let reached = 0;
  for (const { localOffset, dataStart, compressedSize } of [...located].sort((a, b) => a.localOffset - b.localOffset)) {
    if (localOffset < reached) reject({ kind: 'overlapping-entries' });
    reached = Math.max(reached, dataStart + compressedSize);
  }
  return located;
}

function inflate(entry: Entry, compressed: Buffer): Buffer {
  if (entry.method === STORED) return compressed;
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch (error) {
    return reject({ kind: errorCode(error) === 'ERR_BUFFER_TOO_LARGE' ? 'size-mismatch' : 'inflate-failed', entry: entry.name });
  }
}

// visit parses untrusted bytes; whatever it throws is the entry's fault, never the import's.
function visitSafely(visit: (name: string, bytes: Buffer) => TraceRejection | null, name: string, bytes: Buffer): TraceRejection | null {
  try {
    return visit(name, bytes);
  } catch {
    return { kind: 'bad-trace-entry', entry: name };
  }
}

// Validates every entry from the central directory and the local headers, then inflates only the
// selected ones, one at a time, handing each to visit and dropping it. Never extracts, never writes.
export async function readZip({
  file,
  select,
  visit,
}: {
  file: string;
  select: (name: string) => boolean;
  visit: (name: string, bytes: Buffer) => TraceRejection | null;
}): Promise<ZipRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { size } = await handle.stat();
    const { entries, end } = await centralDirectory(handle, size);
    const located = await locate(handle, entries, end);
    const selected = located.filter(({ name }) => select(name));
    let total = 0;
    // Deflate output is never much smaller than a valid input, so the output bound also bounds the read.
    for (const entry of selected) {
      const bytes = Math.max(entry.compressedSize, entry.uncompressedSize);
      if (bytes > LIMITS.entryBytes) reject({ kind: 'entry-too-large', entry: entry.name, bytes });
      total += bytes;
      if (total > LIMITS.totalBytes) reject({ kind: 'total-too-large', bytes: total });
    }
    for (const entry of selected) {
      const bytes = inflate(entry, await readAt(handle, entry.dataStart, entry.compressedSize));
      if (bytes.length !== entry.uncompressedSize) reject({ kind: 'size-mismatch', entry: entry.name });
      if (crc32(bytes) !== entry.crc) reject({ kind: 'crc-mismatch', entry: entry.name });
      const refused = visitSafely(visit, entry.name, bytes);
      if (refused !== null) return { kind: 'rejected', why: refused };
    }
    return { kind: 'read' };
  } catch (error) {
    if (error instanceof Rejected) return { kind: 'rejected', why: error.why };
    const code = ioCode(error);
    if (code === null) throw error;
    return { kind: 'rejected', why: { kind: 'io-error', code } };
  } finally {
    await handle?.close();
  }
}
