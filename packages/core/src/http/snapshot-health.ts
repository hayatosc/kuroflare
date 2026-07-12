import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { DocIdSchema, KuroflareIdSchema } from '../utils/ids'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'
import { SnapshotObjectKeySchema } from './snapshot'

const MAX_REASON_LENGTH = 1024
const MAX_HEALTH_ENTRIES = 256
const MAX_HEALTH_REASONS = 16

/** Stable system or authenticated device identity that produced an audit event. */
export const SnapshotHealthActorSchema = KuroflareIdSchema
export type SnapshotHealthActor = v.InferInput<typeof SnapshotHealthActorSchema>

/** Mutations that the current durable authority permits for one generation. */
export const SnapshotHealthActionSchema = v.union([
  v.literal('verify'),
  v.literal('quarantine'),
  v.literal('rollback'),
])
export type SnapshotHealthAction = v.InferInput<typeof SnapshotHealthActionSchema>

/** Durable expected evidence captured before an immutable snapshot write. */
export const SnapshotExpectedEvidenceSchema = v.object({
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  upperSeq: PositiveSafeIntegerSchema,
  actor: SnapshotHealthActorSchema,
  expectedByteLength: NonNegativeSafeIntegerSchema,
  expectedUpdateSha256: Sha256HexSchema,
  expectedStateVectorSha256: Sha256HexSchema,
})
export type SnapshotExpectedEvidence = v.InferInput<typeof SnapshotExpectedEvidenceSchema>

/** Physical and logical health state for one immutable snapshot generation. */
export const SnapshotHealthEntrySchema = v.object({
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  upperSeq: PositiveSafeIntegerSchema,
  actor: SnapshotHealthActorSchema,
  authorityStatus: v.union([v.literal('candidate'), v.literal('authoritative')]),
  allowedActions: v.pipe(v.array(SnapshotHealthActionSchema), v.maxLength(3)),
  actionBlockReason: v.optional(v.pipe(v.string(), v.maxLength(256))),
  expectedByteLength: v.optional(NonNegativeSafeIntegerSchema),
  expectedUpdateSha256: v.optional(Sha256HexSchema),
  expectedStateVectorSha256: v.optional(Sha256HexSchema),
  actualByteLength: v.optional(NonNegativeSafeIntegerSchema),
  actualUpdateSha256: v.optional(Sha256HexSchema),
  actualStateVectorSha256: v.optional(Sha256HexSchema),
  physicalStatus: v.union([v.literal('verified'), v.literal('unverified'), v.literal('mismatch')]),
  logicalStatus: v.union([v.literal('healthy'), v.literal('quarantined')]),
  reasons: v.pipe(v.array(v.string()), v.maxLength(MAX_HEALTH_REASONS)),
  observedAt: NonNegativeSafeIntegerSchema,
})
export type SnapshotHealthEntry = v.InferInput<typeof SnapshotHealthEntrySchema>

/** Paginated snapshot health inspection response. */
export const SnapshotHealthListResponseSchema = v.object({
  entries: v.pipe(v.array(SnapshotHealthEntrySchema), v.maxLength(MAX_HEALTH_ENTRIES)),
  nextCursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})
export type SnapshotHealthListResponse = v.InferInput<typeof SnapshotHealthListResponseSchema>

/** Explicit operator request to verify and approve a legacy or unverified snapshot. */
export const SnapshotHealthVerifyRequestSchema = v.object({
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  upperSeq: PositiveSafeIntegerSchema,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_LENGTH)),
  confirmation: v.literal('verify'),
})
export type SnapshotHealthVerifyRequest = v.InferInput<typeof SnapshotHealthVerifyRequestSchema>

/** Explicit operator request to logically quarantine a snapshot generation. */
export const SnapshotHealthQuarantineRequestSchema = v.object({
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  upperSeq: PositiveSafeIntegerSchema,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_LENGTH)),
  confirmation: v.literal('quarantine'),
})
export type SnapshotHealthQuarantineRequest = v.InferInput<
  typeof SnapshotHealthQuarantineRequestSchema
>

/** Explicit operator request to create a new authoritative rollback generation. */
export const SnapshotRollbackRequestSchema = v.object({
  docId: DocIdSchema,
  snapshotKey: SnapshotObjectKeySchema,
  upperSeq: PositiveSafeIntegerSchema,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_LENGTH)),
  confirmation: v.literal('rollback'),
})
export type SnapshotRollbackRequest = v.InferInput<typeof SnapshotRollbackRequestSchema>

/** Response returned after an operator snapshot health mutation. */
export const SnapshotHealthMutationResponseSchema = v.object({
  ok: v.literal(true),
  entry: SnapshotHealthEntrySchema,
})
export type SnapshotHealthMutationResponse = v.InferInput<
  typeof SnapshotHealthMutationResponseSchema
>

/** Response returned after a rollback creates a new immutable generation. */
export const SnapshotRollbackResponseSchema = v.object({
  ok: v.literal(true),
  docId: DocIdSchema,
  actor: SnapshotHealthActorSchema,
  snapshotKey: SnapshotObjectKeySchema,
  snapshotSeq: PositiveSafeIntegerSchema,
  sourceSnapshotKey: SnapshotObjectKeySchema,
  sourceSnapshotSeq: PositiveSafeIntegerSchema,
  auditId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
})
export type SnapshotRollbackResponse = v.InferInput<typeof SnapshotRollbackResponseSchema>
