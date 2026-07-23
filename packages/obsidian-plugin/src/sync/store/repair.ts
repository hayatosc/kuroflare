import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
  LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
  LocalOutboxRepairExportEntrySchema,
  LocalOutboxRepairExportSchema,
  decideLocalOutboxRepairResume,
  decideLocalStoreRepair,
  makeOutboxPlanItemId,
  planLocalOutboxRepairImport,
  type LocalOutboxRepairExportEntry,
  type LocalOutboxRepairImportedYUpdate,
  type LocalStoreSchemaDecision,
} from '@kuroflare/core'
import * as v from 'valibot'

import type {
  LocalStoreRepairEffect,
  LocalStoreRepairExportBuildInput,
  LocalStoreRepairExportBuildPlan,
  LocalStoreRepairExportMetadataInput,
  LocalStoreRepairExportOutboxRecord,
  LocalStoreRepairImportPlan,
  LocalStoreRepairImportPlanInput,
  LocalStoreRepairImportResumeEffect,
  LocalStoreRepairImportResumePlan,
  LocalStoreRepairImportResumePlanInput,
  LocalStoreRepairImportStageEffect,
  LocalStoreRepairImportedOutboxRecord,
  LocalStoreRepairPlan,
  LocalStoreRepairPlanInput,
  SuccessfulLocalStoreRepairImportPlan,
  SuccessfulLocalStoreRepairImportResumePlan,
} from '../store/repair.types'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
  type LocalStoreIndexedDbOpenEffect,
} from '../store/schema'
import { type LocalStoreTransactionOperation } from '../store/store'

export type {
  LocalStoreRepairEffect,
  LocalStoreRepairExportBuildInput,
  LocalStoreRepairExportBuildPlan,
  LocalStoreRepairExportMetadataInput,
  LocalStoreRepairExportOutboxRecord,
  LocalStoreRepairImportPlan,
  LocalStoreRepairImportPlanInput,
  LocalStoreRepairImportResumeEffect,
  LocalStoreRepairImportResumePlan,
  LocalStoreRepairImportResumePlanInput,
  LocalStoreRepairImportStageEffect,
  LocalStoreRepairImportedOutboxRecord,
  LocalStoreRepairPlan,
  LocalStoreRepairPlanInput,
  SuccessfulLocalStoreRepairImportPlan,
  SuccessfulLocalStoreRepairImportResumePlan,
}

/** Directory path used for exporting outbox records during repair. */
export const LOCAL_STORE_REPAIR_EXPORT_DIRECTORY = '.obsidian/kuroflare/repair-exports'

/** Vault storage operations required to export repair files. */
export interface LocalStoreRepairExportFileAdapter {
  readonly read: (path: string) => Promise<string>
  readonly write: (path: string, data: string) => Promise<void>
}

/** Result of reading and validating a repair export file. */
export type LocalStoreRepairExportFileReadPlan =
  | {
      readonly ok: true
      readonly exportFile: v.InferInput<typeof LocalOutboxRepairExportSchema>
    }
  | {
      readonly ok: false
      readonly reason: 'unreadable-json' | 'invalid-export-payload'
      readonly error?: unknown
    }

/**
 * Builds the file path for a repair export.
 */
export function localStoreRepairExportPath(exportName: string): string {
  return `${LOCAL_STORE_REPAIR_EXPORT_DIRECTORY}/${exportName}`
}

/**
 * Writes a validated repair export JSON file to the vault.
 */
export async function writeLocalStoreRepairExportFile(input: {
  readonly adapter: Pick<LocalStoreRepairExportFileAdapter, 'write'>
  readonly path: string
  readonly exportFile: v.InferInput<typeof LocalOutboxRepairExportSchema>
}): Promise<void> {
  await input.adapter.write(input.path, `${JSON.stringify(input.exportFile, null, 2)}\n`)
}

/**
 * Reads and validates a repair export JSON file.
 */
export async function readLocalStoreRepairExportFile(input: {
  readonly adapter: Pick<LocalStoreRepairExportFileAdapter, 'read'>
  readonly path: string
}): Promise<LocalStoreRepairExportFileReadPlan> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await input.adapter.read(input.path)) as unknown
  } catch (error: unknown) {
    return { ok: false, reason: 'unreadable-json', error }
  }
  if (!v.is(LocalOutboxRepairExportSchema, parsed)) {
    return { ok: false, reason: 'invalid-export-payload' }
  }
  return { ok: true, exportFile: parsed }
}

/**
 * Converts core database repair decisions into storage and database actions.
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
 * Builds the JSON payload for exporting the outbox records.
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
 * Converts imported updates into staging actions for the local queue.
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
 * Plans whether a staged imported record can be resumed.
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
        effects: [
          {
            kind: 'resume-repair-import',
            itemId: input.record.id,
            expected: {
              kind: 'y-update',
              status: 'paused',
              reason: 'imported-repair-export',
              resumeOn: 'manual',
              docId: input.record.docId,
              messageId: input.record.messageId,
              updateSha256: input.record.updateSha256,
              updateBytesBase64: input.record.updateBytesBase64,
            },
            patch: decision.patch,
          },
        ],
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
 * Converts staged imported records into database insert operations.
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
 * Converts a confirmed resume effect into an outbox update operation.
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
        expected: effect.expected,
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
    ...(record.metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 as const } : {}),
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
    ...(item.metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 as const } : {}),
  }
}
