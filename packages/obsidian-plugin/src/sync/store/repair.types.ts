import type {
  DeviceId,
  DocId,
  FileId,
  LocalOutboxRepairExport,
  LocalOutboxRepairExportItemKind,
  LocalOutboxRepairExportItemStatus,
  LocalOutboxRepairImportDecision,
  LocalOutboxRepairImportDurableMessage,
  LocalOutboxRepairImportQuarantinedMessage,
  LocalOutboxRepairResumeDecision,
  LocalStoreObjectStore,
  LocalStoreRepairDecision,
  LocalStoreRepairRequest,
  LocalStoreSchemaDecision,
  MessageId,
  OutboxPlanItemId,
  Sha256Hex,
  VaultId,
} from '@kuroflare/core'

import type { LocalStoreIndexedDbOpenEffect } from '../store/schema'

/** Input for planning a plugin-side degraded local-store repair action. */
export interface LocalStoreRepairPlanInput {
  readonly vaultId: VaultId
  readonly schemaDecision: LocalStoreSchemaDecision
  readonly request: LocalStoreRepairRequest
  readonly pendingOutboxCount: number
  readonly exportCompleted: boolean
  readonly discardConfirmed: boolean
  readonly now: number
  readonly targetVersion?: number | undefined
  readonly requiredStores?: readonly LocalStoreObjectStore[] | undefined
}

/** Concrete side effect needed to repair or hold a degraded local store. */
export type LocalStoreRepairEffect =
  | {
      readonly kind: 'write-repair-export'
      readonly path: string
      readonly includeOutbox: true
      readonly includeMetadata: true
    }
  | LocalStoreIndexedDbOpenEffect
  | {
      readonly kind: 'keep-degraded'
      readonly reason: 'user-deferred' | 'schema-not-degraded'
    }
  | {
      readonly kind: 'reject-repair'
      readonly reason:
        | 'invalid-pending-outbox-count'
        | 'invalid-target-version'
        | 'invalid-now'
        | 'export-required'
        | 'discard-confirmation-required'
        | 'unsupported-schema-decision'
    }

/** Input for staging safe entries from a previously written local outbox repair export. */
export interface LocalStoreRepairImportPlanInput {
  readonly exportFile: LocalOutboxRepairExport
  readonly vaultId: VaultId
  readonly deviceId?: DeviceId | undefined
  readonly existingOutboxIds: readonly OutboxPlanItemId[]
  readonly durableMessages: readonly LocalOutboxRepairImportDurableMessage[]
  readonly quarantinedMessages: readonly LocalOutboxRepairImportQuarantinedMessage[]
}

/** Paused outbox row staged from a repair export for explicit user review. */
export interface LocalStoreRepairImportedOutboxRecord {
  readonly id: OutboxPlanItemId
  readonly kind: 'y-update'
  readonly status: 'paused'
  readonly reason: 'imported-repair-export'
  readonly resumeOn: 'manual'
  readonly dependsOn: readonly OutboxPlanItemId[]
  readonly nextAttemptAt: undefined
  readonly createdAt: number
  readonly retryCount: 0
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256: Sha256Hex
  readonly updateBytesBase64: string
  readonly metadataSchemaVersion?: 2 | undefined
}

/** Concrete effect for staging one imported repair entry in the local outbox. */
export interface LocalStoreRepairImportStageEffect {
  readonly kind: 'stage-repair-import'
  readonly record: LocalStoreRepairImportedOutboxRecord
}

/** Input for manually resuming one staged repair import. */
export interface LocalStoreRepairImportResumePlanInput {
  readonly record: LocalStoreRepairImportedOutboxRecord
  readonly userConfirmed: boolean
  readonly durableMessages: readonly LocalOutboxRepairImportDurableMessage[]
  readonly quarantinedMessages: readonly LocalOutboxRepairImportQuarantinedMessage[]
}

/** Concrete effect for moving one staged repair import back to pending. */
export interface LocalStoreRepairImportResumeEffect {
  readonly kind: 'resume-repair-import'
  readonly itemId: OutboxPlanItemId
  readonly expected: {
    readonly kind: 'y-update'
    readonly status: 'paused'
    readonly reason: 'imported-repair-export'
    readonly resumeOn: 'manual'
    readonly docId: DocId
    readonly messageId: MessageId
    readonly updateSha256: Sha256Hex
    readonly updateBytesBase64: string
  }
  readonly patch: Extract<LocalOutboxRepairResumeDecision, { readonly action: 'resume' }>['patch']
}

/** Plugin-level plan for manually resuming one staged repair import. */
export type LocalStoreRepairImportResumePlan =
  | {
      readonly ok: true
      readonly action: 'resume'
      readonly decision: Extract<LocalOutboxRepairResumeDecision, { readonly action: 'resume' }>
      readonly effects: readonly LocalStoreRepairImportResumeEffect[]
    }
  | {
      readonly ok: true
      readonly action: 'wait'
      readonly decision: Extract<LocalOutboxRepairResumeDecision, { readonly action: 'wait' }>
      readonly effects: readonly LocalStoreRepairImportResumeEffect[]
    }
  | {
      readonly ok: false
      readonly action: 'reject'
      readonly decision: Extract<LocalOutboxRepairResumeDecision, { readonly action: 'reject' }>
      readonly effects: readonly LocalStoreRepairImportResumeEffect[]
    }

