import {
  type DocId,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  buildBinaryDownloadOutboxPlan,
  buildBinaryUploadOutboxPlan,
  decideOutboxAuthRefreshRequest,
  decideOutboxAckCompletion,
  decideOutboxConcurrency,
  decideOutboxLeaseAcquire,
  decideOutboxLeaseRelease,
  decideOutboxLeaseRenew,
  decideOutboxQuarantinePause,
  decideOutboxResume,
  decideOutboxRetry,
  decideOutboxRun,
  makeOutboxPlanItemId,
  outboxConcurrencyLane,
  outboxConcurrencyLimit,
  outboxRetryPolicy,
  planOutboxDependencyBlocks,
  planOutboxFullSnapshotRelease,
  planOutboxResumePatches,
  planOutboxSchedulerTick,
  transitionOutboxFailure,
} from './outbox'

const fileId = makeFileId('file-1')
const vaultId = makeVaultId('vault-1')
const deviceId = makeDeviceId('device-1')
const messageId = makeMessageId('message-1')
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId
const firstHash = makeSha256Hex('a'.repeat(64))
const secondHash = makeSha256Hex('b'.repeat(64))
const manifestHash = makeSha256Hex('c'.repeat(64))

test('binary upload plan publishes meta only after chunks and manifest', () => {
  const chunk1 = outboxId('chunk-1')
  const chunk2 = outboxId('chunk-2')
  const manifestPut = outboxId('manifest-put')
  const metaRefUpdate = outboxId('meta-ref-update')

  const result = buildBinaryUploadOutboxPlan({
    fileId,
    blobManifestHash: manifestHash,
    chunks: [
      { id: chunk1, sha256: firstHash, localCacheKey: 'blob/a', size: 10 },
      { id: chunk2, sha256: secondHash, localCacheKey: 'blob/b', size: 20 },
    ],
    manifestPutId: manifestPut,
    metaRefUpdateId: metaRefUpdate,
  })

  assert.equal(result.ok, true)
  if (!result.ok) {
    throw new Error(`unexpected upload plan rejection: ${result.reason}`)
  }
  assert.deepEqual(result.plan.chunkPuts, [chunk1, chunk2])
  assert.deepEqual(
    result.plan.items.map((item) => item.kind),
    ['blob-put', 'blob-put', 'manifest-put', 'meta-ref-update'],
  )
  assert.deepEqual(result.plan.items[2]?.dependsOn, [chunk1, chunk2])
  assert.deepEqual(result.plan.items[3]?.dependsOn, [chunk1, chunk2, manifestPut])
})

test('binary download plan materializes only after all chunks are fetched', () => {
  const chunk1 = outboxId('chunk-1')
  const chunk2 = outboxId('chunk-2')
  const materialize = outboxId('materialize')

  const result = buildBinaryDownloadOutboxPlan({
    fileId,
    expectedHash: manifestHash,
    chunks: [
      { id: chunk1, sha256: firstHash, localCacheKey: 'download/a', size: 10 },
      { id: chunk2, sha256: secondHash, localCacheKey: 'download/b', size: 20 },
    ],
    materializeId: materialize,
  })

  assert.equal(result.ok, true)
  if (!result.ok) {
    throw new Error(`unexpected download plan rejection: ${result.reason}`)
  }
  assert.deepEqual(result.plan.chunkGets, [chunk1, chunk2])
  assert.deepEqual(
    result.plan.items.map((item) => item.kind),
    ['blob-get', 'blob-get', 'materialize'],
  )
  assert.deepEqual(result.plan.items[2]?.dependsOn, [chunk1, chunk2])
})

test('binary plan builders support zero chunk manifests without hidden dependencies', () => {
  const upload = buildBinaryUploadOutboxPlan({
    fileId,
    blobManifestHash: manifestHash,
    chunks: [],
    manifestPutId: outboxId('manifest-put'),
    metaRefUpdateId: outboxId('meta-ref-update'),
  })
  const download = buildBinaryDownloadOutboxPlan({
    fileId,
    expectedHash: manifestHash,
    chunks: [],
    materializeId: outboxId('materialize'),
  })

  assert.equal(upload.ok, true)
  if (!upload.ok) {
    throw new Error(`unexpected upload plan rejection: ${upload.reason}`)
  }
  assert.deepEqual(
    upload.plan.items.map((item) => item.dependsOn),
    [[], [upload.plan.manifestPut]],
  )
  assert.equal(download.ok, true)
  if (!download.ok) {
    throw new Error(`unexpected download plan rejection: ${download.reason}`)
  }
  assert.deepEqual(download.plan.items[0]?.dependsOn, [])
})

test('binary plan builders reject ambiguous or invalid persistent records', () => {
  const duplicateId = outboxId('duplicate')

  assert.deepEqual(
    buildBinaryUploadOutboxPlan({
      fileId,
      blobManifestHash: manifestHash,
      chunks: [{ id: duplicateId, sha256: firstHash, localCacheKey: 'blob/a', size: 10 }],
      manifestPutId: duplicateId,
      metaRefUpdateId: outboxId('meta-ref-update'),
    }),
    { ok: false, reason: 'duplicate-item-id' },
  )

  assert.deepEqual(
    buildBinaryDownloadOutboxPlan({
      fileId,
      expectedHash: manifestHash,
      chunks: [{ id: outboxId('chunk-1'), sha256: firstHash, localCacheKey: '', size: 10 }],
      materializeId: outboxId('materialize'),
    }),
    { ok: false, reason: 'empty-local-cache-key' },
  )

  assert.deepEqual(
    buildBinaryDownloadOutboxPlan({
      fileId,
      expectedHash: manifestHash,
      chunks: [
        { id: outboxId('chunk-1'), sha256: firstHash, localCacheKey: 'download/a', size: -1 },
      ],
      materializeId: outboxId('materialize'),
    }),
    { ok: false, reason: 'invalid-blob-size' },
  )
})

