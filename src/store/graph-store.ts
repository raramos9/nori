import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, type Selectable } from 'kysely';
import { screenId, stateId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  deriveEvidenceStatus,
  isUnresolvedReason,
  parseApplicationId,
  parseBuildId,
  parseCommitSha,
  parseEvidenceId,
  parseRoutePattern,
  parseScreenId,
  parseStateId,
  parseTransitionId,
  type Application,
  type Build,
  type BuildGraph,
  type BuildId,
  type CaptureEvidence,
  type Evidence,
  type LoadedScreen,
  type LoadedTransition,
  type NavigationEvidence,
  type NonEmpty,
  type Observation,
  type ObservationSubject,
  type RunIngestion,
  type RuntimeEvidence,
  type ScreenObservation,
  type Screen,
  type StaticEvidence,
  type StaticIngestion,
  type Transition,
  type TransitionObservation,
  type TransitionTarget,
  type Trigger,
  type UIState,
  type Verdict,
} from '../graph/model.js';
import { migrateToLatest } from './migrations.js';
import {
  captureToRow,
  navigationToRow,
  parseCapture,
  parseNavigation,
  parseRun,
  parseScreenMatch,
  parseTransitionMatch,
  runToRow,
} from './runtime-rows.js';
import type {
  ApplicationsTable,
  BuildsTable,
  Database as Schema,
  EvidenceTable,
  GraphDb,
  ObservationsTable,
  ScreensTable,
  TransitionsTable,
  UiStatesTable,
} from './schema.js';

const INSERT_CHUNK_SIZE = 200;

function* chunks<T>(items: readonly T[]): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += INSERT_CHUNK_SIZE) {
    yield items.slice(i, i + INSERT_CHUNK_SIZE);
  }
}

function appendTo<K, V>(groups: Map<K, [V, ...V[]]>, key: K, value: V): void {
  const existing = groups.get(key);
  if (existing === undefined) groups.set(key, [value]);
  else existing.push(value);
}

function required<T>(value: T | null, description: string): T {
  if (value === null) throw new Error(`${description} must not be null`);
  return value;
}

function mustBeNull(value: unknown, description: string): void {
  if (value !== null) throw new Error(`${description} must be null`);
}

const TRIGGERS: Record<Trigger['kind'], Trigger> = {
  link: { kind: 'link' },
  'router-push': { kind: 'router-push' },
  'router-replace': { kind: 'router-replace' },
  redirect: { kind: 'redirect' },
};

function isTriggerKind(value: string): value is Trigger['kind'] {
  return Object.hasOwn(TRIGGERS, value);
}

function parseTrigger(row: Selectable<TransitionsTable>): Trigger {
  if (!isTriggerKind(row.trigger_kind)) {
    throw new Error(`Transition ${row.id}: unknown trigger_kind ${JSON.stringify(row.trigger_kind)}`);
  }
  return TRIGGERS[row.trigger_kind];
}

function parseTarget(row: Selectable<TransitionsTable>): TransitionTarget {
  const where = (column: string) => `Transition ${row.id}: ${column} (target_kind '${row.target_kind}')`;
  switch (row.target_kind) {
    case 'resolved':
      mustBeNull(row.unresolved_reason, where('unresolved_reason'));
      mustBeNull(row.unresolved_expression, where('unresolved_expression'));
      return {
        kind: 'resolved',
        stateId: parseStateId(required(row.target_state_id, where('target_state_id'))),
      };
    case 'unresolved': {
      mustBeNull(row.target_state_id, where('target_state_id'));
      const reason = required(row.unresolved_reason, where('unresolved_reason'));
      if (!isUnresolvedReason(reason)) {
        throw new Error(`Transition ${row.id}: unknown unresolved_reason ${JSON.stringify(reason)}`);
      }
      return {
        kind: 'unresolved',
        reason,
        expression: required(row.unresolved_expression, where('unresolved_expression')),
      };
    }
    default:
      throw new Error(`Transition ${row.id}: unknown target_kind ${JSON.stringify(row.target_kind)}`);
  }
}

