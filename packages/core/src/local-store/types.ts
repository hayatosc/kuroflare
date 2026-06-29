import { type DeviceId, type DocId, type MessageId, type VaultId } from '../ids'
import { type LocalOutboxRepairExport, type LocalOutboxRepairExportEntry } from '../local-repair'
import { type Sha256Hex } from '../meta'

/** IndexedDB object store owned by the Obsidian plugin local sync database. */
export type LocalStoreObjectStore =
  | 'metadata'
  | 'meta-ydoc'
  | 'file-ydocs'
  | 'remote-cursors'
  | 'last-materialized'
  | 'outbox'
  | 'running-leases'
  | 'blob-cache'

/** Canonical object stores expected in the plugin local sync database. */
export const DEFAULT_LOCAL_STORE_OBJECT_STORES = [
  'metadata',
  'meta-ydoc',
  'file-ydocs',
  'remote-cursors',
  'last-materialized',
  'outbox',
  'running-leases',
  'blob-cache',
] as const satisfies readonly LocalStoreObjectStore[]

/** Evidence read while opening the plugin IndexedDB database. */
export interface LocalStoreSchemaDecisionInput {
  readonly dbExists: boolean
  readonly currentVersion?: number | undefined
  readonly targetVersion: number
  readonly minimumReadableVersion: number
  readonly presentStores: readonly LocalStoreObjectStore[]
  readonly requiredStores: readonly LocalStoreObjectStore[]
  readonly pendingOutboxCount: number
}

/** Plan for creating, opening, upgrading, or refusing the local IndexedDB database. */
export type LocalStoreSchemaDecision =
  | {
      readonly action: 'create'
      readonly version: number
      readonly createStores: readonly LocalStoreObjectStore[]
    }
  | {
      readonly action: 'open'
      readonly version: number
    }
  | {
      readonly action: 'upgrade'
      readonly fromVersion: number
      readonly toVersion: number
      readonly createStores: readonly LocalStoreObjectStore[]
    }
  | {
      readonly action: 'rebuild'
      readonly reason: 'store-version-too-old' | 'missing-required-store'
      readonly targetVersion: number
      readonly pendingOutboxCount: 0
    }
  | {
      readonly action: 'degraded'
      readonly reason:
        | 'local-store-too-new'
        | 'store-version-too-old-with-pending-outbox'
        | 'missing-required-store-with-pending-outbox'
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-version'
        | 'invalid-pending-outbox-count'
        | 'duplicate-store-name'
        | 'inconsistent-local-store-evidence'
    }

/** Repair action requested from the local store degraded repair panel. */
export type LocalStoreRepairRequest =
  | 'export-pending-outbox'
  | 'rebuild-after-export'
  | 'discard-and-rebuild'
  | 'keep-degraded'

/** Evidence available when the user acts on a degraded local store. */
export interface LocalStoreRepairDecisionInput {
  readonly schemaDecision: LocalStoreSchemaDecision
  readonly request: LocalStoreRepairRequest
  readonly pendingOutboxCount: number
  readonly exportCompleted: boolean
  readonly discardConfirmed: boolean
  readonly targetVersion: number
  readonly now: number
}

/** Plan for a local store repair action after schema open degraded. */
export type LocalStoreRepairDecision =
  | {
      readonly action: 'export-pending-outbox'
      readonly exportName: string
      readonly includeOutbox: true
      readonly includeMetadata: true
    }
  | {
      readonly action: 'rebuild'
      readonly reason: 'outbox-exported' | 'outbox-discarded' | 'empty-outbox'
      readonly targetVersion: number
      readonly clearPendingOutbox: boolean
    }
  | {
      readonly action: 'keep-degraded'
      readonly reason: 'user-deferred' | 'schema-not-degraded'
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-pending-outbox-count'
        | 'invalid-target-version'
        | 'invalid-now'
        | 'export-required'
        | 'discard-confirmation-required'
        | 'unsupported-schema-decision'
    }

/** Server evidence showing an exported message is already durable. */
export interface LocalOutboxRepairImportDurableMessage {
  readonly docId: DocId
  readonly messageId: MessageId
  readonly durableSeq: number
}

/** Server evidence showing an exported message is currently quarantined. */
export interface LocalOutboxRepairImportQuarantinedMessage {
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: Sha256Hex | undefined
}

/** Input for safely staging entries from a local outbox repair export. */
export interface LocalOutboxRepairImportInput {
  readonly exportFile: LocalOutboxRepairExport
  readonly vaultId: VaultId
  readonly deviceId?: DeviceId | undefined
  readonly existingOutboxIds: readonly string[]
  readonly durableMessages: readonly LocalOutboxRepairImportDurableMessage[]
  readonly quarantinedMessages: readonly LocalOutboxRepairImportQuarantinedMessage[]
}

/** Paused outbox candidate restored from a repair export for explicit user review. */
export interface LocalOutboxRepairImportedYUpdate {
  readonly id: string
  readonly kind: 'y-update'
  readonly status: 'paused'
  readonly reason: 'imported-repair-export'
  readonly resumeOn: 'manual'
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256: Sha256Hex
  readonly updateBytesBase64: string
  readonly createdAt: number
}

/** One exported entry that was not staged for import. */
export interface LocalOutboxRepairImportSkip {
  readonly id: string
  readonly reason:
    | 'unsupported-kind'
    | 'unsupported-status'
    | 'dependency-not-restored'
    | 'missing-y-update-fields'
    | 'duplicate-local-outbox-id'
    | 'already-durable'
    | 'server-quarantine'
}

/** Decision for staging a local outbox repair export. */
export type LocalOutboxRepairImportDecision =
  | {
      readonly action: 'stage-import'
      readonly imports: readonly LocalOutboxRepairImportedYUpdate[]
      readonly skipped: readonly LocalOutboxRepairImportSkip[]
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'duplicate-export-id'
        | 'invalid-durable-seq'
    }

/** Input for resuming a staged repair-imported outbox item. */
export interface LocalOutboxRepairResumeInput {
  readonly item: LocalOutboxRepairImportedYUpdate
  readonly userConfirmed: boolean
  readonly durableMessages: readonly LocalOutboxRepairImportDurableMessage[]
  readonly quarantinedMessages: readonly LocalOutboxRepairImportQuarantinedMessage[]
}

/** Decision for moving a staged repair-imported outbox item back to pending. */
export type LocalOutboxRepairResumeDecision =
  | {
      readonly action: 'resume'
      readonly patch: {
        readonly status: 'pending'
        readonly nextAttemptAt: undefined
        readonly resumeReason: 'user-confirmed-repair-import'
      }
    }
  | {
      readonly action: 'wait'
      readonly reason: 'confirmation-required' | 'already-durable' | 'server-quarantine'
    }
  | {
      readonly action: 'reject'
      readonly reason: 'invalid-durable-seq'
    }
