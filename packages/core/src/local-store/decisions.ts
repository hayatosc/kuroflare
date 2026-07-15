import type { LocalOutboxRepairExportEntry } from '../local-store/repair'
import type { DocId } from '../utils/ids'
import type {
  LocalStoreObjectStore,
  LocalStoreSchemaDecisionInput,
  LocalStoreSchemaDecision,
  LocalStoreRepairDecisionInput,
  LocalStoreRepairDecision,
  LocalOutboxRepairImportInput,
  LocalOutboxRepairImportDecision,
  LocalOutboxRepairImportedYUpdate,
  LocalOutboxRepairImportSkip,
  LocalOutboxRepairResumeInput,
  LocalOutboxRepairResumeDecision,
} from './types'

/**
 * Decides how the plugin should handle its local IndexedDB schema before sync starts.
 */
export function decideLocalStoreSchema(
  input: LocalStoreSchemaDecisionInput,
): LocalStoreSchemaDecision {
  if (
    !isPositiveSafeInteger(input.targetVersion) ||
    !isPositiveSafeInteger(input.minimumReadableVersion)
  ) {
    return { action: 'reject', reason: 'invalid-version' }
  }
  if (input.minimumReadableVersion > input.targetVersion) {
    return { action: 'reject', reason: 'invalid-version' }
  }
  if (input.currentVersion !== undefined && !isPositiveSafeInteger(input.currentVersion)) {
    return { action: 'reject', reason: 'invalid-version' }
  }
  if (!Number.isSafeInteger(input.pendingOutboxCount) || input.pendingOutboxCount < 0) {
    return { action: 'reject', reason: 'invalid-pending-outbox-count' }
  }
  if (hasDuplicateStore(input.presentStores) || hasDuplicateStore(input.requiredStores)) {
    return { action: 'reject', reason: 'duplicate-store-name' }
  }
  if (
    (!input.dbExists && input.currentVersion !== undefined) ||
    (!input.dbExists && input.presentStores.length > 0) ||
    (!input.dbExists && input.pendingOutboxCount > 0)
  ) {
    return { action: 'reject', reason: 'inconsistent-local-store-evidence' }
  }

  const requiredStores = [...input.requiredStores]
  if (!input.dbExists) {
    return {
      action: 'create',
      version: input.targetVersion,
      createStores: requiredStores,
    }
  }

  const currentVersion = input.currentVersion
  if (currentVersion === undefined) {
    return { action: 'reject', reason: 'inconsistent-local-store-evidence' }
  }
  if (currentVersion > input.targetVersion) {
    return { action: 'degraded', reason: 'local-store-too-new' }
  }
  if (currentVersion < input.minimumReadableVersion) {
    if (input.pendingOutboxCount > 0) {
      return { action: 'degraded', reason: 'store-version-too-old-with-pending-outbox' }
    }
    return {
      action: 'rebuild',
      reason: 'store-version-too-old',
      targetVersion: input.targetVersion,
      pendingOutboxCount: 0,
    }
  }

  const missingStores = missingRequiredStores(input.presentStores, input.requiredStores)
  if (currentVersion < input.targetVersion) {
    return {
      action: 'upgrade',
      fromVersion: currentVersion,
      toVersion: input.targetVersion,
      createStores: missingStores,
    }
  }
  if (missingStores.length > 0) {
    if (input.pendingOutboxCount > 0) {
      return { action: 'degraded', reason: 'missing-required-store-with-pending-outbox' }
    }
    return {
      action: 'rebuild',
      reason: 'missing-required-store',
      targetVersion: input.targetVersion,
      pendingOutboxCount: 0,
    }
  }

  return { action: 'open', version: currentVersion }
}

/**
 * Plans a repair-panel action for a degraded local store without silently losing outbox data.
 */
export function decideLocalStoreRepair(
  input: LocalStoreRepairDecisionInput,
): LocalStoreRepairDecision {
  if (!Number.isSafeInteger(input.pendingOutboxCount) || input.pendingOutboxCount < 0) {
    return { action: 'reject', reason: 'invalid-pending-outbox-count' }
  }
  if (!isPositiveSafeInteger(input.targetVersion)) {
    return { action: 'reject', reason: 'invalid-target-version' }
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { action: 'reject', reason: 'invalid-now' }
  }
  if (input.schemaDecision.action !== 'degraded') {
    if (
      input.schemaDecision.action === 'create' ||
      input.schemaDecision.action === 'open' ||
      input.schemaDecision.action === 'upgrade' ||
      input.schemaDecision.action === 'rebuild'
    ) {
      return { action: 'keep-degraded', reason: 'schema-not-degraded' }
    }
    return { action: 'reject', reason: 'unsupported-schema-decision' }
  }

  switch (input.request) {
    case 'keep-degraded':
      return { action: 'keep-degraded', reason: 'user-deferred' }
    case 'export-pending-outbox':
      return {
        action: 'export-pending-outbox',
        exportName: makeLocalStoreRepairExportName(input.now),
        includeOutbox: true,
        includeMetadata: true,
      }
    case 'rebuild-after-export':
      if (input.pendingOutboxCount > 0 && !input.exportCompleted) {
        return { action: 'reject', reason: 'export-required' }
      }
      return {
        action: 'rebuild',
        reason: input.pendingOutboxCount > 0 ? 'outbox-exported' : 'empty-outbox',
        targetVersion: input.targetVersion,
        clearPendingOutbox: input.pendingOutboxCount > 0,
      }
    case 'discard-and-rebuild':
      if (input.pendingOutboxCount > 0 && !input.discardConfirmed) {
        return { action: 'reject', reason: 'discard-confirmation-required' }
      }
      return {
        action: 'rebuild',
        reason: input.pendingOutboxCount > 0 ? 'outbox-discarded' : 'empty-outbox',
        targetVersion: input.targetVersion,
        clearPendingOutbox: input.pendingOutboxCount > 0,
      }
  }
}

