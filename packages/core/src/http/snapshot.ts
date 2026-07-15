import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { DocIdSchema, VaultIdSchema } from '../utils/ids'
import {
  Base64Schema,
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
} from '../utils/shared'

const MAX_R2_KEY_LENGTH = 1024

export const SnapshotObjectKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_R2_KEY_LENGTH),
  v.check(
    (val) =>
      val.startsWith('snapshots/') &&
      !val.includes('\0') &&
      !val.includes('\\') &&
      !val.includes('//') &&
      val.endsWith('.yupdate'),
    'Invalid R2 object key',
  ),
)

export const MetaLatestSnapshotResponseSchema = v.object({
  manifestSeq: NonNegativeSafeIntegerSchema,
  snapshotKey: SnapshotObjectKeySchema,
  snapshotSeq: NonNegativeSafeIntegerSchema,
  updateSha256: Sha256HexSchema,
  stateVectorSha256: Sha256HexSchema,
  stateVector: Base64Schema,
  updateBytesBase64: Base64Schema,
})
export type MetaLatestSnapshotResponse = v.InferInput<typeof MetaLatestSnapshotResponseSchema>

export const DocLatestSnapshotResponseSchema = v.intersect([
  MetaLatestSnapshotResponseSchema,
  v.object({ docId: DocIdSchema }),
])
export type DocLatestSnapshotResponse = v.InferInput<typeof DocLatestSnapshotResponseSchema>

export const SnapshotImportRequestSchema = v.object({
  updateBytesBase64: Base64Schema,
  latestSeq: v.optional(PositiveSafeIntegerSchema),
  metadataSchemaVersion: v.optional(v.literal(2)),
})
export type SnapshotImportRequest = v.InferInput<typeof SnapshotImportRequestSchema>

export const SnapshotImportResponseSchema = v.object({
  ok: v.literal(true),
  vaultId: VaultIdSchema,
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  snapshotSeq: PositiveSafeIntegerSchema,
})
export type SnapshotImportResponse = v.InferInput<typeof SnapshotImportResponseSchema>
