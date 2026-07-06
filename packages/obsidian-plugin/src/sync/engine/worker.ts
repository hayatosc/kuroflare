export * from '../engine/worker.types'

import {
  type OutboxRunError,
  type BlobManifest,
  type OutboxFailureTransition,
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  assembleBlobBytes,
  decideMaterializeWrite,
  makeSha256Hex,
} from '@kuroflare/core'
import * as v from 'valibot'

import {
  planOutboundQueueLeaseAcquire,
  planOutboundQueueLeaseRenew,
  planOutboundQueueAckCompletion,
  planOutboundQueueFullSnapshotRelease,
  planOutboundQueueFailureCompletion,
  planOutboundQueueQuarantinePause,
  planOutboundQueueSuccessCompletion,
} from '../engine/queue'
import {
  type OutboxWorkerTickInput,
  type OutboxWorkerLeaseAttempt,
  type OutboxWorkerStartEffect,
  type OutboxWorkerMaterializeChunkReadPlan,
  type OutboxWorkerSideEffectPlanInput,
  type OutboxWorkerSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
  type OutboxWorkerSideEffectCompletionEvidence,
  type OutboxWorkerAckCompletionInput,
  type OutboxWorkerQuarantineCompletionInput,
  type OutboxWorkerFailureCompletionInput,
  type OutboxWorkerSuccessCompletionInput,
  type OutboxWorkerLeaseRenewalInput,
  type OutboxWorkerFullSnapshotReleaseInput,
  type OutboxWorkerSideEffectCompletionEvidenceInput,
  type OutboxWorkerLocalSideEffectRunnerPorts,
  type OutboxWorkerTickPlan,
  type OutboxWorkerCompletionPlan,
  type OutboxWorkerLeaseRenewalPlan,
  type OutboxWorkerFullSnapshotReleasePlan,
  type OutboxWorkerIndexedDbWriteTransaction,
} from '../engine/worker.types'
import { applyLocalStoreDriverCommit, planLocalStoreDriverReadSet } from '../store/driver'
import { planLocalStoreIndexedDbReads, planLocalStoreIndexedDbWrites } from '../store/indexeddb'
import {
  type LocalStoreOutboxRecord,
  planLocalStoreFailureCompletionTransaction,
  planLocalStoreAckCompletionTransaction,
  planLocalStoreLeaseAcquireTransaction,
  planLocalStoreLeaseRenewTransaction,
  planLocalStoreFullSnapshotReleaseTransaction,
  planLocalStoreOutboxSchedulerTransaction,
  planLocalStoreQuarantinePauseTransaction,
  planLocalStoreSuccessCompletionTransaction,
} from '../store/store'

/**
 * Splits a successful worker tick into ordered concrete IndexedDB write transactions.
 *
 * @param plan Successful outbox worker tick plan.
 * @returns Scheduler persistence first, followed by one transaction per acquired lease.
 */
export function planOutboxWorkerTickIndexedDbWriteTransactions(
  plan: Extract<OutboxWorkerTickPlan, { readonly ok: true }>,
): readonly OutboxWorkerIndexedDbWriteTransaction[] {
  return [
    { kind: 'scheduler-persist', writes: plan.schedulerIndexedDbWrites },
    ...plan.leaseAttempts.filter(isSuccessfulOutboxWorkerLeaseAttempt).map(
      (attempt): OutboxWorkerIndexedDbWriteTransaction => ({
        kind: 'lease-acquire',
        start: attempt.start,
        writes: attempt.indexedDbWrites,
      }),
    ),
  ]
}

/**
 * Converts a successful completion plan into the single concrete IndexedDB write transaction.
 *
 * @param plan Successful side-effect completion plan.
 * @returns Completion persistence transaction containing item patch and lease release writes.
 */
export function planOutboxWorkerCompletionIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'completion-persist', action: plan.action, writes: plan.indexedDbWrites }
}

/**
 * Runs local binary download/materialize side effects through explicit ports.
 *
 * @param plan Concrete side-effect plan produced after a persisted outbox lease.
 * @param ports Fake vault or production adapters used for local I/O and hashing.
 * @returns Completion evidence consumed by outbox success/failure planning.
 */
