import { decideClientAuthStart } from '../auth'
import {
  type OutboxPlanItemId,
  type OutboxRetryKind,
  type OutboxRetryPolicy,
  type OutboxDependencyState,
  type OutboxResumeEvent,
  type OutboxRuntimeProfile,
  type OutboxConcurrencyLane,
  type BinaryUploadOutboxPlanInput,
  type BinaryDownloadOutboxPlanInput,
  type OutboxRetryDecisionInput,
  type OutboxFailureTransitionInput,
  type OutboxRunDecisionInput,
  type OutboxConcurrencyDecisionInput,
  type OutboxResumeDecisionInput,
  type OutboxAckCompletionInput,
  type OutboxQuarantinePauseInput,
  type OutboxFullSnapshotReleaseInput,
  type OutboxDependencyGraphItem,
  type OutboxSchedulerItem,
  type OutboxSchedulerTickInput,
  type OutboxRunningLease,
  type OutboxLeaseAcquireInput,
  type OutboxLeaseReleaseInput,
  type OutboxLeaseRenewInput,
  type BinaryOutboxPlanItem,
  type BinaryUploadOutboxPlanBuildResult,
  type BinaryDownloadOutboxPlanBuildResult,
  type OutboxRetryDecision,
  type OutboxRunDecision,
  type OutboxConcurrencyDecision,
  type OutboxFailureTransition,
  type OutboxResumeDecision,
  type OutboxAckCompletionDecision,
  type OutboxQuarantinePauseDecision,
  type OutboxFullSnapshotReleasePatch,
  type OutboxFullSnapshotReleasePlan,
  type OutboxResumePatch,
  type OutboxDependencyBlockPatch,
  type OutboxDependencyDeadLetterPatch,
  type OutboxDependencyBlockPlan,
  type OutboxSchedulerStart,
  type OutboxAuthStartRefreshBlock,
  type OutboxAuthRefreshRequestInput,
  type OutboxAuthRefreshRequestDecision,
  type OutboxLeaseReclaimPatch,
  type OutboxLeaseAcquireDecision,
  type OutboxLeaseReleaseDecision,
  type OutboxLeaseRenewDecision,
  type OutboxSchedulerTickPlan,
  Y_UPDATE_RETRY_POLICY,
  BLOB_RETRY_POLICY,
  MATERIALIZE_RETRY_POLICY,
} from './types'
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  validateBinaryChunks,
  hasDuplicateIds,
  sameDocId,
  validateOutboxSchedulerAuthGate,
  mapAuthStartRejectReason,
} from './validation'

/**
 * Brands a caller-assigned outbox item ID after checking it is non-empty.
 */
export function makeOutboxPlanItemId(value: string): OutboxPlanItemId | null {
  return value.length === 0 ? null : value
}

/**
 * Builds blob PUT, manifest PUT, and meta reference update items for binary upload.
 */
export function buildBinaryUploadOutboxPlan(
  input: BinaryUploadOutboxPlanInput,
): BinaryUploadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.manifestPutId, input.metaRefUpdateId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkPuts = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-put',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkPutIds = chunkPuts.map((item) => item.id)
  const manifestPut: BinaryOutboxPlanItem = {
    kind: 'manifest-put',
    id: input.manifestPutId,
    dependsOn: chunkPutIds,
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }
  const metaRefUpdate: BinaryOutboxPlanItem = {
    kind: 'meta-ref-update',
    id: input.metaRefUpdateId,
    dependsOn: [...chunkPutIds, input.manifestPutId],
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkPuts, manifestPut, metaRefUpdate],
      chunkPuts: chunkPutIds,
      manifestPut: input.manifestPutId,
      metaRefUpdate: input.metaRefUpdateId,
    },
  }
}

/**
 * Builds blob GET and dependent materialize items for binary download.
 */
export function buildBinaryDownloadOutboxPlan(
  input: BinaryDownloadOutboxPlanInput,
): BinaryDownloadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.materializeId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkGets = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-get',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkGetIds = chunkGets.map((item) => item.id)
  const materialize: BinaryOutboxPlanItem = {
    kind: 'materialize',
    id: input.materializeId,
    dependsOn: chunkGetIds,
    fileId: input.fileId,
    expectedHash: input.expectedHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkGets, materialize],
      chunkGets: chunkGetIds,
      materialize: input.materializeId,
    },
  }
}

