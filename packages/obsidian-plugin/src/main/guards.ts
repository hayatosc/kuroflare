import type { OutboxRunningLease, DocId } from '@kuroflare/core'

import type {
  KuroflareSettings,
  KuroflareRepairLogEntry,
  KuroflareLocalRepairExportMetadata,
} from '../main-types'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import type { LocalStoreRepairImportedOutboxRecord } from '../sync/store/repair'
import type { LocalStoreOutboxRecord } from '../sync/store/store'

export function isPartialSettings(value: unknown): value is Partial<KuroflareSettings> {
  return typeof value === 'object' && value !== null
}

export function isKuroflareRepairLogEntry(value: unknown): value is KuroflareRepairLogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const id = Reflect.get(value, 'id')
  const kind = Reflect.get(value, 'kind')
  const fileId = Reflect.get(value, 'fileId')
  const reason = Reflect.get(value, 'reason')
  const createdAt = Reflect.get(value, 'createdAt')
  const path = Reflect.get(value, 'path')
  return (
    typeof id === 'string' &&
    (kind === 'path-conflict' ||
      kind === 'delete-vs-edit' ||
      kind === 'invalid-meta' ||
      kind === 'remote-materialize-blocked') &&
    typeof fileId === 'string' &&
    typeof reason === 'string' &&
    Number.isSafeInteger(createdAt) &&
    (path === undefined || typeof path === 'string')
  )
}

export function isKuroflareLocalRepairExportMetadata(
  value: unknown,
): value is KuroflareLocalRepairExportMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const path = Reflect.get(value, 'path')
  const exportedAt = Reflect.get(value, 'exportedAt')
  const pendingOutboxCount = Reflect.get(value, 'pendingOutboxCount')
  return (
    typeof path === 'string' &&
    Number.isSafeInteger(exportedAt) &&
    exportedAt >= 0 &&
    Number.isSafeInteger(pendingOutboxCount) &&
    pendingOutboxCount >= 0
  )
}

export function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('File already exists')
}

export function sameLocalSetupMetadata(
  left: LocalSetupMetadata | undefined,
  right: LocalSetupMetadata,
): boolean {
  return (
    left !== undefined &&
    left.endpoint === right.endpoint &&
    left.vaultId === right.vaultId &&
    left.deviceId === right.deviceId &&
    left.yClientId === right.yClientId &&
    left.protocolVersion === right.protocolVersion &&
    left.bootstrapMode === right.bootstrapMode &&
    left.tokenVersion === right.tokenVersion
  )
}

export function isLocalStoreOutboxRecord(value: unknown): value is LocalStoreOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const id = Reflect.get(value, 'id')
  const kind = Reflect.get(value, 'kind')
  const status = Reflect.get(value, 'status')
  const dependsOn = Reflect.get(value, 'dependsOn')
  const metadataSchemaVersion = Reflect.get(value, 'metadataSchemaVersion')
  return (
    typeof id === 'string' &&
    typeof kind === 'string' &&
    typeof status === 'string' &&
    Array.isArray(dependsOn) &&
    (metadataSchemaVersion === undefined || metadataSchemaVersion === 2)
  )
}

export function isOutboxRunningLease(value: unknown): value is OutboxRunningLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const itemId = Reflect.get(value, 'itemId')
  const kind = Reflect.get(value, 'kind')
  const ownerId = Reflect.get(value, 'ownerId')
  const leaseExpiresAt = Reflect.get(value, 'leaseExpiresAt')
  return (
    typeof itemId === 'string' &&
    typeof kind === 'string' &&
    typeof ownerId === 'string' &&
    Number.isSafeInteger(leaseExpiresAt)
  )
}

export function isStagedRepairImportRecord(
  record: LocalStoreOutboxRecord,
): record is LocalStoreRepairImportedOutboxRecord {
  return (
    record.kind === 'y-update' &&
    record.status === 'paused' &&
    record.reason === 'imported-repair-export' &&
    record.resumeOn === 'manual' &&
    record.docId !== undefined &&
    record.messageId !== undefined &&
    record.updateSha256 !== undefined &&
    record.updateBytesBase64 !== undefined &&
    record.createdAt !== undefined &&
    (record.retryCount ?? 0) === 0
  )
}

export function isStoredYDocRecord(value: unknown): value is {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const docId = Reflect.get(value, 'docId')
  const updateBytes = Reflect.get(value, 'updateBytes')
  return isDocIdLike(docId) && updateBytes instanceof Uint8Array
}

export function isDocIdLike(value: unknown): value is DocId {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const kind = Reflect.get(value, 'kind')
  if (kind === 'meta') {
    return true
  }
  return kind === 'file' && typeof Reflect.get(value, 'ydocId') === 'string'
}
