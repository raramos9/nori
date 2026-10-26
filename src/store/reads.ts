import type { Kysely } from 'kysely';
import {
  deriveEvidenceStatus,
  parseRunId,
  parseScreenId,
  parseTransitionId,
  type Analysis,
  type AnalysisId,
  type BuildGraph,
  type BuildSummary,
  type CaptureEvidence,
  type LoadedScreen,
  type LoadedTransition,
  type NavigationEvidence,
  type NonEmpty,
  type ObservationSubject,
  type Run,
  type RunId,
  type ScreenObservation,
  type SnapshotId,
  type TransitionObservation,
  type UIState,
  type Verdict,
} from '../graph/model.js';
import {
  parseAnalysis,
  parseApplication,
  parseCapture,
  parseNavigation,
  parseRun,
  parseScreen,
  parseScreenMatch,
  parseSnapshot,
  parseState,
  parseStaticEvidence,
  parseTransition,
  parseTransitionMatch,
  parseVerdict,
} from './rows.js';
import type { Database } from './schema.js';

type Db = Kysely<Database>;

function appendTo<K, V>(groups: Map<K, [V, ...V[]]>, key: K, value: V): void {
  const existing = groups.get(key);
  if (existing === undefined) groups.set(key, [value]);
  else existing.push(value);
}

function observationsFor<T>(groups: ReadonlyMap<string, NonEmpty<T>>, subject: ObservationSubject): NonEmpty<T> {
  const found = groups.get(subject.id);
  if (found === undefined) {
    throw new Error(`${subject.kind} ${subject.id} is supported in the build but has no observations loaded`);
  }
  return found;
}

function supportedScreenIds(db: Db, analysisId: AnalysisId) {
  return db
    .selectFrom('static_observations')
    .select('subject_id as id')
    .where('analysis_id', '=', analysisId)
    .where('subject_kind', '=', 'screen')
    .where('verdict', '=', 'supports')
    .union(
      db
        .selectFrom('screen_matches')
        .select('screen_id as id')
        .where('analysis_id', '=', analysisId)
        .where('verdict', '=', 'supports'),
    );
}

function supportedTransitionIds(db: Db, analysisId: AnalysisId) {
  return db
    .selectFrom('static_observations')
    .select('subject_id as id')
    .where('analysis_id', '=', analysisId)
    .where('subject_kind', '=', 'transition')
    .where('verdict', '=', 'supports')
    .union(
      db
        .selectFrom('transition_matches')
        .select('transition_id as id')
        .where('analysis_id', '=', analysisId)
        .where('verdict', '=', 'supports'),
    );
}

function checked<M extends { readonly verdict: Verdict }>(match: M, verdict: Verdict, where: string): M {
  if (match.verdict !== verdict) throw new Error(`${where}: verdict disagrees with its match`);
  return match;
}

