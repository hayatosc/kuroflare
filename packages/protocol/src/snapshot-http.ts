import * as v from 'valibot'

import { DocIdSchema } from './ids.js'
import { Sha256HexSchema } from './meta.js'

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_R2_KEY_LENGTH = 1024

const Base64Schema = v.pipe(v.string(), v.regex(BASE64_PATTERN, 'Invalid base64 string'))

const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

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
