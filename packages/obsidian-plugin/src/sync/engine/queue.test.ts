import {
  makeDeviceId,
  makeMessageId,
  makeOutboxPlanItemId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type DocId,
  type OutboxPlanItemId,
  type OutboxSchedulerItem,
  type OutboxSchedulerStart,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  planOutboundQueueAckCompletion,
  planOutboundQueueFullSnapshotRelease,
  planOutboundQueueLeaseAcquire,
  planOutboundQueueLeaseRelease,
  planOutboundQueueLeaseRenew,
  planOutboundQueueQuarantinePause,
  planOutboundQueueTick,
} from '../engine/queue'

const yUpdateId = outboxId('y-update-1')
const blobPutId = outboxId('blob-put-1')
const pausedId = outboxId('paused-1')
const vaultId = makeVaultId('vault-1')
const deviceId = makeDeviceId('device-1')
const messageId = makeMessageId('message-1')
const firstHash = makeSha256Hex('a'.repeat(64))
const secondHash = makeSha256Hex('b'.repeat(64))
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId

test('outbound queue tick separates persist patches from lease start candidates', () => {
  const items = [
    {
      id: pausedId,
      kind: 'materialize',
      status: 'paused',
      dependsOn: [],
      nextAttemptAt: undefined,
      resumeOn: 'manual',
    },
    runnableItem(yUpdateId, 'y-update'),
  ] satisfies readonly OutboxSchedulerItem[]

  const plan = planOutboundQueueTick({
    items,
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [],
    maxStarts: 2,
    authRefreshState: { status: 'idle' },
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.persist.resumePatches, [
      { id: pausedId, status: 'pending', nextAttemptAt: undefined },
    ])
    assert.deepEqual(
      plan.leaseCandidates.map((start) => start.id),
      [pausedId, yUpdateId],
    )
    assert.deepEqual(plan.authRefresh, { action: 'noop', reason: 'no-auth-blocks' })
  }
})

test('outbound queue tick requests auth refresh before auth-protected starts', () => {
  const plan = planOutboundQueueTick({
    items: [runnableItem(yUpdateId, 'y-update')],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: [],
    leases: [],
    maxStarts: 1,
    auth: {
      tokenExpiresAt: 1_100,
      refreshMarginMs: 500,
      defaultEstimatedDurationMs: 200,
    },
    authRefreshState: { status: 'idle' },
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.leaseCandidates, [])
    assert.deepEqual(plan.authRefresh, {
      action: 'request-refresh',
      reason: 'token-expiring-soon',
      requestedAt: 1_000,
      blockedItemIds: [yUpdateId],
    })
  }
})

test('outbound queue tick preserves scheduler validation failures', () => {
  const plan = planOutboundQueueTick({
    items: [runnableItem(blobPutId, 'blob-put'), runnableItem(blobPutId, 'blob-put')],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: [],
    leases: [],
    maxStarts: 1,
    authRefreshState: { status: 'idle' },
  })

  assert.deepEqual(plan, {
    ok: false,
    reason: 'duplicate-item-id',
    id: blobPutId,
    schedulerPlan: {
      ok: false,
      reason: 'duplicate-item-id',
      id: blobPutId,
    },
  })
})

test('outbound queue lease acquire returns a CAS write before side effects start', () => {
  const start = schedulerStart(yUpdateId, 'y-update')
  const plan = planOutboundQueueLeaseAcquire({
    start,
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
    existingLease: undefined,
  })

  assert.deepEqual(plan, {
    ok: true,
    action: 'acquire',
    write: {
      itemId: yUpdateId,
      expectedLease: undefined,
      nextLease: {
        itemId: yUpdateId,
        kind: 'y-update',
        ownerId: 'worker-1',
        leaseExpiresAt: 31_000,
      },
    },
    previousOwnerId: undefined,
  })
})

