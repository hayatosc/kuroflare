import { createHash } from 'node:crypto'

import {
  buildBinaryDownloadOutboxPlan,
  buildBinaryUploadOutboxPlan,
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeOutboxPlanItemId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type Ack,
  type BlobManifest,
  type DocId,
  type OutboxPlanItemId,
  type OutboxRunningLease,
  type OutboxSchedulerItem,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { planOutboundQueueTick } from '../engine/queue'
import {
  classifyOutboxWorkerSideEffectCompletionEvidence,
  isSafeLocalBlobCacheKey,
  isSafeVaultRelativePath,
  planOutboxWorkerAckCompletion,
  planOutboxWorkerCompletionIndexedDbWriteTransaction,
  planOutboxWorkerFailureCompletion,
  planOutboxWorkerFullSnapshotRelease,
  planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction,
  planOutboxWorkerLeaseRenewal,
  planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction,
  planOutboxWorkerQuarantineCompletion,
  planOutboxWorkerSideEffect,
  planOutboxWorkerSuccessCompletion,
  planOutboxWorkerTick,
  planOutboxWorkerTickIndexedDbWriteTransactions,
  runOutboxWorkerLocalSideEffect,
} from '../engine/worker'
import {
  type OutboxWorkerBlobCacheReadPlan,
  type OutboxWorkerBlobCacheWritePlan,
  type OutboxWorkerHttpRequestPlan,
  type OutboxWorkerHttpUploadBytesPlan,
  type OutboxWorkerLocalSideEffectRunnerPorts,
  type OutboxWorkerSideEffectResultEvidence,
  type OutboxWorkerVaultFileEvidence,
} from '../engine/worker.types'
import { type LocalStoreOutboxRecord } from '../store/store'

const yUpdateId = outboxId('worker-y-update-1')
const blobPutId = outboxId('worker-blob-put-1')
const pausedId = outboxId('worker-paused-1')
const duplicateId = outboxId('worker-duplicate-1')
const vaultId = makeVaultId('vault-1')
const deviceId = makeDeviceId('device-1')
const fileId = makeFileId('file-1')
const messageId = makeMessageId('message-1')
const updateHash = makeSha256Hex('d'.repeat(64))
const secondChunkHash = makeSha256Hex('e'.repeat(64))
const manifestHash = makeSha256Hex('c'.repeat(64))
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId
const metaDocId = { kind: 'meta' } satisfies DocId

test('outbox worker persists scheduler patches before acquiring leases and starting work', () => {
  const tick = planOutboundQueueTick({
    items: [
      pausedSchedulerItem(pausedId),
      runnableSchedulerItem(yUpdateId, 'y-update'),
      runnableSchedulerItem(blobPutId, 'blob-put'),
    ],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [],
    maxStarts: 3,
    authRefreshState: { status: 'idle' },
  })

  const plan = planOutboxWorkerTick({
    tick,
    currentOutboxRecords: [
      pausedOutboxRecord(pausedId),
      outboxRecord(yUpdateId, 'y-update'),
      outboxRecord(blobPutId, 'blob-put'),
    ],
    currentLeaseRows: [],
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.schedulerOperations, [
      {
        kind: 'patch-outbox',
        patch: {
          kind: 'resume',
          patch: { id: pausedId, status: 'pending', nextAttemptAt: undefined },
        },
      },
    ])
    assert.deepEqual(plan.schedulerReadSet, { outboxItemIds: [pausedId], leaseItemIds: [] })
    assert.deepEqual(plan.schedulerIndexedDbReads, [
      { kind: 'get', storeName: 'outbox', key: pausedId },
    ])
    assert.deepEqual(plan.schedulerWrites, [
      {
        kind: 'put-outbox-record',
        record: {
          ...pausedOutboxRecord(pausedId),
          status: 'pending',
          resumeOn: undefined,
          reason: undefined,
        },
      },
    ])
    assert.deepEqual(plan.schedulerIndexedDbWrites, [
      {
        kind: 'put',
        storeName: 'outbox',
        key: pausedId,
        value: {
          ...pausedOutboxRecord(pausedId),
          status: 'pending',
          resumeOn: undefined,
          reason: undefined,
        },
      },
    ])
    assert.deepEqual(
      plan.starts.map((effect) => effect.start.id),
      [pausedId, yUpdateId, blobPutId],
    )
    assert.deepEqual(
      plan.leaseAttempts.flatMap((attempt) => (attempt.ok ? attempt.writes : [])),
      [
        {
          kind: 'put-lease-row',
          lease: {
            itemId: pausedId,
            kind: 'materialize',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
        {
          kind: 'put-lease-row',
          lease: {
            itemId: yUpdateId,
            kind: 'y-update',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
        {
          kind: 'put-lease-row',
          lease: {
            itemId: blobPutId,
            kind: 'blob-put',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
      ],
    )
    assert.deepEqual(
      plan.leaseAttempts.flatMap((attempt) => (attempt.ok ? attempt.indexedDbReads : [])),
      [
        { kind: 'get', storeName: 'running-leases', key: pausedId },
        { kind: 'get', storeName: 'running-leases', key: yUpdateId },
        { kind: 'get', storeName: 'running-leases', key: blobPutId },
      ],
    )
    assert.deepEqual(
      plan.leaseAttempts.flatMap((attempt) => (attempt.ok ? attempt.indexedDbWrites : [])),
      [
        {
          kind: 'put',
          storeName: 'running-leases',
          key: pausedId,
          value: {
            itemId: pausedId,
            kind: 'materialize',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
        {
          kind: 'put',
          storeName: 'running-leases',
          key: yUpdateId,
          value: {
            itemId: yUpdateId,
            kind: 'y-update',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
        {
          kind: 'put',
          storeName: 'running-leases',
          key: blobPutId,
          value: {
            itemId: blobPutId,
            kind: 'blob-put',
            ownerId: 'worker-1',
            leaseExpiresAt: 31_000,
          },
        },
      ],
    )
    assert.deepEqual(planOutboxWorkerTickIndexedDbWriteTransactions(plan), [
      {
        kind: 'scheduler-persist',
        writes: plan.schedulerIndexedDbWrites,
      },
      ...plan.leaseAttempts.flatMap((attempt) =>
        attempt.ok
          ? [
              {
                kind: 'lease-acquire' as const,
                start: attempt.start,
                writes: attempt.indexedDbWrites,
              },
            ]
          : [],
      ),
    ])
    assert.deepEqual(
      plan.nextLeaseRows.map((lease) => ({
        itemId: lease.itemId,
        kind: lease.kind,
        ownerId: lease.ownerId,
        leaseExpiresAt: lease.leaseExpiresAt,
      })),
      [
        { itemId: pausedId, kind: 'materialize', ownerId: 'worker-1', leaseExpiresAt: 31_000 },
        { itemId: yUpdateId, kind: 'y-update', ownerId: 'worker-1', leaseExpiresAt: 31_000 },
        { itemId: blobPutId, kind: 'blob-put', ownerId: 'worker-1', leaseExpiresAt: 31_000 },
      ],
    )
    assert.equal(plan.nextOutboxRecords[0]?.status, 'pending')
  }
})

test('outbox worker skips start candidates whose lease is still active', () => {
  const activeLease = {
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'other-worker',
    leaseExpiresAt: 30_000,
  } as const
  const tick = planOutboundQueueTick({
    items: [runnableSchedulerItem(yUpdateId, 'y-update')],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: [],
    leases: [],
    maxStarts: 1,
    authRefreshState: { status: 'idle' },
  })

  const plan = planOutboxWorkerTick({
    tick,
    currentOutboxRecords: [outboxRecord(yUpdateId, 'y-update')],
    currentLeaseRows: [activeLease],
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.starts, [])
    assert.equal(plan.leaseAttempts.length, 1)
    assert.deepEqual(plan.leaseAttempts[0], {
      ok: false,
      start: { id: yUpdateId, kind: 'y-update', lane: 'sync-control' },
      reason: 'active-lease-exists',
      leaseAcquire: { ok: false, reason: 'active-lease-exists' },
    })
    assert.deepEqual(plan.nextLeaseRows, [activeLease])
  }
})

test('outbox worker stops before side effects when scheduler persist fails', () => {
  const tick = planOutboundQueueTick({
    items: [pausedSchedulerItem(pausedId)],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: ['manual'],
    leases: [],
    maxStarts: 1,
    authRefreshState: { status: 'idle' },
  })

  const plan = planOutboxWorkerTick({
    tick,
    currentOutboxRecords: [],
    currentLeaseRows: [],
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
  })

  assert.equal(plan.ok, false)
  if (!plan.ok) {
    assert.equal(plan.phase, 'scheduler-persist')
    assert.equal(plan.reason, 'missing-outbox-item')
    assert.deepEqual(plan.schedulerReadSet, { outboxItemIds: [pausedId], leaseItemIds: [] })
    assert.deepEqual(plan.schedulerIndexedDbReads, [
      { kind: 'get', storeName: 'outbox', key: pausedId },
    ])
    assert.deepEqual(plan.apply, {
      ok: false,
      reason: 'missing-outbox-item',
      itemId: pausedId,
      commit: { ok: false, reason: 'missing-outbox-item', itemId: pausedId },
    })
  }
})

test('outbox worker preserves scheduler validation failures', () => {
  const tick = planOutboundQueueTick({
    items: [
      runnableSchedulerItem(duplicateId, 'y-update'),
      runnableSchedulerItem(duplicateId, 'y-update'),
    ],
    now: 1_000,
    profile: 'desktop',
    resumeEvents: [],
    leases: [],
    maxStarts: 1,
    authRefreshState: { status: 'idle' },
  })
  if (tick.ok) {
    throw new Error('expected duplicate item IDs to reject scheduler tick')
  }

  assert.deepEqual(
    planOutboxWorkerTick({
      tick,
      currentOutboxRecords: [],
      currentLeaseRows: [],
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
    }),
    {
      ok: false,
      phase: 'scheduler',
      reason: 'duplicate-item-id',
      tick,
    },
  )
})

test('outbox worker carries auth refresh decisions without acquiring blocked starts', () => {
  const tick = planOutboundQueueTick({
    items: [runnableSchedulerItem(yUpdateId, 'y-update')],
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

  const plan = planOutboxWorkerTick({
    tick,
    currentOutboxRecords: [outboxRecord(yUpdateId, 'y-update')],
    currentLeaseRows: [],
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.starts, [])
    assert.deepEqual(plan.leaseAttempts, [])
    assert.deepEqual(plan.authRefresh, {
      action: 'request-refresh',
      reason: 'token-expiring-soon',
      requestedAt: 1_000,
      blockedItemIds: [yUpdateId],
    })
  }
})

test('outbox worker renews a running lease with a CAS write transaction', () => {
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 5_000)
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const plan = planOutboxWorkerLeaseRenewal({
    itemId: blobPutId,
    kind: 'blob-put',
    ownerId: 'worker-1',
    now: 1_000,
    leaseDurationMs: 30_000,
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.readSet, { outboxItemIds: [], leaseItemIds: [blobPutId] })
    assert.deepEqual(plan.indexedDbReads, [
      { kind: 'get', storeName: 'running-leases', key: blobPutId },
    ])
    assert.deepEqual(plan.writes, [
      {
        kind: 'put-lease-row',
        lease: {
          itemId: blobPutId,
          kind: 'blob-put',
          ownerId: 'worker-1',
          leaseExpiresAt: 31_000,
        },
      },
    ])
    assert.deepEqual(plan.indexedDbWrites, [
      {
        kind: 'put',
        storeName: 'running-leases',
        key: blobPutId,
        value: {
          itemId: blobPutId,
          kind: 'blob-put',
          ownerId: 'worker-1',
          leaseExpiresAt: 31_000,
        },
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [
      {
        itemId: blobPutId,
        kind: 'blob-put',
        ownerId: 'worker-1',
        leaseExpiresAt: 31_000,
      },
    ])
    assert.deepEqual(planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction(plan), {
      kind: 'lease-renew',
      writes: plan.indexedDbWrites,
    })
  }
})

test('outbox worker rejects stale lease renewal attempts before persistence', () => {
  const stolenLease = runningLease(blobPutId, 'blob-put', 'worker-2', 5_000)

  assert.deepEqual(
    planOutboxWorkerLeaseRenewal({
      itemId: blobPutId,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      currentOutboxRecords: [outboxRecord(blobPutId, 'blob-put', 'retrying')],
      currentLeaseRows: [stolenLease],
    }),
    {
      ok: false,
      phase: 'renewal',
      reason: 'owner-mismatch',
      renewal: { ok: false, reason: 'owner-mismatch' },
    },
  )
})

test('outbox worker plans blob-put HTTP side effects from a persisted lease', () => {
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 31_000)
  const record = {
    ...outboxRecord(blobPutId, 'blob-put', 'retrying'),
    blobSha256: updateHash,
    localCacheKey: 'blob-cache/chunk-1',
    blobSize: 123,
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: blobPutId, kind: 'blob-put', lane: 'blob-transfer' },
      lease,
    },
    record,
    endpoint: 'https://sync.example.test/api?ignored=1',
    accessToken: 'access-token',
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'blob-put')
    if (plan.action === 'blob-put') {
      assert.equal(plan.itemId, blobPutId)
      assert.deepEqual(plan.lease, lease)
      assert.deepEqual(plan.blob, {
        sha256: updateHash,
        size: 123,
        localCacheKey: 'blob-cache/chunk-1',
      })
      assert.deepEqual(plan.readLocalCache, {
        key: 'blob-cache/chunk-1',
        expectedSha256: updateHash,
        expectedSize: 123,
      })
      assert.deepEqual(plan.headRequest, {
        method: 'POST',
        url: 'https://sync.example.test/blobs/head',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        bodyJson: { hashes: [updateHash] },
      })
      assert.deepEqual(plan.uploadUrlRequest, {
        method: 'POST',
        url: 'https://sync.example.test/blobs/upload-url',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        bodyJson: { sha256: updateHash, size: 123 },
      })
      assert.deepEqual(plan.uploadPut, {
        method: 'PUT',
        urlSource: 'upload-url-response',
        authorization: 'device-access-token',
        bodySource: 'local-cache',
      })
    }
  }
})

test('outbox worker rejects underspecified blob-put side effects before I/O', () => {
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 31_000)
  const effect = {
    kind: 'start-side-effect',
    start: { id: blobPutId, kind: 'blob-put', lane: 'blob-transfer' },
    lease,
  } as const
  const validRecord = {
    ...outboxRecord(blobPutId, 'blob-put', 'retrying'),
    blobSha256: updateHash,
    localCacheKey: 'blob-cache/chunk-1',
    blobSize: 123,
  } satisfies LocalStoreOutboxRecord

  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: undefined,
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-record' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: outboxRecord(blobPutId, 'manifest-put', 'retrying'),
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'kind-mismatch' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, localCacheKey: 'blob-cache/../secret' },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'invalid-local-cache-key' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobSha256: undefined },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-blob-sha256' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, localCacheKey: '' },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-local-cache-key' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, localCacheKey: '/blob-cache/chunk-1' },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'invalid-local-cache-key' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobSize: -1 },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'invalid-blob-size' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: validRecord,
      endpoint: 'https://user:pass@sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'invalid-endpoint' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: validRecord,
      endpoint: 'https://sync.example.test',
      accessToken: '',
    }),
    { ok: false, reason: 'missing-access-token' },
  )
})

test('outbox worker plans manifest-put HTTP side effects after chunk uploads', () => {
  const lease = runningLease(blobPutId, 'manifest-put', 'worker-1', 31_000)
  const manifest = blobManifest()
  const record = {
    ...outboxRecord(blobPutId, 'manifest-put', 'retrying'),
    fileId,
    blobManifestHash: manifestHash,
    blobManifest: manifest,
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: blobPutId, kind: 'manifest-put', lane: 'blob-transfer' },
      lease,
    },
    record,
    endpoint: 'https://sync.example.test/api?ignored=1',
    accessToken: 'access-token',
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'manifest-put')
    if (plan.action === 'manifest-put') {
      assert.equal(plan.itemId, blobPutId)
      assert.equal(plan.fileId, fileId)
      assert.equal(plan.manifestHash, manifestHash)
      assert.deepEqual(plan.putManifestRequest, {
        method: 'PUT',
        url: `https://sync.example.test/blob-manifests/${manifestHash}.json`,
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        bodyJson: manifest,
        bodySource: 'canonical-blob-manifest-json',
      })
    }
  }
})

