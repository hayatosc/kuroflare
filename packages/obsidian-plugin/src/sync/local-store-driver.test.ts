import assert from 'node:assert/strict'

import {
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeVaultId,
  makeYDocId,
  type DocId,
} from '@kuroflare/protocol'
import { test } from 'vitest'

import {
  applyLocalStoreDriverCommit,
  applyLocalStoreDriverTransaction,
  applyLocalStoreDriverWrites,
  planLocalStoreDriverReadSet,
  selectLocalStoreDriverSnapshot,
} from './local-store-driver.js'
import {
  planLocalStoreAckCompletionTransaction,
  planLocalStoreLeaseAcquireTransaction,
  planLocalStoreOutboxSchedulerTransaction,
  planLocalStoreSuccessCompletionTransaction,
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionOperation,
} from './local-store.js'
import {
  planOutboundQueueAckCompletion,
  planOutboundQueueLeaseAcquire,
  planOutboundQueueSuccessCompletion,
  planOutboundQueueTick,
} from './outbound-queue.js'

const yUpdateId = outboxId('driver-y-update-1')
const pausedId = outboxId('driver-paused-1')
const blobPutId = outboxId('driver-blob-put-1')
const vaultId = makeVaultId('vault-driver')
const deviceId = makeDeviceId('device-driver')
const messageId = makeMessageId('message-driver')
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-driver') } satisfies DocId

test('local store driver derives read set from outbox patches and lease operations', () => {
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
      durableSeq: 11,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      planLocalStoreDriverReadSet(planLocalStoreAckCompletionTransaction(completion)),
      {
        outboxItemIds: [yUpdateId],
        leaseItemIds: [yUpdateId],
      },
    )
  }
})

test('local store driver derives read set for success completion', () => {
  const existingLease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      planLocalStoreDriverReadSet(planLocalStoreSuccessCompletionTransaction(completion)),
      {
        outboxItemIds: [blobPutId],
        leaseItemIds: [blobPutId],
      },
    )
  }
})

test('local store driver read set preserves first-use order and de-duplicates keys', () => {
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
      {
        id: yUpdateId,
        kind: 'y-update',
        status: 'retrying',
        dependsOn: [],
        nextAttemptAt: undefined,
      },
    ],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [],
    maxStarts: 2,
    authRefreshState: { status: 'idle' },
  })
  assert.equal(scheduler.ok, true)

  const acquire = planOutboundQueueLeaseAcquire({
    start: {
      id: yUpdateId,
      kind: 'y-update',
      lane: 'sync-control',
    },
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 10_000,
    existingLease: undefined,
  })
  assert.equal(acquire.ok, true)

  if (scheduler.ok && acquire.ok) {
    const operations: readonly LocalStoreTransactionOperation[] = [
      ...planLocalStoreOutboxSchedulerTransaction(scheduler),
      ...planLocalStoreOutboxSchedulerTransaction(scheduler),
      ...planLocalStoreLeaseAcquireTransaction(acquire),
    ]

    assert.deepEqual(planLocalStoreDriverReadSet(operations), {
      outboxItemIds: [pausedId],
      leaseItemIds: [yUpdateId],
    })
  }
})

test('local store driver selects a transaction snapshot from read set keys', () => {
  const yUpdateRecord = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const pausedRecord = outboxRecord(pausedId, 'materialize', 'paused')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)

  assert.deepEqual(
    selectLocalStoreDriverSnapshot({
      source: {
        outboxRecords: [yUpdateRecord, pausedRecord],
        leaseRows: [lease],
      },
      readSet: {
        outboxItemIds: [pausedId, outboxId('driver-missing-outbox'), yUpdateId],
        leaseItemIds: [outboxId('driver-missing-lease'), yUpdateId],
      },
    }),
    {
      ok: true,
      snapshot: {
        outboxRecords: [pausedRecord, yUpdateRecord],
        leaseRows: [lease],
      },
    },
  )
})

