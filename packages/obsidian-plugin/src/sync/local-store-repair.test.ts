import assert from 'node:assert/strict'

import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  decideLocalStoreSchema,
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
} from '@kuroflare/core'
import {
  LocalOutboxRepairExportSchema,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type DocId,
} from '@kuroflare/protocol'
import * as v from 'valibot'
import { test } from 'vitest'

import { applyLocalStoreDriverTransaction } from './local-store-driver.js'
import {
  LOCAL_STORE_REPAIR_EXPORT_DIRECTORY,
  buildLocalStoreRepairExport,
  localStoreRepairExportPath,
  planLocalStoreRepairImport,
  planLocalStoreRepairImportResumeTransaction,
  planLocalStoreRepairImportStageTransaction,
  planLocalStoreRepairImportResume,
  planLocalStoreRepair,
} from './local-store-repair.js'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from './local-store-schema.js'

const vaultId = makeVaultId('repair-vault-1')
const deviceId = makeDeviceId('repair-device-1')
const messageId = makeMessageId('repair-message-1')
const updateSha256 = makeSha256Hex('c'.repeat(64))
const fileDocId = { kind: 'file', ydocId: makeYDocId('repair-doc-1') } satisfies DocId
const yUpdateOutboxId = outboxId('outbox-y-update-1')
const blobPutOutboxId = outboxId('outbox-blob-put-1')
const doneOutboxId = outboxId('outbox-done-1')
const missingCreatedAtOutboxId = outboxId('outbox-missing-created-at-1')
const invalidBase64OutboxId = outboxId('outbox-invalid-base64-1')
const dbName = 'kuroflare:repair-vault-1'
const now = 1_700_000_000_000

const degradedTooOld = decideLocalStoreSchema({
  dbExists: true,
  currentVersion: 1,
  targetVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  minimumReadableVersion: 2,
  presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  requiredStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  pendingOutboxCount: 2,
})

const degradedMissingStore = decideLocalStoreSchema({
  dbExists: true,
  currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  targetVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  minimumReadableVersion: 2,
  presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox'),
  requiredStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  pendingOutboxCount: 1,
})

test('local store repair planner builds vault repair export paths', () => {
  assert.equal(
    localStoreRepairExportPath('kuroflare-local-outbox-1700000000000.json'),
    `${LOCAL_STORE_REPAIR_EXPORT_DIRECTORY}/kuroflare-local-outbox-1700000000000.json`,
  )
})

test('local store repair planner exports pending outbox before rebuild', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedTooOld,
      request: 'export-pending-outbox',
      pendingOutboxCount: 2,
      exportCompleted: false,
      discardConfirmed: false,
      now,
    }),
    {
      ok: true,
      action: 'export-pending-outbox',
      dbName,
      decision: {
        action: 'export-pending-outbox',
        exportName: 'kuroflare-local-outbox-1700000000000.json',
        includeOutbox: true,
        includeMetadata: true,
      },
      effects: [
        {
          kind: 'write-repair-export',
          path: '.obsidian/kuroflare/repair-exports/kuroflare-local-outbox-1700000000000.json',
          includeOutbox: true,
          includeMetadata: true,
        },
      ],
    },
  )
})

test('local store repair planner rejects rebuild before required export completes', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedTooOld,
      request: 'rebuild-after-export',
      pendingOutboxCount: 2,
      exportCompleted: false,
      discardConfirmed: false,
      now,
    }),
    {
      ok: false,
      action: 'reject',
      dbName,
      decision: { action: 'reject', reason: 'export-required' },
      effects: [{ kind: 'reject-repair', reason: 'export-required' }],
    },
  )
})

test('local store repair planner rebuilds after export with database reset effects', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedTooOld,
      request: 'rebuild-after-export',
      pendingOutboxCount: 2,
      exportCompleted: true,
      discardConfirmed: false,
      now,
    }),
    {
      ok: true,
      action: 'rebuild',
      dbName,
      decision: {
        action: 'rebuild',
        reason: 'outbox-exported',
        targetVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        clearPendingOutbox: true,
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

test('local store repair planner requires discard confirmation for pending outbox', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedMissingStore,
      request: 'discard-and-rebuild',
      pendingOutboxCount: 1,
      exportCompleted: false,
      discardConfirmed: false,
      now,
    }),
    {
      ok: false,
      action: 'reject',
      dbName,
      decision: { action: 'reject', reason: 'discard-confirmation-required' },
      effects: [{ kind: 'reject-repair', reason: 'discard-confirmation-required' }],
    },
  )
})

