import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationId, buildId, runId } from '../graph/ids.js';
import { parseCommitSha, parseOrigin } from '../graph/model.js';
import { appHome, artifactPath, runDirectories, sealRunDirectory, stateDatabasePath } from './layout.js';

const app = applicationId({ rootPath: '/repo/web' });
const run = runId({
  buildId: buildId({ applicationId: app, commitSha: parseCommitSha('a'.repeat(40)), sourceHash: 'h', analyzerVersion: '1' }),
  origin: parseOrigin('http://localhost:3000'),
  session: { kind: 'anonymous' },
  startedAt: new Date(0),
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('layout', () => {
  it('keeps the database and every run under the app home', () => {
    const home = appHome(app);
    expect(home).toBe(join(process.env.NORI_HOME ?? '', 'apps', app));
    expect(stateDatabasePath(app)).toBe(join(home, 'graph.db'));
    expect(runDirectories(app, run)).toEqual({
      staging: join(home, 'runs', `${run}.partial`),
      sealed: join(home, 'runs', run),
    });
  });

  it('seals a staged run once and treats a second seal as done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nori-layout-'));
    tempDirs.push(root);
    const dirs = { staging: join(root, 'r.partial'), sealed: join(root, 'r') };
    mkdirSync(dirs.staging);
    writeFileSync(join(dirs.staging, 'reconcile.json'), '[]');

    await sealRunDirectory(dirs);
    await sealRunDirectory(dirs);
    expect(existsSync(join(dirs.sealed, 'reconcile.json'))).toBe(true);
    expect(existsSync(dirs.staging)).toBe(false);
  });

  it('refuses to seal when neither directory exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nori-layout-'));
    tempDirs.push(root);
    await expect(sealRunDirectory({ staging: join(root, 'a.partial'), sealed: join(root, 'a') })).rejects.toThrow();
  });

  it('resolves artifact files inside the run directory and refuses ones that escape it', () => {
    expect(artifactPath('/home/runs/r', 'captures/a.png')).toBe('/home/runs/r/captures/a.png');
    for (const bad of ['../other/a.png', '/etc/passwd', '.', 'captures/../../x']) {
      expect(() => artifactPath('/home/runs/r', bad), bad).toThrow(/not inside/);
    }
  });
});