export async function runOutboxWorkerLocalSideEffect(
  plan:
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-put' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-get' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'manifest-put' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'materialize' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  switch (plan.action) {
    case 'blob-put':
      return await runBlobPutLocalSideEffect(plan, ports)
    case 'blob-get':
      return await runBlobGetLocalSideEffect(plan, ports)
    case 'manifest-put':
      return await runManifestPutLocalSideEffect(plan, ports)
    case 'materialize':
      return await runMaterializeLocalSideEffect(plan, ports)
  }
}

async function runBlobPutLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-put' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const bytes = await ports.readBlobCache(plan.readLocalCache)
  if (bytes === undefined) {
    return { kind: 'invalid-payload', code: 'local-cache-read-failed' }
  }
  if (
    !(await bytesMatch(
      bytes,
      plan.readLocalCache.expectedSha256,
      plan.readLocalCache.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'local-cache-mismatch' }
  }

  const head = await ports.sendJsonRequest(plan.headRequest)
  if (head.kind !== 'success') {
    return head
  }
  if (!v.is(BlobHeadResponseSchema, head.body)) {
    return { kind: 'invalid-payload', code: 'blob-head-response-invalid' }
  }
  const entry = head.body.exists[plan.blob.sha256]
  if (entry?.found === true) {
    if (entry.size !== undefined && entry.size !== plan.blob.size) {
      return { kind: 'invalid-payload', code: 'blob-head-size-mismatch' }
    }
    return { kind: 'success' }
  }

  const uploadUrl = await ports.sendJsonRequest(plan.uploadUrlRequest)
  if (uploadUrl.kind !== 'success') {
    return uploadUrl
  }
  if (!v.is(BlobUploadUrlResponseSchema, uploadUrl.body)) {
    return { kind: 'invalid-payload', code: 'blob-upload-url-response-invalid' }
  }
  if (uploadUrl.body.kind === 'already-exists') {
    return { kind: 'success' }
  }
  if (uploadUrl.body.kind === 'multipart') {
    return { kind: 'invalid-payload', code: 'blob-upload-multipart-unimplemented' }
  }

  return await ports.uploadBytes(
    {
      method: plan.uploadPut.method,
      url: uploadUrl.body.url,
      headers: {
        ...uploadUrl.body.headers,
        authorization: plan.uploadUrlRequest.headers.authorization ?? '',
      },
    },
    bytes,
  )
}

async function runBlobGetLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-get' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const response = await ports.downloadBytes(plan.downloadRequest)
  if (response.kind !== 'success') {
    return response
  }
  if (
    !(await bytesMatch(
      response.bytes,
      plan.writeLocalCache.expectedSha256,
      plan.writeLocalCache.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'blob-download-mismatch' }
  }
  await ports.writeBlobCache(plan.writeLocalCache, response.bytes)
  return { kind: 'success' }
}

async function runManifestPutLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'manifest-put' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const response = await ports.sendJsonRequest(plan.putManifestRequest)
  return response.kind === 'success' ? { kind: 'success' } : response
}

