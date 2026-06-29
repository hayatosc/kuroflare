import * as v from 'valibot'

import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from './_shared'
import { DeviceIdSchema, DocIdSchema, FileIdSchema, MessageIdSchema, VaultIdSchema } from './ids'
import { Sha256HexSchema } from './meta'

export const LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT = 'kuroflare-local-outbox-export'
export const LOCAL_OUTBOX_REPAIR_EXPORT_VERSION = 1

export const LocalOutboxRepairExportItemKindSchema = v.union([
  v.literal('y-update'),
  v.literal('blob-put'),
  v.literal('manifest-put'),
  v.literal('blob-get'),
  v.literal('meta-ref-update'),
  v.literal('materialize'),
])
export type LocalOutboxRepairExportItemKind = v.InferInput<
  typeof LocalOutboxRepairExportItemKindSchema
>

export const LocalOutboxRepairExportItemStatusSchema = v.union([
  v.literal('pending'),
  v.literal('retrying'),
  v.literal('paused'),
  v.literal('blocked'),
  v.literal('failed'),
])
export type LocalOutboxRepairExportItemStatus = v.InferInput<
  typeof LocalOutboxRepairExportItemStatusSchema
>

const MAX_EXPORT_ENTRIES = 10_000
const MAX_ID_LENGTH = 256
const MAX_DEPENDENCIES = 256
const MAX_LOCAL_CACHE_KEY_LENGTH = 2048
const MAX_REASON_LENGTH = 2048
const MAX_UPDATE_BYTES_BASE64_LENGTH = 64 * 1024 * 1024
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const BoundedBase64Schema = v.pipe(
  v.string(),
  v.maxLength(MAX_UPDATE_BYTES_BASE64_LENGTH),
  v.regex(BASE64_PATTERN, 'Invalid base64'),
)

export const LocalOutboxRepairExportEntrySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH)),
  kind: LocalOutboxRepairExportItemKindSchema,
  status: LocalOutboxRepairExportItemStatusSchema,
  dependsOn: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH))),
    v.maxLength(MAX_DEPENDENCIES),
  ),
  createdAt: NonNegativeSafeIntegerSchema,
  retryCount: NonNegativeSafeIntegerSchema,
  docId: v.optional(DocIdSchema),
  fileId: v.optional(FileIdSchema),
  messageId: v.optional(MessageIdSchema),
  updateSha256: v.optional(Sha256HexSchema),
  updateBytesBase64: v.optional(BoundedBase64Schema),
  blobSha256: v.optional(Sha256HexSchema),
  localCacheKey: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_LOCAL_CACHE_KEY_LENGTH)),
  ),
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_LENGTH))),
})
export type LocalOutboxRepairExportEntry = v.InferInput<typeof LocalOutboxRepairExportEntrySchema>

export const LocalOutboxRepairExportMetadataSchema = v.object({
  localStoreVersion: PositiveSafeIntegerSchema,
  targetStoreVersion: PositiveSafeIntegerSchema,
  degradedReason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_LENGTH)),
})
export type LocalOutboxRepairExportMetadata = v.InferInput<
  typeof LocalOutboxRepairExportMetadataSchema
>

export const LocalOutboxRepairExportSchema = v.object({
  format: v.literal(LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT),
  formatVersion: v.literal(LOCAL_OUTBOX_REPAIR_EXPORT_VERSION),
  exportedAt: NonNegativeSafeIntegerSchema,
  vaultId: VaultIdSchema,
  deviceId: v.optional(DeviceIdSchema),
  metadata: LocalOutboxRepairExportMetadataSchema,
  entries: v.pipe(v.array(LocalOutboxRepairExportEntrySchema), v.maxLength(MAX_EXPORT_ENTRIES)),
})
export type LocalOutboxRepairExport = v.InferInput<typeof LocalOutboxRepairExportSchema>