test('outbox worker rejects underspecified manifest-put side effects before I/O', () => {
  const lease = runningLease(blobPutId, 'manifest-put', 'worker-1', 31_000)
  const effect = {
    kind: 'start-side-effect',
    start: { id: blobPutId, kind: 'manifest-put', lane: 'blob-transfer' },
    lease,
  } as const
  const manifest = blobManifest()
  const validRecord = {
    ...outboxRecord(blobPutId, 'manifest-put', 'retrying'),
    fileId,
    blobManifestHash: manifestHash,
    blobManifest: manifest,
  } satisfies LocalStoreOutboxRecord

  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobManifestHash: undefined },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-blob-manifest-hash' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobManifest: undefined },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-blob-manifest' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, fileId: makeFileId('file-2') },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'manifest-file-mismatch' },
  )
})

test('outbox worker plans meta-ref-update websocket side effects after manifest PUT', () => {
  const lease = runningLease(blobPutId, 'meta-ref-update', 'worker-1', 31_000)
  const manifest = blobManifest()
  const record = {
    ...outboxRecord(blobPutId, 'meta-ref-update', 'retrying'),
    fileId,
    docId: metaDocId,
    messageId,
    updateSha256: updateHash,
    updateBytesBase64: 'AQID',
    blobManifestHash: manifestHash,
    blobManifest: manifest,
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: blobPutId, kind: 'meta-ref-update', lane: 'sync-control' },
      lease,
    },
    record,
    endpoint: '',
    accessToken: undefined,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'meta-ref-update')
    if (plan.action === 'meta-ref-update') {
      assert.equal(plan.itemId, blobPutId)
      assert.deepEqual(plan.binaryRef, {
        blobManifestHash: manifestHash,
        blobChunks: [updateHash, secondChunkHash],
      })
      assert.deepEqual(plan.sendSyncUpdate, {
        transport: 'active-sync-websocket',
        docId: metaDocId,
        messageId,
        updateSha256: updateHash,
        updateBytesBase64: 'AQID',
      })
    }
  }
})