async function runMaterializeLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'materialize' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const chunks = new Map<BlobManifest['chunks'][number]['sha256'], Uint8Array>()
  for (const chunk of plan.readChunks) {
    const bytes = await ports.readBlobCache({
      key: chunk.key,
      expectedSha256: chunk.sha256,
      expectedSize: chunk.expectedSize,
    })
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
    }
    chunks.set(chunk.sha256, bytes)
  }

  let assembled: Uint8Array
  try {
    assembled = await assembleBlobBytes(plan.manifest, chunks)
  } catch {
    return { kind: 'invalid-payload', code: 'materialize-assembly-failed' }
  }
  if (
    !(await bytesMatch(
      assembled,
      plan.assemble.expectedContentSha256,
      plan.assemble.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'materialize-assembled-mismatch' }
  }

  const existing = await ports.readVaultFile(plan.diskCas.path)
  if (existing.kind === 'folder') {
    return { kind: 'local-conflict' }
  }
  if (existing.kind === 'file') {
    const decision = decideMaterializeWrite({
      path: plan.diskCas.path,
      activeFilePath: ports.getActiveFilePath(),
      currentDiskHash: makeSha256Hex(await ports.sha256Hex(existing.bytes)),
      lastMaterialized: plan.diskCas.lastMaterialized,
    })
    if (decision.action !== 'write') {
      return { kind: 'local-conflict' }
    }
  } else if (!(await ports.ensureVaultParentFolders(plan.writeVaultFile.path))) {
    return { kind: 'local-conflict' }
  }

  await ports.writeVaultFile(plan.writeVaultFile.path, assembled)
  ports.writeLastMaterialized({
    diskHash: plan.expectedContentSha256,
    ydocHash: plan.expectedContentSha256,
    path: plan.writeVaultFile.path,
    writtenAt: ports.now(),
  })
  return { kind: 'success' }
}

async function bytesMatch(
  bytes: Uint8Array,
  expectedSha256: string,
  expectedSize: number,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<boolean> {
  return (
    bytes.byteLength === expectedSize &&
    makeSha256Hex(await ports.sha256Hex(bytes)) === expectedSha256
  )
}

/**
 * Converts a successful lease renewal plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful renewal plan for one running side effect.
 * @returns Lease-renew persistence transaction containing the CAS lease put.
 */
export function planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerLeaseRenewalPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'lease-renew', writes: plan.indexedDbWrites }
}

/**
 * Converts a successful full snapshot release plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful release plan after applying a full snapshot.
 * @returns Full-snapshot release persistence transaction containing terminal outbox patches.
 */
export function planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'full-snapshot-release', writes: plan.indexedDbWrites }
}

function isSuccessfulOutboxWorkerLeaseAttempt(
  attempt: OutboxWorkerLeaseAttempt,
): attempt is Extract<OutboxWorkerLeaseAttempt, { readonly ok: true }> {
  return attempt.ok
}

/**
 * Plans one outbox worker pass from scheduler result through persisted lease starts.
 *
 * @param input Scheduler tick, local-store snapshot, worker identity, clock, and lease duration.
 * @returns Persisted scheduler state, per-candidate lease attempts, and start effects for acquired leases.
 */
