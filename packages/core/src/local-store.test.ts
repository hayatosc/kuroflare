import {
  LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
  LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
  LocalOutboxRepairEvidenceRequestSchema,
  LocalOutboxRepairEvidenceResponseSchema,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type DocId,
  type LocalOutboxRepairExport,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test } from 'vitest'

import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  decideLocalOutboxRepairResume,
  decideLocalStoreRepair,
  decideLocalStoreSchema,
  planLocalOutboxRepairImport,
  type LocalStoreSchemaDecisionInput,
} from './local-store'

const vaultId = makeVaultId('vault-1')
const otherVaultId = makeVaultId('vault-2')
const deviceId = makeDeviceId('device-1')
const otherDeviceId = makeDeviceId('device-2')
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId
const otherFileDocId = { kind: 'file', ydocId: makeYDocId('doc-2') } satisfies DocId
const messageId = makeMessageId('message-1')
const otherMessageId = makeMessageId('message-2')
const firstHash = makeSha256Hex('a'.repeat(64))
const secondHash = makeSha256Hex('b'.repeat(64))

const baseInput = {
  dbExists: true,
  currentVersion: 3,
  targetVersion: 3,
  minimumReadableVersion: 2,
  presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  requiredStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  pendingOutboxCount: 0,
} satisfies LocalStoreSchemaDecisionInput

test('local store schema creates a missing IndexedDB with all required stores', () => {
  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      dbExists: false,
      currentVersion: undefined,
      presentStores: [],
    }),
    {
      action: 'create',
      version: 3,
      createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
    },
  )
})

test('local store schema opens a complete current database', () => {
  assert.deepEqual(decideLocalStoreSchema(baseInput), { action: 'open', version: 3 })
})

test('local store schema upgrades readable older databases in place', () => {
  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      currentVersion: 2,
      presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter(
        (store) => store !== 'running-leases',
      ),
    }),
    {
      action: 'upgrade',
      fromVersion: 2,
      toVersion: 3,
      createStores: ['running-leases'],
    },
  )
})

test('local store schema rebuilds too-old or corrupt stores only when outbox is empty', () => {
  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      currentVersion: 1,
      minimumReadableVersion: 2,
    }),
    {
      action: 'rebuild',
      reason: 'store-version-too-old',
      targetVersion: 3,
      pendingOutboxCount: 0,
    },
  )

  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox'),
    }),
    {
      action: 'rebuild',
      reason: 'missing-required-store',
      targetVersion: 3,
      pendingOutboxCount: 0,
    },
  )
})

test('local store schema degrades instead of rebuilding when pending outbox may be lost', () => {
  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      currentVersion: 1,
      pendingOutboxCount: 2,
    }),
    { action: 'degraded', reason: 'store-version-too-old-with-pending-outbox' },
  )

  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox'),
      pendingOutboxCount: 1,
    }),
    { action: 'degraded', reason: 'missing-required-store-with-pending-outbox' },
  )
})

test('local store schema refuses newer stores and inconsistent browser evidence', () => {
  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      currentVersion: 4,
    }),
    { action: 'degraded', reason: 'local-store-too-new' },
  )

  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      dbExists: false,
      currentVersion: 3,
      presentStores: [],
    }),
    { action: 'reject', reason: 'inconsistent-local-store-evidence' },
  )

  assert.deepEqual(
    decideLocalStoreSchema({
      ...baseInput,
      pendingOutboxCount: -1,
    }),
    { action: 'reject', reason: 'invalid-pending-outbox-count' },
  )
})

test('local store repair exports degraded pending outbox before rebuild', () => {
  const schemaDecision = decideLocalStoreSchema({
    ...baseInput,
    currentVersion: 1,
    pendingOutboxCount: 2,
  })

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'export-pending-outbox',
      pendingOutboxCount: 2,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1_700_000_000_000,
    }),
    {
      action: 'export-pending-outbox',
      exportName: 'kuroflare-local-outbox-1700000000000.json',
      includeOutbox: true,
      includeMetadata: true,
    },
  )

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'rebuild-after-export',
      pendingOutboxCount: 2,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1_700_000_000_000,
    }),
    { action: 'reject', reason: 'export-required' },
  )

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'rebuild-after-export',
      pendingOutboxCount: 2,
      exportCompleted: true,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1_700_000_000_000,
    }),
    {
      action: 'rebuild',
      reason: 'outbox-exported',
      targetVersion: 3,
      clearPendingOutbox: true,
    },
  )
})

test('local store repair requires explicit discard confirmation for pending outbox', () => {
  const schemaDecision = decideLocalStoreSchema({
    ...baseInput,
    presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox'),
    pendingOutboxCount: 1,
  })

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'discard-and-rebuild',
      pendingOutboxCount: 1,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1,
    }),
    { action: 'reject', reason: 'discard-confirmation-required' },
  )

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'discard-and-rebuild',
      pendingOutboxCount: 1,
      exportCompleted: false,
      discardConfirmed: true,
      targetVersion: 3,
      now: 1,
    }),
    {
      action: 'rebuild',
      reason: 'outbox-discarded',
      targetVersion: 3,
      clearPendingOutbox: true,
    },
  )
})