test('outbox worker rejects underspecified meta-ref-update side effects before WS send', () => {
  const lease = runningLease(blobPutId, 'meta-ref-update', 'worker-1', 31_000)
  const effect = {
    kind: 'start-side-effect',
    start: { id: blobPutId, kind: 'meta-ref-update', lane: 'sync-control' },
    lease,
  } as const
  const manifest = blobManifest()
  const validRecord = {
    ...outboxRecord(blobPutId, 'meta-ref-update', 'retrying'),
    fileId,
    docId: metaDocId,
    messageId,
    updateSha256: updateHash,
    updateBytesBase64: 'AQID',
    blobManifestHash: manifestHash,
    blobManifest: manifest,
  } satisfies LocalStoreOutboxRecord

  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, docId: undefined },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-doc-id' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, messageId: undefined },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-message-id' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, updateSha256: undefined },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-update-sha256' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, updateBytesBase64: '' },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-update-bytes' },
  )
})

test('outbox worker plans blob-get HTTP side effects into the local blob cache', () => {
  const lease = runningLease(blobPutId, 'blob-get', 'worker-1', 31_000)
  const record = {
    ...outboxRecord(blobPutId, 'blob-get', 'retrying'),
    fileId,
    blobSha256: updateHash,
    localCacheKey: 'blob-cache/chunk-1',
    blobSize: 123,
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: blobPutId, kind: 'blob-get', lane: 'blob-transfer' },
      lease,
    },
    record,
    endpoint: 'https://sync.example.test/api?ignored=1',
    accessToken: 'access-token',
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'blob-get')
    if (plan.action === 'blob-get') {
      assert.equal(plan.itemId, blobPutId)
      assert.equal(plan.fileId, fileId)
      assert.deepEqual(plan.blob, {
        sha256: updateHash,
        size: 123,
        localCacheKey: 'blob-cache/chunk-1',
      })
      assert.deepEqual(plan.downloadRequest, {
        method: 'GET',
        url: `https://sync.example.test/blobs/${updateHash}`,
        headers: { authorization: 'Bearer access-token' },
      })
      assert.deepEqual(plan.writeLocalCache, {
        key: 'blob-cache/chunk-1',
        expectedSha256: updateHash,
        expectedSize: 123,
      })
    }
  }
})

test('outbox worker rejects underspecified blob-get side effects before I/O', () => {
  const lease = runningLease(blobPutId, 'blob-get', 'worker-1', 31_000)
  const effect = {
    kind: 'start-side-effect',
    start: { id: blobPutId, kind: 'blob-get', lane: 'blob-transfer' },
    lease,
  } as const
  const validRecord = {
    ...outboxRecord(blobPutId, 'blob-get', 'retrying'),
    fileId,
    blobSha256: updateHash,
    localCacheKey: 'blob-cache/chunk-1',
    blobSize: 123,
  } satisfies LocalStoreOutboxRecord

  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, fileId: undefined },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-file-id' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobSha256: undefined },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-blob-sha256' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, localCacheKey: '' },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'missing-local-cache-key' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, blobSize: 1.5 },
      endpoint: 'https://sync.example.test',
      accessToken: 'access-token',
    }),
    { ok: false, reason: 'invalid-blob-size' },
  )
})

test('outbox worker plans materialize side effects from manifest and cache evidence', () => {
  const lease = runningLease(pausedId, 'materialize', 'worker-1', 31_000)
  const manifest = blobManifest()
  const record = {
    ...outboxRecord(pausedId, 'materialize', 'retrying'),
    fileId,
    expectedHash: manifest.contentSha256,
    targetPath: 'Assets/payload.bin',
    blobManifest: manifest,
    materializeChunks: [
      { sha256: updateHash, localCacheKey: 'blob-cache/chunk-1', size: 64 },
      { sha256: secondChunkHash, localCacheKey: 'blob-cache/chunk-2', size: 59 },
    ],
    lastMaterialized: {
      ydocHash: 'old-ydoc-hash',
      diskHash: 'old-disk-hash',
      path: 'Assets/payload.bin',
      writtenAt: 900,
    },
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: pausedId, kind: 'materialize', lane: 'materialize' },
      lease,
    },
    record,
    endpoint: '',
    accessToken: undefined,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'materialize')
    if (plan.action === 'materialize') {
      assert.equal(plan.itemId, pausedId)
      assert.equal(plan.fileId, fileId)
      assert.equal(plan.targetPath, 'Assets/payload.bin')
      assert.equal(plan.expectedContentSha256, manifest.contentSha256)
      assert.deepEqual(plan.readChunks, [
        { sha256: updateHash, key: 'blob-cache/chunk-1', expectedSize: 64 },
        { sha256: secondChunkHash, key: 'blob-cache/chunk-2', expectedSize: 59 },
      ])
      assert.deepEqual(plan.assemble, {
        expectedContentSha256: manifest.contentSha256,
        expectedSize: 123,
      })
      assert.deepEqual(plan.diskCas, {
        path: 'Assets/payload.bin',
        lastMaterialized: {
          ydocHash: 'old-ydoc-hash',
          diskHash: 'old-disk-hash',
          path: 'Assets/payload.bin',
          writtenAt: 900,
        },
      })
      assert.deepEqual(plan.writeVaultFile, {
        path: 'Assets/payload.bin',
        bodySource: 'assembled-blob',
      })
    }
  }
})

test('outbox worker allows materialize without a CAS base for missing local files', () => {
  const lease = runningLease(pausedId, 'materialize', 'worker-1', 31_000)
  const manifest = blobManifest()
  const record = {
    ...outboxRecord(pausedId, 'materialize', 'retrying'),
    fileId,
    expectedHash: manifest.contentSha256,
    targetPath: 'Assets/payload.bin',
    blobManifest: manifest,
    materializeChunks: [
      { sha256: updateHash, localCacheKey: 'blob-cache/chunk-1', size: 64 },
      { sha256: secondChunkHash, localCacheKey: 'blob-cache/chunk-2', size: 59 },
    ],
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: pausedId, kind: 'materialize', lane: 'materialize' },
      lease,
    },
    record,
    endpoint: '',
    accessToken: undefined,
  })

  assert.equal(plan.ok, true)
  if (plan.ok && plan.action === 'materialize') {
    assert.equal(plan.diskCas.lastMaterialized, undefined)
  }
})

