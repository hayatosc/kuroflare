import { type DocId } from '../utils/ids'
import {
  type BinaryDownloadChunkInput,
  type BinaryUploadChunkInput,
  type BinaryOutboxPlanBuildError,
  type OutboxSchedulerAuthGateInput,
  type OutboxSchedulerTickPlan,
  type OutboxPlanItemId,
} from './types'
import { decideClientAuthStart } from '../auth'
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../utils/shared'
export { isNonNegativeSafeInteger, isPositiveSafeInteger }

export function validateBinaryChunks(
  chunks: readonly (BinaryUploadChunkInput | BinaryDownloadChunkInput)[],
): BinaryOutboxPlanBuildError | undefined {
  for (const chunk of chunks) {
    if (!isNonNegativeSafeInteger(chunk.size)) {
      return 'invalid-blob-size'
    }
    if (chunk.localCacheKey.length === 0) {
      return 'empty-local-cache-key'
    }
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

  const defaultValidation = decideClientAuthStart({
    now,
    tokenExpiresAt: auth.tokenExpiresAt,
    refreshMarginMs: auth.refreshMarginMs,
    estimatedDurationMs: auth.defaultEstimatedDurationMs ?? 0,
  })
  if (defaultValidation.action === 'reject') {
    return { ok: false, reason: mapAuthStartRejectReason(defaultValidation.reason) }
  }

  const estimateById = new Map<OutboxPlanItemId, number>()
  for (const estimate of auth.estimates ?? []) {
    if (estimateById.has(estimate.id)) {
      return { ok: false, reason: 'duplicate-auth-estimate', id: estimate.id }
    }
    const estimateValidation = decideClientAuthStart({
      now,
      tokenExpiresAt: auth.tokenExpiresAt,
      refreshMarginMs: auth.refreshMarginMs,
      estimatedDurationMs: estimate.estimatedDurationMs,
    })
    if (estimateValidation.action === 'reject') {
      return {
        ok: false,
        reason: mapAuthStartRejectReason(estimateValidation.reason),
        id: estimate.id,
      }
    }
    estimateById.set(estimate.id, estimate.estimatedDurationMs)
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
