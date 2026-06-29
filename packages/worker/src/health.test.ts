import assert from 'node:assert/strict'

import { HealthResponseSchema } from '@kuroflare/core'
import * as v from 'valibot'
import { test } from 'vitest'

import {
  decideDurableObjectSyncAdmission,
  decideWorkerHealth,
  healthAcceptsCheckpoint,
  healthAcceptsSync,
} from './health'

test('worker health is ok when all subsystems and migrations are ready', () => {
  const health = decideWorkerHealth({
    durableObjectAvailable: true,
    sqliteAvailable: true,
    r2Available: true,
    migrationDecision: { action: 'ready', currentVersion: 3 },
    checkedAt: 100,
  })

  assert.equal(v.is(HealthResponseSchema, health), true)
  assert.equal(health.status, 'ok')
  assert.equal(healthAcceptsSync(health), true)
  assert.equal(healthAcceptsCheckpoint(health), true)
})

test('worker health is degraded while migrations are pending', () => {
  const health = decideWorkerHealth({
    durableObjectAvailable: true,
    sqliteAvailable: true,
    r2Available: true,
    migrationDecision: {
      action: 'apply-migrations',
      fromVersion: 1,
      toVersion: 2,
      migrations: [
        {
          version: 2,
          name: 'add-devices',
          statements: ['create table devices (device_id text primary key)'],
        },
      ],
    },
    checkedAt: 100,
  })

  assert.equal(v.is(HealthResponseSchema, health), true)
  assert.equal(health.status, 'degraded')
  assert.equal(healthAcceptsSync(health), false)
  assert.equal(healthAcceptsCheckpoint(health), false)
  assert.deepEqual(health.checks.at(-1), {
    name: 'migrations',
    status: 'degraded',
    detail: 'pending:1->2',
  })
})

test('worker health is degraded when storage dependencies fail', () => {
  const health = decideWorkerHealth({
    durableObjectAvailable: true,
    sqliteAvailable: false,
    r2Available: true,
    migrationDecision: { action: 'ready', currentVersion: 3 },
    checkedAt: 100,
  })

  assert.equal(v.is(HealthResponseSchema, health), true)
  assert.equal(health.status, 'degraded')
  assert.equal(healthAcceptsSync(health), false)
  assert.equal(healthAcceptsCheckpoint(health), false)
  assert.deepEqual(health.checks[2], { name: 'sqlite', status: 'degraded' })
})

test('worker health keeps sync open when only R2 is degraded', () => {
  const health = decideWorkerHealth({
    durableObjectAvailable: true,
    sqliteAvailable: true,
    r2Available: false,
    migrationDecision: { action: 'ready', currentVersion: 3 },
    checkedAt: 100,
  })

  assert.equal(v.is(HealthResponseSchema, health), true)
  assert.equal(health.status, 'degraded')
  assert.equal(healthAcceptsSync(health), true)
  assert.equal(healthAcceptsCheckpoint(health), false)
  assert.deepEqual(health.checks[3], { name: 'r2', status: 'degraded' })
})

test('worker health exposes migration failure as degraded', () => {
  const health = decideWorkerHealth({
    durableObjectAvailable: true,
    sqliteAvailable: true,
    r2Available: true,
    migrationDecision: { action: 'degraded', reason: 'migration-failed' },
    checkedAt: 100,
  })

  assert.equal(v.is(HealthResponseSchema, health), true)
  assert.equal(health.status, 'degraded')
  assert.equal(healthAcceptsSync(health), false)
  assert.equal(healthAcceptsCheckpoint(health), false)
  assert.deepEqual(health.checks.at(-1), {
    name: 'migrations',
    status: 'degraded',
    detail: 'migration-failed',
  })
})

test('durable object sync admission is local to sqlite and migrations', () => {
  assert.deepEqual(
    decideDurableObjectSyncAdmission({
      sqliteAvailable: true,
      migrationDecision: { action: 'ready', currentVersion: 3 },
    }),
    { action: 'accept' },
  )

  assert.deepEqual(
    decideDurableObjectSyncAdmission({
      sqliteAvailable: false,
      migrationDecision: { action: 'ready', currentVersion: 3 },
    }),
    { action: 'reject', reason: 'sqlite-unavailable' },
  )

  assert.deepEqual(
    decideDurableObjectSyncAdmission({
      sqliteAvailable: true,
      migrationDecision: {
        action: 'apply-migrations',
        fromVersion: 1,
        toVersion: 2,
        migrations: [
          {
            version: 2,
            name: 'add-devices',
            statements: ['create table devices (device_id text primary key)'],
          },
        ],
      },
    }),
    { action: 'reject', reason: 'schema-not-ready' },
  )
})