test('outbound queue lease acquire can take over expired leases but rejects active leases', () => {
  const start = schedulerStart(blobPutId, 'blob-put')
  const expiredLease = {
    itemId: blobPutId,
    kind: 'blob-put',
    ownerId: 'stale-worker',
    leaseExpiresAt: 900,
  } as const

  assert.deepEqual(
    planOutboundQueueLeaseAcquire({
      start,
      ownerId: 'worker-2',
      now: 1_000,
      leaseDurationMs: 10_000,
      existingLease: expiredLease,
    }),
    {
      ok: true,
      action: 'take-over-expired',
      write: {
        itemId: blobPutId,
        expectedLease: expiredLease,
        nextLease: {
          itemId: blobPutId,
          kind: 'blob-put',
          ownerId: 'worker-2',
          leaseExpiresAt: 11_000,
        },
      },
      previousOwnerId: 'stale-worker',
    },
  )

  assert.deepEqual(
    planOutboundQueueLeaseAcquire({
      start,
      ownerId: 'worker-2',
      now: 1_000,
      leaseDurationMs: 10_000,
      existingLease: { ...expiredLease, leaseExpiresAt: 1_001 },
    }),
    { ok: false, reason: 'active-lease-exists' },
  )
})

test('outbound queue lease renew returns a CAS write for the current owner', () => {
  const existingLease = {
    itemId: blobPutId,
    kind: 'blob-put',
    ownerId: 'worker-1',
    leaseExpiresAt: 5_000,
  } as const

  assert.deepEqual(
    planOutboundQueueLeaseRenew({
      itemId: blobPutId,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 10_000,
      existingLease,
    }),
    {
      ok: true,
      write: {
        itemId: blobPutId,
        expectedLease: existingLease,
        nextLease: {
          itemId: blobPutId,
          kind: 'blob-put',
          ownerId: 'worker-1',
          leaseExpiresAt: 11_000,
        },
      },
    },
  )
})

test('outbound queue lease release returns a CAS delete after state transition', () => {
  const existingLease = {
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'worker-1',
    leaseExpiresAt: 5_000,
  } as const

  assert.deepEqual(
    planOutboundQueueLeaseRelease({
      itemId: yUpdateId,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease,
    }),
    {
      ok: true,
      delete: {
        itemId: yUpdateId,
        expectedLease: existingLease,
      },
    },
  )
})

test('outbound queue lease renew and release reject stale or stolen completions', () => {
  const stolenLease = {
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'worker-2',
    leaseExpiresAt: 5_000,
  } as const
  const expiredLease = {
    ...stolenLease,
    ownerId: 'worker-1',
    leaseExpiresAt: 1_000,
  } as const

  assert.deepEqual(
    planOutboundQueueLeaseRenew({
      itemId: yUpdateId,
      kind: 'y-update',
      ownerId: 'worker-1',
      now: 2_000,
      leaseDurationMs: 10_000,
      existingLease: stolenLease,
    }),
    { ok: false, reason: 'owner-mismatch' },
  )

  assert.deepEqual(
    planOutboundQueueLeaseRelease({
      itemId: yUpdateId,
      ownerId: 'worker-1',
      now: 2_000,
      existingLease: expiredLease,
    }),
    { ok: false, reason: 'lease-expired' },
  )
})

test('outbound queue ack completion returns an atomic item patch and lease release', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 5_000)
  const plan = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    minDurableSeqExclusive: 40,
    message: {
      type: 'ack',
      protocolVersion: 1,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 41,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })

  assert.deepEqual(plan, {
    ok: true,
    action: 'complete',
    itemId: yUpdateId,
    patch: {
      status: 'done',
      nextAttemptAt: undefined,
      durableSeq: 41,
    },
    leaseDelete: {
      itemId: yUpdateId,
      expectedLease: existingLease,
    },
  })
})

test('outbound queue ack completion pauses for full snapshot and releases the lease atomically', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 5_000)
  const plan = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'pending',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'need-full-snapshot',
      protocolVersion: 1,
      vaultId,
      deviceId,
      docId: fileDocId,
      reason: 'state-vector-too-old',
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease,
  })

  assert.deepEqual(plan, {
    ok: true,
    action: 'pause-for-full-snapshot',
    itemId: yUpdateId,
    patch: {
      status: 'paused',
      nextAttemptAt: undefined,
      reason: 'full-snapshot-required',
      resumeOn: 'manual',
      snapshotReason: 'state-vector-too-old',
      docId: fileDocId,
    },
    leaseDelete: {
      itemId: yUpdateId,
      expectedLease: existingLease,
    },
  })
})