test('local store repair handles empty outbox and invalid repair evidence', () => {
  const schemaDecision = decideLocalStoreSchema({
    ...baseInput,
    currentVersion: 4,
  })

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'rebuild-after-export',
      pendingOutboxCount: 0,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1,
    }),
    {
      action: 'rebuild',
      reason: 'empty-outbox',
      targetVersion: 3,
      clearPendingOutbox: false,
    },
  )

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision: { action: 'open', version: 3 },
      request: 'keep-degraded',
      pendingOutboxCount: 0,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1,
    }),
    { action: 'keep-degraded', reason: 'schema-not-degraded' },
  )

  assert.deepEqual(
    decideLocalStoreRepair({
      schemaDecision,
      request: 'keep-degraded',
      pendingOutboxCount: -1,
      exportCompleted: false,
      discardConfirmed: false,
      targetVersion: 3,
      now: 1,
    }),
    { action: 'reject', reason: 'invalid-pending-outbox-count' },
  )
})

test('local outbox repair evidence protocol guards request and response payloads', () => {
  const request = {
    items: [{ docId: fileDocId, messageId, updateSha256: firstHash }],
  }
  assert.equal(v.is(LocalOutboxRepairEvidenceRequestSchema, request), true)
  assert.equal(
    v.is(LocalOutboxRepairEvidenceRequestSchema, {
      items: [{ docId: fileDocId, updateSha256: firstHash }],
    }),
    false,
  )

  const response = {
    durableMessages: [{ docId: fileDocId, messageId, durableSeq: 1 }],
    quarantinedMessages: [{ docId: fileDocId, messageId, updateSha256: firstHash }],
  }
  assert.equal(v.is(LocalOutboxRepairEvidenceResponseSchema, response), true)
  assert.equal(
    v.is(LocalOutboxRepairEvidenceResponseSchema, {
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: -1 }],
      quarantinedMessages: [],
    }),
    false,
  )
})

test('local outbox repair import stages safe y-updates as manual paused items', () => {
  const plan = planLocalOutboxRepairImport({
    exportFile: makeRepairExport({
      entries: [
        {
          id: 'outbox-1',
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          retryCount: 3,
          docId: fileDocId,
          messageId,
          updateSha256: firstHash,
          updateBytesBase64: 'AQID',
        },
      ],
    }),
    vaultId,
    deviceId,
    existingOutboxIds: [],
    durableMessages: [],
    quarantinedMessages: [],
  })

  assert.deepEqual(plan, {
    action: 'stage-import',
    imports: [
      {
        id: 'outbox-1',
        kind: 'y-update',
        status: 'paused',
        reason: 'imported-repair-export',
        resumeOn: 'manual',
        docId: fileDocId,
        messageId,
        updateSha256: firstHash,
        updateBytesBase64: 'AQID',
        createdAt: 100,
      },
    ],
    skipped: [],
  })
})

test('local outbox repair import skips entries that cannot be safely replayed', () => {
  const plan = planLocalOutboxRepairImport({
    exportFile: makeRepairExport({
      entries: [
        {
          id: 'blob-1',
          kind: 'blob-put',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          retryCount: 0,
          blobSha256: firstHash,
        },
        {
          id: 'failed-1',
          kind: 'y-update',
          status: 'failed',
          dependsOn: [],
          createdAt: 100,
          retryCount: 0,
          docId: fileDocId,
          messageId,
          updateSha256: firstHash,
          updateBytesBase64: 'AQID',
        },
        {
          id: 'dependent-1',
          kind: 'y-update',
          status: 'pending',
          dependsOn: ['blob-1'],
          createdAt: 100,
          retryCount: 0,
          docId: fileDocId,
          messageId: otherMessageId,
          updateSha256: secondHash,
          updateBytesBase64: 'BAUG',
        },
        {
          id: 'missing-fields-1',
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          retryCount: 0,
        },
        {
          id: 'duplicate-local-1',
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          retryCount: 0,
          docId: otherFileDocId,
          messageId: otherMessageId,
          updateSha256: secondHash,
          updateBytesBase64: 'BAUG',
        },
      ],
    }),
    vaultId,
    deviceId,
    existingOutboxIds: ['duplicate-local-1'],
    durableMessages: [],
    quarantinedMessages: [],
  })

  assert.deepEqual(plan, {
    action: 'stage-import',
    imports: [],
    skipped: [
      { id: 'blob-1', reason: 'unsupported-kind' },
      { id: 'failed-1', reason: 'unsupported-status' },
      { id: 'dependent-1', reason: 'dependency-not-restored' },
      { id: 'missing-fields-1', reason: 'missing-y-update-fields' },
      { id: 'duplicate-local-1', reason: 'duplicate-local-outbox-id' },
    ],
  })
})

