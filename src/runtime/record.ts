import type { Kysely, Transaction } from 'kysely';
import { errorCode } from '../errors.js';
import { screenId, stateId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  type BuildGraph,
  type Run,
  type RunId,
  type RunIngestion,
  type Snapshot,
  type StaticIngestion,
} from '../graph/model.js';
import { openWriteDatabase } from '../store/database.js';
import { loadBuild, matchState, runsOfSnapshot } from '../store/reads.js';
import {
  analysisToRow,
  applicationToRow,
  captureToRow,
  navigationToRow,
  runToRow,
  snapshotToRow,
  staticEvidenceToRow,
  transitionToRow,
} from '../store/rows.js';
import type { Database } from '../store/schema.js';
import { stateDatabasePath } from './layout.js';
import { reconcileRun, validateCrawl, type StaticSide } from './reconcile.js';
import { listSealedRuns, readSealedCrawl } from './sealed-run.js';

export type RunOutcome =
  | { readonly kind: 'matched-now'; readonly ingestion: RunIngestion }
  | { readonly kind: 'already-matched'; readonly run: Run }
  | { readonly kind: 'failed'; readonly runId: RunId; readonly reason: string };

export type Recorded = { readonly graph: BuildGraph; readonly runs: readonly RunOutcome[] };

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

const INSERT_CHUNK_SIZE = 200;

function* chunks<T>(items: readonly T[]): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += INSERT_CHUNK_SIZE) {
    yield items.slice(i, i + INSERT_CHUNK_SIZE);
  }
}

async function upsertSnapshotPromotingClean(trx: Trx, snapshot: Snapshot): Promise<void> {
  await trx
    .insertInto('snapshots')
    .values(snapshotToRow(snapshot))
    .onConflict((oc) =>
      oc
        .column('id')
        .doUpdateSet({ worktree: (eb) => eb.ref('excluded.worktree') })
        .where('excluded.worktree', '=', 'clean')
        .where('snapshots.worktree', '=', 'dirty'),
    )
    .execute();
}