test('outbox worker preserves one binary manifest across plugin upload and download side effects', () => {
  const manifest = blobManifest()
  const upload = buildBinaryUploadOutboxPlan({
    fileId,
    blobManifestHash: manifestHash,
    chunks: [
      {
        id: outboxId('binary-flow-upload-chunk-1'),
        sha256: updateHash,
        localCacheKey: 'blob-cache/chunk-1',
        size: 64,
      },
      {
        id: outboxId('binary-flow-upload-chunk-2'),
        sha256: secondChunkHash,
        localCacheKey: 'blob-cache/chunk-2',
        size: 59,
      },
    ],
    manifestPutId: outboxId('binary-flow-upload-manifest'),
    metaRefUpdateId: outboxId('binary-flow-upload-meta-ref'),
  })
  assert.equal(upload.ok, true)

  const download = buildBinaryDownloadOutboxPlan({
    fileId,
    expectedHash: manifest.contentSha256,
    chunks: manifest.chunks.map((chunk, index) => ({
      id: outboxId(`binary-flow-download-chunk-${index.toString(36)}`),
      sha256: chunk.sha256,
      localCacheKey: `blob-cache/${chunk.sha256}`,
      size: chunk.size,
    })),
    materializeId: outboxId('binary-flow-download-materialize'),
  })
  assert.equal(download.ok, true)
  if (!upload.ok || !download.ok) {
    return
  }
  const uploadChunkPutId = upload.plan.chunkPuts[0]
  const downloadChunkGetId = download.plan.chunkGets[0]
  assert.notEqual(uploadChunkPutId, undefined)
  assert.notEqual(downloadChunkGetId, undefined)
  if (uploadChunkPutId === undefined || downloadChunkGetId === undefined) {
    return
  }

  const uploadChunkPut = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: uploadChunkPutId, kind: 'blob-put', lane: 'blob-transfer' },
      lease: runningLease(uploadChunkPutId, 'blob-put', 'worker-1', 31_000),
    },
    record: {
      ...outboxRecord(uploadChunkPutId, 'blob-put', 'retrying'),
      fileId,
      blobSha256: updateHash,
      localCacheKey: 'blob-cache/chunk-1',
      blobSize: 64,
    },
    endpoint: 'https://sync.example.test',
    accessToken: 'access-token',
  })
  const uploadManifestPut = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: upload.plan.manifestPut, kind: 'manifest-put', lane: 'blob-transfer' },
      lease: runningLease(upload.plan.manifestPut, 'manifest-put', 'worker-1', 31_000),
    },
    record: {
      ...outboxRecord(upload.plan.manifestPut, 'manifest-put', 'retrying'),
      fileId,
      blobManifestHash: manifestHash,
      blobManifest: manifest,
    },
    endpoint: 'https://sync.example.test',
    accessToken: 'access-token',
  })
  const uploadMetaRef = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: upload.plan.metaRefUpdate, kind: 'meta-ref-update', lane: 'sync-control' },
      lease: runningLease(upload.plan.metaRefUpdate, 'meta-ref-update', 'worker-1', 31_000),
    },
    record: {
      ...outboxRecord(upload.plan.metaRefUpdate, 'meta-ref-update', 'retrying'),
      fileId,
      docId: metaDocId,
      messageId,
      updateSha256: updateHash,
      updateBytesBase64: 'AQID',
      blobManifestHash: manifestHash,
      blobManifest: manifest,
    },
    endpoint: '',
    accessToken: undefined,
  })
  const downloadChunkGet = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: {
        id: downloadChunkGetId,
        kind: 'blob-get',
        lane: 'blob-transfer',
      },
      lease: runningLease(downloadChunkGetId, 'blob-get', 'worker-1', 31_000),
    },
    record: {
      ...outboxRecord(downloadChunkGetId, 'blob-get', 'retrying'),
      fileId,
      blobSha256: updateHash,
      localCacheKey: `blob-cache/${updateHash}`,
      blobSize: 64,
    },
    endpoint: 'https://sync.example.test',
    accessToken: 'access-token',
  })
  const downloadMaterialize = planOutboxWorkerSideEffect({
    effect: {
      kind: 'start-side-effect',
      start: { id: download.plan.materialize, kind: 'materialize', lane: 'materialize' },
      lease: runningLease(download.plan.materialize, 'materialize', 'worker-1', 31_000),
    },
    record: {
      ...outboxRecord(download.plan.materialize, 'materialize', 'retrying'),
      fileId,
      expectedHash: manifest.contentSha256,
      targetPath: 'Assets/payload.bin',
      blobManifestHash: manifestHash,
      blobManifest: manifest,
      materializeChunks: manifest.chunks.map((chunk) => ({
        sha256: chunk.sha256,
        localCacheKey: `blob-cache/${chunk.sha256}`,
        size: chunk.size,
      })),
    },
    endpoint: '',
    accessToken: undefined,
  })

  assert.equal(uploadChunkPut.ok, true)
  assert.equal(uploadManifestPut.ok, true)
  assert.equal(uploadMetaRef.ok, true)
  assert.equal(downloadChunkGet.ok, true)
  assert.equal(downloadMaterialize.ok, true)
  if (
    uploadChunkPut.ok &&
    uploadChunkPut.action === 'blob-put' &&
    uploadManifestPut.ok &&
    uploadManifestPut.action === 'manifest-put' &&
    uploadMetaRef.ok &&
    uploadMetaRef.action === 'meta-ref-update' &&
    downloadChunkGet.ok &&
    downloadChunkGet.action === 'blob-get' &&
    downloadMaterialize.ok &&
    downloadMaterialize.action === 'materialize'
  ) {
    assert.deepEqual(uploadManifestPut.putManifestRequest.bodyJson, manifest)
    assert.deepEqual(uploadMetaRef.binaryRef, {
      blobManifestHash: manifestHash,
      blobChunks: [updateHash, secondChunkHash],
    })
    assert.equal(
      downloadChunkGet.downloadRequest.url,
      `https://sync.example.test/blobs/${updateHash}`,
    )
    assert.deepEqual(downloadMaterialize.readChunks, [
      { sha256: updateHash, key: `blob-cache/${updateHash}`, expectedSize: 64 },
      { sha256: secondChunkHash, key: `blob-cache/${secondChunkHash}`, expectedSize: 59 },
    ])
    assert.equal(downloadMaterialize.assemble.expectedContentSha256, manifest.contentSha256)
    assert.deepEqual(downloadMaterialize.writeVaultFile, {
      path: 'Assets/payload.bin',
      bodySource: 'assembled-blob',
    })
  }
})

