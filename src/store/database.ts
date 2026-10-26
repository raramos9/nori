import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CompiledQuery,
  Kysely,
  SqliteDialect,
  SqliteDriver,
  sql,
  type DatabaseConnection,
  type Driver,
  type SqliteDialectConfig,
} from 'kysely';
import { errorCode, NoriError } from '../errors.js';
import { isCurrent, migrateToLatest } from './migrations.js';
import type { Database as Schema, GraphDb } from './schema.js';

const MEMORY = ':memory:';

// A deferred transaction that reads and then writes gets SQLITE_BUSY_SNAPSHOT under WAL, with no busy
// retry. Taking the write lock at BEGIN makes a second writer wait on busy_timeout instead.
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}

class WriteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config);
  }
}

const WAL_ATTEMPTS = 50;

// Switching the journal mode needs an exclusive lock and SQLite reports SQLITE_BUSY for it without
// calling the busy handler, so first opens from several processes retry here.
async function enableWal(sqlite: Database.Database): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (sqlite.pragma('journal_mode', { simple: true }) === 'wal') return;
      sqlite.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (errorCode(error) !== 'SQLITE_BUSY' || attempt === WAL_ATTEMPTS) throw error;
      await sleep(100);
    }
  }
}

// Kysely runs SQLite migrations without a transaction or lock, so two first opens would race and a crash
// mid-migration would leave tables with no migration row.
async function migrateUnderWriteLock(db: GraphDb): Promise<void> {
  await sql`begin immediate`.execute(db);
  try {
    await migrateToLatest(db);
  } catch (error) {
    await sql`rollback`.execute(db);
    throw error;
  }
  await sql`commit`.execute(db);
}

export async function openWriteDatabase({ path }: { path: string }): Promise<GraphDb> {
  if (path !== MEMORY) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  if (path !== MEMORY) await enableWal(sqlite);
  const db = new Kysely<Schema>({ dialect: new WriteDialect({ database: sqlite }) });
  try {
    await migrateUnderWriteLock(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return db;
}

export async function openReadDatabase({ path }: { path: string }): Promise<GraphDb> {
  if (!existsSync(path)) throw new NoriError(`No nori store at ${path}. Run nori scan first.`);
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
  if (!(await isCurrent(db))) {
    await db.destroy();
    throw new NoriError(`The nori store at ${path} is older than this nori. Run nori scan first.`);
  }
  return db;
}
