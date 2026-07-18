import { hashBytesSha256, makeSha256Hex, type DocId, type SyncUpdate } from '@kuroflare/core'
import * as Y from 'yjs'

import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'
import { type SyncRuntimeWebSocketInboundRoutePorts } from './inbound'

/** Port exposing loaded YDocs to the remote-update and sync-request bridges. */
export interface SyncRuntimeWebSocketYDocRegistryPort {
  /** Returns the local YDoc for the given sync document. */
  getYDoc(docId: DocId): Y.Doc | undefined
}

/** Input for creating a concrete Yjs remote-update apply port. */
export interface SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput {
  readonly registry: SyncRuntimeWebSocketYDocRegistryPort
  readonly origin?: unknown
}

/** Verified peer sync-update payload accepted for local YDoc application. */
export interface SyncRuntimeWebSocketRemoteUpdateApplyInput {
  readonly message: SyncUpdate
  readonly updateBytes: Uint8Array
  readonly actualUpdateSha256: NonNullable<SyncUpdate['updateSha256']>
}

/** Local YDoc state captured after applying a verified peer update. */
export interface SyncRuntimeWebSocketAppliedYDocState {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
  readonly stateVectorBase64: string
}

/** Verified peer update plus resulting local YDoc state ready for durable commit. */
export interface SyncRuntimeWebSocketRemoteUpdateCommitInput extends SyncRuntimeWebSocketRemoteUpdateApplyInput {
  readonly appliedState: SyncRuntimeWebSocketAppliedYDocState
}

/** Result of decoding and verifying one peer sync-update before local mutation. */
export type SyncRuntimeWebSocketRemoteUpdateDecodePlan =
  | {
      readonly ok: true
      readonly apply: SyncRuntimeWebSocketRemoteUpdateApplyInput
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-base64'
        | 'missing-update-sha256'
        | 'missing-durable-seq'
        | 'hash-mismatch'
    }

/** Port that applies a verified peer update to the in-memory local YDoc. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  /** Applies one verified peer update to the correct local YDoc. */
  applyRemoteUpdate(
    input: SyncRuntimeWebSocketRemoteUpdateApplyInput,
  ): Promise<SyncRuntimeWebSocketAppliedYDocState>
}

/** Port that records a successfully applied peer update durably. */
export interface SyncRuntimeWebSocketRemoteUpdateCommitPort {
  /** Persists cursor/update evidence after the in-memory YDoc apply succeeds. */
  commitRemoteUpdate(input: SyncRuntimeWebSocketRemoteUpdateCommitInput): Promise<void>
}

/** Local YDoc state write produced after applying an incremental peer update. */
export type SyncRuntimeWebSocketRemoteUpdateYDocWrite =
  | {
      readonly kind: 'put'
      readonly storeName: 'meta-ydoc'
      readonly key: 'meta'
      readonly value: SyncRuntimeWebSocketRemoteUpdateYDocRecord
    }
  | {
      readonly kind: 'put'
      readonly storeName: 'file-ydocs'
      readonly key: string
      readonly value: SyncRuntimeWebSocketRemoteUpdateYDocRecord
    }