export async function loadBuild(db: Db, analysisId: AnalysisId): Promise<BuildGraph | null> {
  return db.transaction().execute(async (trx) => {
    const analysisRow = await trx.selectFrom('analyses').selectAll().where('id', '=', analysisId).executeTakeFirst();
    if (analysisRow === undefined) return null;
    const analysis = parseAnalysis(analysisRow);
    const snapshot = parseSnapshot(
      await trx.selectFrom('snapshots').selectAll().where('id', '=', analysis.snapshotId).executeTakeFirstOrThrow(),
    );
    const application = parseApplication(
      await trx.selectFrom('applications').selectAll().where('id', '=', snapshot.appKey).executeTakeFirstOrThrow(),
    );

    const runRows = await trx
      .selectFrom('runs')
      .innerJoin('matches', 'matches.run_id', 'runs.id')
      .selectAll('runs')
      .where('matches.analysis_id', '=', analysisId)
      .orderBy('runs.started_at')
      .orderBy('runs.id')
      .execute();
    const runs = runRows.map(parseRun);
    const unmatchedRuns = (
      await trx
        .selectFrom('match_failures')
        .select('sealed_run_id')
        .where('analysis_id', '=', analysisId)
        .orderBy('sealed_run_id')
        .execute()
    ).map((row) => parseRunId(row.sealed_run_id));
    const runById = new Map(runs.map((run) => [run.id as string, run]));
    const runOf = (id: string): Run => {
      const run = runById.get(id);
      if (run === undefined) throw new Error(`Run ${id} is not matched under analysis ${analysisId}`);
      return run;
    };

    const captureRows = await trx
      .selectFrom('captures')
      .innerJoin('matches', 'matches.run_id', 'captures.run_id')
      .selectAll('captures')
      .where('matches.analysis_id', '=', analysisId)
      .orderBy('captures.evidence_id')
      .execute();
    const captures = new Map<string, CaptureEvidence>(
      captureRows.map((row) => [row.evidence_id, parseCapture(snapshot.appKey, runOf(row.run_id), row)]),
    );
    const navigationRows = await trx
      .selectFrom('navigations')
      .innerJoin('matches', 'matches.run_id', 'navigations.run_id')
      .selectAll('navigations')
      .where('matches.analysis_id', '=', analysisId)
      .orderBy('navigations.evidence_id')
      .execute();
    const navigations = new Map<string, NavigationEvidence>(
      navigationRows.map((row) => [row.evidence_id, parseNavigation(runOf(row.run_id), row, captures)]),
    );

    const screenObservations = new Map<string, [ScreenObservation, ...ScreenObservation[]]>();
    const transitionObservations = new Map<string, [TransitionObservation, ...TransitionObservation[]]>();

    const staticRows = await trx
      .selectFrom('static_observations')
      .innerJoin('static_evidence', (join) =>
        join
          .onRef('static_evidence.analysis_id', '=', 'static_observations.analysis_id')
          .onRef('static_evidence.id', '=', 'static_observations.evidence_id'),
      )
      .selectAll('static_evidence')
      .select(['static_observations.subject_kind', 'static_observations.subject_id', 'static_observations.verdict'])
      .where('static_observations.analysis_id', '=', analysisId)
      .orderBy('static_evidence.id')
      .execute();
    for (const row of staticRows) {
      const where = `Observation of ${row.subject_kind} ${row.subject_id} by ${row.id}`;
      const observation = { evidence: parseStaticEvidence(row), verdict: parseVerdict(row.verdict, where) };
      switch (row.subject_kind) {
        case 'screen':
          appendTo(screenObservations, parseScreenId(row.subject_id), observation);
          break;
        case 'transition':
          appendTo(transitionObservations, parseTransitionId(row.subject_id), observation);
          break;
        default:
          throw new Error(`${where}: unknown subject_kind`);
      }
    }

    const screenMatchRows = await trx
      .selectFrom('screen_matches')
      .selectAll()
      .where('analysis_id', '=', analysisId)
      .orderBy('capture_id')
      .execute();
    for (const row of screenMatchRows) {
      const where = `Match of screen ${row.screen_id} by ${row.capture_id}`;
      const evidence = captures.get(row.capture_id);
      if (evidence === undefined) throw new Error(`${where}: no capture of a matched run`);
      const match = checked(parseScreenMatch(row.match, `${where}: match`), parseVerdict(row.verdict, where), where);
      appendTo(screenObservations, parseScreenId(row.screen_id), { evidence, match });
    }

    const transitionMatchRows = await trx
      .selectFrom('transition_matches')
      .selectAll()
      .where('analysis_id', '=', analysisId)
      .orderBy('navigation_id')
      .orderBy('transition_id')
      .execute();
    for (const row of transitionMatchRows) {
      const where = `Match of transition ${row.transition_id} by ${row.navigation_id}`;
      const evidence = navigations.get(row.navigation_id);
      if (evidence === undefined) throw new Error(`${where}: no navigation of a matched run`);
      const match = checked(parseTransitionMatch(row.match, `${where}: match`), parseVerdict(row.verdict, where), where);
      appendTo(transitionObservations, parseTransitionId(row.transition_id), { evidence, match });
    }

    const screenRows = await trx
      .selectFrom('screens')
      .selectAll()
      .where('id', 'in', supportedScreenIds(trx, analysisId))
      .orderBy('id')
      .execute();
    const stateRows = await trx
      .selectFrom('ui_states')
      .selectAll()
      .where('screen_id', 'in', supportedScreenIds(trx, analysisId))
      .orderBy('id')
      .execute();
    const transitionRows = await trx
      .selectFrom('transitions')
      .selectAll()
      .where('id', 'in', supportedTransitionIds(trx, analysisId))
      .orderBy('id')
      .execute();

    const statesByScreen = new Map<string, [UIState, ...UIState[]]>();
    for (const row of stateRows) appendTo(statesByScreen, row.screen_id, parseState(row));

    const screens = screenRows.map((row): LoadedScreen => {
      const screen = parseScreen(row);
      const states = statesByScreen.get(screen.id);
      if (states === undefined) throw new Error(`Screen ${screen.id} has no states`);
      const observations = observationsFor(screenObservations, { kind: 'screen', id: screen.id });
      return { screen, states, observations, status: deriveEvidenceStatus(observations) };
    });

    const transitions = transitionRows.map((row): LoadedTransition => {
      const transition = parseTransition(row);
      const observations = observationsFor(transitionObservations, { kind: 'transition', id: transition.id });
      return { transition, observations, status: deriveEvidenceStatus(observations) };
    });

    return { application, snapshot, analysis, runs, unmatchedRuns, screens, transitions };
  });
}