/**
 * Decides whether a paused outbox item may return to pending after a resume event.
 */
export function decideOutboxResume(input: OutboxResumeDecisionInput): OutboxResumeDecision {
  if (input.status !== 'paused') {
    return { action: 'wait', reason: 'not-paused' }
  }
  if (input.resumeOn === undefined) {
    return { action: 'wait', reason: 'missing-resume-condition' }
  }
  if (input.event !== 'manual' && input.event !== input.resumeOn) {
    return { action: 'wait', reason: 'resume-condition-not-met' }
  }
  return { action: 'resume', status: 'pending', nextAttemptAt: undefined }
}

/**
 * Decides whether a server ack-like message can complete an outbound Yjs update item.
 */
export function decideOutboxAckCompletion(
  input: OutboxAckCompletionInput,
): OutboxAckCompletionDecision {
  if (input.kind !== 'y-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { action: 'reject', reason: 'not-runnable-status' }
  }
  if (input.message.vaultId !== input.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (input.message.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!sameDocId(input.message.docId, input.docId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }

  if (input.message.type === 'need-full-snapshot') {
    return {
      action: 'pause-for-full-snapshot',
      patch: {
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'full-snapshot-required',
        resumeOn: 'manual',
        snapshotReason: input.message.reason,
        docId: input.message.docId,
      },
    }
  }

  if (input.message.messageId !== input.messageId) {
    return { action: 'reject', reason: 'message-mismatch' }
  }
  if (!isNonNegativeSafeInteger(input.message.durableSeq)) {
    return { action: 'reject', reason: 'invalid-durable-seq' }
  }
  if (
    input.minDurableSeqExclusive !== undefined &&
    (!isNonNegativeSafeInteger(input.minDurableSeqExclusive) ||
      input.message.durableSeq <= input.minDurableSeqExclusive)
  ) {
    return { action: 'reject', reason: 'stale-durable-seq' }
  }

  return {
    action: 'complete',
    patch: {
      status: 'done',
      nextAttemptAt: undefined,
      durableSeq: input.message.durableSeq,
    },
  }
}

/**
 * Decides whether server quarantine evidence should pause an outbound Yjs update item.
 */
export function decideOutboxQuarantinePause(
  input: OutboxQuarantinePauseInput,
): OutboxQuarantinePauseDecision {
  if (input.kind !== 'y-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { action: 'reject', reason: 'not-runnable-status' }
  }
  if (input.quarantine.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!sameDocId(input.quarantine.docId, input.docId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }
  if (input.quarantine.messageId !== input.messageId) {
    return { action: 'reject', reason: 'message-mismatch' }
  }
  if (input.updateSha256 !== undefined && input.quarantine.updateSha256 !== input.updateSha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }

  return {
    action: 'pause-for-quarantine',
    patch: {
      status: 'paused',
      nextAttemptAt: undefined,
      reason: 'server-quarantine',
      resumeOn: 'manual',
      quarantineId: input.quarantine.id,
      quarantineReason: input.quarantine.reason,
      docId: input.quarantine.docId,
    },
  }
}

/**
 * Plans terminal patches for outbox items superseded by an applied full snapshot.
 */
export function planOutboxFullSnapshotRelease(
  input: OutboxFullSnapshotReleaseInput,
): OutboxFullSnapshotReleasePlan {
  if (!isNonNegativeSafeInteger(input.snapshotSeq)) {
    return { ok: false, reason: 'invalid-snapshot-seq' }
  }

  const releasePatches: OutboxFullSnapshotReleasePatch[] = []
  for (const item of input.items) {
    if (
      item.kind !== 'y-update' ||
      item.status !== 'paused' ||
      item.reason !== 'full-snapshot-required' ||
      item.docId === undefined ||
      !sameDocId(item.docId, input.appliedDocId)
    ) {
      continue
    }

    releasePatches.push({
      id: item.id,
      status: 'done',
      nextAttemptAt: undefined,
      completedBy: 'full-snapshot-apply',
      snapshotSeq: input.snapshotSeq,
    })
  }

  return { ok: true, releasePatches }
}

/**
 * Plans blocked status patches for items with failed or already blocked ancestors.
 */
export function planOutboxDependencyBlocks(
  items: readonly OutboxDependencyGraphItem[],
): OutboxDependencyBlockPlan {
  const byId = new Map<OutboxPlanItemId, OutboxDependencyGraphItem>()
  for (const item of items) {
    if (byId.has(item.id)) {
      return { ok: false, reason: 'duplicate-item-id', id: item.id }
    }
    byId.set(item.id, item)
  }

  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!byId.has(dependencyId)) {
        return { ok: false, reason: 'missing-dependency', id: dependencyId }
      }
    }
  }

  const blockPatches: OutboxDependencyBlockPatch[] = []
  const deadLetterPatches: OutboxDependencyDeadLetterPatch[] = []
  const plannedDeadLetterIds = new Set<OutboxPlanItemId>()
  const plannedBlockedIds = new Set<OutboxPlanItemId>()

  for (const item of items) {
    if (item.status === 'done' || item.status === 'failed' || item.status === 'blocked') {
      continue
    }

    const dependencyFailures = dependencyFailureAncestors(
      item,
      byId,
      plannedDeadLetterIds,
      plannedBlockedIds,
      new Set<OutboxPlanItemId>(),
    )
    if (dependencyFailures.deadLetteredBy.length > 0) {
      deadLetterPatches.push({
        id: item.id,
        status: 'failed',
        reason: 'dead-letter',
        deadLetterReason: 'dependency-dead-letter',
        deadLetteredBy: dependencyFailures.deadLetteredBy,
      })
      plannedDeadLetterIds.add(item.id)
      continue
    }
    if (dependencyFailures.blockedBy.length > 0) {
      blockPatches.push({ id: item.id, status: 'blocked', blockedBy: dependencyFailures.blockedBy })
      plannedBlockedIds.add(item.id)
    }
  }

  return { ok: true, blockPatches, deadLetterPatches }
}

