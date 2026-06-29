import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  decideLocalStoreRepair,
  decideLocalOutboxRepairResume,
  makeOutboxPlanItemId,
  planLocalOutboxRepairImport,
  type LocalOutboxRepairImportDecision,
  type LocalOutboxRepairImportedYUpdate,
  type LocalOutboxRepairImportDurableMessage,
  type LocalOutboxRepairImportQuarantinedMessage,
  type LocalOutboxRepairResumeDecision,
  type OutboxPlanItemId,
  type LocalStoreObjectStore,
  type LocalStoreRepairDecision,
  type LocalStoreRepairRequest,
  type LocalStoreSchemaDecision,
} from '@kuroflare/core'
import {
  LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
  LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
  LocalOutboxRepairExportSchema,
  LocalOutboxRepairExportEntrySchema,
  type DeviceId,
  type DocId,
  type FileId,
  type LocalOutboxRepairExport,
  type LocalOutboxRepairExportEntry,
  type LocalOutboxRepairExportItemKind,
  type LocalOutboxRepairExportItemStatus,
  type MessageId,
  type Sha256Hex,
  type VaultId,
} from '@kuroflare/protocol'
import * as v from 'valibot'

import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
  type LocalStoreIndexedDbOpenEffect,
} from './local-store-schema.js'
import { type LocalStoreTransactionOperation } from './local-store.js'

/** Vault-relative directory used for degraded local-store repair exports. */
export const LOCAL_STORE_REPAIR_EXPORT_DIRECTORY = '.obsidian/kuroflare/repair-exports'

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

/**
 * Builds the Vault-relative path for a degraded local-store repair export.
 *
 * @param exportName Deterministic export filename returned by core repair decision logic.
 * @returns Vault-relative repair export path.
 */
export function localStoreRepairExportPath(exportName: string): string {
  return `${LOCAL_STORE_REPAIR_EXPORT_DIRECTORY}/${exportName}`
}

/**
 * Converts core degraded local-store repair decisions into plugin Vault and IndexedDB effects.
 *
 * @param input Degraded schema evidence, user request, export/confirmation evidence, and schema version overrides.
 * @returns Plugin repair plan for export, rebuild, degraded hold, or rejection.
 */
export function planLocalStoreRepair(input: LocalStoreRepairPlanInput): LocalStoreRepairPlan {
  const targetVersion = input.targetVersion ?? LOCAL_STORE_INDEXEDDB_TARGET_VERSION
  const requiredStores = input.requiredStores ?? DEFAULT_LOCAL_STORE_OBJECT_STORES
  const dbName = localStoreIndexedDbName(input.vaultId)
  const decision = decideLocalStoreRepair({
    schemaDecision: input.schemaDecision,
    request: input.request,
    pendingOutboxCount: input.pendingOutboxCount,
    exportCompleted: input.exportCompleted,
    discardConfirmed: input.discardConfirmed,
    targetVersion,
    now: input.now,
  })

  switch (decision.action) {
    case 'export-pending-outbox':
      return {
        ok: true,
        action: 'export-pending-outbox',
        dbName,
        decision,
        effects: [
          {
            kind: 'write-repair-export',
            path: localStoreRepairExportPath(decision.exportName),
            includeOutbox: decision.includeOutbox,
            includeMetadata: decision.includeMetadata,
          },
        ],
      }
    case 'rebuild':
      return {
        ok: true,
        action: 'rebuild',
        dbName,
        decision,
        effects: [
          {
            kind: 'delete-database',
            dbName,
            reason: repairRebuildDeleteReason(input.schemaDecision),
          },
          {
            kind: 'open-database',
            mode: 'create',
            dbName,
            version: decision.targetVersion,
            createStores: requiredStores,
          },
        ],
      }
    case 'keep-degraded':
      return {
        ok: true,
        action: 'keep-degraded',
        dbName,
        decision,
        effects: [{ kind: 'keep-degraded', reason: decision.reason }],
      }
    case 'reject':
      return {
        ok: false,
        action: 'reject',
        dbName,
        decision,
        effects: [{ kind: 'reject-repair', reason: decision.reason }],
      }
  }
}

/**
 * Builds the protocol JSON payload for a degraded local-store outbox repair export.
 *
 * @param input Export timestamp, vault/device identity, degraded metadata, and local outbox rows.
 * @returns A protocol-valid export payload or the first local evidence rejection.
 */
