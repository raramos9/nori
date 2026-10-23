import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('applications')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('root_path', 'text', (c) => c.notNull().unique())
      .addColumn('framework', 'text', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('builds')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('application_id', 'text', (c) => c.notNull().references('applications.id'))
      .addColumn('commit_sha', 'text', (c) => c.notNull())
      .addColumn('source_hash', 'text', (c) => c.notNull())
      .addColumn('branch', 'text')
      .addColumn('analyzer_version', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('screens')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('application_id', 'text', (c) => c.notNull().references('applications.id'))
      .addColumn('route_pattern', 'text', (c) => c.notNull())
      .addUniqueConstraint('screens_logical_identity', ['application_id', 'route_pattern'])
      .execute();

    await db.schema
      .createTable('ui_states')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('screen_id', 'text', (c) => c.notNull().references('screens.id'))
      .addColumn('key', 'text', (c) => c.notNull())
      .addUniqueConstraint('ui_states_logical_identity', ['screen_id', 'key'])
      .execute();

    await db.schema
      .createTable('transitions')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('source_state_id', 'text', (c) => c.notNull().references('ui_states.id'))
      .addColumn('trigger_kind', 'text', (c) => c.notNull())
      .addColumn('target_kind', 'text', (c) => c.notNull())
      .addColumn('target_state_id', 'text', (c) => c.references('ui_states.id'))
      .addColumn('unresolved_reason', 'text')
      .addColumn('unresolved_expression', 'text')
      .execute();

    await db.schema
      .createTable('evidence')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('build_id', 'text', (c) => c.notNull().references('builds.id'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('extractor', 'text')
      .addColumn('span_file', 'text')
      .addColumn('span_start_line', 'integer')
      .addColumn('span_start_column', 'integer')
      .addColumn('span_end_line', 'integer')
      .addColumn('span_end_column', 'integer')
      .execute();

    // subject_id points at screens or transitions depending on subject_kind, so it has no foreign key.
    await db.schema
      .createTable('observations')
      .addColumn('evidence_id', 'text', (c) => c.notNull().references('evidence.id'))
      .addColumn('subject_kind', 'text', (c) => c.notNull())
      .addColumn('subject_id', 'text', (c) => c.notNull())
      .addColumn('verdict', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('observations_pk', ['evidence_id', 'subject_kind', 'subject_id'])
      .execute();

    await db.schema.createIndex('builds_application_idx').on('builds').column('application_id').execute();
    await db.schema.createIndex('ui_states_screen_idx').on('ui_states').column('screen_id').execute();
    await db.schema
      .createIndex('transitions_source_idx')
      .on('transitions')
      .column('source_state_id')
      .execute();
    await db.schema.createIndex('evidence_build_idx').on('evidence').column('build_id').execute();
    await db.schema
      .createIndex('observations_subject_idx')
      .on('observations')
      .columns(['subject_kind', 'subject_id'])
      .execute();
  },
};

// JSON columns are text the store parses itself; no JSON functions, so the DDL stays portable.
const runtimeEvidence: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('runs')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('application_id', 'text', (c) => c.notNull().references('applications.id'))
      .addColumn('build_id', 'text', (c) => c.notNull().references('builds.id'))
      .addColumn('origin', 'text', (c) => c.notNull())
      .addColumn('session_kind', 'text', (c) => c.notNull())
      .addColumn('session_label', 'text', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .addColumn('finished_at', 'text', (c) => c.notNull())
      .addColumn('stop', 'text', (c) => c.notNull())
      .addColumn('crawler_version', 'text', (c) => c.notNull())
      .addColumn('reconciler_version', 'text', (c) => c.notNull())
      .addColumn('requests_allowed', 'integer', (c) => c.notNull())
      .addColumn('requests_blocked', 'integer', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('runs_build_idx').on('runs').column('build_id').execute();

    await db.schema
      .createTable('captures')
      .addColumn('evidence_id', 'text', (c) => c.primaryKey().references('evidence.id'))
      .addColumn('run_id', 'text', (c) => c.notNull().references('runs.id'))
      .addColumn('url', 'text', (c) => c.notNull())
      .addColumn('http_status', 'integer', (c) => c.notNull())
      .addColumn('screenshot_path', 'text', (c) => c.notNull())
      .addColumn('dom_path', 'text', (c) => c.notNull())
      .addUniqueConstraint('captures_run_url', ['run_id', 'url'])
      .execute();

    await db.schema
      .createTable('navigations')
      .addColumn('evidence_id', 'text', (c) => c.primaryKey().references('evidence.id'))
      .addColumn('run_id', 'text', (c) => c.notNull().references('runs.id'))
      .addColumn('start_kind', 'text', (c) => c.notNull())
      .addColumn('from_capture_id', 'text', (c) => c.references('captures.evidence_id'))
      .addColumn('action_kind', 'text')
      .addColumn('action', 'text')
      .addColumn('requested_url', 'text', (c) => c.notNull())
      .addColumn('redirects', 'text', (c) => c.notNull())
      .addColumn('landing_capture_id', 'text', (c) => c.notNull().references('captures.evidence_id'))
      .addColumn('log_seq', 'integer', (c) => c.notNull())
      .addCheckConstraint(
        'navigations_start',
        sql`(start_kind = 'entry' and from_capture_id is null and action_kind is null and action is null)
          or (start_kind = 'action' and from_capture_id is not null and action_kind is not null and action is not null)`,
      )
      .execute();

    await db.schema.alterTable('observations').addColumn('match', 'text').execute();
  },
};

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001_initial': initial,
  '002_runtime_evidence': runtimeEvidence,
};

const provider: MigrationProvider = {
  async getMigrations() {
    return { ...MIGRATIONS };
  },
};

export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<void> {
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  const failed = results?.find((result) => result.status === 'Error');
  if (error !== undefined || failed !== undefined) {
    throw new Error(`Migration failed${failed ? ` at ${failed.migrationName}` : ''}`, { cause: error });
  }
}
