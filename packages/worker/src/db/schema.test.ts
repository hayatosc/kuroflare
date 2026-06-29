import assert from 'node:assert/strict'

import { test } from 'vitest'

import { decideSchemaMigration } from '../db/migrations'
import {
  collectSqlObjectNames,
  INITIAL_SCHEMA_INDEXES,
  INITIAL_SCHEMA_OBJECTS,
  INITIAL_SCHEMA_TABLES,
  migrationStatements,
  SCHEMA_MIGRATIONS,
} from '../db/schema'

test('initial schema declares all required tables and indexes', () => {
  assert.deepEqual(collectSqlObjectNames(INITIAL_SCHEMA_OBJECTS, 'table'), INITIAL_SCHEMA_TABLES)
  assert.deepEqual(collectSqlObjectNames(INITIAL_SCHEMA_OBJECTS, 'index'), INITIAL_SCHEMA_INDEXES)
})

test('initial schema DDL statements are wired into bundled migrations', () => {
  assert.equal(SCHEMA_MIGRATIONS.length, 1)

  const [initialMigration] = SCHEMA_MIGRATIONS
  assert.ok(initialMigration)
  assert.equal(initialMigration.version, 1)
  assert.equal(initialMigration.name, 'initial-schema')
  assert.deepEqual(
    migrationStatements(initialMigration),
    INITIAL_SCHEMA_OBJECTS.map((object) => object.sql),
  )
})

test('bundled schema migrations are accepted by the migration decision', () => {
  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set(),
      availableMigrations: SCHEMA_MIGRATIONS,
      failedMigration: undefined,
    }),
    {
      action: 'apply-migrations',
      fromVersion: 0,
      toVersion: 1,
      migrations: SCHEMA_MIGRATIONS,
    },
  )

  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set([1]),
      availableMigrations: SCHEMA_MIGRATIONS,
      failedMigration: undefined,
    }),
    { action: 'ready', currentVersion: 1 },
  )
})

test('initial schema DDL includes conflict and recovery-critical constraints', () => {
  const opLogSql = findSql('op_log')
  assert.match(opLogSql, /primary key \(doc_id, seq\)/)
  assert.match(opLogSql, /unique \(doc_id, message_id\)/)

  const devicesSql = findSql('devices')
  assert.match(devicesSql, /device_id text primary key/)
  assert.match(devicesSql, /y_client_id integer not null unique/)
  assert.match(devicesSql, /token_version integer not null default 1/)

  const setupTokensSql = findSql('setup_tokens')
  assert.match(setupTokensSql, /token_hash text primary key/)
  assert.match(setupTokensSql, /consumed_at integer/)

  const refreshTokensSql = findSql('device_refresh_tokens')
  assert.match(refreshTokensSql, /token_hash text primary key/)
  assert.match(refreshTokensSql, /device_id text not null references devices\(device_id\)/)
  assert.match(refreshTokensSql, /expires_at integer not null/)
  assert.match(refreshTokensSql, /revoked_at integer/)

  const checkpointRunsSql = findSql('checkpoint_runs')
  assert.match(checkpointRunsSql, /status text not null/)
  assert.match(checkpointRunsSql, /pointer_updated_at integer/)
})

function findSql(name: string): string {
  const definition = INITIAL_SCHEMA_OBJECTS.find((object) => object.name === name)
  assert.ok(definition)
  return definition.sql
}
