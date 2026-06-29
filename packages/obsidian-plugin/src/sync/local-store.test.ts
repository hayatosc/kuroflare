import assert from 'node:assert/strict'

import {
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
  type OutboxSchedulerItem,
  type OutboxSchedulerStart,
} from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type DocId,
} from '@kuroflare/core'
import { test } from 'vitest'

import {
  applyLocalStoreOutboxPatch,
  applyLocalStoreTransactionSnapshot,
  planLocalStoreAckCompletionTransaction,
  planLocalStoreFullSnapshotReleaseTransaction,
  planLocalStoreLeaseAcquireTransaction,
  planLocalStoreLeaseRenewTransaction,
  planLocalStoreOutboxSchedulerTransaction,
  planLocalStoreQuarantinePauseTransaction,
  planLocalStoreSuccessCompletionTransaction,
  planLocalStoreTransactionCommit,
  type LocalStoreOutboxRecord,
} from './local-store'
import {
  planOutboundQueueAckCompletion,
  planOutboundQueueFullSnapshotRelease,
  planOutboundQueueLeaseAcquire,
  planOutboundQueueLeaseRenew,
  planOutboundQueueQuarantinePause,
  planOutboundQueueSuccessCompletion,
  planOutboundQueueTick,
} from './outbound-queue'

const yUpdateId = outboxId('local-y-update-1')
const pausedId = outboxId('local-paused-1')
const leasedId = outboxId('local-leased-1')
const snapshotPausedId = outboxId('local-snapshot-paused-1')
const vaultId = makeVaultId('vault-1')
const deviceId = makeDeviceId('device-1')
const messageId = makeMessageId('message-1')
const updateHash = makeSha256Hex('c'.repeat(64))
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId

test('local store scheduler transaction preserves persist patch ordering', () => {
  const plan = planOutboundQueueTick({
    items: [
      {
        id: pausedId,
        kind: 'materialize',
        status: 'paused',
        dependsOn: [],
        nextAttemptAt: undefined,
        resumeOn: 'manual',
      },
      {
        id: leasedId,
        kind: 'blob-put',
        status: 'retrying',
        dependsOn: [],
        nextAttemptAt: undefined,
      },
      runnableItem(yUpdateId, 'y-update'),
    ],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [
      {
        itemId: leasedId,
        kind: 'blob-put',
        ownerId: 'stale-worker',
        leaseExpiresAt: 999,
      },
    ],
    maxStarts: 3,
    authRefreshState: { status: 'idle' },
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(planLocalStoreOutboxSchedulerTransaction(plan), [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'resume',
          patch: { id: pausedId, status: 'pending', nextAttemptAt: undefined },
        },
      },
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'lease-reclaim',
          patch: {
            id: leasedId,
            previousOwnerId: 'stale-worker',
            status: 'retrying',
            nextAttemptAt: undefined,
          },
        },
      },
    ])
  }
})

test('local store lease transactions carry CAS evidence', () => {
  const start = schedulerStart(yUpdateId, 'y-update')
  const acquire = planOutboundQueueLeaseAcquire({
    start,
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 10_000,
    existingLease: undefined,
  })
  assert.equal(acquire.ok, true)

  if (acquire.ok) {
    assert.deepEqual(planLocalStoreLeaseAcquireTransaction(acquire), [
      {
        kind: 'lease',
        operation: {
          kind: 'put-lease',
          write: {
            itemId: yUpdateId,
            expectedLease: undefined,
            nextLease: {
              itemId: yUpdateId,
              kind: 'y-update',
              ownerId: 'worker-1',
              leaseExpiresAt: 11_000,
            },
          },
        },
      },
    ])
  }

  const existingLease = {
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'worker-1',
    leaseExpiresAt: 11_000,
  } as const
  const renew = planOutboundQueueLeaseRenew({
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'worker-1',
    now: 5_000,
    leaseDurationMs: 10_000,
    existingLease,
  })
  assert.equal(renew.ok, true)

  if (renew.ok) {
    assert.deepEqual(planLocalStoreLeaseRenewTransaction(renew), [
      {
        kind: 'lease',
        operation: {
          kind: 'put-lease',
          write: {
            itemId: yUpdateId,
            expectedLease: existingLease,
            nextLease: {
              itemId: yUpdateId,
              kind: 'y-update',
              ownerId: 'worker-1',
              leaseExpiresAt: 15_000,
            },
          },
        },
      },
    ])
  }
})

test('local store ack completion patches item before releasing lease', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const plan = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 7,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(planLocalStoreAckCompletionTransaction(plan), [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'ack-completion',
          itemId: yUpdateId,
          patch: { status: 'done', nextAttemptAt: undefined, durableSeq: 7 },
        },
      },
      {
        kind: 'lease',
        operation: {
          kind: 'delete-lease',
          delete: { itemId: yUpdateId, expectedLease: existingLease },
        },
      },
    ])
  }
})

