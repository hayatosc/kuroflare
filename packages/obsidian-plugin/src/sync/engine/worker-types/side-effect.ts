import {
  type BlobManifest,
  type LastMaterializedRecord,
  type OutboxRunError,
  type OutboxRunningLease,
  type OutboxSchedulerStart,
} from '@kuroflare/core'

import { type LocalStoreOutboxRecord } from '../../store/store'

/** Side effect that may be started after its lease was persisted. */
export interface OutboxWorkerStartEffect {
  readonly kind: 'start-side-effect'
  readonly start: OutboxSchedulerStart
  readonly lease: OutboxRunningLease
}

/** HTTP request plan used by the plugin side-effect runner. */
export interface OutboxWorkerHttpRequestPlan {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly bodyJson?: unknown
  readonly bodySource?: 'canonical-blob-manifest-json' | undefined
}

/** HTTP byte upload the side-effect runner performs after receiving an upload URL. */
export interface OutboxWorkerHttpUploadBytesPlan {
  readonly method: 'PUT'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** Local blob-cache read the side-effect runner must perform before uploading bytes. */
export interface OutboxWorkerBlobCacheReadPlan {
  readonly key: string
  readonly expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
  readonly expectedSize: number
}

/** Local blob-cache write the side-effect runner must perform after downloading bytes. */
export interface OutboxWorkerBlobCacheWritePlan {
  readonly key: string
  readonly expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
  readonly expectedSize: number
}

/** One local blob-cache chunk read needed to assemble a materialized binary file. */
export interface OutboxWorkerMaterializeChunkReadPlan {
  readonly sha256: BlobManifest['chunks'][number]['sha256']
  readonly key: string
  readonly expectedSize: number
}

/** Planned local materialize side effect after a lease has been persisted. */
export interface OutboxWorkerMaterializeSideEffectPlan {
  readonly ok: true
  readonly action: 'materialize'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly targetPath: string
  readonly expectedContentSha256: NonNullable<LocalStoreOutboxRecord['expectedHash']>
  readonly manifest: BlobManifest
  readonly readChunks: readonly OutboxWorkerMaterializeChunkReadPlan[]
  readonly assemble: {
    readonly expectedContentSha256: NonNullable<LocalStoreOutboxRecord['expectedHash']>
    readonly expectedSize: number
  }
  readonly diskCas: {
    readonly path: string
    readonly lastMaterialized?: LastMaterializedRecord | undefined
  }
  readonly writeVaultFile: {
    readonly path: string
    readonly bodySource: 'assembled-blob'
  }
}

/** Planned blob PUT side effect after a lease has been persisted. */
export interface OutboxWorkerBlobPutSideEffectPlan {
  readonly ok: true
  readonly action: 'blob-put'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly blob: {
    readonly sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
    readonly size: number
    readonly localCacheKey: string
  }
  readonly readLocalCache: OutboxWorkerBlobCacheReadPlan
  readonly headRequest: OutboxWorkerHttpRequestPlan
  readonly uploadUrlRequest: OutboxWorkerHttpRequestPlan
  readonly uploadPut: {
    readonly method: 'PUT'
    readonly urlSource: 'upload-url-response'
    readonly authorization: 'device-access-token'
    readonly bodySource: 'local-cache'
  }
}

/** Planned blob GET side effect after a lease has been persisted. */
export interface OutboxWorkerBlobGetSideEffectPlan {
  readonly ok: true
  readonly action: 'blob-get'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly blob: {
    readonly sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
    readonly size: number
    readonly localCacheKey: string
  }
  readonly downloadRequest: OutboxWorkerHttpRequestPlan
  readonly writeLocalCache: OutboxWorkerBlobCacheWritePlan
}

/** Planned manifest PUT side effect after all chunks have been uploaded. */
export interface OutboxWorkerManifestPutSideEffectPlan {
  readonly ok: true
  readonly action: 'manifest-put'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly manifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
  readonly manifest: BlobManifest
  readonly putManifestRequest: OutboxWorkerHttpRequestPlan
}

/** Planned meta reference update side effect after the manifest is durable. */
export interface OutboxWorkerMetaRefUpdateSideEffectPlan {
  readonly ok: true
  readonly action: 'meta-ref-update'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly binaryRef: {
    readonly blobManifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
    readonly blobChunks: readonly BlobManifest['chunks'][number]['sha256'][]
  }
  readonly sendSyncUpdate: {
    readonly transport: 'active-sync-websocket'
    readonly docId: NonNullable<LocalStoreOutboxRecord['docId']>
    readonly messageId: NonNullable<LocalStoreOutboxRecord['messageId']>
    readonly updateSha256: NonNullable<LocalStoreOutboxRecord['updateSha256']>
    readonly updateBytesBase64: string
  }
}

/** Rejection returned before starting an unsafe or underspecified side effect. */
export interface OutboxWorkerSideEffectRejectPlan {
  readonly ok: false
  readonly reason:
    | 'missing-record'
    | 'kind-mismatch'
    | 'unsupported-kind'
    | 'missing-access-token'
    | 'invalid-endpoint'
    | 'missing-doc-id'
    | 'missing-file-id'
    | 'missing-message-id'
    | 'missing-blob-sha256'
    | 'missing-blob-manifest-hash'
    | 'missing-blob-manifest'
    | 'missing-local-cache-key'
    | 'invalid-local-cache-key'
    | 'invalid-blob-size'
    | 'missing-update-sha256'
    | 'missing-update-bytes'
    | 'missing-expected-hash'
    | 'missing-target-path'
    | 'invalid-target-path'
    | 'missing-last-materialized'
    | 'manifest-file-mismatch'
    | 'manifest-content-mismatch'
    | 'manifest-chunk-key-mismatch'
}

/** Concrete side effect plan for a persisted outbox lease. */
export type OutboxWorkerSideEffectPlan =
  | OutboxWorkerBlobPutSideEffectPlan
  | OutboxWorkerBlobGetSideEffectPlan
  | OutboxWorkerManifestPutSideEffectPlan
  | OutboxWorkerMetaRefUpdateSideEffectPlan
  | OutboxWorkerMaterializeSideEffectPlan
  | OutboxWorkerSideEffectRejectPlan

/** Vault file evidence read by a local side-effect runner before materializing bytes. */
export type OutboxWorkerVaultFileEvidence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'folder' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array }

