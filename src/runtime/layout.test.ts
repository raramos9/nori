import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runId } from '../graph/ids.js';
import { parseOrigin } from '../graph/model.js';
import { TEST_APP, testSnapshot } from '../testing/identity.js';
import { appHome, artifactPath, runDirectory, stagingDirectory, stateDatabasePath } from './layout.js';

const app = TEST_APP.id;
const snapshot = testSnapshot().id;
const run = runId({
  snapshotId: snapshot,
  origin: parseOrigin('http://localhost:3000'),
  session: { kind: 'anonymous' },
  startedAt: new Date(0),
});

describe('layout', () => {
  it('keeps the database and every run of a snapshot under the store of its app key', () => {
    const home = appHome(app);
    expect(home).toBe(join(process.env.NORI_HOME ?? '', 'stores', app));
    expect(stateDatabasePath(app)).toBe(join(home, 'graph.db'));
    expect(runDirectory(app, snapshot, run)).toBe(join(home, 'runs', snapshot, run));
    const staging = stagingDirectory(app);
    expect(dirname(staging)).toBe(join(home, 'runs'));
    expect(staging).toMatch(/\.partial$/);
    expect(stagingDirectory(app)).not.toBe(staging);
  });

  it('resolves artifact files inside the run directory and refuses ones that escape it', () => {
    expect(artifactPath('/home/runs/r', 'captures/a.png')).toBe('/home/runs/r/captures/a.png');
    for (const bad of ['../other/a.png', '/etc/passwd', '.', 'captures/../../x']) {
      expect(() => artifactPath('/home/runs/r', bad), bad).toThrow(/not inside/);
    }
  });
});