test('local store success completion patches non-ack item before releasing lease', () => {
  const existingLease = runningLease(leasedId, 'blob-put', 'worker-1', 30_000)
  const plan = planOutboundQueueSuccessCompletion({
    itemId: leasedId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(planLocalStoreSuccessCompletionTransaction(plan), [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'success-completion',
          itemId: leasedId,
          patch: { status: 'done', nextAttemptAt: undefined },
        },
      },
      {
        kind: 'lease',
        operation: {
          kind: 'delete-lease',
          delete: { itemId: leasedId, expectedLease: existingLease },
        },
      },
    ])
  }
})

test('local store quarantine pause patches item before releasing lease', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const plan = planOutboundQueueQuarantinePause({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    deviceId,
    docId: fileDocId,
    messageId,
    updateSha256: updateHash,
    quarantine: {
      id: 'quarantine-1',
      docId: fileDocId,
      messageId,
      deviceId,
      reason: 'meta-schema-invalid',
      updateSha256: updateHash,
      updateBytesLength: 42,
      createdAt: 100,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(planLocalStoreQuarantinePauseTransaction(plan), [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'quarantine-pause',
          itemId: yUpdateId,
          patch: {
            status: 'paused',
            nextAttemptAt: undefined,
            reason: 'server-quarantine',
            resumeOn: 'manual',
            quarantineId: 'quarantine-1',
            quarantineReason: 'meta-schema-invalid',
            docId: fileDocId,
          },
        },
      },
      {
        kind: 'lease',
        operation: {
          kind: 'delete-lease',
          delete: { itemId: yUpdateId, expectedLease: existingLease },
        },
      },
    ])
  }
})

test('local store full snapshot release produces terminal outbox patches', () => {
  const plan = planOutboundQueueFullSnapshotRelease({
    appliedDocId: fileDocId,
    snapshotSeq: 20,
    items: [
      {
        id: snapshotPausedId,
        kind: 'y-update',
        status: 'paused',
        reason: 'full-snapshot-required',
        docId: fileDocId,
      },
    ],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(planLocalStoreFullSnapshotReleaseTransaction(plan), [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'full-snapshot-release',
          patch: {
            id: snapshotPausedId,
            status: 'done',
            nextAttemptAt: undefined,
            completedBy: 'full-snapshot-apply',
            snapshotSeq: 20,
          },
        },
      },
    ])
  }
})

test('local store commit plan folds ack patch and lease release atomically', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 8,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const commit = planLocalStoreTransactionCommit({
      operations: planLocalStoreAckCompletionTransaction(completion),
      currentOutboxItemIds: [yUpdateId],
      currentLeaseRows: [existingLease],
    })

    assert.deepEqual(commit, {
      ok: true,
      outboxPutRecords: [],
      outboxPatchItemIds: [yUpdateId],
      leaseWrites: [],
      leaseDeletes: [{ itemId: yUpdateId, expectedLease: existingLease }],
      nextLeaseRows: [],
    })
  }
})

test('local store commit plan folds success patch and lease release atomically', () => {
  const existingLease = runningLease(leasedId, 'blob-put', 'worker-1', 30_000)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: leasedId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const commit = planLocalStoreTransactionCommit({
      operations: planLocalStoreSuccessCompletionTransaction(completion),
      currentOutboxItemIds: [leasedId],
      currentLeaseRows: [existingLease],
    })

    assert.deepEqual(commit, {
      ok: true,
      outboxPutRecords: [],
      outboxPatchItemIds: [leasedId],
      leaseWrites: [],
      leaseDeletes: [{ itemId: leasedId, expectedLease: existingLease }],
      nextLeaseRows: [],
    })
  }
})

test('local store commit plan rejects stale lease evidence before patching', () => {
  const expectedLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const stolenLease = runningLease(yUpdateId, 'y-update', 'worker-2', 40_000)
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 9,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: expectedLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      planLocalStoreTransactionCommit({
        operations: planLocalStoreAckCompletionTransaction(completion),
        currentOutboxItemIds: [yUpdateId],
        currentLeaseRows: [stolenLease],
      }),
      { ok: false, reason: 'lease-cas-mismatch', itemId: yUpdateId },
    )
  }
})