/**
 * Plans paused item resume patches for events observed since the previous scheduler tick.
 */
export function planOutboxResumePatches(
  items: readonly OutboxSchedulerItem[],
  events: readonly OutboxResumeEvent[],
): readonly OutboxResumePatch[] {
  if (events.length === 0) {
    return []
  }

  const patches: OutboxResumePatch[] = []
  for (const item of items) {
    for (const event of events) {
      const decision = decideOutboxResume({
        status: item.status,
        resumeOn: item.resumeOn,
        event,
      })
      if (decision.action === 'resume') {
        patches.push({
          id: item.id,
          status: decision.status,
          nextAttemptAt: decision.nextAttemptAt,
        })
        break
      }
    }
  }
  return patches
}

/**
 * Plans one outbound queue scan without performing side effects.
 */
export function planOutboxSchedulerTick(input: OutboxSchedulerTickInput): OutboxSchedulerTickPlan {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { ok: false, reason: 'invalid-clock' }
  }
  if (!isNonNegativeSafeInteger(input.maxStarts)) {
    return { ok: false, reason: 'invalid-max-starts' }
  }
  const authGate = validateOutboxSchedulerAuthGate(input.auth, input.now)
  if (!authGate.ok) {
    return authGate
  }

  const resumePatches = planOutboxResumePatches(input.items, input.resumeEvents)
  const resumedIds = new Set(resumePatches.map((patch) => patch.id))
  const resumedItems = input.items.map(
    (item): OutboxSchedulerItem =>
      resumedIds.has(item.id) ? { ...item, status: 'pending', nextAttemptAt: undefined } : item,
  )

  const blockPlan = planOutboxDependencyBlocks(resumedItems)
  if (!blockPlan.ok) {
    return { ok: false, reason: blockPlan.reason, id: blockPlan.id }
  }

  const byId = new Map(resumedItems.map((item) => [item.id, item]))
  const leasePlan = planEffectiveLeases(input.leases, byId, input.now)
  if (!leasePlan.ok) {
    return leasePlan
  }

  const effectiveStatus = new Map(resumedItems.map((item) => [item.id, item.status]))
  for (const patch of blockPlan.blockPatches) {
    effectiveStatus.set(patch.id, 'blocked')
  }
  for (const patch of blockPlan.deadLetterPatches) {
    effectiveStatus.set(patch.id, 'failed')
  }

  const running = new Map<OutboxConcurrencyLane, number>([
    ['sync-control', 0],
    ['blob-transfer', 0],
    ['materialize', 0],
  ])
  for (const lease of leasePlan.activeLeases) {
    const lane = outboxConcurrencyLane(lease.kind)
    running.set(lane, (running.get(lane) ?? 0) + 1)
  }

  const starts: OutboxSchedulerStart[] = []
  const authRefreshBlocks: OutboxAuthStartRefreshBlock[] = []

  for (const item of resumedItems) {
    if (starts.length >= input.maxStarts) {
      break
    }

    if (leasePlan.activeLeaseIds.has(item.id)) {
      continue
    }

    const status = effectiveStatus.get(item.id) ?? item.status
    const dependencies = item.dependsOn.map((dependencyId): OutboxDependencyState => {
      const dependency = byId.get(dependencyId)
      return { status: effectiveStatus.get(dependencyId) ?? dependency?.status ?? 'blocked' }
    })
    const runDecision = decideOutboxRun({
      status,
      dependencies,
      nextAttemptAt: item.nextAttemptAt,
      now: input.now,
    })
    if (runDecision.action !== 'run') {
      continue
    }

    const lane = outboxConcurrencyLane(item.kind)
    const runningInLane = running.get(lane) ?? 0
    const concurrencyDecision = decideOutboxConcurrency({
      kind: item.kind,
      profile: input.profile,
      runningInLane,
    })
    if (concurrencyDecision.action !== 'start') {
      continue
    }

    if (outboxKindRequiresAuth(item.kind) && authGate.auth !== undefined) {
      const authDecision = decideClientAuthStart({
        now: input.now,
        tokenExpiresAt: authGate.auth.tokenExpiresAt,
        refreshMarginMs: authGate.auth.refreshMarginMs,
        estimatedDurationMs:
          authGate.estimateById.get(item.id) ?? authGate.auth.defaultEstimatedDurationMs,
      })
      if (authDecision.action === 'reject') {
        return {
          ok: false,
          reason: mapAuthStartRejectReason(authDecision.reason),
          id: item.id,
        }
      }
      if (authDecision.action === 'refresh-first') {
        authRefreshBlocks.push({
          id: item.id,
          kind: item.kind,
          lane,
          reason: authDecision.reason,
          remainingMs: authDecision.remainingMs,
          requiredRemainingMs: authDecision.requiredRemainingMs,
        })
        continue
      }
    }

    starts.push({ id: item.id, kind: item.kind, lane })
    running.set(lane, runningInLane + 1)
  }

  const basePlan = {
    ok: true,
    resumePatches,
    blockPatches: blockPlan.blockPatches,
    deadLetterPatches: blockPlan.deadLetterPatches,
    leaseReclaims: leasePlan.reclaimPatches,
    starts,
  } satisfies Extract<OutboxSchedulerTickPlan, { readonly ok: true }>
  if (authRefreshBlocks.length > 0) {
    return { ...basePlan, authRefreshBlocks }
  }
  return {
    ...basePlan,
  }
}

