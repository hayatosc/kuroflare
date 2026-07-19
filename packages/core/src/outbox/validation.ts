import * as v from 'valibot'

import { decideClientAuthStart } from '../auth'
import { type DocId } from '../utils/ids'
import {
  NonEmptyBase64Schema,
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from '../utils/shared'
import {
  type BinaryDownloadChunkInput,
  type BinaryUploadChunkInput,
  type BinaryOutboxPlanBuildError,
  type OutboxSchedulerAuthGateInput,
  type OutboxSchedulerTickPlan,
  type OutboxPlanItemId,
} from './types'
export { isNonNegativeSafeInteger, isPositiveSafeInteger }

export const OutboxPlanItemIdSchema = v.pipe(v.string(), v.minLength(1))
const OutboxRetryKindSchema = v.picklist([
  'y-update',
  'blob-put',
  'manifest-put',
  'blob-get',
  'meta-ref-update',
  'materialize',
])
const OutboxConcurrencyLaneSchema = v.picklist(['sync-control', 'blob-transfer', 'materialize'])

/** Primitive chunk evidence shared by binary upload and download plan builders. */
export const BinaryChunkValidationSchema = v.object({
  size: NonNegativeSafeIntegerSchema,
  localCacheKey: v.pipe(v.string(), v.minLength(1)),
})

export const BinaryChunkValidationListSchema = v.array(BinaryChunkValidationSchema)

export const OutboxAuthStartRefreshBlockSchema = v.object({
  id: OutboxPlanItemIdSchema,
  kind: OutboxRetryKindSchema,
  lane: OutboxConcurrencyLaneSchema,
  reason: v.union([v.literal('token-expired'), v.literal('token-expiring-soon')]),
  remainingMs: v.pipe(v.number(), v.safeInteger()),
  requiredRemainingMs: NonNegativeSafeIntegerSchema,
})

export const OutboxAuthRefreshStateSchema = v.union([
  v.object({ status: v.literal('idle') }),
  v.object({ status: v.literal('refreshing') }),
  v.object({
    status: v.literal('backing-off'),
    nextAllowedRefreshAt: NonNegativeSafeIntegerSchema,
  }),
])

export const OutboxAuthRefreshRequestInputSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  refreshState: OutboxAuthRefreshStateSchema,
  refreshBlocks: v.optional(v.array(OutboxAuthStartRefreshBlockSchema)),
})

/** Auth request primitives validated before duplicate/block evidence is inspected. */
export const OutboxAuthRefreshRequestPrimitivesSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
})

export const OutboxAuthRefreshBackoffSchema = v.object({
  nextAllowedRefreshAt: NonNegativeSafeIntegerSchema,
})

export const OutboxAuthRefreshBlockEvidenceSchema = v.object({
  remainingMs: v.pipe(v.number(), v.safeInteger()),
  requiredRemainingMs: NonNegativeSafeIntegerSchema,
})

export const OutboxRunningLeaseSchema = v.object({
  itemId: OutboxPlanItemIdSchema,
  kind: OutboxRetryKindSchema,
  ownerId: v.pipe(v.string(), v.minLength(1)),
  leaseExpiresAt: NonNegativeSafeIntegerSchema,
})

export const OutboxLeaseAcquireInputSchema = v.object({
  ownerId: v.pipe(v.string(), v.minLength(1)),
  now: NonNegativeSafeIntegerSchema,
  leaseDurationMs: PositiveSafeIntegerSchema,
  itemId: OutboxPlanItemIdSchema,
  kind: OutboxRetryKindSchema,
  existingLease: v.optional(OutboxRunningLeaseSchema),
})

export const OutboxLeaseReleaseInputSchema = v.object({
  ownerId: v.pipe(v.string(), v.minLength(1)),
  now: NonNegativeSafeIntegerSchema,
  itemId: OutboxPlanItemIdSchema,
  existingLease: v.optional(
    v.object({
      itemId: OutboxPlanItemIdSchema,
      ownerId: v.pipe(v.string(), v.minLength(1)),
      leaseExpiresAt: NonNegativeSafeIntegerSchema,
    }),
  ),
})