test('outbox worker fake harness uploads, downloads, materializes, and completes websocket ack', async () => {
  const firstChunk = new Uint8Array([1, 2, 3])
  const secondChunk = new Uint8Array([4, 5])
  const content = new Uint8Array([...firstChunk, ...secondChunk])
  const firstHash = sha256Hex(firstChunk)
  const secondHash = sha256Hex(secondChunk)
  const contentHash = sha256Hex(content)
  const upload = buildBinaryUploadOutboxPlan({
    fileId,
    blobManifestHash: manifestHash,
    chunks: [
      {
        id: outboxId('harness-upload-chunk-1'),
        sha256: firstHash,
        localCacheKey: `blob-cache/upload-${firstHash}`,
        size: firstChunk.byteLength,
      },
      {
        id: outboxId('harness-upload-chunk-2'),
        sha256: secondHash,
        localCacheKey: `blob-cache/upload-${secondHash}`,
        size: secondChunk.byteLength,
      },
    ],
    manifestPutId: outboxId('harness-upload-manifest'),
    metaRefUpdateId: outboxId('harness-upload-meta-ref'),
  })
  const download = buildBinaryDownloadOutboxPlan({
    fileId,
    expectedHash: contentHash,
    chunks: [
      {
        id: outboxId('harness-download-chunk-1'),
        sha256: firstHash,
        localCacheKey: `blob-cache/${firstHash}`,
        size: firstChunk.byteLength,
      },
      {
        id: outboxId('harness-download-chunk-2'),
        sha256: secondHash,
        localCacheKey: `blob-cache/${secondHash}`,
        size: secondChunk.byteLength,
      },
    ],
    materializeId: outboxId('harness-materialize'),
  })
  assert.equal(upload.ok, true)
  assert.equal(download.ok, true)
  if (!upload.ok || !download.ok) {
    return
  }
  const metaRefMessageId = makeMessageId('harness-meta-ref-message')
  const manifest = {
    version: 1,
    fileId,
    contentSha256: contentHash,
    size: content.byteLength,
    chunks: [
      { sha256: firstHash, offset: 0, size: firstChunk.byteLength },
      { sha256: secondHash, offset: firstChunk.byteLength, size: secondChunk.byteLength },
    ],
    createdBy: deviceId,
    createdAt: 1_000,
  } satisfies BlobManifest
  const harness = new FakeOutboxHarness(
    [
      {
        ...outboxRecord(upload.plan.chunkPuts[0] ?? outboxId('missing'), 'blob-put'),
        fileId,
        blobSha256: firstHash,
        localCacheKey: `blob-cache/upload-${firstHash}`,
        blobSize: firstChunk.byteLength,
      },
      {
        ...outboxRecord(upload.plan.chunkPuts[1] ?? outboxId('missing'), 'blob-put'),
        fileId,
        blobSha256: secondHash,
        localCacheKey: `blob-cache/upload-${secondHash}`,
        blobSize: secondChunk.byteLength,
      },
      {
        ...outboxRecord(upload.plan.manifestPut, 'manifest-put'),
        fileId,
        dependsOn: [...upload.plan.chunkPuts],
        blobManifestHash: manifestHash,
        blobManifest: manifest,
      },
      {
        ...outboxRecord(upload.plan.metaRefUpdate, 'meta-ref-update'),
        fileId,
        dependsOn: [...upload.plan.chunkPuts, upload.plan.manifestPut],
        docId: metaDocId,
        messageId: metaRefMessageId,
        updateSha256: contentHash,
        updateBytesBase64: 'AQID',
        blobManifestHash: manifestHash,
        blobManifest: manifest,
      },
      {
        ...outboxRecord(download.plan.chunkGets[0] ?? outboxId('missing'), 'blob-get'),
        fileId,
        blobSha256: firstHash,
        localCacheKey: `blob-cache/${firstHash}`,
        blobSize: firstChunk.byteLength,
      },
      {
        ...outboxRecord(download.plan.chunkGets[1] ?? outboxId('missing'), 'blob-get'),
        fileId,
        blobSha256: secondHash,
        localCacheKey: `blob-cache/${secondHash}`,
        blobSize: secondChunk.byteLength,
      },
      {
        ...outboxRecord(download.plan.materialize, 'materialize'),
        fileId,
        dependsOn: [...download.plan.chunkGets],
        expectedHash: contentHash,
        targetPath: 'Assets/payload.bin',
        blobManifestHash: sha256Hex(new TextEncoder().encode('manifest')),
        blobManifest: manifest,
        materializeChunks: manifest.chunks.map((chunk) => ({
          sha256: chunk.sha256,
          localCacheKey: `blob-cache/${chunk.sha256}`,
          size: chunk.size,
        })),
      },
      {
        ...outboxRecord(yUpdateId, 'y-update'),
        dependsOn: [download.plan.materialize],
        docId: fileDocId,
        messageId,
        updateSha256: updateHash,
        updateBytesBase64: 'AQID',
      },
    ],
    {},
  )
  harness.blobCache.set(`blob-cache/upload-${firstHash}`, firstChunk)
  harness.blobCache.set(`blob-cache/upload-${secondHash}`, secondChunk)

  await harness.runSideEffectTick(2)
  assert.deepEqual(
    harness.records.filter((record) => record.kind === 'blob-put').map((record) => record.status),
    ['done', 'done'],
  )
  assert.deepEqual(
    harness.uploadedBlobs.get(`https://sync.example.test/blobs/${firstHash}`),
    firstChunk,
  )
  assert.deepEqual(
    harness.uploadedBlobs.get(`https://sync.example.test/blobs/${secondHash}`),
    secondChunk,
  )
  await harness.runSideEffectTick(1)
  assert.equal(
    harness.records.find((record) => record.id === upload.plan.manifestPut)?.status,
    'done',
  )
  assert.deepEqual(
    harness.manifests.get(`https://sync.example.test/blob-manifests/${manifestHash}.json`),
    manifest,
  )

  await harness.acquireOne(upload.plan.metaRefUpdate)
  harness.completeAck({
    type: 'ack',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId,
    docId: metaDocId,
    messageId: metaRefMessageId,
    durableSeq: 41,
  })
  const metaRef = harness.records.find((record) => record.id === upload.plan.metaRefUpdate)
  assert.equal(metaRef?.status, 'done')
  assert.equal(metaRef?.durableSeq, 41)

  await harness.runSideEffectTick(2)
  assert.deepEqual(
    harness.records.filter((record) => record.kind === 'blob-get').map((record) => record.status),
    ['done', 'done'],
  )
  await harness.runSideEffectTick(1)
  assert.deepEqual(harness.vaultFiles.get('Assets/payload.bin'), content)
  assert.equal(harness.lastMaterialized.get('Assets/payload.bin')?.diskHash, contentHash)
  assert.equal(
    harness.records.find((record) => record.id === download.plan.materialize)?.status,
    'done',
  )

  await harness.acquireOne(yUpdateId)
  harness.completeAck({
    type: 'ack',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    durableSeq: 42,
  })
  const yUpdate = harness.records.find((record) => record.id === yUpdateId)
  assert.equal(yUpdate?.status, 'done')
  assert.equal(yUpdate?.durableSeq, 42)
  assert.deepEqual(harness.leases, [])
})

test('outbox worker rejects unsafe materialize side effects before disk I/O', () => {
  const lease = runningLease(pausedId, 'materialize', 'worker-1', 31_000)
  const manifest = blobManifest()
  const effect = {
    kind: 'start-side-effect',
    start: { id: pausedId, kind: 'materialize', lane: 'materialize' },
    lease,
  } as const
  const validRecord = {
    ...outboxRecord(pausedId, 'materialize', 'retrying'),
    fileId,
    expectedHash: manifest.contentSha256,
    targetPath: 'Assets/payload.bin',
    blobManifest: manifest,
    materializeChunks: [
      { sha256: updateHash, localCacheKey: 'blob-cache/chunk-1', size: 64 },
      { sha256: secondChunkHash, localCacheKey: 'blob-cache/chunk-2', size: 59 },
    ],
    lastMaterialized: {
      ydocHash: 'old-ydoc-hash',
      diskHash: 'old-disk-hash',
      path: 'Assets/payload.bin',
      writtenAt: 900,
    },
  } satisfies LocalStoreOutboxRecord

  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, targetPath: '' },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-target-path' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, targetPath: '../Assets/payload.bin' },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'invalid-target-path' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: { ...validRecord, expectedHash: updateHash },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'manifest-content-mismatch' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: {
        ...validRecord,
        materializeChunks: [{ sha256: updateHash, localCacheKey: 'blob-cache/chunk-1', size: 64 }],
      },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'manifest-chunk-key-mismatch' },
  )
  assert.deepEqual(
    planOutboxWorkerSideEffect({
      effect,
      record: {
        ...validRecord,
        materializeChunks: [
          { sha256: updateHash, localCacheKey: 'blob-cache/chunk-1', size: 64 },
          { sha256: secondChunkHash, localCacheKey: 'blob-cache/chunk\\2', size: 59 },
        ],
      },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'invalid-local-cache-key' },
  )
})

