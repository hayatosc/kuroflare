import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { type LocalSetupMetadataSnapshotDecision } from '../engine/setup'
import {
  createSyncRuntimeObsidianShellEvidencePort,
  createSyncRuntimeObsidianStartupEvidenceReader,
  planSyncRuntimeObsidianStartupInputFromEvidence,
} from '../obsidian/evidence'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from '../store/schema'

const vaultId = makeVaultId('startup-evidence-vault-1')
const deviceId = makeDeviceId('startup-evidence-device-1')

const metadataSnapshot = {
  ok: true,
  snapshot: {
    setup: {
      endpoint: 'https://sync.example.test',
      vaultId,
      deviceId,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 2,
    },
    auth: {
      deviceId,
      tokenVersion: 2,
      authState: 'active',
      accessTokenSecretKey: 'kuroflare/access',
      refreshTokenSecretKey: 'kuroflare/refresh',
      accessTokenExpiresAt: 10_000,
      refreshState: 'idle',
      retryCount: 0,
    },
  },
} satisfies LocalSetupMetadataSnapshotDecision

test('Obsidian startup evidence converts absent metadata into setup-required startup input', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupInputFromEvidence({
      intent: 'reconnect',
      hasMetaYDoc: false,
      hasLocalVaultFiles: true,
    }),
    {
      ok: true,
      startupInput: {
        intent: 'reconnect',
        local: {
          hasIndexedDb: false,
          hasDeviceCredentials: false,
          hasMetaYDoc: false,
          hasLocalVaultFiles: true,
          pendingOutboxCount: 0,
          schemaVersion: undefined,
          supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          vaultId: undefined,
          authState: undefined,
        },
        localStoreEvidence: undefined,
        setupResponse: undefined,
        expectedBootstrapMode: undefined,
      },
    },
  )
})

test('Obsidian startup evidence preserves metadata and schema evidence for reconnect planning', () => {
  const localStoreEvidence = {
    ok: true,
    evidence: {
      dbExists: true,
      currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      presentStores: ['metadata', 'meta-ydoc', 'file-ydocs'],
      pendingOutboxCount: 1,
    },
  } as const

  assert.deepEqual(
    planSyncRuntimeObsidianStartupInputFromEvidence({
      intent: 'reconnect',
      metadataSnapshot,
      localStoreEvidence,
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: true,
      startupInput: {
        intent: 'reconnect',
        local: {
          hasIndexedDb: true,
          hasDeviceCredentials: true,
          hasMetaYDoc: true,
          hasLocalVaultFiles: true,
          pendingOutboxCount: 1,
          schemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
          vaultId,
          authState: 'active',
        },
        localStoreEvidence,
        setupResponse: undefined,
        expectedBootstrapMode: undefined,
      },
    },
  )
})

test('Obsidian startup evidence returns local evidence failures without planning startup', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupInputFromEvidence({
      intent: 'reconnect',
      metadataSnapshot: { ok: false, reason: 'setup-auth-device-mismatch' },
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: false,
      localState: {
        ok: false,
        reason: 'invalid-local-metadata',
        metadataReason: 'setup-auth-device-mismatch',
      },
    },
  )

  assert.deepEqual(
    planSyncRuntimeObsidianStartupInputFromEvidence({
      intent: 'reconnect',
      metadataSnapshot,
      localStoreEvidence: { ok: false, reason: 'database-directory-unavailable' },
      hasMetaYDoc: true,
      hasLocalVaultFiles: true,
    }),
    {
      ok: false,
      localState: {
        ok: false,
        reason: 'local-store-schema-evidence-failure',
        localStoreReason: 'database-directory-unavailable',
      },
    },
  )
})

test('Obsidian startup evidence forwards setup response fields unchanged', () => {
  const setupResponse = {
    endpoint: 'https://sync.example.test',
    vaultId,
    deviceId,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenVersion: 2,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  } satisfies SetupExchangeResponse

  const plan = planSyncRuntimeObsidianStartupInputFromEvidence({
    intent: 'setup-new-vault',
    setupResponse,
    expectedBootstrapMode: 'new-vault',
    hasMetaYDoc: false,
    hasLocalVaultFiles: true,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.startupInput.setupResponse, setupResponse)
    assert.equal(plan.startupInput.expectedBootstrapMode, 'new-vault')
  }
})