export const OutboxLeaseRenewInputSchema = OutboxLeaseAcquireInputSchema

export const OutboxLeaseAcquirePrimitivesSchema = v.object({
  ownerId: v.pipe(v.string(), v.minLength(1)),
  now: NonNegativeSafeIntegerSchema,
  leaseDurationMs: PositiveSafeIntegerSchema,
})

export const OutboxLeaseReleasePrimitivesSchema = v.object({
  ownerId: v.pipe(v.string(), v.minLength(1)),
  now: NonNegativeSafeIntegerSchema,
})

export const OutboxLeaseRenewPrimitivesSchema = OutboxLeaseAcquirePrimitivesSchema
export const OutboxLeaseExpirySchema = v.object({
  leaseExpiresAt: NonNegativeSafeIntegerSchema,
})
export const OutboxLeaseOwnerSchema = v.object({
  ownerId: v.pipe(v.string(), v.minLength(1)),
})

export const OutboxSchedulerAuthGateInputSchema = v.object({
  tokenExpiresAt: NonNegativeSafeIntegerSchema,
  refreshMarginMs: NonNegativeSafeIntegerSchema,
  estimates: v.optional(
    v.array(
      v.object({
        id: OutboxPlanItemIdSchema,
        estimatedDurationMs: NonNegativeSafeIntegerSchema,
      }),
    ),
  ),
  defaultEstimatedDurationMs: v.optional(NonNegativeSafeIntegerSchema),
})

export const OutboxSchedulerAuthGatePrimitivesSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  tokenExpiresAt: NonNegativeSafeIntegerSchema,
  refreshMarginMs: NonNegativeSafeIntegerSchema,
  defaultEstimatedDurationMs: v.optional(NonNegativeSafeIntegerSchema),
})

export const OutboxSchedulerAuthEstimateSchema = v.object({
  id: OutboxPlanItemIdSchema,
  estimatedDurationMs: NonNegativeSafeIntegerSchema,
})
export const OutboxSchedulerAuthEstimateEvidenceSchema = v.object({
  estimatedDurationMs: NonNegativeSafeIntegerSchema,
})

export const OutboxSchedulerTickInputSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  maxStarts: NonNegativeSafeIntegerSchema,
})

export const OutboxRetryDecisionInputSchema = v.object({
  retryCount: NonNegativeSafeIntegerSchema,
  kind: OutboxRetryKindSchema,
  error: v.union([
    v.object({ kind: v.union([v.literal('network'), v.literal('timeout'), v.literal('offline')]) }),
    v.object({
      kind: v.literal('api'),
      retryable: v.boolean(),
      // Invalid retry-after evidence intentionally remains opaque: retry policy
      // treats it as absent rather than changing the decision's fallback.
      retryAfterMs: v.optional(v.unknown()),
      code: v.optional(v.string()),
    }),
    v.object({
      kind: v.union([
        v.literal('local-conflict'),
        v.literal('invalid-payload'),
        v.literal('auth'),
        v.literal('metadata-migration-required'),
      ]),
    }),
  ]),
})
export const OutboxRetryCountSchema = v.object({ retryCount: NonNegativeSafeIntegerSchema })

export const OutboxRunClockSchema = v.object({ now: NonNegativeSafeIntegerSchema })
export const OutboxConcurrencyInputSchema = v.object({
  runningInLane: NonNegativeSafeIntegerSchema,
})

export const OutboxAckSequenceEvidenceSchema = v.object({
  durableSeq: NonNegativeSafeIntegerSchema,
  minDurableSeqExclusive: v.optional(NonNegativeSafeIntegerSchema),
})

export const OutboxSyncUpdateRejectedRepairEvidenceSchema = v.object({
  updateBytesBase64: v.optional(NonEmptyBase64Schema),
  importedSnapshotSeq: PositiveSafeIntegerSchema,
})

export const OutboxFullSnapshotReleaseEvidenceSchema = v.object({
  snapshotSeq: NonNegativeSafeIntegerSchema,
})