test('outbox retry uses y-update backoff schedule', () => {
  assert.deepEqual(
    decideOutboxRetry({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'network' },
    }),
    { action: 'retry', delayMs: 250, jitterRatio: 0.2 },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'y-update',
      retryCount: 3,
      error: { kind: 'timeout' },
    }),
    { action: 'retry', delayMs: 30_000, jitterRatio: 0.2 },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'y-update',
      retryCount: 10,
      error: { kind: 'offline' },
    }),
    { action: 'retry', delayMs: 30_000, jitterRatio: 0.2 },
  )
})

test('outbox retry uses blob backoff schedule and retry-after as a floor', () => {
  assert.deepEqual(
    decideOutboxRetry({
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'network' },
    }),
    { action: 'retry', delayMs: 5_000, jitterRatio: 0.2 },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'blob-get',
      retryCount: 10,
      error: { kind: 'api', retryable: true, retryAfterMs: 600_000 },
    }),
    { action: 'retry', delayMs: 600_000, jitterRatio: 0.2 },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'manifest-put',
      retryCount: 0,
      error: { kind: 'api', retryable: true, retryAfterMs: 2_000 },
    }),
    { action: 'retry', delayMs: 2_000, jitterRatio: 0.2 },
  )
})

test('outbox retry dead-letters invalid payloads but pauses auth failures', () => {
  assert.deepEqual(
    decideOutboxRetry({
      kind: 'blob-put',
      retryCount: 0,
      error: { kind: 'api', retryable: false, code: 'blob/hash-mismatch' },
    }),
    { action: 'dead-letter', reason: 'non-retryable-api-error' },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'meta-ref-update',
      retryCount: 0,
      error: { kind: 'invalid-payload' },
    }),
    { action: 'dead-letter', reason: 'invalid-payload' },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'auth' },
    }),
    { action: 'pause', reason: 'auth-required', resumeOn: 'auth-refresh' },
  )
})

test('materialize retries immediately three times then pauses', () => {
  assert.deepEqual(
    decideOutboxRetry({
      kind: 'materialize',
      retryCount: 0,
      error: { kind: 'local-conflict' },
    }),
    { action: 'pause', reason: 'dependency-or-local-state', resumeOn: 'local-state-change' },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'materialize',
      retryCount: 2,
      error: { kind: 'timeout' },
    }),
    { action: 'retry', delayMs: 0, jitterRatio: 0 },
  )

  assert.deepEqual(
    decideOutboxRetry({
      kind: 'materialize',
      retryCount: 3,
      error: { kind: 'timeout' },
    }),
    { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' },
  )
})

test('outbox retry exposes policy constants', () => {
  assert.deepEqual(outboxRetryPolicy('blob-get'), {
    scheduleMs: [1_000, 5_000, 30_000, 300_000],
    maxDelayMs: 300_000,
    jitterRatio: 0.2,
  })
  assert.deepEqual(outboxRetryPolicy('materialize'), {
    scheduleMs: [0, 0, 0],
    maxRetryCount: 3,
    maxDelayMs: 0,
    jitterRatio: 0,
  })
})

test('outbox run waits until retrying items are due', () => {
  assert.deepEqual(
    decideOutboxRun({
      status: 'retrying',
      dependencies: [],
      nextAttemptAt: 200,
      now: 100,
    }),
    { action: 'wait', reason: 'not-due' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'retrying',
      dependencies: [],
      nextAttemptAt: 200,
      now: 200,
    }),
    { action: 'run' },
  )
})

test('outbox run requires completed dependencies', () => {
  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [{ status: 'done' }, { status: 'retrying' }],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'wait', reason: 'dependency-pending' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [{ status: 'done' }, { status: 'done' }],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'run' },
  )
})

test('outbox run blocks when dependencies failed permanently', () => {
  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [{ status: 'done' }, { status: 'failed' }],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'block', reason: 'dependency-failed' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [{ status: 'blocked' }],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'block', reason: 'dependency-failed' },
  )
})

test('outbox run ignores terminal and paused items', () => {
  assert.deepEqual(
    decideOutboxRun({
      status: 'done',
      dependencies: [],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'wait', reason: 'already-complete' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'paused',
      dependencies: [],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'wait', reason: 'paused' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'failed',
      dependencies: [],
      nextAttemptAt: undefined,
      now: 100,
    }),
    { action: 'skip', reason: 'failed-or-blocked' },
  )
})

test('outbox run rejects invalid clocks', () => {
  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [],
      nextAttemptAt: undefined,
      now: -1,
    }),
    { action: 'wait', reason: 'invalid-clock' },
  )

  assert.deepEqual(
    decideOutboxRun({
      status: 'pending',
      dependencies: [],
      nextAttemptAt: -1,
      now: 100,
    }),
    { action: 'wait', reason: 'not-due' },
  )
})