test('local store repair planner rebuilds after explicit discard', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedMissingStore,
      request: 'discard-and-rebuild',
      pendingOutboxCount: 1,
      exportCompleted: false,
      discardConfirmed: true,
      now,
    }),
    {
      ok: true,
      action: 'rebuild',
      dbName,
      decision: {
        action: 'rebuild',
        reason: 'outbox-discarded',
        targetVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        clearPendingOutbox: true,
      },
      effects: [
        { kind: 'delete-database', dbName, reason: 'missing-required-store' },
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

test('local store repair planner keeps degraded stores without side effects', () => {
  assert.deepEqual(
    planLocalStoreRepair({
      vaultId,
      schemaDecision: degradedTooOld,
      request: 'keep-degraded',
      pendingOutboxCount: 2,
      exportCompleted: false,
      discardConfirmed: false,
      now,
    }),
    {
      ok: true,
      action: 'keep-degraded',
      dbName,
      decision: { action: 'keep-degraded', reason: 'user-deferred' },
      effects: [{ kind: 'keep-degraded', reason: 'user-deferred' }],
    },
  )
})

test('local store repair export builder creates protocol-valid payloads', () => {
  const plan = buildLocalStoreRepairExport({
    exportedAt: now,
    vaultId,
    deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [
      {
        id: yUpdateOutboxId,
        kind: 'y-update',
        status: 'retrying',
        dependsOn: [],
        createdAt: 100,
        retryCount: 2,
        docId: fileDocId,
        messageId,
        updateSha256,
        updateBytesBase64: 'AQID',
        reason: 'network',
      },
      {
        id: blobPutOutboxId,
        kind: 'blob-put',
        status: 'pending',
        dependsOn: [yUpdateOutboxId],
        createdAt: 101,
        blobSha256: updateSha256,
        localCacheKey: 'blob-cache/outbox-blob-put-1',
      },
    ],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(v.is(LocalOutboxRepairExportSchema, plan.exportFile), true)
    assert.deepEqual(plan.exportedEntryIds, ['outbox-y-update-1', 'outbox-blob-put-1'])
    assert.deepEqual(plan.exportFile.entries, [
      {
        id: 'outbox-y-update-1',
        kind: 'y-update',
        status: 'retrying',
        dependsOn: [],
        createdAt: 100,
        retryCount: 2,
        docId: fileDocId,
        messageId,
        updateSha256,
        updateBytesBase64: 'AQID',
        reason: 'network',
      },
      {
        id: 'outbox-blob-put-1',
        kind: 'blob-put',
        status: 'pending',
        dependsOn: ['outbox-y-update-1'],
        createdAt: 101,
        retryCount: 0,
        blobSha256: updateSha256,
        localCacheKey: 'blob-cache/outbox-blob-put-1',
      },
    ])
  }
})

test('local store repair export builder rejects unsafe export evidence', () => {
  const baseInput = {
    exportedAt: now,
    vaultId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
  } as const

  assert.deepEqual(
    buildLocalStoreRepairExport({
      ...baseInput,
      outboxRecords: [
        {
          id: doneOutboxId,
          kind: 'y-update',
          status: 'done',
          dependsOn: [],
          createdAt: 100,
        },
      ],
    }),
    { ok: false, reason: 'unsupported-status', itemId: doneOutboxId },
  )

  assert.deepEqual(
    buildLocalStoreRepairExport({
      ...baseInput,
      outboxRecords: [
        {
          id: missingCreatedAtOutboxId,
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
        },
      ],
    }),
    { ok: false, reason: 'missing-created-at', itemId: missingCreatedAtOutboxId },
  )

  assert.deepEqual(
    buildLocalStoreRepairExport({
      ...baseInput,
      outboxRecords: [
        {
          id: invalidBase64OutboxId,
          kind: 'y-update',
          status: 'pending',
          dependsOn: [],
          createdAt: 100,
          updateBytesBase64: 'not base64!',
        },
      ],
    }),
    { ok: false, reason: 'invalid-export-payload', itemId: invalidBase64OutboxId },
  )
})

test('local store repair import planner stages safe y-updates as paused local outbox records', () => {
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: now,
    vaultId,
    deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [
      {
        id: yUpdateOutboxId,
        kind: 'y-update',
        status: 'pending',
        dependsOn: [],
        createdAt: 100,
        docId: fileDocId,
        messageId,
        updateSha256,
        updateBytesBase64: 'AQID',
      },
      {
        id: blobPutOutboxId,
        kind: 'blob-put',
        status: 'pending',
        dependsOn: [],
        createdAt: 101,
        blobSha256: updateSha256,
        localCacheKey: 'blob-cache/outbox-blob-put-1',
      },
    ],
  })
  assert.equal(exportPlan.ok, true)

  if (exportPlan.ok) {
    assert.deepEqual(
      planLocalStoreRepairImport({
        exportFile: exportPlan.exportFile,
        vaultId,
        deviceId,
        existingOutboxIds: [],
        durableMessages: [],
        quarantinedMessages: [],
      }),
      {
        ok: true,
        action: 'stage-import',
        decision: {
          action: 'stage-import',
          imports: [
            {
              id: 'outbox-y-update-1',
              kind: 'y-update',
              status: 'paused',
              reason: 'imported-repair-export',
              resumeOn: 'manual',
              docId: fileDocId,
              messageId,
              updateSha256,
              updateBytesBase64: 'AQID',
              createdAt: 100,
            },
          ],
          skipped: [{ id: 'outbox-blob-put-1', reason: 'unsupported-kind' }],
        },
        effects: [
          {
            kind: 'stage-repair-import',
            record: {
              id: yUpdateOutboxId,
              kind: 'y-update',
              status: 'paused',
              reason: 'imported-repair-export',
              resumeOn: 'manual',
              dependsOn: [],
              nextAttemptAt: undefined,
              createdAt: 100,
              retryCount: 0,
              docId: fileDocId,
              messageId,
              updateSha256,
              updateBytesBase64: 'AQID',
            },
          },
        ],
      },
    )
  }
})

test('local store repair import planner propagates duplicate and server evidence decisions', () => {
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: now,
    vaultId,
    deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [
      {
        id: yUpdateOutboxId,
        kind: 'y-update',
        status: 'pending',
        dependsOn: [],
        createdAt: 100,
        docId: fileDocId,
        messageId,
        updateSha256,
        updateBytesBase64: 'AQID',
      },
    ],
  })
  assert.equal(exportPlan.ok, true)

  if (exportPlan.ok) {
    assert.deepEqual(
      planLocalStoreRepairImport({
        exportFile: exportPlan.exportFile,
        vaultId,
        deviceId,
        existingOutboxIds: [yUpdateOutboxId],
        durableMessages: [],
        quarantinedMessages: [],
      }),
      {
        ok: true,
        action: 'stage-import',
        decision: {
          action: 'stage-import',
          imports: [],
          skipped: [{ id: 'outbox-y-update-1', reason: 'duplicate-local-outbox-id' }],
        },
        effects: [],
      },
    )

    assert.deepEqual(
      planLocalStoreRepairImport({
        exportFile: { ...exportPlan.exportFile, vaultId: makeVaultId('repair-other-vault') },
        vaultId,
        deviceId,
        existingOutboxIds: [],
        durableMessages: [],
        quarantinedMessages: [],
      }),
      {
        ok: false,
        action: 'reject',
        reason: 'vault-mismatch',
        decision: { action: 'reject', reason: 'vault-mismatch' },
      },
    )
  }
})