export function buildLocalStoreRepairExport(
  input: LocalStoreRepairExportBuildInput,
): LocalStoreRepairExportBuildPlan {
  if (!Number.isSafeInteger(input.exportedAt) || input.exportedAt < 0) {
    return { ok: false, reason: 'invalid-exported-at' }
  }
  if (
    !Number.isSafeInteger(input.metadata.localStoreVersion) ||
    input.metadata.localStoreVersion <= 0 ||
    !Number.isSafeInteger(input.metadata.targetStoreVersion) ||
    input.metadata.targetStoreVersion <= 0 ||
    input.metadata.degradedReason.length === 0
  ) {
    return { ok: false, reason: 'invalid-export-metadata' }
  }

  const entries: LocalOutboxRepairExportEntry[] = []
  for (const record of input.outboxRecords) {
    const entry = buildLocalStoreRepairExportEntry(record)
    if (!entry.ok) {
      return entry
    }
    entries.push(entry.entry)
  }

  const exportFile =
    input.deviceId === undefined
      ? {
          format: LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
          formatVersion: LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
          exportedAt: input.exportedAt,
          vaultId: input.vaultId,
          metadata: input.metadata,
          entries,
        }
      : {
          format: LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
          formatVersion: LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
          exportedAt: input.exportedAt,
          vaultId: input.vaultId,
          deviceId: input.deviceId,
          metadata: input.metadata,
          entries,
        }

  if (!v.is(LocalOutboxRepairExportSchema, exportFile)) {
    return { ok: false, reason: 'invalid-export-payload' }
  }

  return {
    ok: true,
    exportFile,
    exportedEntryIds: entries.map((entry) => entry.id),
  }
}

/**
 * Converts safe core repair-import candidates into plugin local-outbox staging effects.
 *
 * @param input Guarded repair export and current local/server evidence.
 * @returns Paused imported y-update rows to stage, skip evidence, or a file-level rejection.
 */
export function planLocalStoreRepairImport(
  input: LocalStoreRepairImportPlanInput,
): LocalStoreRepairImportPlan {
  const decision = planLocalOutboxRepairImport({
    exportFile: input.exportFile,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    existingOutboxIds: input.existingOutboxIds,
    durableMessages: input.durableMessages,
    quarantinedMessages: input.quarantinedMessages,
  })

  if (decision.action === 'reject') {
    return {
      ok: false,
      action: 'reject',
      reason: decision.reason,
      decision,
    }
  }

  const effects: LocalStoreRepairImportStageEffect[] = []
  for (const item of decision.imports) {
    const record = convertImportedYUpdateToOutboxRecord(item)
    if (record === null) {
      return {
        ok: false,
        action: 'reject',
        reason: 'invalid-outbox-item-id',
        itemId: item.id,
      }
    }
    effects.push({ kind: 'stage-repair-import', record })
  }

  return {
    ok: true,
    action: 'stage-import',
    decision,
    effects,
  }
}

/**
 * Plans whether one staged repair import may be manually resumed.
 *
 * @param input Staged paused repair-import record plus user confirmation and fresh server evidence.
 * @returns A resume effect, a wait reason, or a rejection for invalid evidence.
 */
export function planLocalStoreRepairImportResume(
  input: LocalStoreRepairImportResumePlanInput,
): LocalStoreRepairImportResumePlan {
  const decision = decideLocalOutboxRepairResume({
    item: {
      id: input.record.id,
      kind: 'y-update',
      status: 'paused',
      reason: 'imported-repair-export',
      resumeOn: 'manual',
      docId: input.record.docId,
      messageId: input.record.messageId,
      updateSha256: input.record.updateSha256,
      updateBytesBase64: input.record.updateBytesBase64,
      createdAt: input.record.createdAt,
    },
    userConfirmed: input.userConfirmed,
    durableMessages: input.durableMessages,
    quarantinedMessages: input.quarantinedMessages,
  })

  switch (decision.action) {
    case 'resume':
      return {
        ok: true,
        action: 'resume',
        decision,
        effects: [{ kind: 'resume-repair-import', itemId: input.record.id, patch: decision.patch }],
      }
    case 'wait':
      return {
        ok: true,
        action: 'wait',
        decision,
        effects: [],
      }
    case 'reject':
      return {
        ok: false,
        action: 'reject',
        decision,
        effects: [],
      }
  }
}