test('outbox resume respects persisted resume conditions', () => {
  assert.deepEqual(
    decideOutboxResume({
      status: 'paused',
      resumeOn: 'auth-refresh',
      event: 'local-state-change',
    }),
    { action: 'wait', reason: 'resume-condition-not-met' },
  )

  assert.deepEqual(
    decideOutboxResume({
      status: 'paused',
      resumeOn: 'auth-refresh',
      event: 'auth-refresh',
    }),
    { action: 'resume', status: 'pending', nextAttemptAt: undefined },
  )

  assert.deepEqual(
    decideOutboxResume({
      status: 'paused',
      resumeOn: 'local-state-change',
      event: 'manual',
    }),
    { action: 'resume', status: 'pending', nextAttemptAt: undefined },
  )

  assert.deepEqual(
    decideOutboxResume({
      status: 'paused',
      resumeOn: undefined,
      event: 'manual',
    }),
    { action: 'wait', reason: 'missing-resume-condition' },
  )

  assert.deepEqual(
    decideOutboxResume({
      status: 'retrying',
      resumeOn: 'manual',
      event: 'manual',
    }),
    { action: 'wait', reason: 'not-paused' },
  )
})

test('outbox resume patch planner resumes only matching paused items', () => {
  const authPaused = outboxId('auth-paused')
  const localPaused = outboxId('local-paused')
  const running = outboxId('running')

  assert.deepEqual(
    planOutboxResumePatches(
      [
        schedulerItem(authPaused, 'y-update', 'paused', [], undefined, 'auth-refresh'),
        schedulerItem(localPaused, 'materialize', 'paused', [], undefined, 'local-state-change'),
        schedulerItem(running, 'blob-put', 'retrying', [], undefined, 'manual'),
      ],
      ['auth-refresh'],
    ),
    [{ id: authPaused, status: 'pending', nextAttemptAt: undefined }],
  )

  assert.deepEqual(
    planOutboxResumePatches(
      [
        schedulerItem(authPaused, 'y-update', 'paused', [], undefined, 'auth-refresh'),
        schedulerItem(localPaused, 'materialize', 'paused', [], undefined, 'local-state-change'),
      ],
      ['manual'],
    ),
    [
      { id: authPaused, status: 'pending', nextAttemptAt: undefined },
      { id: localPaused, status: 'pending', nextAttemptAt: undefined },
    ],
  )
})

test('outbox ack completion marks matching y-update a durable done', () => {
  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      minDurableSeqExclusive: 40,
      message: {
        type: 'ack',
        protocolVersion: 1,
        vaultId,
        deviceId,
        docId: fileDocId,
        messageId,
        durableSeq: 41,
      },
    }),
    {
      action: 'complete',
      patch: {
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 41,
      },
    },
  )
})

test('outbox ack completion marks a matching meta-ref-update a durable done, same as y-update', () => {
  // `meta-ref-update` is the DAG-scheduled meta write that follows a binary
  // upload's blob-put/manifest-put chain; it is sent over the same
  // sync-update WebSocket frame as `y-update` and must be ack-completable
  // identically, or its lease never releases and permanently starves the
  // single-slot `sync-control` concurrency lane.
  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'meta-ref-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      minDurableSeqExclusive: 40,
      message: {
        type: 'ack',
        protocolVersion: 1,
        vaultId,
        deviceId,
        docId: fileDocId,
        messageId,
        durableSeq: 41,
      },
    }),
    {
      action: 'complete',
      patch: {
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 41,
      },
    },
  )
})

test('outbox ack completion rejects stale or mismatched evidence', () => {
  const ack = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    durableSeq: 41,
  } as const

  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'blob-put',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      message: ack,
    }),
    { action: 'reject', reason: 'unsupported-kind' },
  )

  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'done',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      message: ack,
    }),
    { action: 'reject', reason: 'not-runnable-status' },
  )

  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId: makeMessageId('message-2'),
      message: ack,
    }),
    { action: 'reject', reason: 'message-mismatch' },
  )

  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: { kind: 'file', ydocId: makeYDocId('doc-2') },
      messageId,
      message: ack,
    }),
    { action: 'reject', reason: 'doc-mismatch' },
  )

  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      minDurableSeqExclusive: 41,
      message: ack,
    }),
    { action: 'reject', reason: 'stale-durable-seq' },
  )
})

test('outbox ack completion pauses on full snapshot boundary messages', () => {
  assert.deepEqual(
    decideOutboxAckCompletion({
      kind: 'y-update',
      status: 'retrying',
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      message: {
        type: 'need-full-snapshot',
        protocolVersion: 1,
        vaultId,
        deviceId,
        docId: fileDocId,
        reason: 'state-vector-too-old',
      },
    }),
    {
      action: 'pause-for-full-snapshot',
      patch: {
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'full-snapshot-required',
        resumeOn: 'manual',
        snapshotReason: 'state-vector-too-old',
        docId: fileDocId,
      },
    },
  )
})

test('outbox quarantine pause links matching y-update to repair UI', () => {
  assert.deepEqual(
    decideOutboxQuarantinePause({
      kind: 'y-update',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      updateSha256: firstHash,
      quarantine: {
        id: 'quarantine-1',
        docId: fileDocId,
        messageId,
        deviceId,
        reason: 'meta-schema-invalid',
        updateSha256: firstHash,
        updateBytesLength: 42,
        createdAt: 100,
      },
    }),
    {
      action: 'pause-for-quarantine',
      patch: {
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'server-quarantine',
        resumeOn: 'manual',
        quarantineId: 'quarantine-1',
        quarantineReason: 'meta-schema-invalid',
        docId: fileDocId,
      },
    },
  )
})