async function insertStatic(trx: Trx, ingestion: StaticIngestion): Promise<void> {
  const { application, snapshot, analysis, screens, transitions, evidence, observations } = ingestion;
  await trx
    .insertInto('applications')
    .values(applicationToRow(application))
    .onConflict((oc) => oc.doNothing())
    .execute();
  await upsertSnapshotPromotingClean(trx, snapshot);
  await trx
    .insertInto('analyses')
    .values(analysisToRow(analysis))
    .onConflict((oc) => oc.doNothing())
    .execute();

  for (const batch of chunks(screens)) {
    await trx
      .insertInto('screens')
      .values(batch.map((screen) => ({ id: screen.id, application_id: screen.appKey, route_pattern: screen.routePattern })))
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto('ui_states')
      .values(
        batch.map((screen) => ({
          id: stateId({ screenId: screen.id, key: DEFAULT_STATE_KEY }),
          screen_id: screen.id,
          key: DEFAULT_STATE_KEY,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  for (const batch of chunks(transitions)) {
    await trx.insertInto('transitions').values(batch.map(transitionToRow)).onConflict((oc) => oc.doNothing()).execute();
  }
  for (const batch of chunks(evidence)) {
    await trx
      .insertInto('static_evidence')
      .values(batch.map(staticEvidenceToRow))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  for (const batch of chunks(observations)) {
    await trx
      .insertInto('static_observations')
      .values(
        batch.map((observation) => ({
          analysis_id: analysis.id,
          evidence_id: observation.evidenceId,
          subject_kind: observation.subject.kind,
          subject_id: observation.subject.id,
          verdict: observation.verdict,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

async function recordAnalysis(db: Db, ingestion: StaticIngestion): Promise<void> {
  const present = await db
    .selectFrom('analyses')
    .innerJoin('snapshots', 'snapshots.id', 'analyses.snapshot_id')
    .select('snapshots.worktree')
    .where('analyses.id', '=', ingestion.analysis.id)
    .executeTakeFirst();
  if (present === undefined) {
    await db.transaction().execute((trx) => insertStatic(trx, ingestion));
  } else if (present.worktree === 'dirty' && ingestion.snapshot.worktree === 'clean') {
    await db.transaction().execute((trx) => upsertSnapshotPromotingClean(trx, ingestion.snapshot));
  }
}

async function insertMatch(trx: Trx, ingestion: StaticIngestion, match: RunIngestion): Promise<void> {
  const { application, snapshot, analysis } = ingestion;
  const { run, captures, navigations, created } = match;
  const owner = { snapshot_id: snapshot.id, run_id: run.id, analysis_id: analysis.id };

  await trx.insertInto('runs').values(runToRow(run)).onConflict((oc) => oc.doNothing()).execute();
  for (const batch of chunks(captures)) {
    await trx
      .insertInto('captures')
      .values(batch.map(({ evidence }) => captureToRow(application.id, run, evidence)))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  for (const batch of chunks(navigations)) {
    await trx
      .insertInto('navigations')
      .values(batch.map(({ evidence }) => navigationToRow(evidence)))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  for (const batch of chunks(created)) {
    await trx.insertInto('transitions').values(batch.map(transitionToRow)).onConflict((oc) => oc.doNothing()).execute();
  }
  const screenRows = captures.flatMap(({ evidence, match: screenMatch }) =>
    screenMatch === null
      ? []
      : [
          {
            ...owner,
            capture_id: evidence.id,
            screen_id: screenId({ appKey: application.id, routePattern: screenMatch.pattern }),
            verdict: screenMatch.verdict,
            match: JSON.stringify(screenMatch),
          },
        ],
  );
  const transitionRows = navigations.flatMap(({ evidence, matches }) =>
    matches.map(({ transitionId, match: transitionMatch }) => ({
      ...owner,
      navigation_id: evidence.id,
      transition_id: transitionId,
      verdict: transitionMatch.verdict,
      match: JSON.stringify(transitionMatch),
    })),
  );
  await trx
    .insertInto('matches')
    .values({ ...owner, created_at: new Date().toISOString() })
    .execute();
  for (const batch of chunks(screenRows)) await trx.insertInto('screen_matches').values(batch).execute();
  for (const batch of chunks(transitionRows)) await trx.insertInto('transition_matches').values(batch).execute();
}

const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

// A parse, validation, reconcile, constraint or missing-file error repeats on every retry under this
// analysis, so it is recorded. A permission, busy or I/O error may not, so it propagates.
function failsEveryTime(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return true;
  return typeof code === 'string' && (code.startsWith('SQLITE_CONSTRAINT') || MISSING_FILE_CODES.has(code));
}

async function recordFailure(db: Db, staticSide: StaticSide, runId: RunId, error: unknown): Promise<RunOutcome> {
  const { snapshot, analysis } = staticSide.ingestion;
  const reason = error instanceof Error ? error.message : String(error);
  await db
    .insertInto('match_failures')
    .values({
      snapshot_id: snapshot.id,
      sealed_run_id: runId,
      analysis_id: analysis.id,
      error: reason,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return { kind: 'failed', runId, reason };
}

async function matchRun(
  db: Db,
  staticSide: StaticSide,
  { runId, directory }: { runId: RunId; directory: string },
): Promise<RunOutcome> {
  const { snapshot, analysis } = staticSide.ingestion;
  try {
    const sealed = await readSealedCrawl({ directory, snapshotId: snapshot.id, runId });
    const match = reconcileRun({ staticSide, validated: validateCrawl(sealed, directory) });
    const wrote = await db.transaction().execute(async (trx) => {
      const done = await trx
        .selectFrom('matches')
        .select('run_id')
        .where('run_id', '=', runId)
        .where('analysis_id', '=', analysis.id)
        .executeTakeFirst();
      if (done !== undefined) return false;
      await insertMatch(trx, staticSide.ingestion, match);
      return true;
    });
    return wrote ? { kind: 'matched-now', ingestion: match } : { kind: 'already-matched', run: match.run };
  } catch (error) {
    if (!failsEveryTime(error)) throw error;
    return recordFailure(db, staticSide, runId, error);
  }
}

async function recordRuns(db: Db, staticSide: StaticSide): Promise<readonly RunOutcome[]> {
  const { application, snapshot, analysis } = staticSide.ingestion;
  const sealed = await listSealedRuns(application.id, snapshot.id);
  if (sealed.length === 0) return [];
  const { matched, failed } = await matchState(db, analysis.id);
  const stored = await runsOfSnapshot(db, snapshot.id);
  const outcomes: RunOutcome[] = [];
  for (const entry of sealed) {
    const run = matched.has(entry.runId) ? stored.get(entry.runId) : undefined;
    const reason = failed.get(entry.runId);
    if (run !== undefined) outcomes.push({ kind: 'already-matched', run });
    else if (reason !== undefined) outcomes.push({ kind: 'failed', runId: entry.runId, reason });
    else outcomes.push(await matchRun(db, staticSide, entry));
  }
  return outcomes;
}

export async function record(staticSide: StaticSide): Promise<Recorded> {
  const { ingestion } = staticSide;
  const db = await openWriteDatabase({ path: stateDatabasePath(ingestion.application.id) });
  try {
    await recordAnalysis(db, ingestion);
    const runs = await recordRuns(db, staticSide);
    const graph = await loadBuild(db, ingestion.analysis.id);
    if (graph === null) throw new Error(`Analysis ${ingestion.analysis.id} was not found after recording it`);
    return { graph, runs };
  } finally {
    await db.destroy();
  }
}