test('local store repair import resume waits for confirmation and fresh server evidence', () => {
  const record = stagedImportedRecord()

  assert.deepEqual(
    planLocalStoreRepairImportResume({
      record,
      userConfirmed: false,
      durableMessages: [],
      quarantinedMessages: [],
    }),
    {
      ok: true,
      action: 'wait',
      decision: { action: 'wait', reason: 'confirmation-required' },
      effects: [],
    },
  )

  assert.deepEqual(
    planLocalStoreRepairImportResume({
      record,
      userConfirmed: true,
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: 10 }],
      quarantinedMessages: [],
    }),
    {
      ok: true,
      action: 'wait',
      decision: { action: 'wait', reason: 'already-durable' },
      effects: [],
    },
  )

  assert.deepEqual(
    planLocalStoreRepairImportResume({
      record,
      userConfirmed: true,
      durableMessages: [],
      quarantinedMessages: [{ docId: fileDocId, messageId, updateSha256 }],
    }),
    {
      ok: true,
      action: 'wait',
      decision: { action: 'wait', reason: 'server-quarantine' },
      effects: [],
    },
  )
})

test('local store repair import resume emits a pending patch only after confirmation', () => {
  const record = stagedImportedRecord()

  assert.deepEqual(
    planLocalStoreRepairImportResume({
      record,
      userConfirmed: true,
      durableMessages: [],
      quarantinedMessages: [],
    }),
    {
      ok: true,
      action: 'resume',
      decision: {
        action: 'resume',
        patch: {
          status: 'pending',
          nextAttemptAt: undefined,
          resumeReason: 'user-confirmed-repair-import',
        },
      },
      effects: [
        {
          kind: 'resume-repair-import',
          itemId: yUpdateOutboxId,
          patch: {
            status: 'pending',
            nextAttemptAt: undefined,
            resumeReason: 'user-confirmed-repair-import',
          },
        },
      ],
    },
  )
})