test('outbox quarantine pause rejects unrelated evidence', () => {
  const quarantine = {
    id: 'quarantine-1',
    docId: fileDocId,
    messageId,
    deviceId,
    reason: 'hash-mismatch' as const,
    updateSha256: firstHash,
    updateBytesLength: 42,
    createdAt: 100,
  }

  assert.deepEqual(
    decideOutboxQuarantinePause({
      kind: 'blob-put',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      quarantine,
    }),
    { action: 'reject', reason: 'unsupported-kind' },
  )

  assert.deepEqual(
    decideOutboxQuarantinePause({
      kind: 'y-update',
      status: 'done',
      deviceId,
      docId: fileDocId,
      messageId,
      quarantine,
    }),
    { action: 'reject', reason: 'not-runnable-status' },
  )

  assert.deepEqual(
    decideOutboxQuarantinePause({
      kind: 'y-update',
      status: 'retrying',
      deviceId,
      docId: fileDocId,
      messageId,
      updateSha256: secondHash,
      quarantine,
    }),
    { action: 'reject', reason: 'hash-mismatch' },
  )
})

test('outbox full snapshot release closes only matching paused y-updates and meta-ref-updates', () => {
  const matching = outboxId('matching')
  const matchingMetaRef = outboxId('matching-meta-ref')
  const otherDoc = outboxId('other-doc')
  const manualPaused = outboxId('manual-paused')
  const blobPaused = outboxId('blob-paused')

  assert.deepEqual(
    planOutboxFullSnapshotRelease({
      appliedDocId: fileDocId,
      snapshotSeq: 20,
      items: [
        {
          id: matching,
          kind: 'y-update',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: fileDocId,
        },
        {
          id: matchingMetaRef,
          kind: 'meta-ref-update',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: fileDocId,
        },
        {
          id: otherDoc,
          kind: 'y-update',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: { kind: 'file', ydocId: makeYDocId('doc-2') },
        },
        {
          id: manualPaused,
          kind: 'y-update',
          status: 'paused',
          reason: 'manual-intervention-required',
          docId: fileDocId,
        },
        {
          id: blobPaused,
          kind: 'blob-put',
          status: 'paused',
          reason: 'full-snapshot-required',
          docId: fileDocId,
        },
      ],
    }),
    {
      ok: true,
      releasePatches: [
        {
          id: matching,
          status: 'done',
          nextAttemptAt: undefined,
          completedBy: 'full-snapshot-apply',
          snapshotSeq: 20,
        },
        {
          id: matchingMetaRef,
          status: 'done',
          nextAttemptAt: undefined,
          completedBy: 'full-snapshot-apply',
          snapshotSeq: 20,
        },
      ],
    },
  )
})

test('outbox full snapshot release validates snapshot sequence', () => {
  assert.deepEqual(
    planOutboxFullSnapshotRelease({
      appliedDocId: fileDocId,
      snapshotSeq: -1,
      items: [],
    }),
    { ok: false, reason: 'invalid-snapshot-seq' },
  )
})

test('outbox dependency block plan cascades failed ancestors as dead letters', () => {
  const failed = outboxId('failed')
  const middle = outboxId('middle')
  const leaf = outboxId('leaf')
  const independent = outboxId('independent')

  assert.deepEqual(
    planOutboxDependencyBlocks([
      { id: failed, status: 'failed', dependsOn: [] },
      { id: middle, status: 'pending', dependsOn: [failed] },
      { id: leaf, status: 'retrying', dependsOn: [middle] },
      { id: independent, status: 'pending', dependsOn: [] },
    ]),
    {
      ok: true,
      blockPatches: [],
      deadLetterPatches: [
        {
          id: middle,
          status: 'failed',
          reason: 'dead-letter',
          deadLetterReason: 'dependency-dead-letter',
          deadLetteredBy: [failed],
        },
        {
          id: leaf,
          status: 'failed',
          reason: 'dead-letter',
          deadLetterReason: 'dependency-dead-letter',
          deadLetteredBy: [middle],
        },
      ],
    },
  )
})

test('outbox dependency block plan keeps blocked ancestors as transient blocks', () => {
  const blocked = outboxId('blocked')
  const dependent = outboxId('dependent')

  assert.deepEqual(
    planOutboxDependencyBlocks([
      { id: blocked, status: 'blocked', dependsOn: [] },
      { id: dependent, status: 'pending', dependsOn: [blocked] },
    ]),
    {
      ok: true,
      blockPatches: [{ id: dependent, status: 'blocked', blockedBy: [blocked] }],
      deadLetterPatches: [],
    },
  )
})

test('outbox dependency block plan validates persisted graph shape', () => {
  const duplicate = outboxId('duplicate')
  const missing = outboxId('missing')
  const item = outboxId('item')

  assert.deepEqual(
    planOutboxDependencyBlocks([
      { id: duplicate, status: 'pending', dependsOn: [] },
      { id: duplicate, status: 'retrying', dependsOn: [] },
    ]),
    { ok: false, reason: 'duplicate-item-id', id: duplicate },
  )

  assert.deepEqual(
    planOutboxDependencyBlocks([{ id: item, status: 'pending', dependsOn: [missing] }]),
    { ok: false, reason: 'missing-dependency', id: missing },
  )
})

test('outbox scheduler tick applies resume events before selecting starts', () => {
  const authPaused = outboxId('auth-paused')
  const localPaused = outboxId('local-paused')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: ['auth-refresh'],
      leases: [],
      maxStarts: 3,
      items: [
        schedulerItem(authPaused, 'y-update', 'paused', [], undefined, 'auth-refresh'),
        schedulerItem(localPaused, 'materialize', 'paused', [], undefined, 'local-state-change'),
      ],
    }),
    {
      ok: true,
      resumePatches: [{ id: authPaused, status: 'pending', nextAttemptAt: undefined }],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [],
      starts: [{ id: authPaused, kind: 'y-update', lane: 'sync-control' }],
    },
  )
})

