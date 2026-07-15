import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeVaultId,
  type ClientStartupLocalState,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  planSyncRuntimeLocalStateFromEvidence,
  planSyncRuntimeStartup,
  planSyncRuntimeStartupFromSchemaEvidence,
  type SyncRuntimeLocalStoreEvidence,
} from '../engine/startup'
import {
  LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  type LocalStoreIndexedDbOpenPlanInput,
} from '../store/schema'

const vaultId = makeVaultId('runtime-vault-1')
const deviceId = makeDeviceId('runtime-device-1')
const dbName = 'kuroflare:runtime-vault-1'

const baseLocalState = {
  hasIndexedDb: true,
  hasDeviceCredentials: true,
  hasMetaYDoc: true,
  hasLocalVaultFiles: true,
  pendingOutboxCount: 0,
  schemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  vaultId,
  authState: 'active',
} satisfies ClientStartupLocalState

const baseLocalStore = {
  dbExists: true,
  currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  pendingOutboxCount: 0,
} satisfies SyncRuntimeLocalStoreEvidence

const setupResponse = {
  endpoint: 'https://example.com',
  vaultId,
  deviceId,
  yClientId: 1,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

const metadataSnapshot = {
  ok: true,
  snapshot: {
    setup: {
      endpoint: 'https://example.com',
      vaultId,
      deviceId,
      yClientId: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    auth: {
      deviceId,
      authState: 'active',
      tokenVersion: 1,
      accessTokenExpiresAt: 10_000,
      refreshState: 'idle',
      retryCount: 0,
      accessTokenSecretKey: 'kuroflare:runtime-vault-1:runtime-device-1:access-token',
      refreshTokenSecretKey: 'kuroflare:runtime-vault-1:runtime-device-1:refresh-token',
    },
  },
} as const

test('sync runtime startup opens local store before reconnect sync effects', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
    localStore: baseLocalStore,
  })

  assert.equal(plan.action, 'continue')
  assert.deepEqual(
    plan.effects.map((effect) => effect.kind),
    [
      'run-local-store-open-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
    ],
  )
  assert.deepEqual(plan.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'open',
      dbName,
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: [],
    },
  })
})

test('sync runtime startup composes successful schema evidence before sync effects', () => {
  const plan = planSyncRuntimeStartupFromSchemaEvidence({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: {
      ok: true,
      evidence: baseLocalStore,
    },
  })

  assert.equal(plan.action, 'continue')
  assert.deepEqual(plan.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'open',
      dbName,
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: [],
    },
  })
  assert.equal(plan.effects[1]?.kind, 'run-sync-startup-effect')
})

test('sync runtime startup rejects schema evidence failures before sync effects', () => {
  const plan = planSyncRuntimeStartupFromSchemaEvidence({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: { ok: false, reason: 'database-directory-unavailable' },
  })

  assert.equal(plan.action, 'reject-local-store-schema-evidence')
  assert.deepEqual(plan.effects, [
    {
      kind: 'report-local-store-schema-evidence-failure',
      reason: 'database-directory-unavailable',
    },
  ])
})

test('sync runtime startup holds degraded local stores before any sync side effect starts', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: { ...baseLocalState, pendingOutboxCount: 1 },
    localStore: {
      ...baseLocalStore,
      currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION - 1,
      pendingOutboxCount: 1,
    },
  })

  assert.equal(plan.action, 'hold-local-store-degraded')
  assert.deepEqual(plan.effects, [
    {
      kind: 'run-local-store-open-effect',
      effect: {
        kind: 'hold-degraded',
        dbName,
        reason: 'store-version-too-old-with-pending-outbox',
      },
    },
  ])
})

test('sync runtime startup rebuilds empty unsafe stores and reruns startup evidence', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
    localStore: {
      ...baseLocalStore,
      currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION - 1,
    },
  })

  assert.equal(plan.action, 'rebuild-local-store')
  assert.deepEqual(plan.effects, [
    {
      kind: 'run-local-store-open-effect',
      effect: { kind: 'delete-database', dbName, reason: 'store-version-too-old' },
    },
    {
      kind: 'run-local-store-open-effect',
      effect: {
        kind: 'open-database',
        mode: 'create',
        dbName,
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
      },
    },
    {
      kind: 'rerun-startup-after-local-store-rebuild',
      vaultId,
      dbName,
    },
  ])
})

test('sync runtime startup runs setup exchange without local store evidence when vault is unknown', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'setup-new-vault',
    local: { ...baseLocalState, vaultId: undefined },
  })

  assert.equal(plan.action, 'run-sync-without-local-store-gate')
  assert.deepEqual(plan.effects, [
    {
      kind: 'run-sync-startup-effect',
      effect: { kind: 'run-setup-exchange', reason: 'setup-required' },
    },
  ])
})

