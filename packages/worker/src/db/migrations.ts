import type { Kysely } from 'kysely'

import type { Database } from './types'

/** Durable Object schema migration known to the Worker bundle. */
export interface SchemaMigration {
  readonly version: number
  readonly name: string
  readonly migrate: (db: Kysely<Database>) => Promise<void>
}

/** Previously failed schema migration evidence persisted by the caller. */
export interface FailedSchemaMigration {
  readonly version: number
  readonly failedAt: number
  readonly reason: string
}

/** Input for deciding how to bring a Durable Object schema up to date. */
export interface SchemaMigrationDecisionInput {
  readonly appliedVersions: ReadonlySet<number>
  readonly availableMigrations: readonly SchemaMigration[]
  readonly failedMigration: FailedSchemaMigration | undefined
}

/** Schema migration decision before the caller runs SQL. */
export type SchemaMigrationDecision =
  | { readonly action: 'ready'; readonly currentVersion: number }
  | {
      readonly action: 'apply-migrations'
      readonly fromVersion: number
      readonly toVersion: number
      readonly migrations: readonly SchemaMigration[]
    }
  | {
      readonly action: 'degraded'
      readonly reason:
        | 'migration-failed'
        | 'invalid-migration-plan'
        | 'unknown-applied-migration'
        | 'non-contiguous-applied-migrations'
      readonly failedMigration?: FailedSchemaMigration
    }

/**
 * Decides which schema migrations should run before sync traffic is accepted.
 *
 * @param input Applied schema versions, bundled migration list, and any persisted failure.
 * @returns A migration plan or degraded state. SQL execution happens outside this decision.
 */
export function decideSchemaMigration(
  input: SchemaMigrationDecisionInput,
): SchemaMigrationDecision {
  if (input.failedMigration !== undefined) {
    return {
      action: 'degraded',
      reason: 'migration-failed',
      failedMigration: input.failedMigration,
    }
  }

  if (!isValidMigrationPlan(input.availableMigrations)) {
    return { action: 'degraded', reason: 'invalid-migration-plan' }
  }

  const availableVersions = new Set(input.availableMigrations.map((migration) => migration.version))
  for (const appliedVersion of input.appliedVersions) {
    if (!availableVersions.has(appliedVersion)) {
      return { action: 'degraded', reason: 'unknown-applied-migration' }
    }
  }

  const currentVersion = input.appliedVersions.size
  for (let version = 1; version <= currentVersion; version += 1) {
    if (!input.appliedVersions.has(version)) {
      return { action: 'degraded', reason: 'non-contiguous-applied-migrations' }
    }
  }

  const pendingMigrations = input.availableMigrations.slice(currentVersion)
  if (pendingMigrations.length === 0) {
    return { action: 'ready', currentVersion }
  }

  return {
    action: 'apply-migrations',
    fromVersion: currentVersion,
    toVersion: currentVersion + pendingMigrations.length,
    migrations: pendingMigrations,
  }
}

/**
 * Returns true when the schema is ready for normal sync traffic.
 *
 * @param decision Migration decision from `decideSchemaMigration`.
 * @returns Whether HTTP/WS sync handlers may accept operations.
 */
export function schemaAcceptsSync(decision: SchemaMigrationDecision): boolean {
  return decision.action === 'ready'
}

function isValidMigrationPlan(migrations: readonly SchemaMigration[]): boolean {
  if (migrations.length === 0) {
    return true
  }

  const names = new Set<string>()
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1 ||
      migration.name.length < 1 ||
      migration.name.length > 128 ||
      names.has(migration.name)
    ) {
      return false
    }
    names.add(migration.name)
  }

  return true
}