/**
 * Decides whether auth-blocked scheduler starts should trigger a token refresh attempt.
 */
export function decideOutboxAuthRefreshRequest(
  input: OutboxAuthRefreshRequestInput,
): OutboxAuthRefreshRequestDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    !isNonNegativeSafeInteger(input.refreshState.nextAllowedRefreshAt)
  ) {
    return { action: 'reject', reason: 'invalid-refresh-backoff' }
  }

  const refreshBlocks = input.refreshBlocks ?? []
  if (refreshBlocks.length === 0) {
    return { action: 'noop', reason: 'no-auth-blocks' }
  }

  const seen = new Set<OutboxPlanItemId>()
  let strongestReason: 'token-expired' | 'token-expiring-soon' = 'token-expiring-soon'
  for (const block of refreshBlocks) {
    if (seen.has(block.id)) {
      return { action: 'reject', reason: 'duplicate-refresh-block', id: block.id }
    }
    seen.add(block.id)
    if (
      !isNonNegativeSafeInteger(block.requiredRemainingMs) ||
      !Number.isSafeInteger(block.remainingMs) ||
      (block.reason === 'token-expired' && block.remainingMs > 0) ||
      (block.reason === 'token-expiring-soon' && block.remainingMs <= 0)
    ) {
      return { action: 'reject', reason: 'invalid-refresh-block', id: block.id }
    }
    if (block.reason === 'token-expired') {
      strongestReason = 'token-expired'
    }
  }

  const blockedItemIds = refreshBlocks.map((block) => block.id)
  if (input.refreshState.status === 'refreshing') {
    return {
      action: 'wait',
      reason: 'refresh-already-running',
      blockedItemIds,
    }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    input.now < input.refreshState.nextAllowedRefreshAt
  ) {
    return {
      action: 'wait',
      reason: 'refresh-backoff',
      nextAllowedRefreshAt: input.refreshState.nextAllowedRefreshAt,
      blockedItemIds,
    }
  }

  return {
    action: 'request-refresh',
    reason: strongestReason,
    requestedAt: input.now,
    blockedItemIds,
  }
}

