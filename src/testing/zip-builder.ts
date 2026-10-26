import { crc32, deflateRawSync } from 'node:zlib';

export const STORED = 0;
export const DEFLATED = 8;
const DATA_DESCRIPTOR = 0x0008;

export type Spec = {
  readonly name: string;
  readonly data: Buffer;
  readonly method?: number;
  readonly flags?: number;
  readonly descriptor?: boolean;
  readonly localName?: string;
  readonly declaredSize?: number;
  readonly crc?: number;
  readonly centralSizes?: number;
  readonly compressed?: Buffer;
};

type Layout = {
  readonly central?: (index: number, header: Buffer) => void;
  readonly end?: (record: Buffer) => void;
  readonly zip64Locator?: boolean;
  readonly extraCentral?: readonly Buffer[];
};

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export function localHeader(spec: Spec, compressed: Buffer): Buffer {
  const name = Buffer.from(spec.localName ?? spec.name);
  const zeroed = spec.descriptor === true;
  return Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16((spec.flags ?? 0) | (zeroed ? DATA_DESCRIPTOR : 0)),
    u16(spec.method ?? DEFLATED),
    u16(0),
    u16(0),
    u32(zeroed ? 0 : (spec.crc ?? crc32(spec.data))),
    u32(zeroed ? 0 : compressed.length),
    u32(zeroed ? 0 : (spec.declaredSize ?? spec.data.length)),
    u16(name.length),
    u16(0),
    name,
  ]);
}

export function centralHeader(spec: Spec, compressed: Buffer, offset: number): Buffer {
  const name = Buffer.from(spec.name);
  return Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16((spec.flags ?? 0) | (spec.descriptor === true ? DATA_DESCRIPTOR : 0)),
    u16(spec.method ?? DEFLATED),
    u16(0),
    u16(0),
    u32(spec.crc ?? crc32(spec.data)),
    u32(spec.centralSizes ?? compressed.length),
    u32(spec.centralSizes ?? spec.declaredSize ?? spec.data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    name,
  ]);
}

function compress(spec: Spec): Buffer {
  return spec.compressed ?? ((spec.method ?? DEFLATED) === DEFLATED ? deflateRawSync(spec.data) : spec.data);
}

export function zip(specs: readonly Spec[], layout: Layout = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  specs.forEach((spec, index) => {
    const compressed = compress(spec);
    const descriptor = spec.descriptor === true
      ? Buffer.concat([u32(0x08074b50), u32(crc32(spec.data)), u32(compressed.length), u32(spec.data.length)])
      : Buffer.alloc(0);
    const local = Buffer.concat([localHeader(spec, compressed), compressed, descriptor]);
    const central = centralHeader(spec, compressed, offset);
    layout.central?.(index, central);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  });
  centrals.push(...(layout.extraCentral ?? []));
  const cd = Buffer.concat(centrals);
  const locator = layout.zip64Locator === true ? Buffer.concat([u32(0x07064b50), Buffer.alloc(16)]) : Buffer.alloc(0);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  layout.end?.(end);
  return Buffer.concat([...locals, cd, locator, end]);
}

export const text = (value: string) => Buffer.from(value);
export const trace = (data = '{"type":"context-options","version":10}\n') => ({ name: 'test.trace', data: text(data) });