/**
 * Converts staged repair-import effects into absence-guarded local outbox insert operations.
 *
 * @param plan Successful repair-import staging plan.
 * @returns Ordered outbox put operations for one local-store transaction.
 */
export function planLocalStoreRepairImportStageTransaction(
  plan: SuccessfulLocalStoreRepairImportPlan,
): readonly LocalStoreTransactionOperation[] {
  return plan.effects.map(
    (effect): LocalStoreTransactionOperation => ({
      kind: 'put-outbox',
      put: { record: effect.record },
    }),
  )
}

/**
 * Converts a confirmed repair-import resume effect into a local outbox patch operation.
 *
 * @param plan Successful repair-import resume plan.
 * @returns A patch operation that makes the paused repair import runnable.
 */
export function planLocalStoreRepairImportResumeTransaction(
  plan: SuccessfulLocalStoreRepairImportResumePlan,
): readonly LocalStoreTransactionOperation[] {
  return plan.effects.map(
    (effect): LocalStoreTransactionOperation => ({
      kind: 'patch-outbox',
      patch: {
        kind: 'repair-import-resume',
        itemId: effect.itemId,
        patch: effect.patch,
      },
    }),
  )
}

function repairRebuildDeleteReason(
  schemaDecision: LocalStoreSchemaDecision,
): Extract<LocalStoreIndexedDbOpenEffect, { readonly kind: 'delete-database' }>['reason'] {
  if (
    schemaDecision.action === 'degraded' &&
    schemaDecision.reason === 'missing-required-store-with-pending-outbox'
  ) {
    return 'missing-required-store'
  }
  return 'store-version-too-old'
}

type LocalStoreRepairExportEntryBuildPlan =
  | { readonly ok: true; readonly entry: LocalOutboxRepairExportEntry }
  | Extract<LocalStoreRepairExportBuildPlan, { readonly ok: false }>

function buildLocalStoreRepairExportEntry(
  record: LocalStoreRepairExportOutboxRecord,
): LocalStoreRepairExportEntryBuildPlan {
  if (record.status === 'done') {
    return { ok: false, reason: 'unsupported-status', itemId: record.id }
  }
  if (record.createdAt === undefined) {
    return { ok: false, reason: 'missing-created-at', itemId: record.id }
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    return { ok: false, reason: 'invalid-created-at', itemId: record.id }
  }
  const retryCount = record.retryCount ?? 0
  if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
    return { ok: false, reason: 'invalid-retry-count', itemId: record.id }
  }

  let entry: LocalOutboxRepairExportEntry = {
    id: record.id,
    kind: record.kind,
    status: record.status,
    dependsOn: [...record.dependsOn],
    createdAt: record.createdAt,
    retryCount,
  }
  if (record.docId !== undefined) {
    entry = { ...entry, docId: record.docId }
  }
  if (record.fileId !== undefined) {
    entry = { ...entry, fileId: record.fileId }
  }
  if (record.messageId !== undefined) {
    entry = { ...entry, messageId: record.messageId }
  }
  if (record.updateSha256 !== undefined) {
    entry = { ...entry, updateSha256: record.updateSha256 }
  }
  if (record.updateBytesBase64 !== undefined) {
    entry = { ...entry, updateBytesBase64: record.updateBytesBase64 }
  }
  if (record.blobSha256 !== undefined) {
    entry = { ...entry, blobSha256: record.blobSha256 }
  }
  if (record.localCacheKey !== undefined) {
    entry = { ...entry, localCacheKey: record.localCacheKey }
  }
  if (record.reason !== undefined) {
    entry = { ...entry, reason: record.reason }
  }

  if (!v.is(LocalOutboxRepairExportEntrySchema, entry)) {
    return { ok: false, reason: 'invalid-export-payload', itemId: record.id }
  }

  return { ok: true, entry }
}

function convertImportedYUpdateToOutboxRecord(
  item: LocalOutboxRepairImportedYUpdate,
): LocalStoreRepairImportedOutboxRecord | null {
  const id = makeOutboxPlanItemId(item.id)
  if (id === null) {
    return null
  }

  return {
    id,
    kind: 'y-update',
    status: 'paused',
    reason: 'imported-repair-export',
    resumeOn: 'manual',
    dependsOn: [],
    nextAttemptAt: undefined,
    createdAt: item.createdAt,
    retryCount: 0,
    docId: item.docId,
    messageId: item.messageId,
    updateSha256: item.updateSha256,
    updateBytesBase64: item.updateBytesBase64,
  }
}