/**
 * Decides whether a scheduler start can acquire or take over a running lease.
 */
export function decideOutboxLeaseAcquire(
  input: OutboxLeaseAcquireInput,
): OutboxLeaseAcquireDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }

  const nextLease: OutboxRunningLease = {
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    leaseExpiresAt: input.now + input.leaseDurationMs,
  }

  if (input.existingLease === undefined) {
    return { action: 'acquire', lease: nextLease, previousOwnerId: undefined }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt > input.now
  ) {
    return { action: 'reject', reason: 'active-lease-exists' }
  }

  return {
    action: 'take-over-expired',
    lease: nextLease,
    previousOwnerId: input.existingLease.ownerId,
  }
}

/**
 * Decides whether a worker may release a running lease it owns.
 */
export function decideOutboxLeaseRelease(
  input: OutboxLeaseReleaseInput,
): OutboxLeaseReleaseDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }
  return { action: 'release' }
}

/**
 * Decides whether a worker may extend a running lease it owns.
 */
export function decideOutboxLeaseRenew(input: OutboxLeaseRenewInput): OutboxLeaseRenewDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }

  return {
    action: 'renew',
    lease: {
      itemId: input.itemId,
      kind: input.kind,
      ownerId: input.ownerId,
      leaseExpiresAt: input.now + input.leaseDurationMs,
    },
  }
}

/**
 * Decides whether an outbox failure should retry, pause, or fail permanently.
 */
export function decideOutboxRetry(input: OutboxRetryDecisionInput): OutboxRetryDecision {
  if (input.retryCount < 0 || !Number.isSafeInteger(input.retryCount)) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  switch (input.error.kind) {
    case 'network':
    case 'timeout':
    case 'offline':
      return retryWithPolicy(input.kind, input.retryCount, undefined)
    case 'api':
      return input.error.retryable
        ? retryWithPolicy(input.kind, input.retryCount, input.error.retryAfterMs)
        : { action: 'dead-letter', reason: 'non-retryable-api-error' }
    case 'local-conflict':
      return {
        action: 'pause',
        reason: 'dependency-or-local-state',
        resumeOn: 'local-state-change',
      }
    case 'invalid-payload':
      return { action: 'dead-letter', reason: 'invalid-payload' }
    case 'auth':
      return { action: 'pause', reason: 'auth-required', resumeOn: 'auth-refresh' }
  }
}

/**
 * Builds the persistable item update after an outbox attempt fails.
 */
export function transitionOutboxFailure(
  input: OutboxFailureTransitionInput,
): OutboxFailureTransition {
  if (!isNonNegativeSafeInteger(input.now)) {
    return {
      status: 'paused',
      retryCount: input.retryCount,
      nextAttemptAt: undefined,
      lastError: input.error,
      reason: 'manual-intervention-required',
      resumeOn: 'manual',
    }
  }

  const retryDecision = decideOutboxRetry(input)
  switch (retryDecision.action) {
    case 'retry':
      const retryJitterMs = selectedRetryJitterMs(input.retryJitterMs, retryDecision)
      return {
        status: 'retrying',
        retryCount: input.retryCount + 1,
        nextAttemptAt: input.now + retryDecision.delayMs + retryJitterMs,
        lastError: input.error,
      }
    case 'pause':
      return {
        status: 'paused',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: retryDecision.reason,
        resumeOn: retryDecision.resumeOn,
      }
    case 'dead-letter':
      return {
        status: 'failed',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: 'dead-letter',
        deadLetterReason: retryDecision.reason,
      }
  }
}