test('local store driver snapshot selection rejects duplicate source rows and read keys', () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)

  assert.deepEqual(
    selectLocalStoreDriverSnapshot({
      source: {
        outboxRecords: [
          outboxRecord(yUpdateId, 'y-update', 'retrying'),
          outboxRecord(yUpdateId, 'y-update', 'pending'),
        ],
        leaseRows: [],
      },
      readSet: { outboxItemIds: [yUpdateId], leaseItemIds: [] },
    }),
    { ok: false, reason: 'duplicate-outbox-record', itemId: yUpdateId },
  )
  assert.deepEqual(
    selectLocalStoreDriverSnapshot({
      source: { outboxRecords: [], leaseRows: [lease, lease] },
      readSet: { outboxItemIds: [], leaseItemIds: [yUpdateId] },
    }),
    { ok: false, reason: 'duplicate-lease-row', itemId: yUpdateId },
  )
  assert.deepEqual(
    selectLocalStoreDriverSnapshot({
      source: { outboxRecords: [outboxRecord(yUpdateId, 'y-update', 'retrying')], leaseRows: [] },
      readSet: { outboxItemIds: [yUpdateId, yUpdateId], leaseItemIds: [] },
    }),
    { ok: false, reason: 'duplicate-read-outbox-item', itemId: yUpdateId },
  )
  assert.deepEqual(
    selectLocalStoreDriverSnapshot({
      source: { outboxRecords: [], leaseRows: [lease] },
      readSet: { outboxItemIds: [], leaseItemIds: [yUpdateId, yUpdateId] },
    }),
    { ok: false, reason: 'duplicate-read-lease-item', itemId: yUpdateId },
  )
})

test('local store driver commit applies patch and lease release atomically', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
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
      durableSeq: 12,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = applyLocalStoreDriverCommit({
      operations: planLocalStoreAckCompletionTransaction(completion),
      snapshot: { outboxRecords: [record], leaseRows: [existingLease] },
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.snapshot.outboxRecords, [
        {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
          durableSeq: 12,
        },
      ])
      assert.deepEqual(plan.snapshot.leaseRows, [])
      assert.deepEqual(plan.writes, [
        {
          kind: 'put-outbox-record',
          record: {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
            durableSeq: 12,
          },
        },
        { kind: 'delete-lease-row', itemId: yUpdateId, expectedLease: existingLease },
      ])
      assert.deepEqual(
        applyLocalStoreDriverWrites({
          snapshot: { outboxRecords: [record], leaseRows: [existingLease] },
          writes: plan.writes,
        }),
        { ok: true, snapshot: plan.snapshot },
      )
    }
  }
})

test('local store driver commit applies success completion and lease release atomically', () => {
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const existingLease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = applyLocalStoreDriverCommit({
      operations: planLocalStoreSuccessCompletionTransaction(completion),
      snapshot: { outboxRecords: [record], leaseRows: [existingLease] },
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.snapshot.outboxRecords, [
        {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
        },
      ])
      assert.deepEqual(plan.snapshot.leaseRows, [])
      assert.deepEqual(plan.writes, [
        {
          kind: 'put-outbox-record',
          record: {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
          },
        },
        { kind: 'delete-lease-row', itemId: blobPutId, expectedLease: existingLease },
      ])
      assert.deepEqual(
        applyLocalStoreDriverWrites({
          snapshot: { outboxRecords: [record], leaseRows: [existingLease] },
          writes: plan.writes,
        }),
        { ok: true, snapshot: plan.snapshot },
      )
    }
  }
})