export async function listBuilds(db: Db): Promise<readonly BuildSummary[]> {
  const snapshotRows = await db.selectFrom('snapshots').selectAll().orderBy('created_at', 'desc').orderBy('id').execute();
  const analysisRows = await db.selectFrom('analyses').selectAll().orderBy('created_at', 'desc').orderBy('id').execute();
  const runCounts = await db
    .selectFrom('runs')
    .select(['snapshot_id', (eb) => eb.fn.countAll<number>().as('count')])
    .groupBy('snapshot_id')
    .execute();
  const counts = new Map(runCounts.map((row) => [row.snapshot_id, Number(row.count)]));
  const analysesBySnapshot = new Map<string, [Analysis, ...Analysis[]]>();
  for (const row of analysisRows) appendTo(analysesBySnapshot, row.snapshot_id, parseAnalysis(row));
  return snapshotRows.flatMap((row): BuildSummary[] => {
    const analyses = analysesBySnapshot.get(row.id);
    return analyses === undefined ? [] : [{ snapshot: parseSnapshot(row), analyses, runCount: counts.get(row.id) ?? 0 }];
  });
}

export type MatchState = {
  readonly matched: ReadonlySet<RunId>;
  readonly failed: ReadonlyMap<RunId, string>;
};

export async function matchState(db: Db, analysisId: AnalysisId): Promise<MatchState> {
  const matched = await db.selectFrom('matches').select('run_id').where('analysis_id', '=', analysisId).execute();
  const failed = await db
    .selectFrom('match_failures')
    .select(['sealed_run_id', 'error'])
    .where('analysis_id', '=', analysisId)
    .execute();
  return {
    matched: new Set(matched.map((row) => parseRunId(row.run_id))),
    failed: new Map(failed.map((row) => [parseRunId(row.sealed_run_id), row.error])),
  };
}

export async function runsOfSnapshot(db: Db, snapshotId: SnapshotId): Promise<ReadonlyMap<RunId, Run>> {
  const rows = await db.selectFrom('runs').selectAll().where('snapshot_id', '=', snapshotId).execute();
  return new Map(rows.map((row) => [parseRunId(row.id), parseRun(row)]));
}
