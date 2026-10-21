import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, type Selectable } from 'kysely';
import { stateId } from '../graph/ids.js';
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
  type Evidence,
  type EvidenceObservation,
  type LoadedScreen,
  type LoadedTransition,
  type NonEmpty,
  type Observation,
  type ObservationSubject,
  type Screen,
  type StaticIngestion,
  type Transition,
  type TransitionTarget,
  type Trigger,
  type UIState,
  type Verdict,
} from '../graph/model.js';
import { migrateToLatest } from './migrations.js';
import type {
  ApplicationsTable,
  BuildsTable,
  Database as Schema,
  EvidenceTable,
  GraphDb,
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

function parseEvidence(row: Selectable<EvidenceTable>): Evidence {
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
    default: {
      const _exhaustive: never = evidence.kind;
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

function observationToRow(observation: Observation) {
  return {
    evidence_id: observation.evidenceId,
    subject_kind: observation.subject.kind,
    subject_id: observation.subject.id,
    verdict: observation.verdict,
  };
}

function buildToRow(build: Build): Selectable<BuildsTable> {
  return {
    id: build.id,
    application_id: build.applicationId,
    commit_sha: build.commitSha,
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

function subjectKey(subject: ObservationSubject): string {
  return `${subject.kind}:${subject.id}`;
}

function observationsFor(
  groups: ReadonlyMap<string, NonEmpty<EvidenceObservation>>,
  subject: ObservationSubject,
): NonEmpty<EvidenceObservation> {
  const found = groups.get(subjectKey(subject));
  if (found === undefined) {
    throw new Error(`${subjectKey(subject)} is supported in the build but has no observations loaded`);
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

  async loadBuildGraph({ buildId }: { buildId: BuildId }): Promise<BuildGraph | null> {
    return this.db.transaction().execute(async (trx) => {
      const buildRow = await trx
        .selectFrom('builds')
        .selectAll()
        .where('id', '=', buildId)
        .executeTakeFirst();
      if (buildRow === undefined) return null;

      const observationRows = await trx
        .selectFrom('observations')
        .innerJoin('evidence', 'evidence.id', 'observations.evidence_id')
        .selectAll('evidence')
        .select(['observations.subject_kind', 'observations.subject_id', 'observations.verdict'])
        .where('evidence.build_id', '=', buildId)
        .orderBy('evidence.id')
        .execute();

      const groups = new Map<string, [EvidenceObservation, ...EvidenceObservation[]]>();
      for (const row of observationRows) {
        appendTo(groups, subjectKey(parseSubject(row.subject_kind, row.subject_id)), {
          evidence: parseEvidence(row),
          verdict: parseVerdict(row.verdict),
        });
      }

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
        const observations = observationsFor(groups, { kind: 'screen', id: screen.id });
        return { screen, states, observations, status: deriveEvidenceStatus(observations) };
      });

      const loadedTransitions = transitionRows.map((row): LoadedTransition => {
        const transition = parseTransition(row);
        const observations = observationsFor(groups, { kind: 'transition', id: transition.id });
        return { transition, observations, status: deriveEvidenceStatus(observations) };
      });

      return { build: parseBuild(buildRow), screens, transitions: loadedTransitions };
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