/** Compact local YDoc state stored after applying a peer update. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocRecord {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
}

/** Remote cursor write produced after applying a peer update. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorWrite {
  readonly kind: 'put'
  readonly storeName: 'remote-cursors'
  readonly key: string
  readonly value: SyncRuntimeWebSocketRemoteUpdateCursorRecord
}

/** Remote cursor state stored for the durable peer update sequence. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorRecord {
  readonly docId: DocId
  readonly remoteCursorSeq: number
  readonly stateVectorBase64: string
}

/** IndexedDB transaction plan for durable peer update state. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction {
  readonly kind: 'remote-update-apply'
  readonly ydocWrite: SyncRuntimeWebSocketRemoteUpdateYDocWrite
  readonly remoteCursorWrite: SyncRuntimeWebSocketRemoteUpdateCursorWrite
}

/** Object store surface required for remote update YDoc writes. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort {
  /** Stores one compact local YDoc state by the runtime's stable key. */
  put(
    value: SyncRuntimeWebSocketRemoteUpdateYDocRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object store surface required for remote cursor writes. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorObjectStorePort {
  /** Stores one remote cursor record by the runtime's stable document key. */
  put(
    value: SyncRuntimeWebSocketRemoteUpdateCursorRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object stores required by one remote update commit transaction. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts {
  readonly metaYDoc: SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort
  readonly fileYDocs: SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort
  readonly remoteCursors: SyncRuntimeWebSocketRemoteUpdateCursorObjectStorePort
}

/** Open IndexedDB transaction handle for remote update commits. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbTransactionHandle {
  readonly stores: SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts
  readonly lifecycle: LocalStoreIndexedDbTransactionLifecycle
}

/** Database surface that can open a remote update commit transaction. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort {
  /** Opens one readwrite transaction across YDoc and remote cursor stores. */
  openRemoteUpdateCommitTransaction(): SyncRuntimeWebSocketRemoteUpdateIndexedDbTransactionHandle
}

/** Input for committing one remote update through IndexedDB. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput {
  readonly transaction: SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction
  readonly database: SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort
}

/** Observer for rejected peer updates that must not mutate local state. */
export interface SyncRuntimeWebSocketRemoteUpdateRejectPort {
  /** Observes a rejected peer update without raw token material. */
  rejectRemoteUpdate(
    message: SyncUpdate,
    reason: Extract<SyncRuntimeWebSocketRemoteUpdateDecodePlan, { readonly ok: false }>['reason'],
  ): Promise<void>
}

/** Input for creating the peer sync-update apply port used by inbound dispatch. */
export interface SyncRuntimeWebSocketRemoteUpdateApplyPortInput {
  readonly ydoc: SyncRuntimeWebSocketRemoteUpdateYDocApplyPort
  readonly commit: SyncRuntimeWebSocketRemoteUpdateCommitPort
  readonly reject?: SyncRuntimeWebSocketRemoteUpdateRejectPort | undefined
}

/**
 * Decodes and verifies one peer sync-update before local YDoc mutation.
 *
 * @param message Guarded peer sync-update message.
 * @returns Decoded bytes with a verified SHA-256 hash, or a rejection reason.
 */
export async function decodeSyncRuntimeWebSocketRemoteUpdate(
  message: SyncUpdate,
): Promise<SyncRuntimeWebSocketRemoteUpdateDecodePlan> {
  if (message.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (message.durableSeq === undefined) {
    return { ok: false, reason: 'missing-durable-seq' }
  }
  const updateBytes = decodeBase64Bytes(message.update)
  if (updateBytes === null) {
    return { ok: false, reason: 'invalid-base64' }
  }
  const actualUpdateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  if (actualUpdateSha256 !== message.updateSha256) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  return {
    ok: true,
    apply: {
      message,
      updateBytes,
      actualUpdateSha256,
    },
  }
}

/**
 * Creates the peer sync-update apply port used by the inbound WebSocket dispatcher.
 *
 * @param input In-memory YDoc apply port, durable commit port, and optional rejection observer.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.applyRemoteUpdate`.
 */
export function createSyncRuntimeWebSocketRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketRemoteUpdateApplyPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'applyRemoteUpdate'> {
  return {
    async applyRemoteUpdate(message) {
      const decoded = await decodeSyncRuntimeWebSocketRemoteUpdate(message)
      if (!decoded.ok) {
        await input.reject?.rejectRemoteUpdate(message, decoded.reason)
        return
      }
      const appliedState = await input.ydoc.applyRemoteUpdate(decoded.apply)
      await input.commit.commitRemoteUpdate({ ...decoded.apply, appliedState })
    },
  }
}

/**
 * Creates a concrete Yjs apply port for verified peer sync updates.
 *
 * @param input Registry of loaded YDocs and optional transaction origin.
 * @returns Apply port that mutates the matching YDoc and returns durable state evidence.
 */
export function createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput,
): SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  return {
    async applyRemoteUpdate(applyInput) {
      const doc = input.registry.getYDoc(applyInput.message.docId)
      if (doc === undefined) {
        throw new Error('remote-update-ydoc-not-loaded')
      }
      Y.applyUpdate(doc, applyInput.updateBytes, input.origin)
      return {
        docId: applyInput.message.docId,
        updateBytes: Y.encodeStateAsUpdate(doc),
        stateVectorBase64: encodeBase64Bytes(Y.encodeStateVector(doc)),
      }
    },
  }
}

/**
 * Plans the IndexedDB writes needed after applying one peer update to a local YDoc.
 *
 * @param input Guarded message, decoded update bytes, and applied local YDoc state.
 * @returns YDoc and remote cursor writes for one durable IndexedDB transaction.
 * @throws When the server did not provide a durable sequence.
 */
export function planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateCommitInput,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction {
  const durableSeq = input.message.durableSeq
  if (durableSeq === undefined) {
    throw new Error('remote-update-durable-seq-missing')
  }
  return {
    kind: 'remote-update-apply',
    ydocWrite: remoteUpdateYDocWrite(input.appliedState),
    remoteCursorWrite: {
      kind: 'put',
      storeName: 'remote-cursors',
      key: remoteUpdateDocKey(input.message.docId),
      value: {
        docId: input.message.docId,
        remoteCursorSeq: durableSeq,
        stateVectorBase64: input.appliedState.stateVectorBase64,
      },
    },
  }
}

/**
 * Creates a remote update commit database port from a concrete IndexedDB database.
 *
 * @param database Open IndexedDB database containing YDoc and remote cursor stores.
 * @returns Database port that opens one readwrite transaction for peer update commits.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(
  database: IDBDatabase,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort {
  return {
    openRemoteUpdateCommitTransaction() {
      const transaction = database.transaction(
        ['meta-ydoc', 'file-ydocs', 'remote-cursors'],
        'readwrite',
      )
      return {
        stores: {
          metaYDoc: transaction.objectStore('meta-ydoc'),
          fileYDocs: transaction.objectStore('file-ydocs'),
          remoteCursors: transaction.objectStore('remote-cursors'),
        },
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Commits a peer update apply plan as one IndexedDB transaction.
 *
 * @param input Planned remote update transaction and database transaction opener.
 * @returns Resolves after YDoc state and remote cursor writes are durable.
 * @throws When a write request rejects or the IndexedDB transaction aborts/errors.
 */
export async function commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput,
): Promise<void> {
  const transaction = input.database.openRemoteUpdateCommitTransaction()
  const ydocRequest = queueRemoteUpdateYDocWrite(transaction.stores, input.transaction.ydocWrite)
  const cursorRequest = transaction.stores.remoteCursors.put(
    input.transaction.remoteCursorWrite.value,
    input.transaction.remoteCursorWrite.key,
  )
  await Promise.all(
    [ydocRequest, cursorRequest].map((request) => waitForRemoteUpdateIndexedDbRequest(request)),
  )
  await waitForRemoteUpdateIndexedDbTransaction(transaction.lifecycle)
}