test('sync runtime startup gates setup response paths by the setup vault local store', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'setup-new-vault',
    local: { ...baseLocalState, vaultId: undefined },
    setupResponse,
    localStore: {
      dbExists: false,
      currentVersion: undefined,
      presentStores: [],
      pendingOutboxCount: 0,
    },
  })

  assert.equal(plan.action, 'continue')
  assert.deepEqual(plan.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'create',
      dbName,
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
    },
  })
  assert.deepEqual(
    plan.effects.slice(1).map((effect) => effect.kind),
    Array.from({ length: 8 }, () => 'run-sync-startup-effect'),
  )
})

test('sync runtime startup rejects inconsistent local store evidence before sync effects', () => {
  const plan = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
    localStore: {
      ...baseLocalStore,
      dbExists: false,
      currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      presentStores: [],
    } satisfies Omit<LocalStoreIndexedDbOpenPlanInput, 'vaultId'>,
  })

  assert.equal(plan.action, 'reject-local-store-open')
  assert.deepEqual(plan.effects, [
    {
      kind: 'run-local-store-open-effect',
      effect: { kind: 'reject-open', dbName, reason: 'inconsistent-local-store-evidence' },
    },
  ])
})

test('sync runtime local state evidence accepts valid metadata and schema evidence', () => {
  assert.deepEqual(
    planSyncRuntimeLocalStateFromEvidence({
      metadataSnapshot,
      localStoreEvidence: { ok: true, evidence: baseLocalStore },
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: true,
      local: baseLocalState,
    },
  )
})

test('sync runtime local state evidence treats absent metadata as missing credentials', () => {
  assert.deepEqual(
    planSyncRuntimeLocalStateFromEvidence({
      localStoreEvidence: { ok: true, evidence: baseLocalStore },
      hasMetaYDoc: false,
      hasLocalVaultFiles: true,
    }),
    {
      ok: true,
      local: {
        hasIndexedDb: true,
        hasDeviceCredentials: false,
        hasMetaYDoc: false,
        hasLocalVaultFiles: true,
        pendingOutboxCount: 0,
        schemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        vaultId: undefined,
        authState: undefined,
      },
    },
  )
})

test('sync runtime local state evidence rejects corrupt metadata or schema probe failures', () => {
  assert.deepEqual(
    planSyncRuntimeLocalStateFromEvidence({
      metadataSnapshot: { ok: false, reason: 'setup-auth-device-mismatch' },
      localStoreEvidence: { ok: true, evidence: baseLocalStore },
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: false,
      reason: 'invalid-local-metadata',
      metadataReason: 'setup-auth-device-mismatch',
    },
  )
  assert.deepEqual(
    planSyncRuntimeLocalStateFromEvidence({
      metadataSnapshot,
      localStoreEvidence: { ok: false, reason: 'database-directory-unavailable' },
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: false,
      reason: 'local-store-schema-evidence-failure',
      localStoreReason: 'database-directory-unavailable',
    },
  )
})

test('sync runtime local state evidence keeps revoked or reauth metadata from reconnecting', () => {
  const reauthMetadataSnapshot = {
    ok: true,
    snapshot: {
      ...metadataSnapshot.snapshot,
      auth: {
        ...metadataSnapshot.snapshot.auth,
        authState: 'reauth-required',
      },
    },
  } as const

  const plan = planSyncRuntimeLocalStateFromEvidence({
    metadataSnapshot: reauthMetadataSnapshot,
    localStoreEvidence: { ok: true, evidence: baseLocalStore },
    hasMetaYDoc: true,
    hasLocalVaultFiles: true,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.local.hasDeviceCredentials, true)
    assert.equal(plan.local.vaultId, vaultId)
    assert.equal(plan.local.authState, 'reauth-required')
  }
})

test('sync runtime startup enters auth-blocked state for revoked or reauth metadata', () => {
  assert.deepEqual(
    planSyncRuntimeStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: true, authState: 'revoked' },
      localStore: baseLocalStore,
    }),
    {
      action: 'run-sync-without-local-store-gate',
      sync: {
        clientPlan: { action: 'auth-blocked', reason: 'device-revoked' },
        effects: [{ kind: 'enter-auth-blocked', reason: 'device-revoked' }],
      },
      effects: [
        {
          kind: 'run-sync-startup-effect',
          effect: { kind: 'enter-auth-blocked', reason: 'device-revoked' },
        },
      ],
    },
  )

  assert.deepEqual(
    planSyncRuntimeStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: true, authState: 'reauth-required' },
      localStore: baseLocalStore,
    }).effects,
    [
      {
        kind: 'run-sync-startup-effect',
        effect: { kind: 'enter-auth-blocked', reason: 'reauth-required' },
      },
    ],
  )
})