export function planOutboxWorkerTick(input: OutboxWorkerTickInput): OutboxWorkerTickPlan {
  if (!input.tick.ok) {
    return {
      ok: false,
      phase: 'scheduler',
      reason: input.tick.reason,
      tick: input.tick,
    }
  }

  const schedulerOperations = planLocalStoreOutboxSchedulerTransaction(input.tick)
  const schedulerReadSet = planLocalStoreDriverReadSet(schedulerOperations)
  const schedulerIndexedDbReads = planLocalStoreIndexedDbReads(schedulerReadSet)
  const schedulerDriverCommit = applyLocalStoreDriverCommit({
    operations: schedulerOperations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!schedulerDriverCommit.ok) {
    return {
      ok: false,
      phase: 'scheduler-persist',
      reason: schedulerDriverCommit.reason,
      schedulerReadSet,
      schedulerIndexedDbReads,
      schedulerDriverCommit,
      apply: schedulerDriverCommit.apply,
    }
  }

  const schedulerApply = schedulerDriverCommit.apply
  const schedulerIndexedDbWrites = planLocalStoreIndexedDbWrites(schedulerDriverCommit.writes)
  let nextOutboxRecords = schedulerDriverCommit.snapshot.outboxRecords
  let nextLeaseRows = schedulerDriverCommit.snapshot.leaseRows
  const leaseAttempts: OutboxWorkerLeaseAttempt[] = []
  const starts: OutboxWorkerStartEffect[] = []

  for (const start of input.tick.leaseCandidates) {
    const existingLease = nextLeaseRows.find((lease) => lease.itemId === start.id)
    const leaseAcquire = planOutboundQueueLeaseAcquire({
      start,
      ownerId: input.ownerId,
      now: input.now,
      leaseDurationMs: input.leaseDurationMs,
      existingLease,
    })
    if (!leaseAcquire.ok) {
      leaseAttempts.push({
        ok: false,
        start,
        reason: leaseAcquire.reason,
        leaseAcquire,
      })
      continue
    }

    const operations = planLocalStoreLeaseAcquireTransaction(leaseAcquire)
    const readSet = planLocalStoreDriverReadSet(operations)
    const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
    const driverCommit = applyLocalStoreDriverCommit({
      operations,
      snapshot: {
        outboxRecords: nextOutboxRecords,
        leaseRows: nextLeaseRows,
      },
    })
    if (!driverCommit.ok) {
      leaseAttempts.push({
        ok: false,
        start,
        reason: driverCommit.reason,
        readSet,
        driverCommit,
        apply: driverCommit.apply,
      })
      continue
    }

    const apply = driverCommit.apply
    nextOutboxRecords = driverCommit.snapshot.outboxRecords
    nextLeaseRows = driverCommit.snapshot.leaseRows
    leaseAttempts.push({
      ok: true,
      start,
      lease: leaseAcquire.write.nextLease,
      previousOwnerId: leaseAcquire.previousOwnerId,
      operations,
      readSet,
      writes: driverCommit.writes,
      indexedDbReads,
      indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
      driverCommit,
      apply,
    })
    starts.push({
      kind: 'start-side-effect',
      start,
      lease: leaseAcquire.write.nextLease,
    })
  }

  return {
    ok: true,
    schedulerOperations,
    schedulerReadSet,
    schedulerWrites: schedulerDriverCommit.writes,
    schedulerIndexedDbReads,
    schedulerIndexedDbWrites,
    schedulerDriverCommit,
    schedulerApply,
    leaseAttempts,
    starts,
    nextOutboxRecords,
    nextLeaseRows,
    authRefresh: input.tick.authRefresh,
  }
}

/**
 * Builds the concrete side-effect plan for a persisted outbox lease.
 *
 * @param input Start effect, matching outbox record, sync endpoint, and current access token.
 * @returns A concrete local or network side-effect sequence, or the reason it must not start.
 */
export function planOutboxWorkerSideEffect(
  input: OutboxWorkerSideEffectPlanInput,
): OutboxWorkerSideEffectPlan {
  const record = input.record
  if (record === undefined || record.id !== input.effect.start.id) {
    return { ok: false, reason: 'missing-record' }
  }
  if (record.kind !== input.effect.start.kind) {
    return { ok: false, reason: 'kind-mismatch' }
  }

  if (record.kind === 'materialize') {
    return planOutboxWorkerMaterializeSideEffect(input.effect, record)
  }
  if (record.kind === 'meta-ref-update') {
    return planOutboxWorkerMetaRefUpdateSideEffect(input.effect, record)
  }

  if (record.kind !== 'blob-put' && record.kind !== 'blob-get' && record.kind !== 'manifest-put') {
    return { ok: false, reason: 'unsupported-kind' }
  }

  if (input.accessToken === undefined || input.accessToken.length === 0) {
    return { ok: false, reason: 'missing-access-token' }
  }

  const endpoint = normalizeHttpEndpoint(input.endpoint)
  if (endpoint === undefined) {
    return { ok: false, reason: 'invalid-endpoint' }
  }

  const headers = {
    authorization: `Bearer ${input.accessToken}`,
    'content-type': 'application/json',
  }
  if (record.kind === 'manifest-put') {
    return planOutboxWorkerManifestPutSideEffect(input.effect, record, endpoint, headers)
  }

  if (record.blobSha256 === undefined) {
    return { ok: false, reason: 'missing-blob-sha256' }
  }
  if (record.localCacheKey === undefined || record.localCacheKey.length === 0) {
    return { ok: false, reason: 'missing-local-cache-key' }
  }
  if (!isSafeLocalBlobCacheKey(record.localCacheKey)) {
    return { ok: false, reason: 'invalid-local-cache-key' }
  }
  if (
    record.blobSize === undefined ||
    !Number.isSafeInteger(record.blobSize) ||
    record.blobSize < 0
  ) {
    return { ok: false, reason: 'invalid-blob-size' }
  }

  if (record.kind === 'blob-get') {
    if (record.fileId === undefined) {
      return { ok: false, reason: 'missing-file-id' }
    }
    return {
      ok: true,
      action: 'blob-get',
      itemId: record.id,
      lease: input.effect.lease,
      fileId: record.fileId,
      blob: {
        sha256: record.blobSha256,
        size: record.blobSize,
        localCacheKey: record.localCacheKey,
      },
      downloadRequest: {
        method: 'GET',
        url: new URL(`/blobs/${record.blobSha256}`, endpoint).toString(),
        headers: { authorization: `Bearer ${input.accessToken}` },
      },
      writeLocalCache: {
        key: record.localCacheKey,
        expectedSha256: record.blobSha256,
        expectedSize: record.blobSize,
      },
    }
  }

  const headUrl = new URL('/blobs/head', endpoint).toString()
  const uploadUrl = new URL('/blobs/upload-url', endpoint).toString()
  return {
    ok: true,
    action: 'blob-put',
    itemId: record.id,
    lease: input.effect.lease,
    blob: {
      sha256: record.blobSha256,
      size: record.blobSize,
      localCacheKey: record.localCacheKey,
    },
    readLocalCache: {
      key: record.localCacheKey,
      expectedSha256: record.blobSha256,
      expectedSize: record.blobSize,
    },
    headRequest: {
      method: 'POST',
      url: headUrl,
      headers,
      bodyJson: { hashes: [record.blobSha256] },
    },
    uploadUrlRequest: {
      method: 'POST',
      url: uploadUrl,
      headers,
      bodyJson: { sha256: record.blobSha256, size: record.blobSize },
    },
    uploadPut: {
      method: 'PUT',
      urlSource: 'upload-url-response',
      authorization: 'device-access-token',
      bodySource: 'local-cache',
    },
  }
}

/**
 * Plans the transaction that renews a running side-effect lease before it expires.
 *
 * @param input Running item identity, owner evidence, lease duration, clock, and local-store snapshot.
 * @returns Atomic lease CAS write plan, or the reason the runner must stop reporting completion.
 */
export function planOutboxWorkerLeaseRenewal(
  input: OutboxWorkerLeaseRenewalInput,
): OutboxWorkerLeaseRenewalPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const renewal = planOutboundQueueLeaseRenew({
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    existingLease,
  })
  if (!renewal.ok) {
    return {
      ok: false,
      phase: 'renewal',
      reason: renewal.reason,
      renewal,
    }
  }

  const operations = planLocalStoreLeaseRenewTransaction(renewal)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'renewal-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    renewal,
  }
}