function parseTransition(row: Selectable<TransitionsTable>): Transition {
  return {
    id: parseTransitionId(row.id),
    sourceStateId: parseStateId(row.source_state_id),
    trigger: parseTrigger(row),
    target: parseTarget(row),
  };
}

function transitionToRow(transition: Transition): Selectable<TransitionsTable> {
  const base = {
    id: transition.id,
    source_state_id: transition.sourceStateId,
    trigger_kind: transition.trigger.kind,
  };
  const { target } = transition;
  switch (target.kind) {
    case 'resolved':
      return {
        ...base,
        target_kind: target.kind,
        target_state_id: target.stateId,
        unresolved_reason: null,
        unresolved_expression: null,
      };
    case 'unresolved':
      return {
        ...base,
        target_kind: target.kind,
        target_state_id: null,
        unresolved_reason: target.reason,
        unresolved_expression: target.expression,
      };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function parseStaticEvidence(row: Selectable<EvidenceTable>): StaticEvidence {
  const where = (column: string) => `Evidence ${row.id}: ${column} (kind '${row.kind}')`;
  switch (row.kind) {
    case 'static':
      return {
        kind: 'static',
        id: parseEvidenceId(row.id),
        buildId: parseBuildId(row.build_id),
        extractor: required(row.extractor, where('extractor')),
        span: {
          file: required(row.span_file, where('span_file')),
          start: {
            line: required(row.span_start_line, where('span_start_line')),
            column: required(row.span_start_column, where('span_start_column')),
          },
          end: {
            line: required(row.span_end_line, where('span_end_line')),
            column: required(row.span_end_column, where('span_end_column')),
          },
        },
      };
    default:
      throw new Error(`Evidence ${row.id}: unknown kind ${JSON.stringify(row.kind)}`);
  }
}

function evidenceToRow(evidence: Evidence): Selectable<EvidenceTable> {
  switch (evidence.kind) {
    case 'static':
      return {
        id: evidence.id,
        build_id: evidence.buildId,
        kind: evidence.kind,
        extractor: evidence.extractor,
        span_file: evidence.span.file,
        span_start_line: evidence.span.start.line,
        span_start_column: evidence.span.start.column,
        span_end_line: evidence.span.end.line,
        span_end_column: evidence.span.end.column,
      };
    case 'capture':
    case 'navigation':
      return {
        id: evidence.id,
        build_id: evidence.buildId,
        kind: evidence.kind,
        extractor: null,
        span_file: null,
        span_start_line: null,
        span_start_column: null,
        span_end_line: null,
        span_end_column: null,
      };
    default: {
      const _exhaustive: never = evidence;
      return _exhaustive;
    }
  }
}

function parseVerdict(value: string): Verdict {
  switch (value) {
    case 'supports':
    case 'contradicts':
      return value;
    default:
      throw new Error(`Observation: unknown verdict ${JSON.stringify(value)}`);
  }
}

function parseSubject(kind: string, id: string): ObservationSubject {
  switch (kind) {
    case 'screen':
      return { kind, id: parseScreenId(id) };
    case 'transition':
      return { kind, id: parseTransitionId(id) };
    default:
      throw new Error(`Observation: unknown subject_kind ${JSON.stringify(kind)}`);
  }
}

function parseBuild(row: Selectable<BuildsTable>): Build {
  const createdAt = new Date(row.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Build ${row.id}: created_at ${JSON.stringify(row.created_at)} is not a date`);
  }
  return {
    id: parseBuildId(row.id),
    applicationId: parseApplicationId(row.application_id),
    commitSha: parseCommitSha(row.commit_sha),
    sourceHash: row.source_hash,
    branch: row.branch,
    analyzerVersion: row.analyzer_version,
    createdAt,
  };
}

function parseScreen(row: Selectable<ScreensTable>): Screen {
  return {
    id: parseScreenId(row.id),
    applicationId: parseApplicationId(row.application_id),
    routePattern: parseRoutePattern(row.route_pattern),
  };
}

function parseState(row: Selectable<UiStatesTable>): UIState {
  return { id: parseStateId(row.id), screenId: parseScreenId(row.screen_id), key: row.key };
}

function applicationToRow(application: Application): Selectable<ApplicationsTable> {
  return { id: application.id, root_path: application.rootPath, framework: application.framework };
}

function observationToRow(observation: Observation): Selectable<ObservationsTable> {
  return {
    evidence_id: observation.evidenceId,
    subject_kind: observation.subject.kind,
    subject_id: observation.subject.id,
    verdict: observation.verdict,
    match: null,
  };
}

function runtimeObservationRows(ingestion: RunIngestion): Selectable<ObservationsTable>[] {
  const { run, captures, navigations } = ingestion;
  return [
    ...captures.flatMap(({ evidence, match }) =>
      match === null
        ? []
        : [
            {
              evidence_id: evidence.id,
              subject_kind: 'screen',
              subject_id: screenId({ applicationId: run.applicationId, routePattern: match.pattern }),
              verdict: match.verdict,
              match: JSON.stringify(match),
            },
          ],
    ),
    ...navigations.flatMap(({ evidence, matches }) =>
      matches.map(({ transitionId, match }) => ({
        evidence_id: evidence.id,
        subject_kind: 'transition',
        subject_id: transitionId,
        verdict: match.verdict,
        match: JSON.stringify(match),
      })),
    ),
  ];
}

function buildToRow(build: Build): Selectable<BuildsTable> {
  return {
    id: build.id,
    application_id: build.applicationId,
    commit_sha: build.commitSha,
    source_hash: build.sourceHash,
    branch: build.branch,
    analyzer_version: build.analyzerVersion,
    created_at: build.createdAt.toISOString(),
  };
}

// Entities belong to a build only through supporting evidence from that build.
function supportedSubjectIds(db: GraphDb, buildId: BuildId, subjectKind: ObservationSubject['kind']) {
  return db
    .selectFrom('observations')
    .innerJoin('evidence', 'evidence.id', 'observations.evidence_id')
    .select('observations.subject_id')
    .where('evidence.build_id', '=', buildId)
    .where('observations.subject_kind', '=', subjectKind)
    .where('observations.verdict', '=', 'supports');
}

type ObservationRow = Selectable<EvidenceTable> &
  Pick<Selectable<ObservationsTable>, 'subject_kind' | 'subject_id' | 'verdict' | 'match'>;

type RuntimeEvidenceIndex = {
  readonly captures: ReadonlyMap<string, CaptureEvidence>;
  readonly navigations: ReadonlyMap<string, NavigationEvidence>;
};

type ObservationGroups = {
  readonly screens: Map<string, [ScreenObservation, ...ScreenObservation[]]>;
  readonly transitions: Map<string, [TransitionObservation, ...TransitionObservation[]]>;
};

function runtimeEvidenceOf<E>(index: ReadonlyMap<string, E>, row: ObservationRow): E {
  const where = (column: string) => `Evidence ${row.id}: ${column} (kind '${row.kind}')`;
  mustBeNull(row.extractor, where('extractor'));
  mustBeNull(row.span_file, where('span_file'));
  const evidence = index.get(row.id);
  if (evidence === undefined) throw new Error(`Evidence ${row.id}: no ${row.kind} row in a run of its build`);
  return evidence;
}

function groupObservation(row: ObservationRow, runtime: RuntimeEvidenceIndex, groups: ObservationGroups): void {
  const subject = parseSubject(row.subject_kind, row.subject_id);
  const verdict = parseVerdict(row.verdict);
  const where = `Observation of ${subject.kind} ${subject.id} by ${row.id}`;
  const checked = <M extends { readonly verdict: Verdict }>(match: M): M => {
    if (match.verdict !== verdict) throw new Error(`${where}: verdict disagrees with its match`);
    return match;
  };
  switch (row.kind) {
    case 'static': {
      mustBeNull(row.match, `${where}: match`);
      const observation = { evidence: parseStaticEvidence(row), verdict };
      if (subject.kind === 'screen') appendTo(groups.screens, subject.id, observation);
      else appendTo(groups.transitions, subject.id, observation);
      return;
    }
    case 'capture': {
      if (subject.kind !== 'screen') throw new Error(`${where}: a capture only observes screens`);
      const evidence = runtimeEvidenceOf(runtime.captures, row);
      const match = checked(parseScreenMatch(required(row.match, `${where}: match`), `${where}: match`));
      appendTo(groups.screens, subject.id, { evidence, match });
      return;
    }
    case 'navigation': {
      if (subject.kind !== 'transition') throw new Error(`${where}: a navigation only observes transitions`);
      const evidence = runtimeEvidenceOf(runtime.navigations, row);
      const match = checked(parseTransitionMatch(required(row.match, `${where}: match`), `${where}: match`));
      appendTo(groups.transitions, subject.id, { evidence, match });
      return;
    }
    default:
      throw new Error(`Evidence ${row.id}: unknown kind ${JSON.stringify(row.kind)}`);
  }
}

function observationsFor<T>(groups: ReadonlyMap<string, NonEmpty<T>>, subject: ObservationSubject): NonEmpty<T> {
  const found = groups.get(subject.id);
  if (found === undefined) {
    throw new Error(`${subject.kind} ${subject.id} is supported in the build but has no observations loaded`);
  }
  return found;
}

export class GraphStore {
  private constructor(private readonly db: GraphDb) {}

  static async open({ path }: { path: string }): Promise<GraphStore> {
    const sqlite = new Database(path);
    sqlite.pragma('foreign_keys = ON');
    const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
    try {
      await migrateToLatest(db);
    } catch (error) {
      await db.destroy();
      throw error;
    }
    return new GraphStore(db);
  }

  async ingestStatic(ingestion: StaticIngestion): Promise<void> {
    const { application, build, screens, transitions, evidence, observations } = ingestion;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('applications')
        .values(applicationToRow(application))
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto('builds')
        .values(buildToRow(build))
        .onConflict((oc) => oc.doNothing())
        .execute();

      for (const batch of chunks(screens)) {
        await trx
          .insertInto('screens')
          .values(
            batch.map((screen) => ({
              id: screen.id,
              application_id: screen.applicationId,
              route_pattern: screen.routePattern,
            })),
          )
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
        await trx
          .insertInto('transitions')
          .values(batch.map(transitionToRow))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      for (const batch of chunks(evidence)) {
        await trx
          .insertInto('evidence')
          .values(batch.map(evidenceToRow))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      for (const batch of chunks(observations)) {
        await trx
          .insertInto('observations')
          .values(batch.map(observationToRow))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
  }

  async ingestRun(ingestion: RunIngestion): Promise<void> {
    const { run, captures, navigations, created } = ingestion;
    const evidence: readonly RuntimeEvidence[] = [
      ...captures.map((capture) => capture.evidence),
      ...navigations.map((navigation) => navigation.evidence),
    ];
    for (const item of evidence) {
      if (item.runId !== run.id || item.buildId !== run.buildId) {
        throw new Error(`Evidence ${item.id} does not belong to run ${run.id} of build ${run.buildId}`);
      }
    }
    const captureRows = captures.map((capture) => captureToRow(run, capture.evidence));
    const observationRows = runtimeObservationRows(ingestion);

    await this.db.transaction().execute(async (trx) => {
      const build = await trx.selectFrom('builds').select('id').where('id', '=', run.buildId).executeTakeFirst();
      if (build === undefined) throw new Error(`Run ${run.id}: build ${run.buildId} must be ingested first`);

      await trx
        .insertInto('runs')
        .values(runToRow(run))
        .onConflict((oc) => oc.doNothing())
        .execute();
      for (const batch of chunks(evidence)) {
        await trx
          .insertInto('evidence')
          .values(batch.map(evidenceToRow))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      for (const batch of chunks(captureRows)) {
        await trx
          .insertInto('captures')
          .values(batch)
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      for (const batch of chunks(navigations)) {
        await trx
          .insertInto('navigations')
          .values(batch.map((navigation) => navigationToRow(navigation.evidence)))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      for (const batch of chunks(created)) {
        await trx
          .insertInto('transitions')
          .values(batch.map(transitionToRow))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }

      // Only the current match of a run is kept (PRD 9.2), so a re-ingest replaces its observations.
      await trx
        .deleteFrom('observations')
        .where((eb) =>
          eb.or([
            eb('evidence_id', 'in', eb.selectFrom('captures').select('evidence_id').where('run_id', '=', run.id)),
            eb('evidence_id', 'in', eb.selectFrom('navigations').select('evidence_id').where('run_id', '=', run.id)),
          ]),
        )
        .execute();
      for (const batch of chunks(observationRows)) {
        await trx.insertInto('observations').values(batch).execute();
      }
    });
  }

  async loadBuildGraph({ buildId }: { buildId: BuildId }): Promise<BuildGraph | null> {
    return this.db.transaction().execute(async (trx) => {
      const buildRow = await trx
        .selectFrom('builds')
        .selectAll()
        .where('id', '=', buildId)
        .executeTakeFirst();
      if (buildRow === undefined) return null;

      const runRows = await trx
        .selectFrom('runs')
        .selectAll()
        .where('build_id', '=', buildId)
        .orderBy('started_at')
        .orderBy('id')
        .execute();
      const runs = runRows.map(parseRun);
      const runById = new Map(runs.map((run) => [run.id as string, run]));
      const runOf = (id: string) => {
        const run = runById.get(id);
        if (run === undefined) throw new Error(`Run ${id} is not a run of build ${buildId}`);
        return run;
      };

      const captureRows = await trx
        .selectFrom('captures')
        .innerJoin('runs', 'runs.id', 'captures.run_id')
        .selectAll('captures')
        .where('runs.build_id', '=', buildId)
        .orderBy('captures.evidence_id')
        .execute();
      const captures = new Map(captureRows.map((row) => [row.evidence_id, parseCapture(runOf(row.run_id), row)]));
      const navigationRows = await trx
        .selectFrom('navigations')
        .innerJoin('runs', 'runs.id', 'navigations.run_id')
        .selectAll('navigations')
        .where('runs.build_id', '=', buildId)
        .orderBy('navigations.evidence_id')
        .execute();
      const navigations = new Map(
        navigationRows.map((row) => [row.evidence_id, parseNavigation(runOf(row.run_id), row, captures)]),
      );

      const observationRows = await trx
        .selectFrom('observations')
        .innerJoin('evidence', 'evidence.id', 'observations.evidence_id')
        .selectAll('evidence')
        .select([
          'observations.subject_kind',
          'observations.subject_id',
          'observations.verdict',
          'observations.match',
        ])
        .where('evidence.build_id', '=', buildId)
        .orderBy('evidence.id')
        .execute();

      const groups: ObservationGroups = { screens: new Map(), transitions: new Map() };
      for (const row of observationRows) groupObservation(row, { captures, navigations }, groups);

      const screenRows = await trx
        .selectFrom('screens')
        .selectAll()
        .where('id', 'in', supportedSubjectIds(trx, buildId, 'screen'))
        .orderBy('id')
        .execute();
      const stateRows = await trx
        .selectFrom('ui_states')
        .selectAll()
        .where('screen_id', 'in', supportedSubjectIds(trx, buildId, 'screen'))
        .orderBy('id')
        .execute();
      const transitionRows = await trx
        .selectFrom('transitions')
        .selectAll()
        .where('id', 'in', supportedSubjectIds(trx, buildId, 'transition'))
        .orderBy('id')
        .execute();

      const statesByScreen = new Map<string, [UIState, ...UIState[]]>();
      for (const row of stateRows) appendTo(statesByScreen, row.screen_id, parseState(row));

      const screens = screenRows.map((row): LoadedScreen => {
        const screen = parseScreen(row);
        const states = statesByScreen.get(screen.id);
        if (states === undefined) throw new Error(`Screen ${screen.id} has no states`);
        const observations = observationsFor(groups.screens, { kind: 'screen', id: screen.id });
        return { screen, states, observations, status: deriveEvidenceStatus(observations) };
      });

      const loadedTransitions = transitionRows.map((row): LoadedTransition => {
        const transition = parseTransition(row);
        const observations = observationsFor(groups.transitions, { kind: 'transition', id: transition.id });
        return { transition, observations, status: deriveEvidenceStatus(observations) };
      });

      return { build: parseBuild(buildRow), runs, screens, transitions: loadedTransitions };
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
