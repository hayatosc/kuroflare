import assert from 'node:assert/strict'

import { test } from 'vitest'

import { decideSchemaMigration } from '../db/migrations'
import { SCHEMA_MIGRATIONS } from '../db/schema'

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

test('initial schema migration has correct metadata', () => {
  assert.equal(SCHEMA_MIGRATIONS.length, 1)

  const [initialMigration] = SCHEMA_MIGRATIONS
  assert.ok(initialMigration)
  assert.equal(initialMigration.version, 1)
  assert.equal(initialMigration.name, 'initial-schema')
  assert.equal(typeof initialMigration.migrate, 'function')
})