/**
 * Stages safe Yjs update entries from a local repair export without automatically replaying them.
 */
export function planLocalOutboxRepairImport(
  input: LocalOutboxRepairImportInput,
): LocalOutboxRepairImportDecision {
  if (input.exportFile.vaultId !== input.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (
    input.deviceId !== undefined &&
    input.exportFile.deviceId !== undefined &&
    input.exportFile.deviceId !== input.deviceId
  ) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (hasDuplicateString(input.exportFile.entries.map((entry) => entry.id))) {
    return { action: 'reject', reason: 'duplicate-export-id' }
  }
  if (input.durableMessages.some((message) => !isNonNegativeSafeInteger(message.durableSeq))) {
    return { action: 'reject', reason: 'invalid-durable-seq' }
  }

  const imports: LocalOutboxRepairImportedYUpdate[] = []
  const skipped: LocalOutboxRepairImportSkip[] = []
  const existingIds = new Set(input.existingOutboxIds)

  for (const entry of input.exportFile.entries) {
    const skipReason = decideLocalOutboxRepairImportSkip(entry, input, existingIds)
    if (skipReason !== null) {
      skipped.push({ id: entry.id, reason: skipReason })
      continue
    }
    const docId = entry.docId
    const messageId = entry.messageId
    const updateSha256 = entry.updateSha256
    const updateBytesBase64 = entry.updateBytesBase64
    if (
      docId === undefined ||
      messageId === undefined ||
      updateSha256 === undefined ||
      updateBytesBase64 === undefined
    ) {
      skipped.push({ id: entry.id, reason: 'missing-y-update-fields' })
      continue
    }

    imports.push({
      id: entry.id,
      kind: 'y-update',
      status: 'paused',
      reason: 'imported-repair-export',
      resumeOn: 'manual',
      docId,
      messageId,
      updateSha256,
      updateBytesBase64,
      ...(entry.metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 as const } : {}),
      createdAt: entry.createdAt,
    })
  }

  return { action: 'stage-import', imports, skipped }
}

/**
 * Decides whether a staged repair-imported Yjs update may be manually resumed.
 */
export function decideLocalOutboxRepairResume(
  input: LocalOutboxRepairResumeInput,
): LocalOutboxRepairResumeDecision {
  if (input.durableMessages.some((message) => !isNonNegativeSafeInteger(message.durableSeq))) {
    return { action: 'reject', reason: 'invalid-durable-seq' }
  }
  if (!input.userConfirmed) {
    return { action: 'wait', reason: 'confirmation-required' }
  }
  if (
    input.durableMessages.some(
      (message) =>
        sameDocId(message.docId, input.item.docId) && message.messageId === input.item.messageId,
    )
  ) {
    return { action: 'wait', reason: 'already-durable' }
  }
  if (
    input.quarantinedMessages.some(
      (message) =>
        sameDocId(message.docId, input.item.docId) &&
        message.messageId === input.item.messageId &&
        (message.updateSha256 === undefined || message.updateSha256 === input.item.updateSha256),
    )
  ) {
    return { action: 'wait', reason: 'server-quarantine' }
  }

  return {
    action: 'resume',
    patch: {
      status: 'pending',
      nextAttemptAt: undefined,
      resumeReason: 'user-confirmed-repair-import',
    },
  }
}

function missingRequiredStores(
  presentStores: readonly LocalStoreObjectStore[],
  requiredStores: readonly LocalStoreObjectStore[],
): readonly LocalStoreObjectStore[] {
  const present = new Set(presentStores)
  return requiredStores.filter((store) => !present.has(store))
}

function hasDuplicateStore(stores: readonly LocalStoreObjectStore[]): boolean {
  return new Set(stores).size !== stores.length
}

function decideLocalOutboxRepairImportSkip(
  entry: LocalOutboxRepairExportEntry,
  input: LocalOutboxRepairImportInput,
  existingIds: ReadonlySet<string>,
): LocalOutboxRepairImportSkip['reason'] | null {
  if (existingIds.has(entry.id)) {
    return 'duplicate-local-outbox-id'
  }
  if (entry.kind !== 'y-update') {
    return 'unsupported-kind'
  }
  if (entry.status !== 'pending' && entry.status !== 'retrying' && entry.status !== 'paused') {
    return 'unsupported-status'
  }
  if (entry.dependsOn.length > 0) {
    return 'dependency-not-restored'
  }
  if (
    entry.docId === undefined ||
    entry.messageId === undefined ||
    entry.updateSha256 === undefined ||
    entry.updateBytesBase64 === undefined
  ) {
    return 'missing-y-update-fields'
  }
  const docId = entry.docId
  const messageId = entry.messageId
  const updateSha256 = entry.updateSha256
  if (
    input.durableMessages.some(
      (message) => sameDocId(message.docId, docId) && message.messageId === messageId,
    )
  ) {
    return 'already-durable'
  }
  if (
    input.quarantinedMessages.some(
      (message) =>
        sameDocId(message.docId, docId) &&
        message.messageId === messageId &&
        (message.updateSha256 === undefined || message.updateSha256 === updateSha256),
    )
  ) {
    return 'server-quarantine'
  }
  return null
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta') {
    return true
  }
  return right.kind === 'file' && left.ydocId === right.ydocId
}

function hasDuplicateString(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function makeLocalStoreRepairExportName(now: number): string {
  return `kuroflare-local-outbox-${now}.json`
}