test('outbox scheduler tick dead-letters a resumed item with a failed dependency', () => {
  const failed = outboxId('failed')
  const paused = outboxId('paused')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: ['manual'],
      leases: [],
      maxStarts: 3,
      items: [
        schedulerItem(failed, 'blob-put', 'failed', [], undefined),
        schedulerItem(paused, 'manifest-put', 'paused', [failed], undefined, 'manual'),
      ],
    }),
    {
      ok: true,
      resumePatches: [{ id: paused, status: 'pending', nextAttemptAt: undefined }],
      blockPatches: [],
      deadLetterPatches: [
        {
          id: paused,
          status: 'failed',
          reason: 'dead-letter',
          deadLetterReason: 'dependency-dead-letter',
          deadLetteredBy: [failed],
        },
      ],
      leaseReclaims: [],
      starts: [],
    },
  )
})

test('outbox scheduler tick starts runnable items by lane without treating starts as done', () => {
  const upload = outboxId('upload')
  const publish = outboxId('publish')
  const materialize = outboxId('materialize')
  const laterBlob = outboxId('later-blob')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 3,
      items: [
        schedulerItem(upload, 'blob-put', 'pending', [], undefined),
        schedulerItem(publish, 'meta-ref-update', 'pending', [upload], undefined),
        schedulerItem(materialize, 'materialize', 'retrying', [], 1_000),
        schedulerItem(laterBlob, 'blob-get', 'retrying', [], 2_000),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [],
      starts: [
        { id: upload, kind: 'blob-put', lane: 'blob-transfer' },
        { id: materialize, kind: 'materialize', lane: 'materialize' },
      ],
    },
  )
})

test('outbox scheduler tick skips full lanes but still fills other lanes', () => {
  const yUpdate = outboxId('y-update')
  const blob = outboxId('blob')
  const materialize = outboxId('materialize')
  const runningSync = outboxId('running-sync')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'mobile',
      resumeEvents: [],
      leases: [lease(runningSync, 'y-update', 'worker-1', 2_000)],
      maxStarts: 4,
      items: [
        schedulerItem(runningSync, 'y-update', 'retrying', [], undefined),
        schedulerItem(yUpdate, 'y-update', 'pending', [], undefined),
        schedulerItem(blob, 'blob-put', 'pending', [], undefined),
        schedulerItem(materialize, 'materialize', 'pending', [], undefined),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [],
      starts: [
        { id: blob, kind: 'blob-put', lane: 'blob-transfer' },
        { id: materialize, kind: 'materialize', lane: 'materialize' },
      ],
    },
  )
})

test('outbox scheduler auth gate refreshes before protected starts without starving local work', () => {
  const yUpdate = outboxId('y-update')
  const materialize = outboxId('materialize')
  const blob = outboxId('blob')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 900,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 2,
      auth: {
        tokenExpiresAt: 1_000,
        refreshMarginMs: 200,
        estimates: [
          { id: yUpdate, estimatedDurationMs: 50 },
          { id: blob, estimatedDurationMs: 500 },
        ],
      },
      items: [
        schedulerItem(yUpdate, 'y-update', 'pending', [], undefined),
        schedulerItem(materialize, 'materialize', 'pending', [], undefined),
        schedulerItem(blob, 'blob-put', 'pending', [], undefined),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [],
      starts: [{ id: materialize, kind: 'materialize', lane: 'materialize' }],
      authRefreshBlocks: [
        {
          id: yUpdate,
          kind: 'y-update',
          lane: 'sync-control',
          reason: 'token-expiring-soon',
          remainingMs: 100,
          requiredRemainingMs: 250,
        },
        {
          id: blob,
          kind: 'blob-put',
          lane: 'blob-transfer',
          reason: 'token-expiring-soon',
          remainingMs: 100,
          requiredRemainingMs: 700,
        },
      ],
    },
  )
})

test('outbox scheduler auth gate starts protected work with enough token lifetime', () => {
  const yUpdate = outboxId('y-update')
  const blob = outboxId('blob')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 100,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 2,
      auth: {
        tokenExpiresAt: 10_000,
        refreshMarginMs: 200,
        defaultEstimatedDurationMs: 50,
      },
      items: [
        schedulerItem(yUpdate, 'y-update', 'pending', [], undefined),
        schedulerItem(blob, 'blob-get', 'pending', [], undefined),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [],
      starts: [
        { id: yUpdate, kind: 'y-update', lane: 'sync-control' },
        { id: blob, kind: 'blob-get', lane: 'blob-transfer' },
      ],
    },
  )
})

test('outbox scheduler auth gate rejects invalid token timing evidence', () => {
  const yUpdate = outboxId('y-update')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 100,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 1,
      auth: {
        tokenExpiresAt: 1_000,
        refreshMarginMs: 200,
        estimates: [
          { id: yUpdate, estimatedDurationMs: 10 },
          { id: yUpdate, estimatedDurationMs: 20 },
        ],
      },
      items: [schedulerItem(yUpdate, 'y-update', 'pending', [], undefined)],
    }),
    { ok: false, reason: 'duplicate-auth-estimate', id: yUpdate },
  )

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 100,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 1,
      auth: {
        tokenExpiresAt: 1_000,
        refreshMarginMs: 200,
        defaultEstimatedDurationMs: -1,
      },
      items: [schedulerItem(yUpdate, 'y-update', 'pending', [], undefined)],
    }),
    { ok: false, reason: 'invalid-estimated-duration' },
  )
})

