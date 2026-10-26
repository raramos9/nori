import { analysisId, appKey, snapshotId } from '../graph/ids.js';
import {
  parseAnalyzerVersion,
  parseCommitSha,
  type Analysis,
  type Application,
  type RepoIdentity,
  type Snapshot,
} from '../graph/model.js';

const REPO_IDENTITY: RepoIdentity = 'remote:example.com/acme/web';

export const TEST_APP: Application = {
  id: appKey({ repoIdentity: REPO_IDENTITY, subpath: '' }),
  repoIdentity: REPO_IDENTITY,
  subpath: '',
  framework: 'next-app-router',
};

export const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

export function testSnapshot({
  commit = 'a',
  sourceHash = 'f'.repeat(64),
  worktree = 'clean',
}: { commit?: string; sourceHash?: string; worktree?: Snapshot['worktree'] } = {}): Snapshot {
  const commitSha = parseCommitSha(commit.repeat(40));
  return {
    id: snapshotId({ appKey: TEST_APP.id, commitSha, sourceHash }),
    appKey: TEST_APP.id,
    commitSha,
    sourceHash,
    worktree,
    branch: 'main',
    createdAt: CREATED_AT,
  };
}

export function testAnalysis(
  snapshot: Snapshot,
  { analyzerVersion = '1.0.0', inputsHash = 'i'.repeat(64) }: { analyzerVersion?: string; inputsHash?: string } = {},
): Analysis {
  const version = parseAnalyzerVersion(analyzerVersion);
  return {
    id: analysisId({ snapshotId: snapshot.id, analyzerVersion: version, inputsHash }),
    snapshotId: snapshot.id,
    analyzerVersion: version,
    inputsHash,
    createdAt: CREATED_AT,
  };
}
