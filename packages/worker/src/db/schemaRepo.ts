import { type Kysely } from 'kysely'
import type { Database } from './types'
import type { DurableObjectSqlStorageBinding } from '../runtime'

export async function createSchemaMigrationsTable(
  db: Kysely<Database>,
): Promise<void> {
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('version', 'integer', (col) => col.primaryKey())
    .addColumn('applied_at', 'integer', (col) => col.notNull())
    .execute()
}

export async function getAppliedMigrations(
  db: Kysely<Database>,
): Promise<readonly { readonly version: number }[]> {
  return db
    .selectFrom('schema_migrations')
    .select(['version'])
    .execute()
}

export async function insertMigration(
  db: Kysely<Database>,
  version: number,
  appliedAt: number,
): Promise<void> {
  await db
    .insertInto('schema_migrations')
    .values({ version, applied_at: appliedAt })
    .execute()
}

export function applyMigrationStatements(
  sql: DurableObjectSqlStorageBinding,
  statements: readonly string[],
): void {
  for (const statement of statements) {
    sql.exec(statement)
  }
}