test('outbox scheduler auth gate prioritizes duplicate estimates over malformed duplicates', () => {
  const duplicate = outboxId('duplicate-estimate')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 100,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 1,
      auth: {
        tokenExpiresAt: 10_000,
        refreshMarginMs: 200,
        estimates: [
          { id: duplicate, estimatedDurationMs: 10 },
          { id: duplicate, estimatedDurationMs: -1 },
        ],
      },
      items: [],
    }),
    { ok: false, reason: 'duplicate-auth-estimate', id: duplicate },
  )
})

test('outbox auth refresh request schedules one refresh for blocked starts', () => {
  const expired = outboxId('expired')
  const expiringSoon = outboxId('expiring-soon')

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'idle' },
      refreshBlocks: [
        authRefreshBlock(expiringSoon, 'y-update', 'token-expiring-soon', 100, 300),
        authRefreshBlock(expired, 'blob-put', 'token-expired', 0, 700),
      ],
    }),
    {
      action: 'request-refresh',
      reason: 'token-expired',
      requestedAt: 1_000,
      blockedItemIds: [expiringSoon, expired],
    },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'idle' },
      refreshBlocks: undefined,
    }),
    { action: 'noop', reason: 'no-auth-blocks' },
  )
})

test('outbox auth refresh request waits while refresh is running or backing off', () => {
  const yUpdate = outboxId('y-update')
  const refreshBlocks = [authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300)]

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'refreshing' },
      refreshBlocks,
    }),
    {
      action: 'wait',
      reason: 'refresh-already-running',
      blockedItemIds: [yUpdate],
    },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'backing-off', nextAllowedRefreshAt: 2_000 },
      refreshBlocks,
    }),
    {
      action: 'wait',
      reason: 'refresh-backoff',
      nextAllowedRefreshAt: 2_000,
      blockedItemIds: [yUpdate],
    },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 2_000,
      refreshState: { status: 'backing-off', nextAllowedRefreshAt: 2_000 },
      refreshBlocks,
    }),
    {
      action: 'request-refresh',
      reason: 'token-expiring-soon',
      requestedAt: 2_000,
      blockedItemIds: [yUpdate],
    },
  )
})

test('outbox auth refresh request rejects corrupted local refresh evidence', () => {
  const yUpdate = outboxId('y-update')

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: -1,
      refreshState: { status: 'idle' },
      refreshBlocks: [authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300)],
    }),
    { action: 'reject', reason: 'invalid-clock' },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'backing-off', nextAllowedRefreshAt: -1 },
      refreshBlocks: [authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300)],
    }),
    { action: 'reject', reason: 'invalid-refresh-backoff' },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'idle' },
      refreshBlocks: [
        authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300),
        authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300),
      ],
    }),
    { action: 'reject', reason: 'duplicate-refresh-block', id: yUpdate },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'idle' },
      refreshBlocks: [
        authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300),
        {
          ...authRefreshBlock(yUpdate, 'y-update', 'token-expiring-soon', 100, 300),
          requiredRemainingMs: -1,
        },
      ],
    }),
    { action: 'reject', reason: 'duplicate-refresh-block', id: yUpdate },
  )

  assert.deepEqual(
    decideOutboxAuthRefreshRequest({
      now: 1_000,
      refreshState: { status: 'idle' },
      refreshBlocks: [authRefreshBlock(yUpdate, 'y-update', 'token-expired', 100, 300)],
    }),
    { action: 'reject', reason: 'invalid-refresh-block', id: yUpdate },
  )
})

test('outbox scheduler tick applies dead-letter cascade before selecting starts', () => {
  const failed = outboxId('failed')
  const dependent = outboxId('dependent')
  const independent = outboxId('independent')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 3,
      items: [
        schedulerItem(failed, 'blob-put', 'failed', [], undefined),
        schedulerItem(dependent, 'manifest-put', 'pending', [failed], undefined),
        schedulerItem(independent, 'y-update', 'pending', [], undefined),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [
        {
          id: dependent,
          status: 'failed',
          reason: 'dead-letter',
          deadLetterReason: 'dependency-dead-letter',
          deadLetteredBy: [failed],
        },
      ],
      leaseReclaims: [],
      starts: [{ id: independent, kind: 'y-update', lane: 'sync-control' }],
    },
  )
})

test('outbox scheduler tick reclaims expired leases before selecting starts', () => {
  const expired = outboxId('expired')
  const active = outboxId('active')
  const candidate = outboxId('candidate')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: [],
      leases: [
        lease(expired, 'blob-put', 'worker-old', 1_000),
        lease(active, 'blob-get', 'worker-live', 2_000),
      ],
      maxStarts: 3,
      items: [
        schedulerItem(expired, 'blob-put', 'retrying', [], undefined),
        schedulerItem(active, 'blob-get', 'retrying', [], undefined),
        schedulerItem(candidate, 'blob-put', 'pending', [], undefined),
      ],
    }),
    {
      ok: true,
      resumePatches: [],
      blockPatches: [],
      deadLetterPatches: [],
      leaseReclaims: [
        {
          id: expired,
          previousOwnerId: 'worker-old',
          status: 'retrying',
          nextAttemptAt: undefined,
        },
      ],
      starts: [
        { id: expired, kind: 'blob-put', lane: 'blob-transfer' },
        { id: candidate, kind: 'blob-put', lane: 'blob-transfer' },
      ],
    },
  )
})