/**
 * Plans terminal patches for paused y-update items superseded by a full snapshot apply.
 *
 * @param input Applied document, snapshot sequence, and current local-store snapshot.
 * @returns Local-store transaction plan that closes only matching full-snapshot-required items.
 */
export function planOutboxWorkerFullSnapshotRelease(
  input: OutboxWorkerFullSnapshotReleaseInput,
): OutboxWorkerFullSnapshotReleasePlan {
  const release = planOutboundQueueFullSnapshotRelease({
    appliedDocId: input.appliedDocId,
    snapshotSeq: input.snapshotSeq,
    items: input.currentOutboxRecords,
  })
  if (!release.ok) {
    return {
      ok: false,
      phase: 'release',
      reason: release.reason,
      release,
    }
  }

  const operations = planLocalStoreFullSnapshotReleaseTransaction(release)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'release-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    release,
  }
}

function planOutboxWorkerManifestPutSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
  endpoint: string,
  headers: Readonly<Record<string, string>>,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }

  return {
    ok: true,
    action: 'manifest-put',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    manifestHash: record.blobManifestHash,
    manifest: record.blobManifest,
    putManifestRequest: {
      method: 'PUT',
      url: new URL(`/blob-manifests/${record.blobManifestHash}.json`, endpoint).toString(),
      headers,
      bodyJson: record.blobManifest,
      bodySource: 'canonical-blob-manifest-json',
    },
  }
}

function planOutboxWorkerMetaRefUpdateSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.docId === undefined) {
    return { ok: false, reason: 'missing-doc-id' }
  }
  if (record.messageId === undefined) {
    return { ok: false, reason: 'missing-message-id' }
  }
  if (record.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (record.updateBytesBase64 === undefined || record.updateBytesBase64.length === 0) {
    return { ok: false, reason: 'missing-update-bytes' }
  }

  return {
    ok: true,
    action: 'meta-ref-update',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    binaryRef: {
      blobManifestHash: record.blobManifestHash,
      blobChunks: record.blobManifest.chunks.map((chunk) => chunk.sha256),
    },
    sendSyncUpdate: {
      transport: 'active-sync-websocket',
      docId: record.docId,
      messageId: record.messageId,
      updateSha256: record.updateSha256,
      updateBytesBase64: record.updateBytesBase64,
    },
  }
}

function planOutboxWorkerMaterializeSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.expectedHash === undefined) {
    return { ok: false, reason: 'missing-expected-hash' }
  }
  if (record.targetPath === undefined || record.targetPath.length === 0) {
    return { ok: false, reason: 'missing-target-path' }
  }
  if (!isSafeVaultRelativePath(record.targetPath)) {
    return { ok: false, reason: 'invalid-target-path' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.blobManifest.contentSha256 !== record.expectedHash) {
    return { ok: false, reason: 'manifest-content-mismatch' }
  }
  if (record.materializeChunks === undefined) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }
  if (record.materializeChunks.length !== record.blobManifest.chunks.length) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }

  const seenChunkHashes = new Set<BlobManifest['chunks'][number]['sha256']>()
  const readChunks: OutboxWorkerMaterializeChunkReadPlan[] = []
  for (const chunk of record.blobManifest.chunks) {
    if (seenChunkHashes.has(chunk.sha256)) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    seenChunkHashes.add(chunk.sha256)
    const cached = record.materializeChunks.find((candidate) => candidate.sha256 === chunk.sha256)
    if (cached === undefined || cached.localCacheKey.length === 0 || cached.size !== chunk.size) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    if (!isSafeLocalBlobCacheKey(cached.localCacheKey)) {
      return { ok: false, reason: 'invalid-local-cache-key' }
    }
    readChunks.push({
      sha256: chunk.sha256,
      key: cached.localCacheKey,
      expectedSize: chunk.size,
    })
  }

  return {
    ok: true,
    action: 'materialize',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    targetPath: record.targetPath,
    expectedContentSha256: record.expectedHash,
    manifest: record.blobManifest,
    readChunks,
    assemble: {
      expectedContentSha256: record.expectedHash,
      expectedSize: record.blobManifest.size,
    },
    diskCas: {
      path: record.targetPath,
      lastMaterialized: record.lastMaterialized,
    },
    writeVaultFile: {
      path: record.targetPath,
      bodySource: 'assembled-blob',
    },
  }
}

/**
 * Classifies a concrete non-ack side-effect runner result for completion planning.
 *
 * @param input Item identity, retry evidence, and runner result.
 * @returns Success completion evidence or a normalized failure error for retry policy.
 */
export function classifyOutboxWorkerSideEffectCompletionEvidence(
  input: OutboxWorkerSideEffectCompletionEvidenceInput,
): OutboxWorkerSideEffectCompletionEvidence {
  if (input.result.kind !== 'success') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: outboxRunErrorFromSideEffectResult(input.result),
    }
  }

  if (input.kind === 'y-update' || input.kind === 'meta-ref-update') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: { kind: 'invalid-payload' },
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
  }
}

function outboxRunErrorFromSideEffectResult(
  result: Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>,
): OutboxRunError {
  switch (result.kind) {
    case 'network-error':
      return { kind: 'network' }
    case 'timeout':
      return { kind: 'timeout' }
    case 'offline':
      return { kind: 'offline' }
    case 'local-conflict':
      return { kind: 'local-conflict' }
    case 'invalid-payload':
      return { kind: 'invalid-payload' }
    case 'http-response':
      return outboxRunErrorFromHttpStatus(result)
  }
}