test('outbox worker path guards accept only normalized vault-relative paths', () => {
  assert.equal(isSafeVaultRelativePath('Assets/payload.bin'), true)
  assert.equal(isSafeVaultRelativePath('/Assets/payload.bin'), false)
  assert.equal(isSafeVaultRelativePath('Assets/../payload.bin'), false)
  assert.equal(isSafeVaultRelativePath('Assets//payload.bin'), false)
  assert.equal(isSafeVaultRelativePath('Assets\\payload.bin'), false)

  assert.equal(isSafeLocalBlobCacheKey('blob-cache/chunk-1'), true)
  assert.equal(isSafeLocalBlobCacheKey('blob-cache'), false)
  assert.equal(isSafeLocalBlobCacheKey('blob-cache/../chunk-1'), false)
  assert.equal(isSafeLocalBlobCacheKey('other-cache/chunk-1'), false)
})

test('outbox worker classifies side effect runner results before completion planning', () => {
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: blobPutId,
      kind: 'blob-put',
      status: 'retrying',
      retryCount: 1,
      result: { kind: 'success' },
    }),
    { ok: true, itemId: blobPutId, kind: 'blob-put', status: 'retrying' },
  )
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: blobPutId,
      kind: 'blob-put',
      status: 'retrying',
      retryCount: 1,
      result: { kind: 'http-response', status: 401, code: 'token-expired' },
    }),
    {
      ok: false,
      itemId: blobPutId,
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'auth' },
    },
  )
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: blobPutId,
      kind: 'blob-put',
      status: 'retrying',
      retryCount: 1,
      result: { kind: 'http-response', status: 429, retryAfterMs: 5_000, code: 'rate-limited' },
    }),
    {
      ok: false,
      itemId: blobPutId,
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'api', retryable: true, retryAfterMs: 5_000, code: 'rate-limited' },
    },
  )
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: blobPutId,
      kind: 'blob-put',
      status: 'retrying',
      retryCount: 1,
      result: { kind: 'http-response', status: 404, code: 'blob-missing' },
    }),
    {
      ok: false,
      itemId: blobPutId,
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'api', retryable: false, code: 'blob-missing' },
    },
  )
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: pausedId,
      kind: 'materialize',
      status: 'retrying',
      retryCount: 2,
      result: { kind: 'local-conflict' },
    }),
    {
      ok: false,
      itemId: pausedId,
      kind: 'materialize',
      retryCount: 2,
      error: { kind: 'local-conflict' },
    },
  )
  assert.deepEqual(
    classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: yUpdateId,
      kind: 'meta-ref-update',
      status: 'retrying',
      retryCount: 0,
      result: { kind: 'success' },
    }),
    {
      ok: false,
      itemId: yUpdateId,
      kind: 'meta-ref-update',
      retryCount: 0,
      error: { kind: 'invalid-payload' },
    },
  )
})

test('outbox worker commits ack completion and releases the lease atomically', () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const plan = planOutboxWorkerAckCompletion({
    itemId: yUpdateId,
    kind: record.kind,
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
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'ack-completion')
    assert.deepEqual(plan.readSet, { outboxItemIds: [yUpdateId], leaseItemIds: [yUpdateId] })
    assert.deepEqual(plan.indexedDbReads, [
      { kind: 'get', storeName: 'outbox', key: yUpdateId },
      { kind: 'get', storeName: 'running-leases', key: yUpdateId },
    ])
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 12,
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [])
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
      { kind: 'delete-lease-row', itemId: yUpdateId, expectedLease: lease },
    ])
    assert.deepEqual(plan.indexedDbWrites, [
      {
        kind: 'put',
        storeName: 'outbox',
        key: yUpdateId,
        value: {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
          durableSeq: 12,
        },
      },
      { kind: 'delete', storeName: 'running-leases', key: yUpdateId, expectedLease: lease },
    ])
    assert.deepEqual(planOutboxWorkerCompletionIndexedDbWriteTransaction(plan), {
      kind: 'completion-persist',
      action: 'ack-completion',
      writes: plan.indexedDbWrites,
    })
  }
})

test('outbox worker pauses for full snapshot and releases the lease atomically', () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const plan = planOutboxWorkerAckCompletion({
    itemId: yUpdateId,
    kind: record.kind,
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
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'pause-for-full-snapshot')
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...record,
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'full-snapshot-required',
        resumeOn: 'manual',
        snapshotReason: 'state-vector-too-old',
        docId: fileDocId,
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [])
  }
})

test('outbox worker releases full-snapshot-required items after snapshot apply', () => {
  const otherDocId = outboxId('worker-other-doc-full-snapshot')
  const manualPausedId = outboxId('worker-manual-paused-full-snapshot')
  const matching = {
    ...outboxRecord(yUpdateId, 'y-update', 'paused'),
    reason: 'full-snapshot-required',
    docId: fileDocId,
  } satisfies LocalStoreOutboxRecord
  const otherDoc = {
    ...outboxRecord(otherDocId, 'y-update', 'paused'),
    reason: 'full-snapshot-required',
    docId: { kind: 'file', ydocId: makeYDocId('worker-other-doc') },
  } satisfies LocalStoreOutboxRecord
  const manualPaused = {
    ...outboxRecord(manualPausedId, 'y-update', 'paused'),
    reason: 'manual-intervention-required',
    docId: fileDocId,
  } satisfies LocalStoreOutboxRecord

  const plan = planOutboxWorkerFullSnapshotRelease({
    appliedDocId: fileDocId,
    snapshotSeq: 20,
    currentOutboxRecords: [matching, otherDoc, manualPaused],
    currentLeaseRows: [],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.readSet, { outboxItemIds: [yUpdateId], leaseItemIds: [] })
    assert.deepEqual(plan.indexedDbReads, [{ kind: 'get', storeName: 'outbox', key: yUpdateId }])
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...matching,
        status: 'done',
        nextAttemptAt: undefined,
        completedBy: 'full-snapshot-apply',
        snapshotSeq: 20,
      },
      otherDoc,
      manualPaused,
    ])
    assert.deepEqual(plan.indexedDbWrites, [
      {
        kind: 'put',
        storeName: 'outbox',
        key: yUpdateId,
        value: {
          ...matching,
          status: 'done',
          nextAttemptAt: undefined,
          completedBy: 'full-snapshot-apply',
          snapshotSeq: 20,
        },
      },
    ])
    assert.deepEqual(planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(plan), {
      kind: 'full-snapshot-release',
      writes: plan.indexedDbWrites,
    })
  }
})

test('outbox worker rejects invalid full snapshot release evidence', () => {
  assert.deepEqual(
    planOutboxWorkerFullSnapshotRelease({
      appliedDocId: fileDocId,
      snapshotSeq: -1,
      currentOutboxRecords: [],
      currentLeaseRows: [],
    }),
    {
      ok: false,
      phase: 'release',
      reason: 'invalid-snapshot-seq',
      release: { ok: false, reason: 'invalid-snapshot-seq' },
    },
  )
})

test('outbox worker commits quarantine pause and releases the lease atomically', () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const plan = planOutboxWorkerQuarantineCompletion({
    itemId: yUpdateId,
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
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'pause-for-quarantine')
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...record,
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'server-quarantine',
        resumeOn: 'manual',
        quarantineId: 'quarantine-1',
        quarantineReason: 'meta-schema-invalid',
        docId: fileDocId,
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [])
  }
})

test('outbox worker rejects stale completions before applying patches', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  assert.deepEqual(
    planOutboxWorkerAckCompletion({
      itemId: yUpdateId,
      kind: record.kind,
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
      currentOutboxRecords: [record],
      currentLeaseRows: [runningLease(yUpdateId, 'y-update', 'worker-2', 30_000)],
    }),
    {
      ok: false,
      phase: 'completion',
      reason: 'owner-mismatch',
      completion: {
        ok: false,
        reason: 'owner-mismatch',
        leaseRelease: { ok: false, reason: 'owner-mismatch' },
      },
    },
  )
})

test('outbox worker marks successful non-ack side effects done and releases the lease atomically', () => {
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const plan = planOutboxWorkerSuccessCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'success-completion')
    assert.deepEqual(plan.readSet, { outboxItemIds: [blobPutId], leaseItemIds: [blobPutId] })
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [])
    assert.deepEqual(plan.indexedDbWrites, [
      {
        kind: 'put',
        storeName: 'outbox',
        key: blobPutId,
        value: {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
        },
      },
      { kind: 'delete', storeName: 'running-leases', key: blobPutId, expectedLease: lease },
    ])
  }
})