test('Obsidian startup evidence port converts raw evidence for the shell driver', async () => {
  const port = createSyncRuntimeObsidianShellEvidencePort({
    async readEvidence() {
      return {
        intent: 'reconnect',
        metadataSnapshot,
        hasMetaYDoc: true,
        hasLocalVaultFiles: true,
      }
    },
  })

  assert.deepEqual(await port.readStartupInput(), {
    ok: true,
    startupInput: {
      intent: 'reconnect',
      local: {
        hasIndexedDb: false,
        hasDeviceCredentials: true,
        hasMetaYDoc: true,
        hasLocalVaultFiles: true,
        pendingOutboxCount: 0,
        schemaVersion: undefined,
        supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        vaultId,
        authState: 'active',
      },
      localStoreEvidence: undefined,
      setupResponse: undefined,
      expectedBootstrapMode: undefined,
    },
  })
})

test('Obsidian startup evidence port forwards local evidence failures', async () => {
  const port = createSyncRuntimeObsidianShellEvidencePort({
    async readEvidence() {
      return {
        intent: 'reconnect',
        metadataSnapshot: { ok: false, reason: 'missing-auth-metadata' },
        hasMetaYDoc: true,
        hasLocalVaultFiles: true,
      }
    },
  })

  assert.deepEqual(await port.readStartupInput(), {
    ok: false,
    localState: {
      ok: false,
      reason: 'invalid-local-metadata',
      metadataReason: 'missing-auth-metadata',
    },
  })
})

test('Obsidian startup evidence reader composes settings intent with local evidence', async () => {
  const reader = createSyncRuntimeObsidianStartupEvidenceReader({
    settings: {
      async readSettings() {
        return {
          endpoint: 'https://sync.example.test',
          setupVaultId: 'startup-evidence-vault-1',
          setupToken: 'setup-token',
          requestedDeviceName: 'desktop',
          setupBootstrapMode: 'new-vault',
        }
      },
    },
    local: {
      async readLocalEvidence() {
        return {
          metadataSnapshot,
          hasMetaYDoc: true,
          hasLocalVaultFiles: true,
        }
      },
    },
  })

  assert.deepEqual(await reader.readEvidence(), {
    intent: 'setup-new-vault',
    expectedBootstrapMode: 'new-vault',
    metadataSnapshot,
    localStoreEvidence: undefined,
    hasMetaYDoc: true,
    hasLocalVaultFiles: true,
    supportedSchemaVersion: undefined,
    setupResponse: undefined,
  })
})

test('Obsidian startup evidence reader defaults to reconnect while preserving local failure evidence', async () => {
  const reader = createSyncRuntimeObsidianStartupEvidenceReader({
    settings: {
      async readSettings() {
        return {}
      },
    },
    local: {
      async readLocalEvidence() {
        return {
          metadataSnapshot: { ok: false, reason: 'invalid-auth-metadata' },
          localStoreEvidence: { ok: false, reason: 'database-directory-unavailable' },
          hasMetaYDoc: false,
          hasLocalVaultFiles: false,
        }
      },
    },
  })

  assert.deepEqual(await reader.readEvidence(), {
    intent: 'reconnect',
    expectedBootstrapMode: undefined,
    metadataSnapshot: { ok: false, reason: 'invalid-auth-metadata' },
    localStoreEvidence: { ok: false, reason: 'database-directory-unavailable' },
    hasMetaYDoc: false,
    hasLocalVaultFiles: false,
    supportedSchemaVersion: undefined,
    setupResponse: undefined,
  })
})

test('Obsidian startup shell evidence port can be backed by composed settings and local readers', async () => {
  const rawReader = createSyncRuntimeObsidianStartupEvidenceReader({
    settings: {
      async readSettings() {
        return {
          endpoint: 'https://sync.example.test',
          setupVaultId: 'startup-evidence-vault-1',
          setupToken: 'setup-token',
          requestedDeviceName: 'desktop',
          setupBootstrapMode: 'join-existing',
        }
      },
    },
    local: {
      async readLocalEvidence() {
        return {
          hasMetaYDoc: false,
          hasLocalVaultFiles: true,
        }
      },
    },
  })

  assert.deepEqual(await createSyncRuntimeObsidianShellEvidencePort(rawReader).readStartupInput(), {
    ok: true,
    startupInput: {
      intent: 'join-existing-vault',
      expectedBootstrapMode: 'join-existing',
      local: {
        hasIndexedDb: false,
        hasDeviceCredentials: false,
        hasMetaYDoc: false,
        hasLocalVaultFiles: true,
        pendingOutboxCount: 0,
        schemaVersion: undefined,
        supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        vaultId: undefined,
        authState: undefined,
      },
      localStoreEvidence: undefined,
      setupResponse: undefined,
    },
  })
})