test('local store driver transaction pipeline preserves unread rows', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const unreadRecord = outboxRecord(pausedId, 'materialize', 'paused')
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
      durableSeq: 14,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = applyLocalStoreDriverTransaction({
      source: {
        outboxRecords: [unreadRecord, record],
        leaseRows: [existingLease],
      },
      operations: planLocalStoreAckCompletionTransaction(completion),
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.readSet, { outboxItemIds: [yUpdateId], leaseItemIds: [yUpdateId] })
      assert.deepEqual(plan.selection.snapshot, {
        outboxRecords: [record],
        leaseRows: [existingLease],
      })
      assert.deepEqual(plan.snapshot, {
        outboxRecords: [
          unreadRecord,
          {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
            durableSeq: 14,
          },
        ],
        leaseRows: [],
      })
    }
  }
})

test('local store driver transaction pipeline reports commit failures after selection', () => {
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
      durableSeq: 15,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = applyLocalStoreDriverTransaction({
      source: { outboxRecords: [], leaseRows: [existingLease] },
      operations: planLocalStoreAckCompletionTransaction(completion),
    })

    assert.equal(plan.ok, false)
    if (!plan.ok) {
      assert.equal(plan.phase, 'commit')
      assert.equal(plan.reason, 'missing-outbox-item')
      assert.equal(plan.itemId, yUpdateId)
      assert.deepEqual(plan.readSet, { outboxItemIds: [yUpdateId], leaseItemIds: [yUpdateId] })
    }
  }
})

test('local store driver commit writes only the acquired lease row for lease CAS', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const acquire = planOutboundQueueLeaseAcquire({
    start: {
      id: yUpdateId,
      kind: 'y-update',
      lane: 'sync-control',
    },
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 10_000,
    existingLease: undefined,
  })
  assert.equal(acquire.ok, true)

  if (acquire.ok) {
    const plan = applyLocalStoreDriverCommit({
      operations: planLocalStoreLeaseAcquireTransaction(acquire),
      snapshot: { outboxRecords: [record], leaseRows: [] },
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.writes, [{ kind: 'put-lease-row', lease: acquire.write.nextLease }])
      assert.deepEqual(plan.snapshot.outboxRecords, [record])
      assert.deepEqual(plan.snapshot.leaseRows, [acquire.write.nextLease])
      assert.deepEqual(
        applyLocalStoreDriverWrites({
          snapshot: { outboxRecords: [record], leaseRows: [] },
          writes: plan.writes,
        }),
        { ok: true, snapshot: plan.snapshot },
      )
    }
  }
})

test('local store driver write replay rejects stale lease deletes', () => {
  const expectedLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const stolenLease = runningLease(yUpdateId, 'y-update', 'worker-2', 40_000)

  assert.deepEqual(
    applyLocalStoreDriverWrites({
      snapshot: {
        outboxRecords: [outboxRecord(yUpdateId, 'y-update', 'retrying')],
        leaseRows: [stolenLease],
      },
      writes: [{ kind: 'delete-lease-row', itemId: yUpdateId, expectedLease }],
    }),
    { ok: false, reason: 'lease-cas-mismatch', itemId: yUpdateId },
  )
})

test('local store driver commit rejects missing rows from the read snapshot', () => {
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
      durableSeq: 13,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    assert.deepEqual(
      applyLocalStoreDriverCommit({
        operations: planLocalStoreAckCompletionTransaction(completion),
        snapshot: { outboxRecords: [], leaseRows: [existingLease] },
      }),
      {
        ok: false,
        reason: 'missing-outbox-item',
        itemId: yUpdateId,
        apply: {
          ok: false,
          reason: 'missing-outbox-item',
          itemId: yUpdateId,
          commit: { ok: false, reason: 'missing-outbox-item', itemId: yUpdateId },
        },
      },
    )
  }
})

function outboxId(value: string): OutboxPlanItemId {
  const itemId = makeOutboxPlanItemId(value)
  assert(itemId !== null)
  return itemId
}

function runningLease(
  itemId: OutboxPlanItemId,
  kind: OutboxRunningLease['kind'],
  ownerId: string,
  leaseExpiresAt: number,
): OutboxRunningLease {
  return { itemId, kind, ownerId, leaseExpiresAt }
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