test('outbox worker rejects unsupported or stale non-ack success completions', () => {
  const blobRecord = outboxRecord(blobPutId, 'blob-put', 'retrying')
  assert.deepEqual(
    planOutboxWorkerSuccessCompletion({
      itemId: blobPutId,
      kind: 'blob-put',
      status: 'retrying',
      ownerId: 'worker-1',
      now: 1_000,
      currentOutboxRecords: [blobRecord],
      currentLeaseRows: [runningLease(blobPutId, 'blob-put', 'worker-2', 30_000)],
    }),
    {
      ok: false,
      phase: 'completion',
      reason: 'owner-mismatch',
      completion: {
        ok: false,
        reason: 'owner-mismatch',
        leaseRelease: { ok: false, reason: 'owner-mismatch' },
      },
    },
  )

  assert.deepEqual(
    planOutboxWorkerSuccessCompletion({
      itemId: yUpdateId,
      kind: 'meta-ref-update',
      status: 'retrying',
      ownerId: 'worker-1',
      now: 1_000,
      currentOutboxRecords: [outboxRecord(yUpdateId, 'meta-ref-update', 'retrying')],
      currentLeaseRows: [runningLease(yUpdateId, 'meta-ref-update', 'worker-1', 30_000)],
    }),
    {
      ok: false,
      phase: 'completion',
      reason: 'unsupported-kind',
      completion: { ok: false, reason: 'unsupported-kind' },
    },
  )
})

test('outbox worker retries failed attempts and releases the lease atomically', () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const record = { ...outboxRecord(yUpdateId, 'y-update', 'retrying'), retryCount: 0 }
  const plan = planOutboxWorkerFailureCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    retryCount: 0,
    error: { kind: 'network' },
    ownerId: 'worker-1',
    now: 1_000,
    currentOutboxRecords: [record],
    currentLeaseRows: [lease],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.action, 'retry-after-failure')
    assert.deepEqual(plan.nextOutboxRecords, [
      {
        ...record,
        status: 'retrying',
        retryCount: 1,
        nextAttemptAt: 1_250,
        lastError: { kind: 'network' },
      },
    ])
    assert.deepEqual(plan.nextLeaseRows, [])
  }
})

test('outbox worker pauses or dead-letters failed attempts and releases the lease', () => {
  const materializeLease = runningLease(pausedId, 'materialize', 'worker-1', 30_000)
  const materializeRecord = { ...outboxRecord(pausedId, 'materialize', 'retrying'), retryCount: 3 }
  const paused = planOutboxWorkerFailureCompletion({
    itemId: pausedId,
    kind: 'materialize',
    retryCount: 3,
    error: { kind: 'timeout' },
    ownerId: 'worker-1',
    now: 1_000,
    currentOutboxRecords: [materializeRecord],
    currentLeaseRows: [materializeLease],
  })
  assert.equal(paused.ok, true)
  if (paused.ok) {
    assert.equal(paused.action, 'pause-after-failure')
    assert.deepEqual(paused.nextOutboxRecords, [
      {
        ...materializeRecord,
        status: 'paused',
        retryCount: 3,
        nextAttemptAt: undefined,
        lastError: { kind: 'timeout' },
        reason: 'manual-intervention-required',
        resumeOn: 'manual',
      },
    ])
    assert.deepEqual(paused.nextLeaseRows, [])
  }

  const blobLease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const blobRecord = { ...outboxRecord(blobPutId, 'blob-put', 'retrying'), retryCount: 1 }
  const failed = planOutboxWorkerFailureCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    retryCount: 1,
    error: { kind: 'api', retryable: false, code: 'blob/hash-mismatch' },
    ownerId: 'worker-1',
    now: 1_000,
    currentOutboxRecords: [blobRecord],
    currentLeaseRows: [blobLease],
  })
  assert.equal(failed.ok, true)
  if (failed.ok) {
    assert.equal(failed.action, 'dead-letter-after-failure')
    assert.deepEqual(failed.nextOutboxRecords, [
      {
        ...blobRecord,
        status: 'failed',
        retryCount: 1,
        nextAttemptAt: undefined,
        lastError: { kind: 'api', retryable: false, code: 'blob/hash-mismatch' },
        reason: 'dead-letter',
        deadLetterReason: 'non-retryable-api-error',
      },
    ])
    assert.deepEqual(failed.nextLeaseRows, [])
  }
})

test('outbox worker rejects stale failed-attempt completions', () => {
  const record = { ...outboxRecord(yUpdateId, 'y-update', 'retrying'), retryCount: 0 }
  assert.deepEqual(
    planOutboxWorkerFailureCompletion({
      itemId: yUpdateId,
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'network' },
      ownerId: 'worker-1',
      now: 1_000,
      currentOutboxRecords: [record],
      currentLeaseRows: [runningLease(yUpdateId, 'y-update', 'worker-2', 30_000)],
    }),
    {
      ok: false,
      phase: 'completion',
      reason: 'owner-mismatch',
      completion: {
        ok: false,
        reason: 'owner-mismatch',
        leaseRelease: { ok: false, reason: 'owner-mismatch' },
      },
    },
  )
})

class FakeOutboxHarness implements OutboxWorkerLocalSideEffectRunnerPorts {
  records: LocalStoreOutboxRecord[]
  leases: OutboxRunningLease[] = []
  readonly blobCache = new Map<string, Uint8Array>()
  readonly uploadedBlobs = new Map<string, Uint8Array>()
  readonly manifests = new Map<string, unknown>()
  readonly vaultFiles = new Map<string, Uint8Array>()
  readonly lastMaterialized = new Map<
    string,
    NonNullable<LocalStoreOutboxRecord['lastMaterialized']>
  >()
  private nowMs = 1_000

  constructor(
    records: readonly LocalStoreOutboxRecord[],
    private readonly downloads: Readonly<Record<string, Uint8Array>>,
  ) {
    this.records = [...records]
  }

  async runSideEffectTick(maxStarts: number): Promise<void> {
    const workerTick = this.planTick(maxStarts)
    this.records = [...workerTick.nextOutboxRecords]
    this.leases = [...workerTick.nextLeaseRows]
    for (const start of workerTick.starts) {
      const record = this.records.find((candidate) => candidate.id === start.start.id)
      const sideEffect = planOutboxWorkerSideEffect({
        effect: start,
        record,
        endpoint: 'https://sync.example.test',
        accessToken: 'access-token',
      })
      if (!sideEffect.ok) {
        throw new Error(sideEffect.reason)
      }
      assert.equal(sideEffect.ok, true)
      if (sideEffect.action === 'meta-ref-update') {
        continue
      }
      const result = await runOutboxWorkerLocalSideEffect(sideEffect, this)
      this.completeNonAck(record, result)
    }
  }

  async acquireOne(id: OutboxPlanItemId): Promise<void> {
    const workerTick = this.planTick(1)
    assert.equal(
      workerTick.starts.some((start) => start.start.id === id),
      true,
    )
    this.records = [...workerTick.nextOutboxRecords]
    this.leases = [...workerTick.nextLeaseRows]
  }

  completeAck(message: Ack): void {
    const record = this.records.find((candidate) => candidate.messageId === message.messageId)
    assert.notEqual(record, undefined)
    if (record === undefined || record.docId === undefined || record.messageId === undefined) {
      throw new Error('ack record missing')
    }
    const plan = planOutboxWorkerAckCompletion({
      itemId: record.id,
      kind: record.kind,
      status: record.status,
      vaultId,
      deviceId,
      docId: record.docId,
      messageId: record.messageId,
      message,
      ownerId: 'worker-1',
      now: this.nextNow(),
      currentOutboxRecords: this.records,
      currentLeaseRows: this.leases,
    })
    assert.equal(plan.ok, true)
    if (!plan.ok) {
      throw new Error(plan.reason)
    }
    this.records = [...plan.nextOutboxRecords]
    this.leases = [...plan.nextLeaseRows]
  }

