import { hashBytesSha256, makeSha256Hex, type DocId, type SyncUpdate } from '@kuroflare/core'
import * as Y from 'yjs'

import {
  type SyncRuntimeWebSocketAppliedYDocState,
  type SyncRuntimeWebSocketInboundRoutePorts,
  type SyncRuntimeWebSocketRemoteUpdateApplyPortInput,
  type SyncRuntimeWebSocketRemoteUpdateCommitInput,
  type SyncRuntimeWebSocketRemoteUpdateCommitPort,
  type SyncRuntimeWebSocketRemoteUpdateDecodePlan,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction,
  type SyncRuntimeWebSocketRemoteUpdateYDocApplyPort,
  type SyncRuntimeWebSocketRemoteUpdateYDocWrite,
  type SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput,
} from '../../engine/websocket.types'
import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../../store/indexeddb'

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