/**
 * Decides whether an outbox item may execute at the current time.
 */
export function decideOutboxRun(input: OutboxRunDecisionInput): OutboxRunDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'wait', reason: 'invalid-clock' }
  }

  switch (input.status) {
    case 'done':
      return { action: 'wait', reason: 'already-complete' }
    case 'paused':
      return { action: 'wait', reason: 'paused' }
    case 'failed':
    case 'blocked':
      return { action: 'skip', reason: 'failed-or-blocked' }
    case 'pending':
    case 'retrying':
      break
  }

  if (
    input.nextAttemptAt !== undefined &&
    (!isNonNegativeSafeInteger(input.nextAttemptAt) || input.now < input.nextAttemptAt)
  ) {
    return { action: 'wait', reason: 'not-due' }
  }

  if (
    input.dependencies.some(
      (dependency) => dependency.status === 'failed' || dependency.status === 'blocked',
    )
  ) {
    return { action: 'block', reason: 'dependency-failed' }
  }

  if (!input.dependencies.every((dependency) => dependency.status === 'done')) {
    return { action: 'wait', reason: 'dependency-pending' }
  }

  return { action: 'run' }
}

/**
 * Decides whether a runnable outbox item may start under per-lane concurrency limits.
 */
export function decideOutboxConcurrency(
  input: OutboxConcurrencyDecisionInput,
): OutboxConcurrencyDecision {
  const lane = outboxConcurrencyLane(input.kind)
  const limit = outboxConcurrencyLimit(input.kind, input.profile)
  if (!isNonNegativeSafeInteger(input.runningInLane)) {
    return { action: 'wait', reason: 'invalid-running-count', lane, limit }
  }

  return input.runningInLane < limit
    ? { action: 'start', lane, limit }
    : { action: 'wait', reason: 'concurrency-limit-reached', lane, limit }
}

/**
 * Returns the concurrency lane for an outbox item kind.
 */
export function outboxConcurrencyLane(kind: OutboxRetryKind): OutboxConcurrencyLane {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return 'sync-control'
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return 'blob-transfer'
    case 'materialize':
      return 'materialize'
  }
}

/**
 * Returns the runtime concurrency limit for an outbox item kind.
 */
export function outboxConcurrencyLimit(
  kind: OutboxRetryKind,
  profile: OutboxRuntimeProfile,
): number {
  switch (outboxConcurrencyLane(kind)) {
    case 'sync-control':
      return 1
    case 'blob-transfer':
      return profile === 'mobile' ? 2 : 4
    case 'materialize':
      return 1
  }
}

/**
 * Returns the retry policy for an outbox item kind.
 */
export function outboxRetryPolicy(kind: OutboxRetryKind): OutboxRetryPolicy {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return Y_UPDATE_RETRY_POLICY
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return BLOB_RETRY_POLICY
    case 'materialize':
      return MATERIALIZE_RETRY_POLICY
  }
}

function retryWithPolicy(
  kind: OutboxRetryKind,
  retryCount: number,
  retryAfterMs: number | undefined,
): OutboxRetryDecision {
  const policy = outboxRetryPolicy(kind)
  if (policy.maxRetryCount !== undefined && retryCount >= policy.maxRetryCount) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  const scheduledDelayMs =
    policy.scheduleMs[Math.min(retryCount, policy.scheduleMs.length - 1)] ?? policy.maxDelayMs
  const retryAfterDelayMs = isNonNegativeSafeInteger(retryAfterMs) ? retryAfterMs : 0
  return {
    action: 'retry',
    delayMs: Math.max(scheduledDelayMs, retryAfterDelayMs),
    jitterRatio: policy.jitterRatio,
  }
}

