import {
  SnapshotHealthMutationResponseSchema,
  SnapshotHealthVerifyRequestSchema,
  makeSha256Hex,
  type DocId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import {
  getLatestSnapshotHealthEvent,
  getSnapshotRetentionCheckpointRuns,
  insertCheckpointRun,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
} from '../../db/checkpointRepo'
import { insertDoc } from '../../db/docRepo'
import {
  getDb,
  readSnapshotPointer,
  readSyncRequestDocState,
  withSqlTransaction,
} from '../../runtime/storage'
import { rehydrateAfterDocPointer, withDocWriteQueue } from '../../runtime/sync'
import { apiErrorBody, docKey } from '../../runtime/utils'
import type { VaultRoom } from '../../runtime/vault-room'
import {
  SNAPSHOT_HEALTH_SYSTEM_ACTORS,
  type SnapshotVerificationExpectedEvidence,
  verifySnapshotObject,
} from '../../sync/snapshot-health'
import type { SnapshotCandidate } from '../../sync/snapshots'
import { admitSnapshotHealthMutation } from './snapshot-health-mutations'
import {
  getLatestSnapshotHealthEventForEntry,
  readSnapshotHealthActionContext,
  snapshotExpectedEvidenceFromEvent,
  snapshotHealthEntryFromRow,
  snapshotHealthRouteDocMatches,
} from './snapshot-health-query'

type SnapshotHealthEventRow = import('../../db/checkpointRepo').SnapshotHealthEventRow

/** Explicitly verifies and approves one legacy or unverified snapshot. */
export async function handleSnapshotHealthVerify(room: VaultRoom, c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotHealthVerifyRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-verify-request'), 400)
  }
  if (!snapshotHealthRouteDocMatches(c.req.param('docId'), body.docId)) {
    return c.json(apiErrorBody('request/invalid', 'snapshot-health-doc-mismatch'), 400)
  }
  const admission = await admitSnapshotHealthMutation(
    room,
    c,
    body.docId,
    body.snapshotKey,
    body.upperSeq,
  )
  if (admission.response !== undefined) return admission.response
  const { db, bucket, candidate, actor } = admission
  const persisted = await readSyncRequestDocState(room, body.docId)
  const recoverMissingDoc = persisted === undefined
  if (
    !recoverMissingDoc &&
    (candidate.upperSeq < persisted.minRetainedSeq || candidate.upperSeq > persisted.latestSeq)
  ) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-approval-out-of-range'), 409)
  }
  const pointer = await readSnapshotPointer(room, body.docId)
  const pointerMatches =
    pointer?.latestSnapshotSeq === candidate.upperSeq && pointer.latestSnapshotKey === candidate.key
  const matchingRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
    (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
  )
  const initialRunState = snapshotHealthRunState(matchingRuns)
  const hasCompletedRun = matchingRuns.some(
    (run) =>
      run.status === 'pointer-updated' || run.status === 'compacted' || run.status === 'completed',
  )
  if (!recoverMissingDoc && !pointerMatches && !hasCompletedRun) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  const existingLatest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
  if (
    existingLatest?.authorityStatus === 'authoritative' &&
    existingLatest.physicalStatus === 'verified' &&
    existingLatest.logicalStatus === 'healthy'
  ) {
    const hasRunEvidence = matchingRuns.some(
      (run) => run.status !== 'failed' && run.stateVector !== null,
    )
    if (!recoverMissingDoc && !hasRunEvidence) {
      const runBackfilled = await backfillSnapshotHealthCheckpointRun(
        room,
        db,
        body.docId,
        candidate,
        existingLatest,
        pointerMatches ? pointer?.stateVector : undefined,
      )
      if (!runBackfilled) {
        // Do not manufacture checkpoint evidence from an authority row alone;
        // continue through the full R2 verification path below.
      } else {
        const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
        const response = {
          ok: true as const,
          entry: snapshotHealthEntryFromRow(existingLatest, actionContext),
        }
        if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
          return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
        }
        return c.json(response, 200)
      }
    } else if (!recoverMissingDoc) {
      const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
      const response = {
        ok: true as const,
        entry: snapshotHealthEntryFromRow(existingLatest, actionContext),
      }
      if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
        return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
      }
      return c.json(response, 200)
    }
  }
  let pendingEventId: number | undefined
  let pendingExpected: SnapshotVerificationExpectedEvidence | undefined
  let pendingRejectedByQuarantine = false
  let pendingRejectedByAuthority = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const commitPersisted = await readSyncRequestDocState(room, body.docId)
      const commitRecovery = commitPersisted === undefined
      if (recoverMissingDoc !== commitRecovery) {
        pendingRejectedByAuthority = true
        return
      }
      if (
        !commitRecovery &&
        (candidate.upperSeq < commitPersisted.minRetainedSeq ||
          candidate.upperSeq > commitPersisted.latestSeq ||
          commitPersisted.latestSeq !== persisted?.latestSeq ||
          commitPersisted.minRetainedSeq !== persisted?.minRetainedSeq)
      ) {
        pendingRejectedByAuthority = true
        return
      }
      const commitPointer = await readSnapshotPointer(room, body.docId)
      if (
        pointer?.latestSnapshotSeq !== commitPointer?.latestSnapshotSeq ||
        pointer?.latestSnapshotKey !== commitPointer?.latestSnapshotKey
      ) {
        pendingRejectedByAuthority = true
        return
      }
      const commitRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (snapshotHealthRunState(commitRuns) !== initialRunState) {
        pendingRejectedByAuthority = true
        return
      }
      const commitPointerMatches =
        commitPointer?.latestSnapshotSeq === candidate.upperSeq &&
        commitPointer.latestSnapshotKey === candidate.key
      const commitHasCompletedRun = commitRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (commitRuns.length > 0 && !commitHasCompletedRun && !commitPointerMatches) {
        pendingRejectedByAuthority = true
        return
      }
      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (latest?.logicalStatus === 'quarantined') {
        pendingRejectedByQuarantine = true
        return
      }
      pendingExpected = snapshotExpectedEvidenceFromEvent(latest)
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'verification',
        actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
        authorityStatus: 'candidate',
        expectedByteLength: latest?.expectedByteLength ?? null,
        expectedUpdateSha256: latest?.expectedUpdateSha256 ?? null,
        expectedStateVectorSha256: latest?.expectedStateVectorSha256 ?? null,
        physicalStatus: 'unverified',
        logicalStatus: 'healthy',
        reasons: ['verification-pending'],
        observedAt: Date.now(),
      })
      const pending = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (pending === undefined) throw new Error('snapshot-health-pending-event-missing')
      pendingEventId = pending.id
    })
  })
  if (pendingRejectedByQuarantine) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-quarantined'), 409)
  }
  if (pendingRejectedByAuthority || pendingEventId === undefined) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  const verificationRunId = `checkpoint:verify:${pendingEventId}`

  const verification = await verifySnapshotObject(
    bucket,
    candidate.key,
    body.docId,
    pendingExpected,
  )
  const verifiedStateVector = verification.stateVector
  const expected: SnapshotVerificationExpectedEvidence | undefined =
    verification.stateVector === undefined || verification.actualStateVectorSha256 === undefined
      ? undefined
      : {
          byteLength: verification.actualByteLength,
          updateSha256: verification.actualUpdateSha256,
          stateVectorSha256: verification.actualStateVectorSha256,
        }
  let approvalRejectedByQuarantine = false
  let approvalRejectedByAuthority = false
  let approvalRecorded = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const commitPersisted = await readSyncRequestDocState(room, body.docId)
      const commitRecovery = commitPersisted === undefined
      if (recoverMissingDoc !== commitRecovery) {
        approvalRejectedByAuthority = true
        return
      }
      if (
        !commitRecovery &&
        (candidate.upperSeq < commitPersisted.minRetainedSeq ||
          candidate.upperSeq > commitPersisted.latestSeq ||
          commitPersisted.latestSeq !== persisted?.latestSeq ||
          commitPersisted.minRetainedSeq !== persisted?.minRetainedSeq)
      ) {
        approvalRejectedByAuthority = true
        return
      }
      const commitPointer = await readSnapshotPointer(room, body.docId)
      const commitPointerMatches =
        commitPointer?.latestSnapshotSeq === candidate.upperSeq &&
        commitPointer.latestSnapshotKey === candidate.key
      if (
        pointer?.latestSnapshotSeq !== commitPointer?.latestSnapshotSeq ||
        pointer?.latestSnapshotKey !== commitPointer?.latestSnapshotKey
      ) {
        approvalRejectedByAuthority = true
        return
      }
      const commitRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (snapshotHealthRunState(commitRuns) !== initialRunState) {
        approvalRejectedByAuthority = true
        return
      }
      const commitHasCompletedRun = commitRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (commitRuns.length > 0 && !commitHasCompletedRun && !commitPointerMatches) {
        approvalRejectedByAuthority = true
        return
      }
      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (latest === undefined) {
        approvalRejectedByAuthority = true
        return
      }
      if (latest.logicalStatus === 'quarantined') {
        approvalRejectedByQuarantine = true
        return
      }
      if (latest.id !== pendingEventId) {
        approvalRejectedByAuthority = true
        return
      }
      if (verification.status !== 'unverified' && verification.status !== 'verified') {
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          event: 'verification',
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
          authorityStatus: 'candidate',
          expectedByteLength: latest.expectedByteLength,
          expectedUpdateSha256: latest.expectedUpdateSha256,
          expectedStateVectorSha256: latest.expectedStateVectorSha256,
          actualByteLength: verification.actualByteLength,
          actualUpdateSha256: verification.actualUpdateSha256 || null,
          actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
          physicalStatus: verification.status,
          logicalStatus: 'healthy',
          reasons: verification.reasons,
          observedAt: Date.now(),
        })
        return
      }
      if (expected === undefined || verifiedStateVector === undefined) {
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          event: 'verification',
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
          authorityStatus: 'candidate',
          expectedByteLength: latest.expectedByteLength,
          expectedUpdateSha256: latest.expectedUpdateSha256,
          expectedStateVectorSha256: latest.expectedStateVectorSha256,
          actualByteLength: verification.actualByteLength,
          actualUpdateSha256: verification.actualUpdateSha256 || null,
          actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
          physicalStatus: verification.status,
          logicalStatus: 'healthy',
          reasons: verification.reasons,
          observedAt: Date.now(),
        })
        return
      }
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId: body.docId,
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          actor,
          expectedByteLength: expected.byteLength,
          expectedUpdateSha256: makeSha256Hex(expected.updateSha256),
          expectedStateVectorSha256: makeSha256Hex(expected.stateVectorSha256),
        },
        Date.now(),
      )
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'approval',
        actor,
        authorityStatus: 'authoritative',
        expectedByteLength: expected.byteLength,
        expectedUpdateSha256: expected.updateSha256,
        expectedStateVectorSha256: expected.stateVectorSha256,
        actualByteLength: expected.byteLength,
        actualUpdateSha256: expected.updateSha256,
        actualStateVectorSha256: expected.stateVectorSha256,
        physicalStatus: 'verified',
        logicalStatus: 'healthy',
        reasons: [body.reason],
        observedAt: Date.now(),
      })
      if (
        !commitRuns.some(
          (run) =>
            run.snapshotKey === candidate.key &&
            run.upperSeq === candidate.upperSeq &&
            run.status !== 'failed',
        )
      ) {
        await insertCheckpointRun(
          db,
          verificationRunId,
          docKey(body.docId),
          candidate.upperSeq,
          candidate.key,
          verifiedStateVector,
          'completed',
          Date.now(),
        )
      }
      if (commitRecovery) {
        await insertDoc(
          db,
          docKey(body.docId),
          body.docId.kind,
          candidate.upperSeq,
          candidate.upperSeq,
          candidate.key,
          verifiedStateVector,
          0,
          Date.now(),
        )
      }
      approvalRecorded = true
    })
  })
  if (approvalRejectedByQuarantine) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-quarantined'), 409)
  }
  if (approvalRejectedByAuthority) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  if (!approvalRecorded) {
    return c.json(
      apiErrorBody(
        'request/conflict',
        `snapshot-health-verification-failed:${verification.reasons.join(',')}`,
      ),
      409,
    )
  }
  if (recoverMissingDoc) {
    try {
      await rehydrateAfterDocPointer(room, body.docId)
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-health-recovery-failed'), 500)
    }
  }
  const row = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
  const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
  const response = { ok: true as const, entry: snapshotHealthEntryFromRow(row, actionContext) }
  if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

