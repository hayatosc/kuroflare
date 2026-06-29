import assert from 'node:assert/strict'

import {
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
  type OutboxSchedulerItem,
} from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type BlobManifest,
  type DocId,
} from '@kuroflare/protocol'
import { test } from 'vitest'

import { type LocalStoreOutboxRecord } from './local-store.js'
import { planOutboundQueueTick } from './outbound-queue.js'
import {
  classifyOutboxWorkerSideEffectCompletionEvidence,
  isSafeLocalBlobCacheKey,
  isSafeVaultRelativePath,
  planOutboxWorkerCompletionIndexedDbWriteTransaction,
  planOutboxWorkerAckCompletion,
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
} from './outbox-worker.js'

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
      record: { ...validRecord, lastMaterialized: undefined },
      endpoint: '',
      accessToken: undefined,
    }),
    { ok: false, reason: 'missing-last-materialized' },
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