test('local store commit plan rejects missing outbox items and duplicate patches', () => {
  const scheduler = planOutboundQueueTick({
    items: [
      {
        id: pausedId,
        kind: 'materialize',
        status: 'paused',
        dependsOn: [],
        nextAttemptAt: undefined,
        resumeOn: 'manual',
      },
    ],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [],
    maxStarts: 1,
    authRefreshState: { status: 'idle' },
  })
  assert.equal(scheduler.ok, true)

  if (scheduler.ok) {
    const operations = planLocalStoreOutboxSchedulerTransaction(scheduler)
    assert.deepEqual(
      planLocalStoreTransactionCommit({
        operations,
        currentOutboxItemIds: [],
        currentLeaseRows: [],
      }),
      { ok: false, reason: 'missing-outbox-item', itemId: pausedId },
    )
    assert.deepEqual(
      planLocalStoreTransactionCommit({
        operations: [...operations, ...operations],
        currentOutboxItemIds: [pausedId],
        currentLeaseRows: [],
      }),
      { ok: false, reason: 'duplicate-outbox-patch', itemId: pausedId },
    )
  }
})

test('local store commit plan applies lease put CAS and detects duplicate current leases', () => {
  const start = schedulerStart(yUpdateId, 'y-update')
  const acquire = planOutboundQueueLeaseAcquire({
    start,
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 10_000,
    existingLease: undefined,
  })
  assert.equal(acquire.ok, true)

  if (acquire.ok) {
    assert.deepEqual(
      planLocalStoreTransactionCommit({
        operations: planLocalStoreLeaseAcquireTransaction(acquire),
        currentOutboxItemIds: [yUpdateId],
        currentLeaseRows: [],
      }),
      {
        ok: true,
        outboxPutRecords: [],
        outboxPatchItemIds: [],
        leaseWrites: [acquire.write],
        leaseDeletes: [],
        nextLeaseRows: [acquire.write.nextLease],
      },
    )
    assert.deepEqual(
      planLocalStoreTransactionCommit({
        operations: planLocalStoreLeaseAcquireTransaction(acquire),
        currentOutboxItemIds: [yUpdateId],
        currentLeaseRows: [
          runningLease(yUpdateId, 'y-update', 'worker-1', 11_000),
          runningLease(yUpdateId, 'y-update', 'worker-1', 11_000),
        ],
      }),
      { ok: false, reason: 'duplicate-current-lease', itemId: yUpdateId },
    )
  }
})

test('local store commit plan inserts new outbox records with absence guards', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'paused')
  const operation = {
    kind: 'put-outbox',
    put: { record },
  } as const

  assert.deepEqual(
    planLocalStoreTransactionCommit({
      operations: [operation],
      currentOutboxItemIds: [],
      currentLeaseRows: [],
    }),
    {
      ok: true,
      outboxPutRecords: [record],
      outboxPatchItemIds: [],
      leaseWrites: [],
      leaseDeletes: [],
      nextLeaseRows: [],
    },
  )
  assert.deepEqual(
    planLocalStoreTransactionCommit({
      operations: [operation],
      currentOutboxItemIds: [yUpdateId],
      currentLeaseRows: [],
    }),
    { ok: false, reason: 'existing-outbox-item', itemId: yUpdateId },
  )
  assert.deepEqual(
    planLocalStoreTransactionCommit({
      operations: [operation, operation],
      currentOutboxItemIds: [],
      currentLeaseRows: [],
    }),
    { ok: false, reason: 'duplicate-outbox-put', itemId: yUpdateId },
  )
})

test('local store applies ack completion patch to an outbox record', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const plan = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 10,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: runningLease(yUpdateId, 'y-update', 'worker-1', 30_000),
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    assert.deepEqual(
      applyLocalStoreOutboxPatch(record, {
        kind: 'ack-completion',
        itemId: yUpdateId,
        patch: plan.patch,
      }),
      {
        ok: true,
        record: {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
          durableSeq: 10,
        },
      },
    )
  }
})

