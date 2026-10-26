import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testImportId } from '../graph/ids.js';
import { parseArtifactPath } from '../graph/model.js';
import { testSnapshot } from '../testing/identity.js';
import { IMPORT_FILE, parseSealedImport, readSealedImport, sealImport, type SealedImportV1 } from './sealed-import.js';

const snapshot = testSnapshot();
const sha256 = 'b'.repeat(64);
const sealedImport: SealedImportV1 = {
  format: 1,
  id: testImportId({ snapshotId: snapshot.id, sha256 }),
  snapshotId: snapshot.id,
  environment: 'ci',
  importedAt: new Date('2026-10-26T00:00:00.000Z'),
  report: { original: parseArtifactPath('/w/report.json'), sha256, playwrightVersion: '1.64.0', startedAt: new Date(0) },
  cases: [],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nori-sealed-import-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sealed imports', () => {
  it('round-trips import.json and refuses another format', () => {
    expect(parseSealedImport(JSON.stringify(sealedImport))).toEqual(sealedImport);
    expect(() => parseSealedImport(JSON.stringify({ ...sealedImport, format: 2 }))).toThrow(/format 2/);
  });

  it('refuses an import.json whose id does not follow from its report digest', async () => {
    const staging = join(dir, 'staging');
    const sealed = join(dir, 'imports', sealedImport.id);
    mkdirSync(staging);
    await sealImport({ staging, sealed, sealedImport: { ...sealedImport, report: { ...sealedImport.report, sha256: 'c'.repeat(64) } } });
    await expect(readSealedImport({ directory: sealed, snapshotId: snapshot.id, importId: sealedImport.id })).rejects.toThrow(/recomputed/);
  });

  it('discards the staging directory of a concurrent import that lost the rename', async () => {
    const sealed = join(dir, 'imports', sealedImport.id);
    for (const name of ['first', 'second']) {
      mkdirSync(join(dir, name));
      await sealImport({ staging: join(dir, name), sealed, sealedImport });
    }
    expect(readdirSync(sealed)).toEqual([IMPORT_FILE]);
    expect(existsSync(join(dir, 'second'))).toBe(false);
    const { testImport } = await readSealedImport({ directory: sealed, snapshotId: snapshot.id, importId: sealedImport.id });
    expect(testImport.report.sealed).toBe(join(sealed, 'report.json'));
  });
});
