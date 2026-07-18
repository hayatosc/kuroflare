import {
  decideFullSnapshotApply,
  makeFullSnapshotApplyInputFromResponse,
  type DocId,
  type DocLatestSnapshotResponse,
  type FullSnapshotApplyPatch,
  type FullSnapshotBytesFromResponseResult,
  type MetaLatestSnapshotResponse,
  type OutboxRunningLease,
} from '@kuroflare/core'

import {
  planOutboxWorkerFullSnapshotRelease,
  planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction,
  type OutboxWorkerFullSnapshotReleasePlan,
  type OutboxWorkerIndexedDbWriteOperation,
} from '../engine/worker'
import {
  queueLocalStoreIndexedDbConcreteWrites,
  type LocalStoreIndexedDbObjectStorePort,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'
import { type LocalStoreOutboxRecord } from '../store/store'

/** Verified full snapshot bytes accepted by the runtime planner. */
export type VerifiedFullSnapshotBytes = Extract<
  FullSnapshotBytesFromResponseResult,
  { readonly ok: true }
>

/** Input for planning one full snapshot apply in the plugin runtime. */
export interface FullSnapshotApplyRuntimeInput {
  readonly requestedDocId: DocId
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly verifiedBytes: VerifiedFullSnapshotBytes
  readonly currentSnapshotSeq?: number | undefined
  readonly hasPendingLocalUpdates: boolean
  readonly activeEditorBound: boolean
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Local YDoc write produced by applying a full snapshot. */
export type FullSnapshotApplyYDocWrite =
  | {
      readonly kind: 'put'
      readonly storeName: 'meta-ydoc'
      readonly key: 'meta'
      readonly value: FullSnapshotApplyYDocRecord
    }
  | {
      readonly kind: 'put'
      readonly storeName: 'file-ydocs'
      readonly key: string
      readonly value: FullSnapshotApplyYDocRecord
    }

/** Local YDoc bytes stored after a full snapshot apply. */
export interface FullSnapshotApplyYDocRecord {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
  readonly snapshotSeq: number
}

/** Remote cursor write produced by applying a full snapshot. */
export interface FullSnapshotApplyRemoteCursorWrite {
  readonly kind: 'put'
  readonly storeName: 'remote-cursors'
  readonly key: string
  readonly value: FullSnapshotApplyRemoteCursorRecord
}

/** Remote cursor state stored after a full snapshot apply. */
export interface FullSnapshotApplyRemoteCursorRecord {
  readonly docId: DocId
  readonly snapshotSeq: number
  readonly remoteCursorSeq: number
  readonly stateVectorBase64: string
}

/** Concrete IndexedDB transaction the runtime must commit after replacing local YDoc state. */
export interface FullSnapshotApplyIndexedDbWriteTransaction {
  readonly kind: 'snapshot-apply'
  readonly ydocWrite: FullSnapshotApplyYDocWrite
  readonly remoteCursorWrite: FullSnapshotApplyRemoteCursorWrite
  readonly outboxWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
}

/** Object store surface required for snapshot YDoc writes. */
export interface FullSnapshotApplyYDocObjectStorePort {
  /** Stores one meta or file YDoc record by the runtime's stable key. */
  put(value: FullSnapshotApplyYDocRecord, key: IDBValidKey): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object store surface required for snapshot remote cursor writes. */
export interface FullSnapshotApplyRemoteCursorObjectStorePort {
  /** Reads the current remote cursor before any snapshot writes are queued. */
  get(key: IDBValidKey): LocalStoreIndexedDbRequest<unknown>
  /** Stores one remote cursor record by the runtime's stable document key. */
  put(
    value: FullSnapshotApplyRemoteCursorRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object stores required by one full snapshot apply transaction. */
export interface FullSnapshotApplyIndexedDbObjectStorePorts {
  readonly metaYDoc: FullSnapshotApplyYDocObjectStorePort
  readonly fileYDocs: FullSnapshotApplyYDocObjectStorePort
  readonly remoteCursors: FullSnapshotApplyRemoteCursorObjectStorePort
  readonly outbox: LocalStoreIndexedDbObjectStorePort<LocalStoreOutboxRecord>
  readonly runningLeases: LocalStoreIndexedDbObjectStorePort<OutboxRunningLease>
}

/** Open IndexedDB transaction handle for a full snapshot apply. */
export interface FullSnapshotApplyIndexedDbTransactionHandle {
  readonly stores: FullSnapshotApplyIndexedDbObjectStorePorts
  readonly lifecycle: LocalStoreIndexedDbTransactionLifecycle
}

/** Database surface that can open a full snapshot apply transaction. */
export interface FullSnapshotApplyIndexedDbDatabasePort {
  /** Opens one readwrite transaction across YDoc, cursor, outbox, and lease stores. */
  openFullSnapshotApplyTransaction(): FullSnapshotApplyIndexedDbTransactionHandle
}

/** Input for committing a planned full snapshot apply transaction. */
export interface FullSnapshotApplyIndexedDbCommitInput {
  readonly transaction: FullSnapshotApplyIndexedDbWriteTransaction
  readonly database: FullSnapshotApplyIndexedDbDatabasePort
  readonly remoteCursorCas?: {
    readonly expectedRemoteCursorSeq: number | undefined
  }
}

/** Successful full snapshot apply plan with local YDoc and outbox release effects. */
export interface SuccessfulFullSnapshotApplyRuntimePlan {
  readonly ok: true
  readonly action: 'apply'
  readonly updateBytes: Uint8Array
  readonly stateVectorBytes: Uint8Array
  readonly patch: FullSnapshotApplyPatch
  readonly outboxRelease: Extract<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>
  readonly indexedDbWriteTransaction: FullSnapshotApplyIndexedDbWriteTransaction
}

/** Full snapshot apply plan that must not mutate local YDoc state yet. */
export type FullSnapshotApplyRuntimePlan =
  | SuccessfulFullSnapshotApplyRuntimePlan
  | {
      readonly ok: false
      readonly action: 'wait'
      readonly reason: 'pending-local-updates' | 'active-editor-bound'
    }
  | {
      readonly ok: false
      readonly action: 'skip'
      readonly reason: 'stale-snapshot'
    }
  | {
      readonly ok: false
      readonly action: 'reject'
      readonly reason:
        | 'doc-mismatch'
        | 'hash-mismatch'
        | 'invalid-snapshot-seq'
        | 'invalid-current-snapshot-seq'
    }
  | {
      readonly ok: false
      readonly action: 'outbox-release-reject'
      readonly reason: Exclude<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>['reason']
      readonly outboxRelease: Exclude<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>
    }

/**
 * Plans applying a verified full snapshot to the local store.
 */
export function planFullSnapshotApplyRuntime(
  input: FullSnapshotApplyRuntimeInput,
): FullSnapshotApplyRuntimePlan {
  const applyInput = makeFullSnapshotApplyInputFromResponse({
    requestedDocId: input.requestedDocId,
    response: input.response,
    actualUpdateSha256: input.verifiedBytes.actualUpdateSha256,
    currentSnapshotSeq: input.currentSnapshotSeq,
    hasPendingLocalUpdates: input.hasPendingLocalUpdates,
    activeEditorBound: input.activeEditorBound,
  })
  const decision = decideFullSnapshotApply(applyInput)

  switch (decision.action) {
    case 'wait':
      return { ok: false, action: 'wait', reason: decision.reason }
    case 'skip':
      return { ok: false, action: 'skip', reason: decision.reason }
    case 'reject':
      return { ok: false, action: 'reject', reason: decision.reason }
    case 'apply':
      break
  }

  const outboxRelease = planOutboxWorkerFullSnapshotRelease({
    appliedDocId: decision.patch.docId,
    snapshotSeq: decision.patch.snapshotSeq,
    currentOutboxRecords: input.currentOutboxRecords,
    currentLeaseRows: input.currentLeaseRows,
  })
  if (!outboxRelease.ok) {
    return {
      ok: false,
      action: 'outbox-release-reject',
      reason: outboxRelease.reason,
      outboxRelease,
    }
  }

  return {
    ok: true,
    action: 'apply',
    updateBytes: input.verifiedBytes.updateBytes,
    stateVectorBytes: input.verifiedBytes.stateVectorBytes,
    patch: decision.patch,
    outboxRelease,
    indexedDbWriteTransaction: planFullSnapshotApplyIndexedDbWriteTransaction({
      patch: decision.patch,
      updateBytes: input.verifiedBytes.updateBytes,
      outboxRelease,
    }),
  }
}

/**
 * Converts a snapshot patch into a database write transaction.
 */
export function planFullSnapshotApplyIndexedDbWriteTransaction(input: {
  readonly patch: FullSnapshotApplyPatch
  readonly updateBytes: Uint8Array
  readonly outboxRelease: Extract<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>
}): FullSnapshotApplyIndexedDbWriteTransaction {
  const outboxTransaction = planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(
    input.outboxRelease,
  )
  return {
    kind: 'snapshot-apply',
    ydocWrite: fullSnapshotApplyYDocWrite(input.patch, input.updateBytes),
    remoteCursorWrite: fullSnapshotApplyRemoteCursorWrite(input.patch),
    outboxWrites: outboxTransaction.writes,
  }
}

/**
 * Creates a database port for snapshot write transactions.
 */
export function createFullSnapshotApplyIndexedDbDatabasePort(
  database: IDBDatabase,
): FullSnapshotApplyIndexedDbDatabasePort {
  return {
    openFullSnapshotApplyTransaction() {
      const transaction = database.transaction(
        ['meta-ydoc', 'file-ydocs', 'remote-cursors', 'outbox', 'running-leases'],
        'readwrite',
      )
      return {
        stores: {
          metaYDoc: transaction.objectStore('meta-ydoc'),
          fileYDocs: transaction.objectStore('file-ydocs'),
          remoteCursors: transaction.objectStore('remote-cursors'),
          outbox: transaction.objectStore('outbox'),
          runningLeases: transaction.objectStore('running-leases'),
        },
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Commits a snapshot apply transaction to the database, ensuring all updates succeed together.
 */
export async function commitFullSnapshotApplyIndexedDbTransaction(
  input: FullSnapshotApplyIndexedDbCommitInput,
): Promise<boolean> {
  const transaction = input.database.openFullSnapshotApplyTransaction()
  if (input.remoteCursorCas !== undefined) {
    const currentCursor: unknown = await waitForSnapshotApplyIndexedDbRequest(
      transaction.stores.remoteCursors.get(input.transaction.remoteCursorWrite.key),
    )
    const currentRemoteCursorSeq = remoteCursorSeq(currentCursor)
    if (currentRemoteCursorSeq !== input.remoteCursorCas.expectedRemoteCursorSeq) return false
  }
  const ydocRequest = queueFullSnapshotApplyYDocWrite(
    transaction.stores,
    input.transaction.ydocWrite,
  )
  const remoteCursorRequest = transaction.stores.remoteCursors.put(
    input.transaction.remoteCursorWrite.value,
    input.transaction.remoteCursorWrite.key,
  )
  const outboxRequests = queueLocalStoreIndexedDbConcreteWrites(
    {
      outbox: transaction.stores.outbox,
      runningLeases: transaction.stores.runningLeases,
    },
    input.transaction.outboxWrites,
  )
  await Promise.all(
    [ydocRequest, remoteCursorRequest, ...outboxRequests].map((request) =>
      waitForSnapshotApplyIndexedDbRequest(request),
    ),
  )
  await waitForSnapshotApplyIndexedDbTransaction(transaction.lifecycle)
  return true
}

function remoteCursorSeq(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('remoteCursorSeq' in value)) return undefined
  const sequence = value.remoteCursorSeq
  return Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? Number(sequence) : undefined
}

function fullSnapshotApplyYDocWrite(
  patch: FullSnapshotApplyPatch,
  updateBytes: Uint8Array,
): FullSnapshotApplyYDocWrite {
  const value = {
    docId: patch.docId,
    updateBytes,
    snapshotSeq: patch.snapshotSeq,
  }
  if (patch.docId.kind === 'meta') {
    return { kind: 'put', storeName: 'meta-ydoc', key: 'meta', value }
  }
  return { kind: 'put', storeName: 'file-ydocs', key: patch.docId.ydocId, value }
}

function fullSnapshotApplyRemoteCursorWrite(
  patch: FullSnapshotApplyPatch,
): FullSnapshotApplyRemoteCursorWrite {
  return {
    kind: 'put',
    storeName: 'remote-cursors',
    key: fullSnapshotApplyDocKey(patch.docId),
    value: {
      docId: patch.docId,
      snapshotSeq: patch.snapshotSeq,
      remoteCursorSeq: patch.remoteCursorSeq,
      stateVectorBase64: patch.stateVectorBase64,
    },
  }
}

function fullSnapshotApplyDocKey(docId: DocId): string {
  if (docId.kind === 'meta') {
    return 'meta'
  }
  return `file:${docId.ydocId}`
}

function queueFullSnapshotApplyYDocWrite(
  stores: FullSnapshotApplyIndexedDbObjectStorePorts,
  write: FullSnapshotApplyYDocWrite,
): LocalStoreIndexedDbRequest<IDBValidKey> {
  if (write.storeName === 'meta-ydoc') {
    return stores.metaYDoc.put(write.value, write.key)
  }
  return stores.fileYDocs.put(write.value, write.key)
}

async function waitForSnapshotApplyIndexedDbRequest<Result>(
  request: LocalStoreIndexedDbRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function waitForSnapshotApplyIndexedDbTransaction(
  transaction: LocalStoreIndexedDbTransactionLifecycle,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

/** A fetched and verified full snapshot, ready to plan through {@link planFullSnapshotApplyRuntime}. */
export interface NeedFullSnapshotRecoverySnapshotPayload {
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly verifiedBytes: VerifiedFullSnapshotBytes
}

/** Ports required to auto-recover from a NeedFullSnapshot pause. */
export interface NeedFullSnapshotRecoveryPorts {
  /** Fetches and verifies the latest replacement snapshot; `null` on any fetch or verification failure. */
  readonly fetchSnapshot: () => Promise<NeedFullSnapshotRecoverySnapshotPayload | null>
  /** Applies a fetched snapshot and resumes the matching paused outbox item(s). */
  readonly applySnapshot: (payload: NeedFullSnapshotRecoverySnapshotPayload) => Promise<boolean>
  /** Waits before the next bounded retry attempt. */
  readonly wait: (delayMs: number) => Promise<void>
}

/** Outcome of one bounded NeedFullSnapshot recovery run. */
export type NeedFullSnapshotRecoveryResult =
  | { readonly ok: true; readonly attempts: number }
  | { readonly ok: false; readonly attempts: number }

/**
 * Runs a bounded, backed-off sequence of fetch+apply attempts after the server reports
 * NeedFullSnapshot. Every port failure (including a thrown error) is treated as one
 * exhausted attempt; exhausting the whole schedule fails closed by leaving the matching
 * outbox item in its existing paused/manual-recovery state rather than retrying forever.
 */
export async function runNeedFullSnapshotRecovery(
  ports: NeedFullSnapshotRecoveryPorts,
  backoffScheduleMs: readonly number[],
): Promise<NeedFullSnapshotRecoveryResult> {
  const schedule = backoffScheduleMs.length > 0 ? backoffScheduleMs : [0]
  for (const [index, delayMs] of schedule.entries()) {
    if (delayMs > 0) await ports.wait(delayMs)
    try {
      const payload = await ports.fetchSnapshot()
      if (payload !== null && (await ports.applySnapshot(payload))) {
        return { ok: true, attempts: index + 1 }
      }
    } catch {
      // Retried on the next scheduled attempt below; see the fail-closed note above.
    }
  }
  return { ok: false, attempts: schedule.length }
}