export function validateBinaryChunks(
  chunks: readonly (BinaryUploadChunkInput | BinaryDownloadChunkInput)[],
): BinaryOutboxPlanBuildError | undefined {
  const result = v.safeParse(BinaryChunkValidationListSchema, chunks)
  if (!result.success) {
    const path = result.issues[0]?.path ?? []
    const field = path[path.length - 1]?.key
    return field === 'localCacheKey' ? 'empty-local-cache-key' : 'invalid-blob-size'
  }
  return undefined
}

export function hasDuplicateIds(ids: readonly OutboxPlanItemId[]): boolean {
  return new Set(ids).size !== ids.length
}

export function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta') {
    return true
  }
  return right.kind === 'file' && left.ydocId === right.ydocId
}

export type ValidatedOutboxSchedulerAuthGate =
  | {
      readonly ok: true
      readonly auth: OutboxSchedulerAuthGateInput | undefined
      readonly estimateById: ReadonlyMap<OutboxPlanItemId, number>
    }
  | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>

export function validateOutboxSchedulerAuthGate(
  auth: OutboxSchedulerAuthGateInput | undefined,
  now: number,
): ValidatedOutboxSchedulerAuthGate {
  if (auth === undefined) {
    return { ok: true, auth: undefined, estimateById: new Map() }
  }

  const authResult = v.safeParse(OutboxSchedulerAuthGatePrimitivesSchema, { ...auth, now })
  if (!authResult.success) {
    const path = authResult.issues[0]?.path ?? []
    const field = path[path.length - 1]?.key
    if (field === 'now') return { ok: false, reason: 'invalid-clock' }
    if (field === 'tokenExpiresAt') return { ok: false, reason: 'invalid-token-expiry' }
    if (field === 'refreshMarginMs') return { ok: false, reason: 'invalid-refresh-margin' }
    return { ok: false, reason: 'invalid-estimated-duration' }
  }
  const validatedAuth = authResult.output

  const defaultValidation = decideClientAuthStart({
    now: validatedAuth.now,
    tokenExpiresAt: validatedAuth.tokenExpiresAt,
    refreshMarginMs: validatedAuth.refreshMarginMs,
    estimatedDurationMs: validatedAuth.defaultEstimatedDurationMs ?? 0,
  })
  if (defaultValidation.action === 'reject') {
    return { ok: false, reason: mapAuthStartRejectReason(defaultValidation.reason) }
  }

  const estimateById = new Map<OutboxPlanItemId, number>()
  const estimates = auth.estimates ?? []
  if (!Array.isArray(estimates)) {
    return { ok: false, reason: 'invalid-estimated-duration' }
  }
  for (const estimate of estimates) {
    if (estimateById.has(estimate.id)) {
      return { ok: false, reason: 'duplicate-auth-estimate', id: estimate.id }
    }
    const estimateResult = v.safeParse(OutboxSchedulerAuthEstimateEvidenceSchema, estimate)
    if (!estimateResult.success) {
      return { ok: false, reason: 'invalid-estimated-duration', id: estimate.id }
    }
    const validatedEstimate = estimateResult.output
    const estimateValidation = decideClientAuthStart({
      now: validatedAuth.now,
      tokenExpiresAt: validatedAuth.tokenExpiresAt,
      refreshMarginMs: validatedAuth.refreshMarginMs,
      estimatedDurationMs: validatedEstimate.estimatedDurationMs,
    })
    if (estimateValidation.action === 'reject') {
      return {
        ok: false,
        reason: mapAuthStartRejectReason(estimateValidation.reason),
        id: estimate.id,
      }
    }
    estimateById.set(estimate.id, validatedEstimate.estimatedDurationMs)
  }

  return { ok: true, auth, estimateById }
}

export function mapAuthStartRejectReason(
  reason: Extract<
    ReturnType<typeof decideClientAuthStart>,
    { readonly action: 'reject' }
  >['reason'],
): Extract<OutboxSchedulerTickPlan, { readonly ok: false }>['reason'] {
  switch (reason) {
    case 'invalid-time':
      return 'invalid-clock'
    case 'invalid-token-expiry':
      return 'invalid-token-expiry'
    case 'invalid-refresh-margin':
      return 'invalid-refresh-margin'
    case 'invalid-estimated-duration':
      return 'invalid-estimated-duration'
  }
}
