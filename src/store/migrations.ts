import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const cascade = <B extends { onDelete(action: 'cascade'): B }>(fk: B): B => fk.onDelete('cascade');

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('applications')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('repo_identity', 'text', (c) => c.notNull())
      .addColumn('subpath', 'text', (c) => c.notNull())
      .addColumn('framework', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('applications_pk', ['id'])
      .execute();

    await db.schema
      .createTable('snapshots')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('application_id', 'text', (c) => c.notNull())
      .addColumn('commit_sha', 'text', (c) => c.notNull())
      .addColumn('source_hash', 'text', (c) => c.notNull())
      .addColumn('worktree', 'text', (c) => c.notNull())
      .addColumn('branch', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('snapshots_pk', ['id'])
      .addUniqueConstraint('snapshots_source', ['application_id', 'commit_sha', 'source_hash'])
      .addForeignKeyConstraint('snapshots_application_fk', ['application_id'], 'applications', ['id'], cascade)
      .addCheckConstraint('snapshots_worktree', sql`worktree in ('clean', 'dirty')`)
      .execute();

    await db.schema
      .createTable('analyses')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('analyzer_version', 'text', (c) => c.notNull())
      .addColumn('inputs_hash', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('analyses_pk', ['id'])
      .addUniqueConstraint('analyses_snapshot_key', ['snapshot_id', 'id'])
      .addUniqueConstraint('analyses_inputs', ['snapshot_id', 'analyzer_version', 'inputs_hash'])
      .addForeignKeyConstraint('analyses_snapshot_fk', ['snapshot_id'], 'snapshots', ['id'], cascade)
      .execute();

    await db.schema
      .createTable('screens')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('application_id', 'text', (c) => c.notNull())
      .addColumn('route_pattern', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('screens_pk', ['id'])
      .addUniqueConstraint('screens_logical_identity', ['application_id', 'route_pattern'])
      .addForeignKeyConstraint('screens_application_fk', ['application_id'], 'applications', ['id'], cascade)
      .execute();

    await db.schema
      .createTable('ui_states')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('screen_id', 'text', (c) => c.notNull())
      .addColumn('key', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('ui_states_pk', ['id'])
      .addUniqueConstraint('ui_states_logical_identity', ['screen_id', 'key'])
      .addForeignKeyConstraint('ui_states_screen_fk', ['screen_id'], 'screens', ['id'], cascade)
      .execute();

    await db.schema
      .createTable('transitions')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('source_state_id', 'text', (c) => c.notNull())
      .addColumn('trigger_kind', 'text', (c) => c.notNull())
      .addColumn('target_kind', 'text', (c) => c.notNull())
      .addColumn('target_state_id', 'text')
      .addColumn('unresolved_reason', 'text')
      .addColumn('unresolved_expression', 'text')
      .addPrimaryKeyConstraint('transitions_pk', ['id'])
      .addForeignKeyConstraint('transitions_source_fk', ['source_state_id'], 'ui_states', ['id'], cascade)
      .addForeignKeyConstraint('transitions_target_fk', ['target_state_id'], 'ui_states', ['id'], cascade)
      .addCheckConstraint(
        'transitions_target',
        sql`(target_kind = 'resolved' and target_state_id is not null and unresolved_reason is null and unresolved_expression is null)
          or (target_kind = 'unresolved' and target_state_id is null and unresolved_reason is not null and unresolved_expression is not null)`,
      )
      .execute();

    await db.schema
      .createTable('static_evidence')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('extractor', 'text', (c) => c.notNull())
      .addColumn('span_file', 'text', (c) => c.notNull())
      .addColumn('span_start_line', 'integer', (c) => c.notNull())
      .addColumn('span_start_column', 'integer', (c) => c.notNull())
      .addColumn('span_end_line', 'integer', (c) => c.notNull())
      .addColumn('span_end_column', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('static_evidence_pk', ['id'])
      .addUniqueConstraint('static_evidence_analysis_key', ['analysis_id', 'id'])
      .addForeignKeyConstraint('static_evidence_analysis_fk', ['analysis_id'], 'analyses', ['id'], cascade)
      .execute();

    // subject_id points at screens or transitions depending on subject_kind, so it has no foreign key.
    await db.schema
      .createTable('static_observations')
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('evidence_id', 'text', (c) => c.notNull())
      .addColumn('subject_kind', 'text', (c) => c.notNull())
      .addColumn('subject_id', 'text', (c) => c.notNull())
      .addColumn('verdict', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('static_observations_pk', ['evidence_id', 'subject_kind', 'subject_id'])
      .addForeignKeyConstraint(
        'static_observations_evidence_fk',
        ['analysis_id', 'evidence_id'],
        'static_evidence',
        ['analysis_id', 'id'],
        cascade,
      )
      .addCheckConstraint('static_observations_subject', sql`subject_kind in ('screen', 'transition')`)
      .addCheckConstraint('static_observations_verdict', sql`verdict in ('supports', 'contradicts')`)
      .execute();

    await db.schema
      .createTable('runs')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('origin', 'text', (c) => c.notNull())
      .addColumn('session_kind', 'text', (c) => c.notNull())
      .addColumn('session_label', 'text', (c) => c.notNull())
      .addColumn('environment', 'text', (c) => c.notNull())
      .addColumn('seeded_by', 'text', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .addColumn('finished_at', 'text', (c) => c.notNull())
      .addColumn('stop', 'text', (c) => c.notNull())
      .addColumn('crawler_version', 'text', (c) => c.notNull())
      .addColumn('requests_allowed', 'integer', (c) => c.notNull())
      .addColumn('requests_blocked', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('runs_pk', ['id'])
      .addUniqueConstraint('runs_snapshot_key', ['snapshot_id', 'id'])
      .addForeignKeyConstraint('runs_snapshot_fk', ['snapshot_id'], 'snapshots', ['id'], cascade)
      .addCheckConstraint('runs_environment', sql`environment in ('local', 'ci')`)
      .execute();

    await db.schema
      .createTable('captures')
      .addColumn('evidence_id', 'text', (c) => c.notNull())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('url', 'text', (c) => c.notNull())
      .addColumn('http_status', 'integer', (c) => c.notNull())
      .addColumn('screenshot_path', 'text', (c) => c.notNull())
      .addColumn('dom_path', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('captures_pk', ['evidence_id'])
      .addUniqueConstraint('captures_run_url', ['run_id', 'url'])
      .addUniqueConstraint('captures_run_key', ['run_id', 'evidence_id'])
      .addForeignKeyConstraint('captures_run_fk', ['run_id'], 'runs', ['id'], cascade)
      .execute();

    await db.schema
      .createTable('navigations')
      .addColumn('evidence_id', 'text', (c) => c.notNull())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('start_kind', 'text', (c) => c.notNull())
      .addColumn('from_capture_id', 'text')
      .addColumn('action_kind', 'text')
      .addColumn('action', 'text')
      .addColumn('requested_url', 'text', (c) => c.notNull())
      .addColumn('redirects', 'text', (c) => c.notNull())
      .addColumn('landing_capture_id', 'text', (c) => c.notNull())
      .addColumn('log_seq', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('navigations_pk', ['evidence_id'])
      .addUniqueConstraint('navigations_run_key', ['run_id', 'evidence_id'])
      .addForeignKeyConstraint('navigations_run_fk', ['run_id'], 'runs', ['id'], cascade)
      .addForeignKeyConstraint(
        'navigations_from_fk',
        ['run_id', 'from_capture_id'],
        'captures',
        ['run_id', 'evidence_id'],
        cascade,
      )
      .addForeignKeyConstraint(
        'navigations_landing_fk',
        ['run_id', 'landing_capture_id'],
        'captures',
        ['run_id', 'evidence_id'],
        cascade,
      )
      .addCheckConstraint(
        'navigations_start',
        sql`(start_kind = 'entry' and from_capture_id is null and action_kind is null and action is null)
          or (start_kind = 'action' and from_capture_id is not null and action_kind is not null and action is not null)`,
      )
      .execute();

    await db.schema
      .createTable('matches')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('matches_pk', ['run_id', 'analysis_id'])
      .addUniqueConstraint('matches_snapshot_key', ['snapshot_id', 'run_id', 'analysis_id'])
      .addForeignKeyConstraint('matches_run_fk', ['snapshot_id', 'run_id'], 'runs', ['snapshot_id', 'id'], cascade)
      .addForeignKeyConstraint(
        'matches_analysis_fk',
        ['snapshot_id', 'analysis_id'],
        'analyses',
        ['snapshot_id', 'id'],
        cascade,
      )
      .execute();

    await db.schema
      .createTable('screen_matches')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('capture_id', 'text', (c) => c.notNull())
      .addColumn('screen_id', 'text', (c) => c.notNull())
      .addColumn('verdict', 'text', (c) => c.notNull())
      .addColumn('match', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('screen_matches_pk', ['analysis_id', 'capture_id'])
      .addForeignKeyConstraint(
        'screen_matches_match_fk',
        ['snapshot_id', 'run_id', 'analysis_id'],
        'matches',
        ['snapshot_id', 'run_id', 'analysis_id'],
        cascade,
      )
      .addForeignKeyConstraint(
        'screen_matches_capture_fk',
        ['run_id', 'capture_id'],
        'captures',
        ['run_id', 'evidence_id'],
        cascade,
      )
      .addForeignKeyConstraint('screen_matches_screen_fk', ['screen_id'], 'screens', ['id'], cascade)
      .addCheckConstraint('screen_matches_verdict', sql`verdict in ('supports', 'contradicts')`)
      .execute();

    await db.schema
      .createTable('transition_matches')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('navigation_id', 'text', (c) => c.notNull())
      .addColumn('transition_id', 'text', (c) => c.notNull())
      .addColumn('verdict', 'text', (c) => c.notNull())
      .addColumn('match', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('transition_matches_pk', ['analysis_id', 'navigation_id', 'transition_id'])
      .addForeignKeyConstraint(
        'transition_matches_match_fk',
        ['snapshot_id', 'run_id', 'analysis_id'],
        'matches',
        ['snapshot_id', 'run_id', 'analysis_id'],
        cascade,
      )
      .addForeignKeyConstraint(
        'transition_matches_navigation_fk',
        ['run_id', 'navigation_id'],
        'navigations',
        ['run_id', 'evidence_id'],
        cascade,
      )
      .addForeignKeyConstraint('transition_matches_transition_fk', ['transition_id'], 'transitions', ['id'], cascade)
      .addCheckConstraint('transition_matches_verdict', sql`verdict = 'supports'`)
      .execute();

    await db.schema
      .createTable('match_failures')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('sealed_run_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('error', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('match_failures_pk', ['sealed_run_id', 'analysis_id'])
      .addForeignKeyConstraint(
        'match_failures_analysis_fk',
        ['snapshot_id', 'analysis_id'],
        'analyses',
        ['snapshot_id', 'id'],
        cascade,
      )
      .execute();

    await db.schema.createIndex('snapshots_application_idx').on('snapshots').column('application_id').execute();
    await db.schema.createIndex('ui_states_screen_idx').on('ui_states').column('screen_id').execute();
    await db.schema.createIndex('transitions_source_idx').on('transitions').column('source_state_id').execute();
    await db.schema.createIndex('transitions_target_idx').on('transitions').column('target_state_id').execute();
    await db.schema
      .createIndex('static_observations_analysis_idx')
      .on('static_observations')
      .columns(['analysis_id', 'subject_kind', 'verdict'])
      .execute();
    await db.schema.createIndex('navigations_from_idx').on('navigations').columns(['run_id', 'from_capture_id']).execute();
    await db.schema
      .createIndex('navigations_landing_idx')
      .on('navigations')
      .columns(['run_id', 'landing_capture_id'])
      .execute();
    await db.schema.createIndex('matches_analysis_idx').on('matches').column('analysis_id').execute();
    await db.schema.createIndex('screen_matches_capture_idx').on('screen_matches').columns(['run_id', 'capture_id']).execute();
    await db.schema
      .createIndex('transition_matches_navigation_idx')
      .on('transition_matches')
      .columns(['run_id', 'navigation_id'])
      .execute();
  },
};

const testImports: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('test_imports')
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('environment', 'text', (c) => c.notNull())
      .addColumn('report_original', 'text', (c) => c.notNull())
      .addColumn('report_sealed', 'text', (c) => c.notNull())
      .addColumn('report_sha256', 'text', (c) => c.notNull())
      .addColumn('playwright_version', 'text', (c) => c.notNull())
      .addColumn('report_started_at', 'text', (c) => c.notNull())
      .addColumn('imported_at', 'text', (c) => c.notNull())
      .addColumn('cases', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('test_imports_pk', ['id'])
      .addUniqueConstraint('test_imports_snapshot_key', ['snapshot_id', 'id'])
      .addForeignKeyConstraint('test_imports_snapshot_fk', ['snapshot_id'], 'snapshots', ['id'], cascade)
      .addCheckConstraint('test_imports_environment', sql`environment in ('local', 'ci')`)
      .execute();

    await db.schema
      .createTable('test_matches')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('import_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('test_matches_pk', ['import_id', 'analysis_id'])
      .addUniqueConstraint('test_matches_snapshot_key', ['snapshot_id', 'import_id', 'analysis_id'])
      .addForeignKeyConstraint(
        'test_matches_import_fk',
        ['snapshot_id', 'import_id'],
        'test_imports',
        ['snapshot_id', 'id'],
        cascade,
      )
      .addForeignKeyConstraint(
        'test_matches_analysis_fk',
        ['snapshot_id', 'analysis_id'],
        'analyses',
        ['snapshot_id', 'id'],
        cascade,
      )
      .execute();

    // transition_id has no foreign key: a walked-runtime-only step names a transition only a crawl creates.
    await db.schema
      .createTable('test_step_matches')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('import_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('case_key', 'text', (c) => c.notNull())
      .addColumn('retry', 'integer', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('transition_id', 'text')
      .addColumn('match', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('test_step_matches_pk', ['analysis_id', 'import_id', 'case_key', 'retry', 'seq'])
      .addForeignKeyConstraint(
        'test_step_matches_match_fk',
        ['snapshot_id', 'import_id', 'analysis_id'],
        'test_matches',
        ['snapshot_id', 'import_id', 'analysis_id'],
        cascade,
      )
      .addCheckConstraint(
        'test_step_matches_kind',
        sql`kind in ('entry', 'walked', 'walked-runtime-only', 'ambiguous', 'no-transition', 'not-a-screen', 'off-origin', 'unattributed')`,
      )
      .addCheckConstraint(
        'test_step_matches_transition',
        sql`(kind in ('walked', 'walked-runtime-only')) = (transition_id is not null)`,
      )
      .execute();

    await db.schema
      .createTable('test_match_failures')
      .addColumn('snapshot_id', 'text', (c) => c.notNull())
      .addColumn('import_id', 'text', (c) => c.notNull())
      .addColumn('analysis_id', 'text', (c) => c.notNull())
      .addColumn('error', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('test_match_failures_pk', ['import_id', 'analysis_id'])
      .addForeignKeyConstraint(
        'test_match_failures_analysis_fk',
        ['snapshot_id', 'analysis_id'],
        'analyses',
        ['snapshot_id', 'id'],
        cascade,
      )
      .execute();

    await db.schema.createIndex('test_matches_analysis_idx').on('test_matches').column('analysis_id').execute();
    await db.schema
      .createIndex('test_step_matches_transition_idx')
      .on('test_step_matches')
      .columns(['analysis_id', 'transition_id'])
      .execute();
  },
};

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001_initial': initial,
  '002_test_imports': testImports,
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

export async function isCurrent<DB>(db: Kysely<DB>): Promise<boolean> {
  const migrations = await new Migrator({ db, provider }).getMigrations();
  return migrations.every((migration) => migration.executedAt !== undefined);
}