function outboxRunErrorFromHttpStatus(
  response: Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>,
): OutboxRunError {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'auth' }
  }
  if (response.status === 408) {
    return { kind: 'timeout' }
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    return outboxApiRunError({
      retryable: true,
      retryAfterMs: response.retryAfterMs,
      code: response.code,
    })
  }
  return outboxApiRunError({ retryable: false, code: response.code })
}

function outboxApiRunError(input: {
  readonly retryable: boolean
  readonly retryAfterMs?: number | undefined
  readonly code?: string | undefined
}): OutboxRunError {
  const error: { kind: 'api'; retryable: boolean; retryAfterMs?: number; code?: string } = {
    kind: 'api',
    retryable: input.retryable,
  }
  if (input.retryAfterMs !== undefined) {
    error.retryAfterMs = input.retryAfterMs
  }
  if (input.code !== undefined) {
    error.code = input.code
  }
  return error
}

/**
 * Plans the transaction that commits an Ack or NeedFullSnapshot returned by a running y-update side effect.
 *
 * @param input Server response, current outbox record status, lease owner evidence, and local-store snapshot.
 * @returns Atomic item patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerAckCompletion(
  input: OutboxWorkerAckCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueAckCompletion({
    itemId: input.itemId,
    kind: 'y-update',
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreAckCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: completion.action === 'complete' ? 'ack-completion' : 'pause-for-full-snapshot',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that pauses a running y-update after matching server quarantine evidence.
 *
 * @param input Server quarantine evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic quarantine pause plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerQuarantineCompletion(
  input: OutboxWorkerQuarantineCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueQuarantinePause({
    itemId: input.itemId,
    kind: 'y-update',
    status: input.status,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    quarantine: input.quarantine,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreQuarantinePauseTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: 'pause-for-quarantine',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that marks a non-ack side effect done and releases its lease.
 *
 * @param input Success evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic done patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerSuccessCompletion(
  input: OutboxWorkerSuccessCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreSuccessCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: 'success-completion',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that commits a failed side-effect attempt and releases its lease.
 *
 * @param input Failure evidence, retry count, lease owner evidence, and local-store snapshot.
 * @returns Atomic retry/pause/dead-letter patch plus lease release, or a stale completion rejection.
 */
export function planOutboxWorkerFailureCompletion(
  input: OutboxWorkerFailureCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueFailureCompletion({
    itemId: input.itemId,
    kind: input.kind,
    retryCount: input.retryCount,
    error: input.error,
    retryJitterMs: input.retryJitterMs,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreFailureCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: outboxFailureCompletionAction(completion.patch.status),
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

function outboxFailureCompletionAction(
  status: OutboxFailureTransition['status'],
): 'retry-after-failure' | 'pause-after-failure' | 'dead-letter-after-failure' {
  switch (status) {
    case 'retrying':
      return 'retry-after-failure'
    case 'paused':
      return 'pause-after-failure'
    case 'failed':
      return 'dead-letter-after-failure'
  }
}

/**
 * Checks whether a local blob-cache key is constrained to the plugin blob cache namespace.
 *
 * @param key Persisted cache key from an outbox row.
 * @returns True when the key is a safe vault-relative blob-cache path.
 */
export function isSafeLocalBlobCacheKey(key: string): boolean {
  return (
    key.startsWith('blob-cache/') &&
    key.length > 'blob-cache/'.length &&
    isSafeVaultRelativePath(key)
  )
}

/**
 * Checks whether a persisted path is a normalized vault-relative path.
 *
 * @param path Path persisted in local-store state.
 * @returns True when the path cannot escape the vault through absolute or parent segments.
 */
export function isSafeVaultRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.includes('\\')) {
    return false
  }
  if (path.startsWith('/')) {
    return false
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeHttpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      return undefined
    }
    url.pathname = '/'
    url.search = ''
    return url.toString()
  } catch {
    return undefined
  }
}