test('outbox scheduler tick rejects untrusted queue snapshots', () => {
  const item = outboxId('item')
  const missing = outboxId('missing')

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: -1,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 1,
      items: [],
    }),
    { ok: false, reason: 'invalid-clock' },
  )

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: [],
      leases: [lease(item, 'blob-get', '', 2_000)],
      maxStarts: 1,
      items: [schedulerItem(item, 'blob-get', 'pending', [], undefined)],
    }),
    { ok: false, reason: 'empty-lease-owner', id: item },
  )

  assert.deepEqual(
    planOutboxSchedulerTick({
      now: 1_000,
      profile: 'desktop',
      resumeEvents: [],
      leases: [],
      maxStarts: 1,
      items: [schedulerItem(item, 'blob-get', 'pending', [missing], undefined)],
    }),
    { ok: false, reason: 'missing-dependency', id: missing },
  )
})

test('outbox lease acquire uses compare-and-set friendly decisions', () => {
  const item = outboxId('item')

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: undefined,
    }),
    {
      action: 'acquire',
      lease: lease(item, 'blob-put', 'worker-1', 31_000),
      previousOwnerId: undefined,
    },
  )

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-2',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'active-lease-exists' },
  )

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-2',
      now: 2_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    {
      action: 'take-over-expired',
      lease: lease(item, 'blob-put', 'worker-2', 32_000),
      previousOwnerId: 'worker-1',
    },
  )
})

test('outbox lease acquire rejects invalid ownership and mismatched records', () => {
  const item = outboxId('item')
  const other = outboxId('other')

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: '',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: undefined,
    }),
    { action: 'reject', reason: 'empty-owner' },
  )

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 0,
      existingLease: undefined,
    }),
    { action: 'reject', reason: 'invalid-lease-duration' },
  )

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(other, 'blob-put', 'worker-2', 500),
    }),
    { action: 'reject', reason: 'lease-item-mismatch' },
  )

  assert.deepEqual(
    decideOutboxLeaseAcquire({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-get', 'worker-2', 500),
    }),
    { action: 'reject', reason: 'lease-kind-mismatch' },
  )
})

test('outbox lease release requires matching owner', () => {
  const item = outboxId('item')

  assert.deepEqual(
    decideOutboxLeaseRelease({
      itemId: item,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'release' },
  )

  assert.deepEqual(
    decideOutboxLeaseRelease({
      itemId: item,
      ownerId: 'worker-2',
      now: 1_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'owner-mismatch' },
  )

  assert.deepEqual(
    decideOutboxLeaseRelease({
      itemId: item,
      ownerId: 'worker-1',
      now: 1_000,
      existingLease: undefined,
    }),
    { action: 'reject', reason: 'missing-lease' },
  )

  assert.deepEqual(
    decideOutboxLeaseRelease({
      itemId: '',
      ownerId: 'worker-1',
      now: 1_000,
      existingLease: undefined,
    }),
    { action: 'reject', reason: 'missing-lease' },
  )

  assert.deepEqual(
    decideOutboxLeaseRelease({
      itemId: item,
      ownerId: 'worker-1',
      now: 2_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'lease-expired' },
  )
})

test('outbox lease renew extends only active owned leases', () => {
  const item = outboxId('item')

  assert.deepEqual(
    decideOutboxLeaseRenew({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    {
      action: 'renew',
      lease: lease(item, 'blob-put', 'worker-1', 31_000),
    },
  )

  assert.deepEqual(
    decideOutboxLeaseRenew({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 2_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'lease-expired' },
  )

  assert.deepEqual(
    decideOutboxLeaseRenew({
      itemId: item,
      kind: 'blob-put',
      ownerId: 'worker-2',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'owner-mismatch' },
  )

  assert.deepEqual(
    decideOutboxLeaseRenew({
      itemId: item,
      kind: 'blob-get',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: lease(item, 'blob-put', 'worker-1', 2_000),
    }),
    { action: 'reject', reason: 'lease-kind-mismatch' },
  )

  assert.deepEqual(
    decideOutboxLeaseRenew({
      itemId: '',
      kind: 'blob-put',
      ownerId: 'worker-1',
      now: 1_000,
      leaseDurationMs: 30_000,
      existingLease: undefined,
    }),
    { action: 'reject', reason: 'missing-lease' },
  )
})

test('outbox failure transition schedules retries atomically', () => {
  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'network' },
      now: 1_000,
    }),
    {
      status: 'retrying',
      retryCount: 1,
      nextAttemptAt: 1_250,
      lastError: { kind: 'network' },
    },
  )

  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'network' },
      now: 1_000,
      retryJitterMs: 100,
    }),
    {
      status: 'retrying',
      retryCount: 1,
      nextAttemptAt: 1_300,
      lastError: { kind: 'network' },
    },
  )

  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'api', retryable: true, retryAfterMs: 2_000 },
      now: 1_000,
    }),
    {
      status: 'retrying',
      retryCount: 2,
      nextAttemptAt: 6_000,
      lastError: { kind: 'api', retryable: true, retryAfterMs: 2_000 },
    },
  )
})

