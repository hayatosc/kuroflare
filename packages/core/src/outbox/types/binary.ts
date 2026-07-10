import { type Sha256Hex } from '../../sync/meta'
import { type FileId } from '../../utils/ids'
import { type OutboxPlanItemId } from './base'

/** Blob PUT evidence needed to build a binary upload outbox plan. */
export interface BinaryUploadChunkInput {
  readonly id: OutboxPlanItemId
  readonly sha256: Sha256Hex
  readonly localCacheKey: string
  readonly size: number
}

/** Blob GET evidence needed to build a binary download outbox plan. */
export interface BinaryDownloadChunkInput {
  readonly id: OutboxPlanItemId
  readonly sha256: Sha256Hex
  readonly localCacheKey: string
  readonly size: number
}

/** Input for building a binary upload dependency graph. */
export interface BinaryUploadOutboxPlanInput {
  readonly fileId: FileId
  readonly blobManifestHash: Sha256Hex
  readonly chunks: readonly BinaryUploadChunkInput[]
  readonly manifestPutId: OutboxPlanItemId
  readonly metaRefUpdateId: OutboxPlanItemId
}

/** Input for building a binary download dependency graph. */
export interface BinaryDownloadOutboxPlanInput {
  readonly fileId: FileId
  readonly expectedHash: Sha256Hex
  readonly chunks: readonly BinaryDownloadChunkInput[]
  readonly materializeId: OutboxPlanItemId
}

/** Persistable binary outbox item emitted by a plan builder. */
export type BinaryOutboxPlanItem =
  | {
      readonly kind: 'blob-put'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly sha256: Sha256Hex
      readonly localCacheKey: string
      readonly size: number
    }
  | {
      readonly kind: 'manifest-put'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly blobManifestHash: Sha256Hex
    }
  | {
      readonly kind: 'meta-ref-update'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly blobManifestHash: Sha256Hex
    }
  | {
      readonly kind: 'blob-get'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly sha256: Sha256Hex
      readonly localCacheKey: string
      readonly size: number
    }
  | {
      readonly kind: 'materialize'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly expectedHash: Sha256Hex
    }

/** Successful binary upload outbox dependency graph. */
export interface BinaryUploadOutboxPlan {
  readonly fileId: FileId
  readonly items: readonly BinaryOutboxPlanItem[]
  readonly chunkPuts: readonly OutboxPlanItemId[]
  readonly manifestPut: OutboxPlanItemId
  readonly metaRefUpdate: OutboxPlanItemId
}

/** Successful binary download outbox dependency graph. */
export interface BinaryDownloadOutboxPlan {
  readonly fileId: FileId
  readonly items: readonly BinaryOutboxPlanItem[]
  readonly chunkGets: readonly OutboxPlanItemId[]
  readonly materialize: OutboxPlanItemId
}

/** Failure reason for binary outbox plan construction. */
export type BinaryOutboxPlanBuildError =
  | 'duplicate-item-id'
  | 'invalid-blob-size'
  | 'empty-local-cache-key'

/** Binary upload plan construction result. */
export type BinaryUploadOutboxPlanBuildResult =
  | { readonly ok: true; readonly plan: BinaryUploadOutboxPlan }
  | { readonly ok: false; readonly reason: BinaryOutboxPlanBuildError }

/** Binary download plan construction result. */
export type BinaryDownloadOutboxPlanBuildResult =
  | { readonly ok: true; readonly plan: BinaryDownloadOutboxPlan }
  | { readonly ok: false; readonly reason: BinaryOutboxPlanBuildError }