test('local outbox repair import skips durable and quarantined server evidence', () => {
  const plan = planLocalOutboxRepairImport({
    exportFile: makeRepairExport({
      entries: [
        {
          id: 'durable-1',
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          retryCount: 0,
          docId: fileDocId,
          messageId,
          updateSha256: firstHash,
          updateBytesBase64: 'AQID',
        },
        {
          id: 'quarantine-1',
          kind: 'y-update',
          status: 'retrying',
          dependsOn: [],
          createdAt: 100,
          retryCount: 2,
          docId: otherFileDocId,
          messageId: otherMessageId,
          updateSha256: secondHash,
          updateBytesBase64: 'BAUG',
        },
      ],
    }),
    vaultId,
    deviceId,
    existingOutboxIds: [],
    durableMessages: [{ docId: fileDocId, messageId, durableSeq: 10 }],
    quarantinedMessages: [
      { docId: otherFileDocId, messageId: otherMessageId, updateSha256: secondHash },
    ],
  })

  assert.deepEqual(plan, {
    action: 'stage-import',
    imports: [],
    skipped: [
      { id: 'durable-1', reason: 'already-durable' },
      { id: 'quarantine-1', reason: 'server-quarantine' },
    ],
  })
})

test('local outbox repair import rejects mismatched files and invalid server evidence', () => {
  assert.deepEqual(
    planLocalOutboxRepairImport({
      exportFile: makeRepairExport({ vaultId: otherVaultId }),
      vaultId,
      deviceId,
      existingOutboxIds: [],
      durableMessages: [],
      quarantinedMessages: [],
    }),
    { action: 'reject', reason: 'vault-mismatch' },
  )

  assert.deepEqual(
    planLocalOutboxRepairImport({
      exportFile: makeRepairExport({ deviceId: otherDeviceId }),
      vaultId,
      deviceId,
      existingOutboxIds: [],
      durableMessages: [],
      quarantinedMessages: [],
    }),
    { action: 'reject', reason: 'device-mismatch' },
  )

  assert.deepEqual(
    planLocalOutboxRepairImport({
      exportFile: makeRepairExport({
        entries: [
          {
            id: 'duplicate',
            kind: 'y-update',
            status: 'pending',
            dependsOn: [],
            createdAt: 100,
            retryCount: 0,
            docId: fileDocId,
            messageId,
            updateSha256: firstHash,
            updateBytesBase64: 'AQID',
          },
          {
            id: 'duplicate',
            kind: 'y-update',
            status: 'pending',
            dependsOn: [],
            createdAt: 101,
            retryCount: 0,
            docId: otherFileDocId,
            messageId: otherMessageId,
            updateSha256: secondHash,
            updateBytesBase64: 'BAUG',
          },
        ],
      }),
      vaultId,
      deviceId,
      existingOutboxIds: [],
      durableMessages: [],
      quarantinedMessages: [],
    }),
    { action: 'reject', reason: 'duplicate-export-id' },
  )

  assert.deepEqual(
    planLocalOutboxRepairImport({
      exportFile: makeRepairExport(),
      vaultId,
      deviceId,
      existingOutboxIds: [],
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: -1 }],
      quarantinedMessages: [],
    }),
    { action: 'reject', reason: 'invalid-durable-seq' },
  )
})

test('local outbox repair resume requires confirmation and fresh server evidence', () => {
  const item = importedItem()

  assert.deepEqual(
    decideLocalOutboxRepairResume({
      item,
      userConfirmed: false,
      durableMessages: [],
      quarantinedMessages: [],
    }),
    { action: 'wait', reason: 'confirmation-required' },
  )

  assert.deepEqual(
    decideLocalOutboxRepairResume({
      item,
      userConfirmed: true,
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: 11 }],
      quarantinedMessages: [],
    }),
    { action: 'wait', reason: 'already-durable' },
  )

  assert.deepEqual(
    decideLocalOutboxRepairResume({
      item,
      userConfirmed: true,
      durableMessages: [],
      quarantinedMessages: [{ docId: fileDocId, messageId, updateSha256: firstHash }],
    }),
    { action: 'wait', reason: 'server-quarantine' },
  )

  assert.deepEqual(
    decideLocalOutboxRepairResume({
      item,
      userConfirmed: true,
      durableMessages: [],
      quarantinedMessages: [],
    }),
    {
      action: 'resume',
      patch: {
        status: 'pending',
        nextAttemptAt: undefined,
        resumeReason: 'user-confirmed-repair-import',
      },
    },
  )
})

test('local outbox repair resume rejects invalid durable evidence', () => {
  assert.deepEqual(
    decideLocalOutboxRepairResume({
      item: importedItem(),
      userConfirmed: true,
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: -1 }],
      quarantinedMessages: [],
    }),
    { action: 'reject', reason: 'invalid-durable-seq' },
  )
})

function makeRepairExport(
  override: Partial<LocalOutboxRepairExport> = {},
): LocalOutboxRepairExport {
  return {
    format: LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
    formatVersion: LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
    exportedAt: 200,
    vaultId,
    deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: 3,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    entries: [],
    ...override,
  }
}

function importedItem() {
  return {
    id: 'outbox-1',
    kind: 'y-update',
    status: 'paused',
    reason: 'imported-repair-export',
    resumeOn: 'manual',
    docId: fileDocId,
    messageId,
    updateSha256: firstHash,
    updateBytesBase64: 'AQID',
    createdAt: 100,
  } as const
}