/**
 * Creates a durable commit port for peer updates backed by IndexedDB.
 *
 * @param database Database transaction opener for YDoc and remote cursor stores.
 * @returns Commit port compatible with the inbound remote update apply port.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
  database: SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
): SyncRuntimeWebSocketRemoteUpdateCommitPort {
  return {
    async commitRemoteUpdate(input) {
      await commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction({
        database,
        transaction: planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(input),
      })
    },
  }
}

export function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export function encodeBase64Bytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function remoteUpdateYDocWrite(
  appliedState: SyncRuntimeWebSocketAppliedYDocState,
): SyncRuntimeWebSocketRemoteUpdateYDocWrite {
  const value = {
    docId: appliedState.docId,
    updateBytes: appliedState.updateBytes,
  }
  if (appliedState.docId.kind === 'meta') {
    return { kind: 'put', storeName: 'meta-ydoc', key: 'meta', value }
  }
  return { kind: 'put', storeName: 'file-ydocs', key: appliedState.docId.ydocId, value }
}

function remoteUpdateDocKey(docId: DocId): string {
  if (docId.kind === 'meta') {
    return 'meta'
  }
  return `file:${docId.ydocId}`
}

function queueRemoteUpdateYDocWrite(
  stores: SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts,
  write: SyncRuntimeWebSocketRemoteUpdateYDocWrite,
): LocalStoreIndexedDbRequest<IDBValidKey> {
  if (write.storeName === 'meta-ydoc') {
    return stores.metaYDoc.put(write.value, write.key)
  }
  return stores.fileYDocs.put(write.value, write.key)
}

async function waitForRemoteUpdateIndexedDbRequest<Result>(
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

async function waitForRemoteUpdateIndexedDbTransaction(
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
