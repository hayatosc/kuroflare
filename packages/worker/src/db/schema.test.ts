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
      toVersion: 4,
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
      toVersion: 4,
      migrations: SCHEMA_MIGRATIONS.slice(1),
    },
  )
})

test('initial schema migration has correct metadata', () => {
  assert.equal(SCHEMA_MIGRATIONS.length, 4)

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

  const snapshotHealthMigration = SCHEMA_MIGRATIONS[2]
  if (snapshotHealthMigration === undefined) throw new Error('missing snapshot health migration')
  assert.equal(snapshotHealthMigration.version, 3)
  assert.equal(snapshotHealthMigration.name, 'snapshot-health-evidence')
  assert.equal(typeof snapshotHealthMigration.migrate, 'function')

  const deviceIdentityMigration = SCHEMA_MIGRATIONS[3]
  if (deviceIdentityMigration === undefined) throw new Error('missing device identity migration')
  assert.equal(deviceIdentityMigration.version, 4)
  assert.equal(deviceIdentityMigration.name, 'device-audit-identity')
  assert.equal(typeof deviceIdentityMigration.migrate, 'function')
})
