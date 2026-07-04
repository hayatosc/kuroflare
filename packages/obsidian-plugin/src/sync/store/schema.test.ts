import { DEFAULT_LOCAL_STORE_OBJECT_STORES } from '@kuroflare/core'
import { makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
  planLocalStoreIndexedDbOpen,
  type LocalStoreIndexedDbOpenPlanInput,
} from '../store/schema'

const vaultId = makeVaultId('schema-vault-1')
const dbName = 'kuroflare:schema-vault-1'

const baseInput = {
  vaultId,
  dbExists: true,
  currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  pendingOutboxCount: 0,
} satisfies LocalStoreIndexedDbOpenPlanInput

test('local store indexeddb schema planner names databases by vault', () => {
  assert.equal(localStoreIndexedDbName(vaultId), dbName)
})

test('local store indexeddb schema planner creates a missing database', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbOpen({
      ...baseInput,
      dbExists: false,
      currentVersion: undefined,
      presentStores: [],
    }),
    {
      ok: true,
      startupGate: 'continue',
      dbName,
      decision: {
        action: 'create',
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
      },
      effects: [
        {
          kind: 'open-database',
          mode: 'create',
          dbName,
          version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        },
      ],
    },
  )
})

test('local store indexeddb schema planner opens a current complete database', () => {
  assert.deepEqual(planLocalStoreIndexedDbOpen(baseInput), {
    ok: true,
    startupGate: 'continue',
    dbName,
    decision: { action: 'open', version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION },
    effects: [
      {
        kind: 'open-database',
        mode: 'open',
        dbName,
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        createStores: [],
      },
    ],
  })
})

test('local store indexeddb schema planner upgrades readable databases in place', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbOpen({
      ...baseInput,
      currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
      presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter(
        (store) => store !== 'running-leases',
      ),
    }),
    {
      ok: true,
      startupGate: 'continue',
      dbName,
      decision: {
        action: 'upgrade',
        fromVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
        toVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        createStores: ['running-leases'],
      },
      effects: [
        {
          kind: 'open-database',
          mode: 'upgrade',
          dbName,
          version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          createStores: ['running-leases'],
        },
      ],
    },
  )
})

test('local store indexeddb schema planner rebuilds empty unsafe stores', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbOpen({
      ...baseInput,
      currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION - 1,
    }),
    {
      ok: true,
      startupGate: 'rebuild',
      dbName,
      decision: {
        action: 'rebuild',
        reason: 'store-version-too-old',
        targetVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        pendingOutboxCount: 0,
      },
      effects: [
        { kind: 'delete-database', dbName, reason: 'store-version-too-old' },
        {
          kind: 'open-database',
          mode: 'create',
          dbName,
          version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        },
      ],
    },
  )
})

test('local store indexeddb schema planner holds degraded stores with pending outbox', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbOpen({
      ...baseInput,
      currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION - 1,
      pendingOutboxCount: 1,
    }),
    {
      ok: false,
      startupGate: 'degraded',
      dbName,
      decision: { action: 'degraded', reason: 'store-version-too-old-with-pending-outbox' },
      effects: [
        { kind: 'hold-degraded', dbName, reason: 'store-version-too-old-with-pending-outbox' },
      ],
    },
  )
})

test('local store indexeddb schema planner rejects inconsistent missing database evidence', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbOpen({
      ...baseInput,
      dbExists: false,
      currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      presentStores: [],
    }),
    {
      ok: false,
      startupGate: 'reject',
      dbName,
      decision: { action: 'reject', reason: 'inconsistent-local-store-evidence' },
      effects: [{ kind: 'reject-open', dbName, reason: 'inconsistent-local-store-evidence' }],
    },
  )
})
