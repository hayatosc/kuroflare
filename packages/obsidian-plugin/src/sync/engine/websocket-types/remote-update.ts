import { type DocId, type SyncUpdate } from '@kuroflare/core'

import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../../store/indexeddb'

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
