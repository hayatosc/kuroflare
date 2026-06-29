import assert from 'node:assert/strict'

import { test } from 'vitest'

import { decideSchemaMigration, schemaAcceptsSync, type SchemaMigration } from '../db/migrations'

const migrations: readonly SchemaMigration[] = [
  { version: 1, name: 'init', statements: ['create table one (id integer primary key)'] },
  { version: 2, name: 'add-devices', statements: ['create table two (id integer primary key)'] },
  {
    version: 3,
    name: 'add-checkpoints',
    statements: ['create table three (id integer primary key)'],
  },
]

test('schema migration is ready when all bundled migrations are applied', () => {
  const decision = decideSchemaMigration({
    appliedVersions: new Set([1, 2, 3]),
    availableMigrations: migrations,
    failedMigration: undefined,
  })

  assert.deepEqual(decision, { action: 'ready', currentVersion: 3 })
  assert.equal(schemaAcceptsSync(decision), true)
})

test('schema migration plans pending suffix migrations', () => {
  const decision = decideSchemaMigration({
    appliedVersions: new Set([1]),
    availableMigrations: migrations,
    failedMigration: undefined,
  })

  assert.deepEqual(decision, {
    action: 'apply-migrations',
    fromVersion: 1,
    toVersion: 3,
    migrations: migrations.slice(1),
  })
  assert.equal(schemaAcceptsSync(decision), false)
})

test('schema migration starts from empty databases', () => {
  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set(),
      availableMigrations: migrations,
      failedMigration: undefined,
    }),
    {
      action: 'apply-migrations',
      fromVersion: 0,
      toVersion: 3,
      migrations,
    },
  )
})

test('schema migration degrades after a persisted failure', () => {
  const failedMigration = { version: 2, failedAt: 100, reason: 'syntax error' }
  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set([1]),
      availableMigrations: migrations,
      failedMigration,
    }),
    { action: 'degraded', reason: 'migration-failed', failedMigration },
  )
})

test('schema migration rejects invalid migration plans', () => {
  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set(),
      availableMigrations: [
        {
          version: 2,
          name: 'skip-init',
          statements: ['create table two (id integer primary key)'],
        },
      ],
      failedMigration: undefined,
    }),
    { action: 'degraded', reason: 'invalid-migration-plan' },
  )

  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set(),
      availableMigrations: [
        { version: 1, name: 'init', statements: ['create table one (id integer primary key)'] },
        { version: 2, name: 'init', statements: ['create table two (id integer primary key)'] },
      ],
      failedMigration: undefined,
    }),
    { action: 'degraded', reason: 'invalid-migration-plan' },
  )

  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set(),
      availableMigrations: [{ version: 1, name: 'init', statements: [] }],
      failedMigration: undefined,
    }),
    { action: 'degraded', reason: 'invalid-migration-plan' },
  )
})

test('schema migration rejects unknown or non-contiguous applied versions', () => {
  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set([1, 4]),
      availableMigrations: migrations,
      failedMigration: undefined,
    }),
    { action: 'degraded', reason: 'unknown-applied-migration' },
  )

  assert.deepEqual(
    decideSchemaMigration({
      appliedVersions: new Set([2]),
      availableMigrations: migrations,
      failedMigration: undefined,
    }),
    { action: 'degraded', reason: 'non-contiguous-applied-migrations' },
  )
})