/** Plugin-level plan for staging entries from a local repair export. */
export type LocalStoreRepairImportPlan =
  | {
      readonly ok: true
      readonly action: 'stage-import'
      readonly decision: Extract<
        LocalOutboxRepairImportDecision,
        { readonly action: 'stage-import' }
      >
      readonly effects: readonly LocalStoreRepairImportStageEffect[]
    }
  | {
      readonly ok: false
      readonly action: 'reject'
      readonly reason:
        | Extract<LocalOutboxRepairImportDecision, { readonly action: 'reject' }>['reason']
        | 'invalid-outbox-item-id'
      readonly decision?:
        | Extract<LocalOutboxRepairImportDecision, { readonly action: 'reject' }>
        | undefined
      readonly itemId?: string | undefined
    }

/** Successful stage-import plan accepted by local-store transaction planning. */
export type SuccessfulLocalStoreRepairImportPlan = Extract<
  LocalStoreRepairImportPlan,
  { readonly ok: true; readonly action: 'stage-import' }
>

/** Successful repair-import resume plan accepted by local-store transaction planning. */
export type SuccessfulLocalStoreRepairImportResumePlan = Extract<
  LocalStoreRepairImportResumePlan,
  { readonly ok: true; readonly action: 'resume' }
>

/** Plan for executing a degraded local-store repair action from plugin UI/runtime. */
export type LocalStoreRepairPlan =
  | {
      readonly ok: true
      readonly action: 'export-pending-outbox'
      readonly dbName: string
      readonly decision: Extract<
        LocalStoreRepairDecision,
        { readonly action: 'export-pending-outbox' }
      >
      readonly effects: readonly LocalStoreRepairEffect[]
    }
  | {
      readonly ok: true
      readonly action: 'rebuild'
      readonly dbName: string
      readonly decision: Extract<LocalStoreRepairDecision, { readonly action: 'rebuild' }>
      readonly effects: readonly LocalStoreRepairEffect[]
    }
  | {
      readonly ok: true
      readonly action: 'keep-degraded'
      readonly dbName: string
      readonly decision: Extract<LocalStoreRepairDecision, { readonly action: 'keep-degraded' }>
      readonly effects: readonly LocalStoreRepairEffect[]
    }
  | {
      readonly ok: false
      readonly action: 'reject'
      readonly dbName: string
      readonly decision: Extract<LocalStoreRepairDecision, { readonly action: 'reject' }>
      readonly effects: readonly LocalStoreRepairEffect[]
    }

/** Input outbox row shape needed to produce a protocol-valid repair export entry. */
export interface LocalStoreRepairExportOutboxRecord {
  readonly id: OutboxPlanItemId
  readonly kind: LocalOutboxRepairExportItemKind
  readonly status: LocalOutboxRepairExportItemStatus | 'done'
  readonly dependsOn: readonly OutboxPlanItemId[]
  readonly createdAt?: number | undefined
  readonly retryCount?: number | undefined
  readonly docId?: DocId | undefined
  readonly fileId?: FileId | undefined
  readonly messageId?: MessageId | undefined
  readonly updateSha256?: Sha256Hex | undefined
  readonly updateBytesBase64?: string | undefined
  readonly metadataSchemaVersion?: 2 | undefined
  readonly blobSha256?: Sha256Hex | undefined
  readonly localCacheKey?: string | undefined
  readonly reason?: string | undefined
}

/** Metadata evidence needed when building a local outbox repair export payload. */
export interface LocalStoreRepairExportMetadataInput {
  readonly localStoreVersion: number
  readonly targetStoreVersion: number
  readonly degradedReason: string
}

/** Input for building the JSON payload written by a repair export effect. */
export interface LocalStoreRepairExportBuildInput {
  readonly exportedAt: number
  readonly vaultId: VaultId
  readonly deviceId?: DeviceId | undefined
  readonly metadata: LocalStoreRepairExportMetadataInput
  readonly outboxRecords: readonly LocalStoreRepairExportOutboxRecord[]
}

/** Plan for building a protocol-valid local outbox repair export payload. */
export type LocalStoreRepairExportBuildPlan =
  | {
      readonly ok: true
      readonly exportFile: LocalOutboxRepairExport
      readonly exportedEntryIds: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-export-metadata'
        | 'invalid-exported-at'
        | 'unsupported-status'
        | 'missing-created-at'
        | 'invalid-created-at'
        | 'invalid-retry-count'
        | 'invalid-export-payload'
      readonly itemId?: OutboxPlanItemId | undefined
    }