test('local store repair import transactions stage and resume imported records', () => {
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: now,
    vaultId,
    deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [
      {
        id: yUpdateOutboxId,
        kind: 'y-update',
        status: 'pending',
        dependsOn: [],
        createdAt: 100,
        docId: fileDocId,
        messageId,
        updateSha256,
        updateBytesBase64: 'AQID',
      },
    ],
  })
  assert.equal(exportPlan.ok, true)

  if (exportPlan.ok) {
    const importPlan = planLocalStoreRepairImport({
      exportFile: exportPlan.exportFile,
      vaultId,
      deviceId,
      existingOutboxIds: [],
      durableMessages: [],
      quarantinedMessages: [],
    })
    assert.equal(importPlan.ok, true)

    if (importPlan.ok) {
      const stagedRecord = stagedImportedRecord()
      const stageOperations = planLocalStoreRepairImportStageTransaction(importPlan)
      const stageTransaction = applyLocalStoreDriverTransaction({
        source: { outboxRecords: [], leaseRows: [] },
        operations: stageOperations,
      })
      assert.equal(stageTransaction.ok, true)

      if (stageTransaction.ok) {
        assert.deepEqual(stageTransaction.readSet, {
          outboxItemIds: [yUpdateOutboxId],
          leaseItemIds: [],
        })
        assert.deepEqual(stageTransaction.snapshot.outboxRecords, [stagedRecord])

        const resumePlan = planLocalStoreRepairImportResume({
          record: stagedRecord,
          userConfirmed: true,
          durableMessages: [],
          quarantinedMessages: [],
        })
        assert.equal(resumePlan.ok, true)
        assert.equal(resumePlan.action, 'resume')

        if (resumePlan.ok && resumePlan.action === 'resume') {
          assert.deepEqual(planLocalStoreRepairImportResumeTransaction(resumePlan), [
            {
              kind: 'patch-outbox',
              patch: {
                kind: 'repair-import-resume',
                itemId: yUpdateOutboxId,
                patch: {
                  status: 'pending',
                  nextAttemptAt: undefined,
                  resumeReason: 'user-confirmed-repair-import',
                },
              },
            },
          ])

          const resumeTransaction = applyLocalStoreDriverTransaction({
            source: stageTransaction.snapshot,
            operations: planLocalStoreRepairImportResumeTransaction(resumePlan),
          })
          assert.equal(resumeTransaction.ok, true)

          if (resumeTransaction.ok) {
            assert.deepEqual(resumeTransaction.snapshot.outboxRecords, [
              {
                ...stagedRecord,
                status: 'pending',
                nextAttemptAt: undefined,
                resumeOn: undefined,
                reason: undefined,
              },
            ])
          }
        }
      }
    }
  }
})

test('local store repair import stage transaction rejects existing local outbox rows', () => {
  const record = stagedImportedRecord()
  const plan = applyLocalStoreDriverTransaction({
    source: { outboxRecords: [record], leaseRows: [] },
    operations: [
      {
        kind: 'put-outbox',
        put: { record },
      },
    ],
  })

  assert.equal(plan.ok, false)
  if (!plan.ok) {
    assert.equal(plan.phase, 'commit')
    assert.equal(plan.reason, 'existing-outbox-item')
    assert.equal(plan.itemId, yUpdateOutboxId)
  }
})

test('local store repair import resume rejects invalid durable evidence', () => {
  assert.deepEqual(
    planLocalStoreRepairImportResume({
      record: stagedImportedRecord(),
      userConfirmed: true,
      durableMessages: [{ docId: fileDocId, messageId, durableSeq: -1 }],
      quarantinedMessages: [],
    }),
    {
      ok: false,
      action: 'reject',
      decision: { action: 'reject', reason: 'invalid-durable-seq' },
      effects: [],
    },
  )
})

function outboxId(value: string): OutboxPlanItemId {
  const itemId = makeOutboxPlanItemId(value)
  assert(itemId !== null)
  return itemId
}

function stagedImportedRecord() {
  return {
    id: yUpdateOutboxId,
    kind: 'y-update',
    status: 'paused',
    reason: 'imported-repair-export',
    resumeOn: 'manual',
    dependsOn: [],
    nextAttemptAt: undefined,
    createdAt: 100,
    retryCount: 0,
    docId: fileDocId,
    messageId,
    updateSha256,
    updateBytesBase64: 'AQID',
  } as const
}