test('outbox failure transition pauses or fails without changing retry count', () => {
  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'metadata-migration-required' },
      now: 1_000,
    }),
    {
      status: 'paused',
      retryCount: 0,
      nextAttemptAt: undefined,
      lastError: { kind: 'metadata-migration-required' },
      reason: 'metadata-schema-v2-migration-required',
      resumeOn: 'manual',
    },
  )

  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'materialize',
      retryCount: 3,
      error: { kind: 'timeout' },
      now: 1_000,
    }),
    {
      status: 'paused',
      retryCount: 3,
      nextAttemptAt: undefined,
      lastError: { kind: 'timeout' },
      reason: 'manual-intervention-required',
      resumeOn: 'manual',
    },
  )

  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'blob-put',
      retryCount: 1,
      error: { kind: 'api', retryable: false, code: 'blob/hash-mismatch' },
      now: 1_000,
    }),
    {
      status: 'failed',
      retryCount: 1,
      nextAttemptAt: undefined,
      lastError: { kind: 'api', retryable: false, code: 'blob/hash-mismatch' },
      reason: 'dead-letter',
      deadLetterReason: 'non-retryable-api-error',
    },
  )
})

test('outbox failure transition pauses on invalid clocks', () => {
  assert.deepEqual(
    transitionOutboxFailure({
      kind: 'y-update',
      retryCount: 0,
      error: { kind: 'network' },
      now: -1,
    }),
    {
      status: 'paused',
      retryCount: 0,
      nextAttemptAt: undefined,
      lastError: { kind: 'network' },
      reason: 'manual-intervention-required',
      resumeOn: 'manual',
    },
  )
})

test('outbox concurrency limits blob transfers by runtime profile', () => {
  assert.equal(outboxConcurrencyLane('blob-put'), 'blob-transfer')
  assert.equal(outboxConcurrencyLane('blob-get'), 'blob-transfer')
  assert.equal(outboxConcurrencyLane('manifest-put'), 'blob-transfer')
  assert.equal(outboxConcurrencyLimit('blob-put', 'desktop'), 4)
  assert.equal(outboxConcurrencyLimit('blob-put', 'mobile'), 2)

  assert.deepEqual(
    decideOutboxConcurrency({
      kind: 'blob-put',
      profile: 'desktop',
      runningInLane: 3,
    }),
    { action: 'start', lane: 'blob-transfer', limit: 4 },
  )

  assert.deepEqual(
    decideOutboxConcurrency({
      kind: 'blob-put',
      profile: 'mobile',
      runningInLane: 2,
    }),
    {
      action: 'wait',
      reason: 'concurrency-limit-reached',
      lane: 'blob-transfer',
      limit: 2,
    },
  )
})

test('outbox concurrency serializes sync control and materialize lanes', () => {
  assert.equal(outboxConcurrencyLane('y-update'), 'sync-control')
  assert.equal(outboxConcurrencyLane('meta-ref-update'), 'sync-control')
  assert.equal(outboxConcurrencyLane('materialize'), 'materialize')
  assert.equal(outboxConcurrencyLimit('y-update', 'desktop'), 1)
  assert.equal(outboxConcurrencyLimit('materialize', 'mobile'), 1)

  assert.deepEqual(
    decideOutboxConcurrency({
      kind: 'meta-ref-update',
      profile: 'desktop',
      runningInLane: 1,
    }),
    {
      action: 'wait',
      reason: 'concurrency-limit-reached',
      lane: 'sync-control',
      limit: 1,
    },
  )

  assert.deepEqual(
    decideOutboxConcurrency({
      kind: 'materialize',
      profile: 'mobile',
      runningInLane: 0,
    }),
    { action: 'start', lane: 'materialize', limit: 1 },
  )
})

test('outbox concurrency rejects invalid running counts', () => {
  assert.deepEqual(
    decideOutboxConcurrency({
      kind: 'blob-get',
      profile: 'desktop',
      runningInLane: -1,
    }),
    {
      action: 'wait',
      reason: 'invalid-running-count',
      lane: 'blob-transfer',
      limit: 4,
    },
  )
})

function outboxId(value: string) {
  const id = makeOutboxPlanItemId(value)
  if (id === null) {
    throw new Error(`invalid outbox item ID: ${value}`)
  }
  return id
}

function schedulerItem(
  id: ReturnType<typeof outboxId>,
  kind: Parameters<typeof planOutboxSchedulerTick>[0]['items'][number]['kind'],
  status: Parameters<typeof planOutboxSchedulerTick>[0]['items'][number]['status'],
  dependsOn: readonly ReturnType<typeof outboxId>[],
  nextAttemptAt: number | undefined,
  resumeOn?: Parameters<typeof planOutboxSchedulerTick>[0]['items'][number]['resumeOn'],
) {
  return { id, kind, status, dependsOn, nextAttemptAt, resumeOn }
}

function lease(
  itemId: ReturnType<typeof outboxId>,
  kind: Parameters<typeof planOutboxSchedulerTick>[0]['leases'][number]['kind'],
  ownerId: string,
  leaseExpiresAt: number,
) {
  return { itemId, kind, ownerId, leaseExpiresAt }
}

function authRefreshBlock(
  id: ReturnType<typeof outboxId>,
  kind: Parameters<typeof planOutboxSchedulerTick>[0]['items'][number]['kind'],
  reason: NonNullable<
    Extract<ReturnType<typeof planOutboxSchedulerTick>, { readonly ok: true }>['authRefreshBlocks']
  >[number]['reason'],
  remainingMs: number,
  requiredRemainingMs: number,
) {
  return {
    id,
    kind,
    lane: outboxConcurrencyLane(kind),
    reason,
    remainingMs,
    requiredRemainingMs,
  }
}