  async sendJsonRequest(
    request: OutboxWorkerHttpRequestPlan,
  ): Promise<
    | { readonly kind: 'success'; readonly body: unknown }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  > {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/blobs/head') {
      const hashes = jsonHashes(request.bodyJson)
      if (hashes === undefined) {
        return { kind: 'invalid-payload', code: 'blob-head-request-invalid' }
      }
      return {
        kind: 'success',
        body: {
          exists: Object.fromEntries(
            hashes.map((hash) => {
              const bytes = this.uploadedBlobs.get(`https://sync.example.test/blobs/${hash}`)
              return [
                hash,
                bytes === undefined ? { found: false } : { found: true, size: bytes.byteLength },
              ]
            }),
          ),
        },
      }
    }
    if (request.method === 'POST' && url.pathname === '/blobs/upload-url') {
      const body = uploadUrlRequestBody(request.bodyJson)
      if (body === undefined) {
        return { kind: 'invalid-payload', code: 'blob-upload-url-request-invalid' }
      }
      if (this.uploadedBlobs.has(`https://sync.example.test/blobs/${body.sha256}`)) {
        return { kind: 'success', body: { kind: 'already-exists' } }
      }
      return {
        kind: 'success',
        body: {
          kind: 'single-put',
          url: `https://upload.example.test/${body.sha256}`,
          headers: { 'content-type': 'application/octet-stream' },
          expiresAt: this.nextNow() + 30_000,
        },
      }
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/blob-manifests/')) {
      this.manifests.set(request.url, request.bodyJson)
      return { kind: 'success', body: { ok: true } }
    }
    return { kind: 'http-response', status: 404, code: 'not-found' }
  }

  async uploadBytes(
    request: OutboxWorkerHttpUploadBytesPlan,
    bytes: Uint8Array,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    const url = new URL(request.url)
    const hash = url.pathname.slice(1)
    if (request.method !== 'PUT' || hash.length === 0) {
      return { kind: 'invalid-payload', code: 'blob-upload-request-invalid' }
    }
    this.uploadedBlobs.set(`https://sync.example.test/blobs/${hash}`, bytes)
    return { kind: 'success' }
  }

  async downloadBytes(
    request: OutboxWorkerHttpRequestPlan,
  ): Promise<
    | { readonly kind: 'success'; readonly bytes: Uint8Array }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  > {
    const bytes = this.downloads[request.url] ?? this.uploadedBlobs.get(request.url)
    return bytes === undefined
      ? { kind: 'http-response', status: 404, code: 'not-found' }
      : { kind: 'success', bytes }
  }

  async readBlobCache(plan: OutboxWorkerBlobCacheReadPlan): Promise<Uint8Array | undefined> {
    return this.blobCache.get(plan.key)
  }

  async writeBlobCache(plan: OutboxWorkerBlobCacheWritePlan, bytes: Uint8Array): Promise<void> {
    this.blobCache.set(plan.key, bytes)
  }

  async readVaultFile(path: string): Promise<OutboxWorkerVaultFileEvidence> {
    const bytes = this.vaultFiles.get(path)
    return bytes === undefined ? { kind: 'missing' } : { kind: 'file', bytes }
  }

  async ensureVaultParentFolders(): Promise<boolean> {
    return true
  }

  async writeVaultFile(path: string, bytes: Uint8Array): Promise<void> {
    this.vaultFiles.set(path, bytes)
  }

  getActiveFilePath(): string | undefined {
    return undefined
  }

  writeLastMaterialized(record: NonNullable<LocalStoreOutboxRecord['lastMaterialized']>): void {
    this.lastMaterialized.set(record.path, record)
  }

  now(): number {
    return this.nextNow()
  }

  async sha256Hex(bytes: Uint8Array): Promise<string> {
    return sha256Hex(bytes)
  }

  private completeNonAck(
    record: LocalStoreOutboxRecord | undefined,
    result: OutboxWorkerSideEffectResultEvidence,
  ): void {
    assert.notEqual(record, undefined)
    if (record === undefined) {
      throw new Error('side effect record missing')
    }
    const evidence = classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: record.id,
      kind: record.kind,
      status: record.status,
      retryCount: record.retryCount ?? 0,
      result,
    })
    const plan = evidence.ok
      ? planOutboxWorkerSuccessCompletion({
          itemId: evidence.itemId,
          kind: evidence.kind,
          status: evidence.status,
          ownerId: 'worker-1',
          now: this.nextNow(),
          currentOutboxRecords: this.records,
          currentLeaseRows: this.leases,
        })
      : planOutboxWorkerFailureCompletion({
          itemId: evidence.itemId,
          kind: evidence.kind,
          retryCount: evidence.retryCount,
          error: evidence.error,
          ownerId: 'worker-1',
          now: this.nextNow(),
          currentOutboxRecords: this.records,
          currentLeaseRows: this.leases,
        })
    assert.equal(plan.ok, true)
    if (!plan.ok) {
      throw new Error(plan.reason)
    }
    this.records = [...plan.nextOutboxRecords]
    this.leases = [...plan.nextLeaseRows]
  }

  private planTick(
    maxStarts: number,
  ): Extract<ReturnType<typeof planOutboxWorkerTick>, { readonly ok: true }> {
    const tick = planOutboundQueueTick({
      items: this.records,
      now: this.nextNow(),
      profile: 'desktop',
      resumeEvents: [],
      leases: this.leases,
      maxStarts,
      authRefreshState: { status: 'idle' },
    })
    const workerTick = planOutboxWorkerTick({
      tick,
      currentOutboxRecords: this.records,
      currentLeaseRows: this.leases,
      ownerId: 'worker-1',
      now: this.nextNow(),
      leaseDurationMs: 30_000,
    })
    assert.equal(workerTick.ok, true)
    if (!workerTick.ok) {
      throw new Error(workerTick.reason)
    }
    return workerTick
  }

  private nextNow(): number {
    this.nowMs += 1
    return this.nowMs
  }
}

function runnableSchedulerItem(
  id: OutboxPlanItemId,
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

function pausedSchedulerItem(id: OutboxPlanItemId): OutboxSchedulerItem {
  return {
    id,
    kind: 'materialize',
    status: 'paused',
    dependsOn: [],
    nextAttemptAt: undefined,
    resumeOn: 'manual',
  }
}

function outboxRecord(
  id: OutboxPlanItemId,
  kind: LocalStoreOutboxRecord['kind'],
  status: LocalStoreOutboxRecord['status'] = 'pending',
): LocalStoreOutboxRecord {
  return {
    id,
    kind,
    status,
    dependsOn: [],
    nextAttemptAt: undefined,
  }
}

function pausedOutboxRecord(id: OutboxPlanItemId): LocalStoreOutboxRecord {
  return {
    id,
    kind: 'materialize',
    status: 'paused',
    dependsOn: [],
    nextAttemptAt: undefined,
    resumeOn: 'manual',
  }
}

function runningLease(
  itemId: OutboxPlanItemId,
  kind: LocalStoreOutboxRecord['kind'],
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

function blobManifest(): BlobManifest {
  return {
    version: 1,
    fileId,
    contentSha256: makeSha256Hex('f'.repeat(64)),
    size: 123,
    chunks: [
      { sha256: updateHash, offset: 0, size: 64 },
      { sha256: secondChunkHash, offset: 64, size: 59 },
    ],
    createdBy: deviceId,
    createdAt: 1_000,
  }
}

function outboxId(value: string): OutboxPlanItemId {
  const id = makeOutboxPlanItemId(value)
  assert(id !== null)
  return id
}

function sha256Hex(bytes: Uint8Array): ReturnType<typeof makeSha256Hex> {
  return makeSha256Hex(createHash('sha256').update(bytes).digest('hex'))
}

function jsonHashes(body: unknown): readonly string[] | undefined {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('hashes' in body) ||
    !Array.isArray(body.hashes)
  ) {
    return undefined
  }
  return body.hashes.every((hash): hash is string => typeof hash === 'string')
    ? body.hashes
    : undefined
}

function uploadUrlRequestBody(
  body: unknown,
): { readonly sha256: string; readonly size: number } | undefined {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('sha256' in body) ||
    !('size' in body) ||
    typeof body.sha256 !== 'string' ||
    typeof body.size !== 'number'
  ) {
    return undefined
  }
  return { sha256: body.sha256, size: body.size }
}
