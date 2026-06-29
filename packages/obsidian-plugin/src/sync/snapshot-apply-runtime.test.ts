import assert from 'node:assert/strict'

import {
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import { makeSha256Hex, makeYDocId, type DocId } from '@kuroflare/protocol'
import { test } from 'vitest'

import {
  type LocalStoreIndexedDbObjectStorePort,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from './local-store-indexeddb.js'
import { type LocalStoreOutboxRecord } from './local-store.js'
import {
  commitFullSnapshotApplyIndexedDbTransaction,
  planFullSnapshotApplyRuntime,
  type FullSnapshotApplyIndexedDbDatabasePort,
  type FullSnapshotApplyIndexedDbObjectStorePorts,
  type FullSnapshotApplyIndexedDbTransactionHandle,
  type FullSnapshotApplyRemoteCursorObjectStorePort,
  type FullSnapshotApplyRemoteCursorRecord,
  type FullSnapshotApplyYDocObjectStorePort,
  type FullSnapshotApplyYDocRecord,
  type VerifiedFullSnapshotBytes,
} from './snapshot-apply-runtime.js'

const fileDocId = { kind: 'file', ydocId: makeYDocId('snapshot-runtime-doc-1') } satisfies DocId
const updateHash = makeSha256Hex('a'.repeat(64))
const stateVectorHash = makeSha256Hex('b'.repeat(64))
const snapshotPausedId = outboxId('snapshot-runtime-paused-1')

test('snapshot apply runtime plans local apply and full snapshot outbox release together', () => {
  const paused = {
    ...outboxRecord(snapshotPausedId, 'y-update', 'paused'),
    reason: 'full-snapshot-required',
    docId: fileDocId,
  } satisfies LocalStoreOutboxRecord

  const plan = planFullSnapshotApplyRuntime({
    requestedDocId: fileDocId,
    response: snapshotResponse(),
    verifiedBytes: verifiedBytes(),
    currentSnapshotSeq: 10,
    hasPendingLocalUpdates: false,
    activeEditorBound: false,
    currentOutboxRecords: [paused],
    currentLeaseRows: [],
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.patch, {
      docId: fileDocId,
      snapshotSeq: 20,
      remoteCursorSeq: 20,
      stateVectorBase64: 'AQID',
      clearPendingForDoc: true,
    })
    assert.deepEqual(plan.updateBytes, Uint8Array.from([4, 5, 6]))
    assert.deepEqual(plan.stateVectorBytes, Uint8Array.from([1, 2, 3]))
    assert.deepEqual(plan.outboxRelease.nextOutboxRecords, [
      {
        ...paused,
        status: 'done',
        nextAttemptAt: undefined,
        completedBy: 'full-snapshot-apply',
        snapshotSeq: 20,
      },
    ])
    assert.deepEqual(plan.indexedDbWriteTransaction, {
      kind: 'snapshot-apply',
      ydocWrite: {
        kind: 'put',
        storeName: 'file-ydocs',
        key: fileDocId.ydocId,
        value: {
          docId: fileDocId,
          updateBytes: Uint8Array.from([4, 5, 6]),
          snapshotSeq: 20,
        },
      },
      remoteCursorWrite: {
        kind: 'put',
        storeName: 'remote-cursors',
        key: `file:${fileDocId.ydocId}`,
        value: {
          docId: fileDocId,
          snapshotSeq: 20,
          remoteCursorSeq: 20,
          stateVectorBase64: 'AQID',
        },
      },
      outboxWrites: plan.outboxRelease.indexedDbWrites,
    })
  }
})

test('snapshot apply runtime waits before local mutation when local state is unsafe', () => {
  assert.deepEqual(
    planFullSnapshotApplyRuntime({
      requestedDocId: fileDocId,
      response: snapshotResponse(),
      verifiedBytes: verifiedBytes(),
      currentSnapshotSeq: 10,
      hasPendingLocalUpdates: true,
      activeEditorBound: false,
      currentOutboxRecords: [],
      currentLeaseRows: [],
    }),
    { ok: false, action: 'wait', reason: 'pending-local-updates' },
  )
})

test('snapshot apply runtime rejects release persistence failures before local mutation', () => {
  const firstPaused = {
    ...outboxRecord(snapshotPausedId, 'y-update', 'paused'),
    reason: 'full-snapshot-required',
    docId: fileDocId,
  } satisfies LocalStoreOutboxRecord
  const duplicatePaused = { ...firstPaused }

  const plan = planFullSnapshotApplyRuntime({
    requestedDocId: fileDocId,
    response: snapshotResponse(),
    verifiedBytes: verifiedBytes(),
    currentSnapshotSeq: 10,
    hasPendingLocalUpdates: false,
    activeEditorBound: false,
    currentOutboxRecords: [firstPaused, duplicatePaused],
    currentLeaseRows: [],
  })

  assert.deepEqual(plan, {
    ok: false,
    action: 'outbox-release-reject',
    reason: 'duplicate-current-outbox-item',
    outboxRelease: {
      ok: false,
      phase: 'release-persist',
      reason: 'duplicate-current-outbox-item',
      readSet: { outboxItemIds: [snapshotPausedId], leaseItemIds: [] },
      indexedDbReads: [{ kind: 'get', storeName: 'outbox', key: snapshotPausedId }],
      driverCommit: {
        ok: false,
        reason: 'duplicate-current-outbox-item',
        itemId: snapshotPausedId,
        apply: {
          ok: false,
          reason: 'duplicate-current-outbox-item',
          itemId: snapshotPausedId,
          commit: { ok: false, reason: 'duplicate-current-outbox-item', itemId: snapshotPausedId },
        },
      },
      apply: {
        ok: false,
        reason: 'duplicate-current-outbox-item',
        itemId: snapshotPausedId,
        commit: { ok: false, reason: 'duplicate-current-outbox-item', itemId: snapshotPausedId },
      },
    },
  })
})

test('snapshot apply indexeddb commit queues all writes before awaiting completion', async () => {
  const paused = {
    ...outboxRecord(snapshotPausedId, 'y-update', 'paused'),
    reason: 'full-snapshot-required',
    docId: fileDocId,
  } satisfies LocalStoreOutboxRecord
  const plan = planFullSnapshotApplyRuntime({
    requestedDocId: fileDocId,
    response: snapshotResponse(),
    verifiedBytes: verifiedBytes(),
    currentSnapshotSeq: 10,
    hasPendingLocalUpdates: false,
    activeEditorBound: false,
    currentOutboxRecords: [paused],
    currentLeaseRows: [],
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    const database = new FakeSnapshotApplyDatabasePort()
    const committed = commitFullSnapshotApplyIndexedDbTransaction({
      database,
      transaction: plan.indexedDbWriteTransaction,
    })
    let completed = false
    void committed.then(() => {
      completed = true
    })

    assert.deepEqual(database.transaction.stores.fileYDocs.operations, [
      {
        key: fileDocId.ydocId,
        value: {
          docId: fileDocId,
          updateBytes: Uint8Array.from([4, 5, 6]),
          snapshotSeq: 20,
        },
      },
    ])
    assert.deepEqual(database.transaction.stores.remoteCursors.operations, [
      {
        key: `file:${fileDocId.ydocId}`,
        value: {
          docId: fileDocId,
          snapshotSeq: 20,
          remoteCursorSeq: 20,
          stateVectorBase64: 'AQID',
        },
      },
    ])
    assert.deepEqual(
      database.transaction.stores.outbox.operations.map((operation) => operation.key),
      [snapshotPausedId],
    )
    database.transaction.succeedAllRequests()
    await Promise.resolve()
    assert.equal(completed, false)

    database.transaction.lifecycle.complete()
    await committed
    assert.equal(completed, true)
  }
})

function snapshotResponse() {
  return {
    docId: fileDocId,
    manifestSeq: 3,
    snapshotKey: 'snapshots/vault-1/files/snapshot-runtime-doc-1/20.yupdate',
    snapshotSeq: 20,
    updateSha256: updateHash,
    stateVectorSha256: stateVectorHash,
    stateVector: 'AQID',
    updateBytesBase64: 'BAUG',
  }
}

function verifiedBytes(): VerifiedFullSnapshotBytes {
  return {
    ok: true,
    updateBytes: Uint8Array.from([4, 5, 6]),
    stateVectorBytes: Uint8Array.from([1, 2, 3]),
    actualUpdateSha256: updateHash,
    actualStateVectorSha256: stateVectorHash,
  }
}

function outboxId(value: string): OutboxPlanItemId {
  const itemId = makeOutboxPlanItemId(value)
  assert(itemId !== null)
  return itemId
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

class FakeSnapshotApplyDatabasePort implements FullSnapshotApplyIndexedDbDatabasePort {
  transaction = new FakeSnapshotApplyTransactionHandle()

  openFullSnapshotApplyTransaction(): FullSnapshotApplyIndexedDbTransactionHandle {
    this.transaction = new FakeSnapshotApplyTransactionHandle()
    return this.transaction
  }
}

class FakeSnapshotApplyTransactionHandle implements FullSnapshotApplyIndexedDbTransactionHandle {
  readonly stores = {
    metaYDoc: new DeferredSnapshotApplyYDocStore(),
    fileYDocs: new DeferredSnapshotApplyYDocStore(),
    remoteCursors: new DeferredSnapshotApplyRemoteCursorStore(),
    outbox: new DeferredLocalStoreObjectStore<LocalStoreOutboxRecord>(),
    runningLeases: new DeferredLocalStoreObjectStore<OutboxRunningLease>(),
  } satisfies FullSnapshotApplyIndexedDbObjectStorePorts
  readonly lifecycle = new DeferredTransactionLifecycle()

  succeedAllRequests(): void {
    this.stores.metaYDoc.succeedAll()
    this.stores.fileYDocs.succeedAll()
    this.stores.remoteCursors.succeedAll()
    this.stores.outbox.succeedAll()
    this.stores.runningLeases.succeedAll()
  }
}

class DeferredSnapshotApplyYDocStore implements FullSnapshotApplyYDocObjectStorePort {
  readonly operations: {
    readonly key: IDBValidKey
    readonly value: FullSnapshotApplyYDocRecord
  }[] = []
  readonly #requests: DeferredIndexedDbRequest<IDBValidKey>[] = []

  put(
    value: FullSnapshotApplyYDocRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey> {
    const request = new DeferredIndexedDbRequest(key)
    this.operations.push({ key, value })
    this.#requests.push(request)
    return request
  }

  succeedAll(): void {
    for (const request of this.#requests) {
      request.succeed()
    }
  }
}

class DeferredSnapshotApplyRemoteCursorStore implements FullSnapshotApplyRemoteCursorObjectStorePort {
  readonly operations: {
    readonly key: IDBValidKey
    readonly value: FullSnapshotApplyRemoteCursorRecord
  }[] = []
  readonly #requests: DeferredIndexedDbRequest<IDBValidKey>[] = []

  put(
    value: FullSnapshotApplyRemoteCursorRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey> {
    const request = new DeferredIndexedDbRequest(key)
    this.operations.push({ key, value })
    this.#requests.push(request)
    return request
  }

  succeedAll(): void {
    for (const request of this.#requests) {
      request.succeed()
    }
  }
}

class DeferredLocalStoreObjectStore<Value> implements LocalStoreIndexedDbObjectStorePort<Value> {
  readonly operations: {
    readonly kind: 'put' | 'delete'
    readonly key: IDBValidKey | undefined
    readonly value?: Value | undefined
  }[] = []
  readonly #requests: DeferredIndexedDbRequest<unknown>[] = []

  get(key: IDBValidKey): LocalStoreIndexedDbRequest<Value | undefined> {
    void key
    return new DeferredIndexedDbRequest<Value | undefined>(undefined)
  }

  put(value: Value, key?: IDBValidKey): LocalStoreIndexedDbRequest<IDBValidKey> {
    const request = new DeferredIndexedDbRequest<IDBValidKey>(key ?? 0)
    this.operations.push({ kind: 'put', key, value })
    this.#requests.push(request)
    return request
  }

  delete(key: IDBValidKey): LocalStoreIndexedDbRequest<undefined> {
    const request = new DeferredIndexedDbRequest<undefined>(undefined)
    this.operations.push({ kind: 'delete', key })
    this.#requests.push(request)
    return request
  }

  succeedAll(): void {
    for (const request of this.#requests) {
      request.succeed()
    }
  }
}

class DeferredTransactionLifecycle implements LocalStoreIndexedDbTransactionLifecycle {
  readonly error = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  #completed = false
  #oncomplete: ((event: Event) => void) | null = null

  get oncomplete(): ((event: Event) => void) | null {
    return this.#oncomplete
  }

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.#oncomplete = handler
    if (handler !== null && this.#completed) {
      queueMicrotask(() => {
        handler(new Event('complete'))
      })
    }
  }

  complete(): void {
    if (this.#oncomplete === null) {
      this.#completed = true
      return
    }
    this.#oncomplete(new Event('complete'))
  }
}

class DeferredIndexedDbRequest<Result> implements LocalStoreIndexedDbRequest<Result> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null

  constructor(readonly result: Result) {}

  succeed(): void {
    if (this.onsuccess !== null) {
      this.onsuccess(new Event('success'))
    }
  }
}