/** Ports used by the local side-effect runner for fake vault and production adapters. */
export interface OutboxWorkerLocalSideEffectRunnerPorts {
  readonly sendJsonRequest: (
    request: OutboxWorkerHttpRequestPlan,
  ) => Promise<
    | { readonly kind: 'success'; readonly body: unknown }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  >
  readonly uploadBytes: (
    request: OutboxWorkerHttpUploadBytesPlan,
    bytes: Uint8Array,
  ) => Promise<OutboxWorkerSideEffectResultEvidence>
  readonly downloadBytes: (
    request: OutboxWorkerHttpRequestPlan,
  ) => Promise<
    | { readonly kind: 'success'; readonly bytes: Uint8Array }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  >
  readonly readBlobCache: (plan: OutboxWorkerBlobCacheReadPlan) => Promise<Uint8Array | undefined>
  readonly writeBlobCache: (
    plan: OutboxWorkerBlobCacheWritePlan,
    bytes: Uint8Array,
  ) => Promise<void>
  readonly readVaultFile: (path: string) => Promise<OutboxWorkerVaultFileEvidence>
  readonly ensureVaultParentFolders: (path: string) => Promise<boolean>
  readonly writeVaultFile: (path: string, bytes: Uint8Array) => Promise<void>
  readonly getActiveFilePath: () => string | undefined
  readonly writeLastMaterialized: (record: LastMaterializedRecord) => void
  readonly now: () => number
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>
}

/** Evidence returned by a concrete side-effect runner before local-store completion planning. */
export type OutboxWorkerSideEffectResultEvidence =
  | { readonly kind: 'success' }
  | { readonly kind: 'network-error' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'offline' }
  | {
      readonly kind: 'http-response'
      readonly status: number
      readonly retryAfterMs?: number | undefined
      readonly code?: string | undefined
    }
  | { readonly kind: 'local-conflict' }
  | { readonly kind: 'invalid-payload'; readonly code?: string | undefined }

/** Classified side-effect result used to choose success or failure completion planning. */
export type OutboxWorkerSideEffectCompletionEvidence =
  | {
      readonly ok: true
      readonly itemId: LocalStoreOutboxRecord['id']
      readonly kind: Exclude<LocalStoreOutboxRecord['kind'], 'y-update' | 'meta-ref-update'>
      readonly status: LocalStoreOutboxRecord['status']
    }
  | {
      readonly ok: false
      readonly itemId: LocalStoreOutboxRecord['id']
      readonly kind: LocalStoreOutboxRecord['kind']
      readonly retryCount: number
      readonly error: OutboxRunError
    }