function selectedRetryJitterMs(
  requestedJitterMs: number | undefined,
  retryDecision: Extract<OutboxRetryDecision, { readonly action: 'retry' }>,
): number {
  if (!isNonNegativeSafeInteger(requestedJitterMs)) {
    return 0
  }

  const maxJitterMs = Math.ceil(retryDecision.delayMs * retryDecision.jitterRatio)
  return Math.min(requestedJitterMs, maxJitterMs)
}

function outboxKindRequiresAuth(kind: OutboxRetryKind): boolean {
  switch (kind) {
    case 'y-update':
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
    case 'meta-ref-update':
      return true
    case 'materialize':
      return false
  }
}

interface DependencyFailureAncestors {
  readonly deadLetteredBy: readonly OutboxPlanItemId[]
  readonly blockedBy: readonly OutboxPlanItemId[]
}

function dependencyFailureAncestors(
  item: OutboxDependencyGraphItem,
  byId: ReadonlyMap<OutboxPlanItemId, OutboxDependencyGraphItem>,
  plannedDeadLetterIds: ReadonlySet<OutboxPlanItemId>,
  plannedBlockedIds: ReadonlySet<OutboxPlanItemId>,
  seen: Set<OutboxPlanItemId>,
): DependencyFailureAncestors {
  const deadLetteredBy: OutboxPlanItemId[] = []
  const blockedBy: OutboxPlanItemId[] = []
  for (const dependencyId of item.dependsOn) {
    if (seen.has(dependencyId)) {
      continue
    }
    seen.add(dependencyId)

    const dependency = byId.get(dependencyId)
    if (dependency === undefined) {
      continue
    }

    if (dependency.status === 'failed' || plannedDeadLetterIds.has(dependency.id)) {
      deadLetteredBy.push(dependency.id)
      continue
    }
    if (dependency.status === 'blocked' || plannedBlockedIds.has(dependency.id)) {
      blockedBy.push(dependency.id)
      continue
    }

    const nested = dependencyFailureAncestors(
      dependency,
      byId,
      plannedDeadLetterIds,
      plannedBlockedIds,
      seen,
    )
    deadLetteredBy.push(...nested.deadLetteredBy)
    blockedBy.push(...nested.blockedBy)
  }

  return {
    deadLetteredBy: [...new Set(deadLetteredBy)],
    blockedBy: [...new Set(blockedBy)],
  }
}

type EffectiveLeasePlan =
  | {
      readonly ok: true
      readonly activeLeases: readonly OutboxRunningLease[]
      readonly activeLeaseIds: ReadonlySet<OutboxPlanItemId>
      readonly reclaimPatches: readonly OutboxLeaseReclaimPatch[]
    }
  | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>

function planEffectiveLeases(
  leases: readonly OutboxRunningLease[],
  items: ReadonlyMap<OutboxPlanItemId, OutboxSchedulerItem>,
  now: number,
): EffectiveLeasePlan {
  const seen = new Set<OutboxPlanItemId>()
  const activeLeases: OutboxRunningLease[] = []
  const activeLeaseIds = new Set<OutboxPlanItemId>()
  const reclaimPatches: OutboxLeaseReclaimPatch[] = []

  for (const lease of leases) {
    if (seen.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-lease', id: lease.itemId }
    }
    seen.add(lease.itemId)

    if (!items.has(lease.itemId)) {
      return { ok: false, reason: 'missing-lease-item', id: lease.itemId }
    }
    if (lease.ownerId.length === 0) {
      return { ok: false, reason: 'empty-lease-owner', id: lease.itemId }
    }
    if (!isNonNegativeSafeInteger(lease.leaseExpiresAt)) {
      return { ok: false, reason: 'invalid-lease-expiry', id: lease.itemId }
    }

    if (lease.leaseExpiresAt <= now) {
      reclaimPatches.push({
        id: lease.itemId,
        previousOwnerId: lease.ownerId,
        status: 'retrying',
        nextAttemptAt: undefined,
      })
      continue
    }

    activeLeases.push(lease)
    activeLeaseIds.add(lease.itemId)
  }

  return { ok: true, activeLeases, activeLeaseIds, reclaimPatches }
}