test('local store applies success completion patch to a non-ack outbox record', () => {
  const record = outboxRecord(leasedId, 'blob-put', 'retrying')
  const plan = planOutboundQueueSuccessCompletion({
    itemId: leasedId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: runningLease(leasedId, 'blob-put', 'worker-1', 30_000),
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    assert.deepEqual(
      applyLocalStoreOutboxPatch(record, {
        kind: 'success-completion',
        itemId: leasedId,
        patch: plan.patch,
      }),
      {
        ok: true,
        record: {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
        },
      },
    )
  }
})

test('local store applies need-full-snapshot and quarantine pause patches', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const snapshotPause = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      reason: 'state-vector-too-old',
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(snapshotPause.ok, true)

  if (snapshotPause.ok) {
    assert.deepEqual(
      applyLocalStoreOutboxPatch(record, {
        kind: 'ack-completion',
        itemId: yUpdateId,
        patch: snapshotPause.patch,
      }),
      {
        ok: true,
        record: {
          ...record,
          status: 'paused',
          nextAttemptAt: undefined,
          reason: 'full-snapshot-required',
          resumeOn: 'manual',
          snapshotReason: 'state-vector-too-old',
          docId: fileDocId,
        },
      },
    )
  }

  const quarantinePause = planOutboundQueueQuarantinePause({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    deviceId,
    docId: fileDocId,
    messageId,
    updateSha256: updateHash,
    quarantine: {
      id: 'quarantine-2',
      docId: fileDocId,
      messageId,
      deviceId,
      reason: 'meta-schema-invalid',
      updateSha256: updateHash,
      updateBytesLength: 42,
      createdAt: 100,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(quarantinePause.ok, true)

  if (quarantinePause.ok) {
    assert.deepEqual(
      applyLocalStoreOutboxPatch(record, {
        kind: 'quarantine-pause',
        itemId: yUpdateId,
        patch: quarantinePause.patch,
      }),
      {
        ok: true,
        record: {
          ...record,
          status: 'paused',
          nextAttemptAt: undefined,
          reason: 'server-quarantine',
          resumeOn: 'manual',
          quarantineId: 'quarantine-2',
          quarantineReason: 'meta-schema-invalid',
          docId: fileDocId,
        },
      },
    )
  }
})

test('local store transaction snapshot applies outbox patches and lease rows together', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 11,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      applyLocalStoreTransactionSnapshot({
        operations: planLocalStoreAckCompletionTransaction(completion),
        currentOutboxRecords: [record],
        currentLeaseRows: [lease],
      }),
      {
        ok: true,
        outboxRecords: [
          {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
            durableSeq: 11,
          },
        ],
        leaseRows: [],
        commit: {
          ok: true,
          outboxPutRecords: [],
          outboxPatchItemIds: [yUpdateId],
          leaseWrites: [],
          leaseDeletes: [{ itemId: yUpdateId, expectedLease: lease }],
          nextLeaseRows: [],
        },
      },
    )
  }
})

test('local store transaction snapshot applies success completion and lease release together', () => {
  const record = outboxRecord(leasedId, 'blob-put', 'retrying')
  const lease = runningLease(leasedId, 'blob-put', 'worker-1', 30_000)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: leasedId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      applyLocalStoreTransactionSnapshot({
        operations: planLocalStoreSuccessCompletionTransaction(completion),
        currentOutboxRecords: [record],
        currentLeaseRows: [lease],
      }),
      {
        ok: true,
        outboxRecords: [
          {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
          },
        ],
        leaseRows: [],
        commit: {
          ok: true,
          outboxPutRecords: [],
          outboxPatchItemIds: [leasedId],
          leaseWrites: [],
          leaseDeletes: [{ itemId: leasedId, expectedLease: lease }],
          nextLeaseRows: [],
        },
      },
    )
  }
})

test('local store transaction snapshot rejects duplicate current outbox records', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'pending')
  const acquire = planOutboundQueueLeaseAcquire({
    start: schedulerStart(yUpdateId, 'y-update'),
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 10_000,
    existingLease: undefined,
  })
  assert.equal(acquire.ok, true)

  if (acquire.ok) {
    assert.deepEqual(
      applyLocalStoreTransactionSnapshot({
        operations: planLocalStoreLeaseAcquireTransaction(acquire),
        currentOutboxRecords: [record, record],
        currentLeaseRows: [],
      }),
      {
        ok: false,
        reason: 'duplicate-current-outbox-item',
        itemId: yUpdateId,
        commit: {
          ok: false,
          reason: 'duplicate-current-outbox-item',
          itemId: yUpdateId,
        },
      },
    )
  }
})

function runnableItem(
  id: OutboxSchedulerItem['id'],
  kind: OutboxSchedulerItem['kind'],
): OutboxSchedulerItem {
  return {
    id,
    kind,
    status: 'pending',
    dependsOn: [],
    nextAttemptAt: undefined,
  }
}

function schedulerStart(
  id: OutboxSchedulerStart['id'],
  kind: OutboxSchedulerStart['kind'],
): OutboxSchedulerStart {
  return {
    id,
    kind,
    lane: kind === 'blob-put' ? 'blob-transfer' : 'sync-control',
  }
}

function runningLease(
  itemId: OutboxSchedulerStart['id'],
  kind: OutboxSchedulerStart['kind'],
  ownerId: string,
  leaseExpiresAt: number,
) {
  return {
    itemId,
    kind,
    ownerId,
    leaseExpiresAt,
  } as const
}

function outboxRecord(
  id: OutboxPlanItemId,
  kind: LocalStoreOutboxRecord['kind'],
  status: LocalStoreOutboxRecord['status'],
): LocalStoreOutboxRecord {
  return {
    id,
    kind,
    status,
    dependsOn: [],
    nextAttemptAt: undefined,
  }
}

function outboxId(value: string): OutboxPlanItemId {
  const id = makeOutboxPlanItemId(value)
  assert(id !== null)
  return id
}