test('outbound queue ack completion rejects mismatched acks and stale leases before patching', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 5_000)
  const ack = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    durableSeq: 41,
  } as const

  assert.deepEqual(
    planOutboundQueueAckCompletion({
      itemId: yUpdateId,
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId: makeMessageId('message-2'),
      message: ack,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease,
    }),
    {
      ok: false,
      reason: 'message-mismatch',
      ackDecision: { action: 'reject', reason: 'message-mismatch' },
    },
  )

  assert.deepEqual(
    planOutboundQueueAckCompletion({
      itemId: yUpdateId,
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      message: ack,
      ownerId: 'worker-1',
      now: 6_000,
      existingLease,
    }),
    {
      ok: false,
      reason: 'lease-expired',
      leaseRelease: { ok: false, reason: 'lease-expired' },
    },
  )
})

test('outbound queue quarantine pause returns an atomic pause patch and lease release', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 5_000)
  const quarantine = quarantineEntry('quarantine-1', firstHash)

  assert.deepEqual(
    planOutboundQueueQuarantinePause({
      itemId: yUpdateId,
      kind: 'y-update',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      updateSha256: firstHash,
      quarantine,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease,
    }),
    {
      ok: true,
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
      leaseDelete: {
        itemId: yUpdateId,
        expectedLease: existingLease,
      },
    },
  )
})

test('outbound queue quarantine pause rejects unrelated evidence and stale leases', () => {
  const existingLease = runningLease(yUpdateId, 'y-update', 'worker-1', 5_000)
  const quarantine = quarantineEntry('quarantine-1', firstHash)

  assert.deepEqual(
    planOutboundQueueQuarantinePause({
      itemId: yUpdateId,
      kind: 'y-update',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      updateSha256: secondHash,
      quarantine,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease,
    }),
    {
      ok: false,
      reason: 'hash-mismatch',
      quarantineDecision: { action: 'reject', reason: 'hash-mismatch' },
    },
  )

  assert.deepEqual(
    planOutboundQueueQuarantinePause({
      itemId: yUpdateId,
      kind: 'y-update',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      quarantine,
      ownerId: 'worker-1',
      now: 6_000,
      existingLease,
    }),
    {
      ok: false,
      reason: 'lease-expired',
      leaseRelease: { ok: false, reason: 'lease-expired' },
    },
  )
})

test('outbound queue full snapshot release closes only superseded paused y-updates', () => {
  const matching = outboxId('matching-full-snapshot')
  const otherDoc = outboxId('other-doc')
  const manualPaused = outboxId('manual-paused')

  assert.deepEqual(
    planOutboundQueueFullSnapshotRelease({
      appliedDocId: fileDocId,
      snapshotSeq: 20,
      items: [
        {
          id: matching,
          kind: 'y-update',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: fileDocId,
        },
        {
          id: otherDoc,
          kind: 'y-update',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: { kind: 'file', ydocId: makeYDocId('doc-2') },
        },
        {
          id: manualPaused,
          kind: 'y-update',
          status: 'paused',
          reason: 'manual-intervention-required',
          docId: fileDocId,
        },
      ],
    }),
    {
      ok: true,
      releasePatches: [
        {
          id: matching,
          status: 'done',
          nextAttemptAt: undefined,
          completedBy: 'full-snapshot-apply',
          snapshotSeq: 20,
        },
      ],
    },
  )
})

test('outbound queue full snapshot release validates snapshot sequence', () => {
  assert.deepEqual(
    planOutboundQueueFullSnapshotRelease({
      appliedDocId: fileDocId,
      snapshotSeq: -1,
      items: [],
    }),
    { ok: false, reason: 'invalid-snapshot-seq' },
  )
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

function quarantineEntry(id: string, updateSha256: typeof firstHash) {
  return {
    id,
    docId: fileDocId,
    messageId,
    deviceId,
    reason: 'meta-schema-invalid',
    updateSha256,
    updateBytesLength: 42,
    createdAt: 100,
  } as const
}

function outboxId(value: string): OutboxPlanItemId {
  const id = makeOutboxPlanItemId(value)
  assert(id !== null)
  return id
}