/** Logically quarantines one generation while preserving it for inspection. */
async function backfillSnapshotHealthCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  candidate: SnapshotCandidate,
  existing: SnapshotHealthEventRow,
  pointerStateVector: Uint8Array | undefined,
): Promise<boolean> {
  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined) return false
  const verification = await verifySnapshotObject(
    bucket,
    candidate.key,
    docId,
    snapshotExpectedEvidenceFromEvent(existing),
  )
  if (
    verification.status !== 'verified' ||
    verification.stateVector === undefined ||
    (pointerStateVector !== undefined && !sameBytes(pointerStateVector, verification.stateVector))
  ) {
    return false
  }
  const verifiedStateVector = verification.stateVector

  let committed = false
  await withDocWriteQueue(room, docId, async () => {
    await withSqlTransaction(room, async () => {
      const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
      if (
        latest === undefined ||
        latest.id !== existing.id ||
        latest.authorityStatus !== 'authoritative' ||
        latest.physicalStatus !== 'verified' ||
        latest.logicalStatus !== 'healthy'
      ) {
        return
      }
      const runs = (await getSnapshotRetentionCheckpointRuns(db, docKey(docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (runs.some((run) => run.status !== 'failed' && run.stateVector !== null)) {
        committed = true
        return
      }
      await insertCheckpointRun(
        db,
        `checkpoint:verify:${existing.id}`,
        docKey(docId),
        candidate.upperSeq,
        candidate.key,
        verifiedStateVector,
        'completed',
        Date.now(),
      )
      committed = true
    })
  })
  return committed
}

function snapshotHealthRunState(
  runs: readonly {
    readonly status: string
    readonly upperSeq: number
    readonly snapshotKey: string | null
  }[],
): string {
  return runs
    .map((run) => `${run.status}:${run.upperSeq}:${run.snapshotKey ?? ''}`)
    .sort()
    .join('|')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}
