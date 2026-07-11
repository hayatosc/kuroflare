import { assert, test } from 'vitest'

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
      toVersion: 2,
      migrations: SCHEMA_MIGRATIONS,
    },
  )

  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set([1]),
      availableMigrations: SCHEMA_MIGRATIONS,
      failedMigration: undefined,
    }),
    {
      action: 'apply-migrations',
      fromVersion: 1,
      toVersion: 2,
      migrations: SCHEMA_MIGRATIONS.slice(1),
    },
  )
})

test('initial schema migration has correct metadata', () => {
  assert.equal(SCHEMA_MIGRATIONS.length, 2)

  const [initialMigration] = SCHEMA_MIGRATIONS
  assert.ok(initialMigration)
  assert.equal(initialMigration.version, 1)
  assert.equal(initialMigration.name, 'initial-schema')
  assert.equal(typeof initialMigration.migrate, 'function')

  const updateHashMigration = SCHEMA_MIGRATIONS[1]
  if (updateHashMigration === undefined) throw new Error('missing update hash migration')
  assert.equal(updateHashMigration.version, 2)
  assert.equal(updateHashMigration.name, 'message-dedup-update-hash')
  assert.equal(typeof updateHashMigration.migrate, 'function')
})
