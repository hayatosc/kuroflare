import type {
  Ack,
  DocId,
  DeviceId,
  MessageId,
  NeedFullSnapshot,
  Sha256Hex,
  SyncUpdate,
} from '@kuroflare/core'

/** Durable evidence for an update message already processed by this document. */
export interface SyncUpdateDuplicateEvidence {
  readonly durableSeq: number
}

/** Existing document clock used before appending inbound update. */
export interface SyncUpdateDocClock {
  readonly latestSeq: number
}

/** Reason an inbound update must be isolated from the authoritative document. */
export type SyncUpdateQuarantineReason =
  | 'hash-mismatch'
  | 'yjs-apply-failed'
  | 'meta-schema-invalid'

/** Input for deciding whether an inbound update is safe to append. */
export interface SyncUpdateQuarantineDecisionInput {
  readonly update: SyncUpdate
  readonly quarantineId: string
  readonly updateBytesLength: number
  readonly actualUpdateSha256: Sha256Hex
  readonly expectedUpdateSha256?: Sha256Hex
  readonly yjsApplySucceeded: boolean
  readonly metaSchemaValid: boolean | undefined
  readonly now: number
}

/** Row the caller should insert into `quarantined_updates` without acknowledging. */
export interface SyncUpdateQuarantineRow {
  readonly id: string
  readonly docId: DocId
  readonly messageId: MessageId
  readonly deviceId: DeviceId
  readonly reason: SyncUpdateQuarantineReason
  readonly updateSha256: Sha256Hex
  readonly updateBytesLength: number
  readonly createdAt: number
}

/** Decision for pre-append update validation. */
export type SyncUpdateQuarantineDecision =
  | {
      readonly action: 'accept'
      readonly updateBytesLength: number
      readonly updateSha256: Sha256Hex
    }
  | {
      readonly action: 'quarantine'
      readonly row: SyncUpdateQuarantineRow
    }
  | {
      readonly action: 'reject'
      readonly reason: 'invalid-now' | 'invalid-update-size' | 'invalid-quarantine-id'
    }

/** Input for deciding how to durably handle an inbound sync update. */
export interface SyncUpdateAppendDecisionInput {
  readonly update: SyncUpdate
  readonly doc: SyncUpdateDocClock | undefined
  readonly duplicate: SyncUpdateDuplicateEvidence | undefined
  readonly updateBytesLength: number
  readonly updateSha256: Sha256Hex
  readonly yClientId: number
  readonly now: number
  readonly largeUpdateThresholdBytes: number
}

/** Row the caller should append to `op_log` inside the Durable Object transaction. */
export interface SyncUpdateOpLogAppend {
  readonly seq: number
  readonly messageId: SyncUpdate['messageId']
  readonly deviceId: SyncUpdate['deviceId']
  readonly docId: SyncUpdate['docId']
  readonly yClientId: number
  readonly updateSha256: Sha256Hex
  readonly createdAt: number
}

/** Patch the caller should apply to `docs` after successful append. */
export interface SyncUpdateDocPatch {
  readonly latestSeq: number
  readonly updatedAt: number
}

/** Decision for an inbound sync update before mutating. */
export type SyncUpdateAppendDecision =
  | {
      readonly action: 'append-op'
      readonly opLogAppend: SyncUpdateOpLogAppend
      readonly docPatch: SyncUpdateDocPatch
      readonly ack: Ack
    }
  | {
      readonly action: 'ack-duplicate'
      readonly ack: Ack
    }
  | {
      readonly action: 'snapshot-escape'
      readonly seq: number
      readonly docPatch: SyncUpdateDocPatch
      readonly ack: Ack
      readonly boundary: NeedFullSnapshot
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-clock'
        | 'invalid-update-size'
        | 'invalid-y-client-id'
        | 'invalid-now'
        | 'duplicate-ahead-of-doc'
    }
