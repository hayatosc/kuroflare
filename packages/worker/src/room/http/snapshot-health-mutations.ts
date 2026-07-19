import {
  DeviceIdSchema,
  SnapshotHealthMutationResponseSchema,
  SnapshotHealthQuarantineRequestSchema,
  SnapshotRollbackRequestSchema,
  SnapshotRollbackResponseSchema,
  hashBytesSha256,
  makeSha256Hex,
  type DocId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  getLatestSnapshotHealthEvent,
  getSnapshotRetentionCheckpointRuns,
  insertCheckpointRun,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
  updateCheckpointFailed,
  updateCheckpointPointerUpdated,
  updateCheckpointR2Written,
} from '../../db/checkpointRepo'
import { updateDocSnapshotPointer } from '../../db/docRepo'
import { getOpLogUpdatesBetween } from '../../db/docRepo'
import { readSqlUpdateBytes } from '../../db/helpers'
import { authorizeHttpRequestWithClaims } from '../../runtime/auth'
import {
  appendSnapshotVerificationEventPreservingLogical,
  rehydrateAfterDocPointer,
} from '../../runtime/documents'
import type { VaultRoom } from '../../runtime/room'
import {
  getDb,
  ensureSchema,
  readDocClock,
  readSnapshotPointer,
  readSyncRequestDocState,
  withSqlTransaction,
} from '../../runtime/storage'
import { withDocWriteQueue } from '../../runtime/sync'
import {
  apiErrorBody,
  docKey,
  logEvent,
  retentionErrorMessage,
  sha256Text,
} from '../../runtime/utils'
import { verifySnapshotObject } from '../../sync/snapshot-health'
import {
  makeSnapshotListPrefix,
  makeSnapshotObjectKey,
  type SnapshotCandidate,
} from '../../sync/snapshots'
import { metaIdentityImmutable, metaYDocWritable } from '../../sync/yjs'
import {
  getLatestSnapshotHealthEventForEntry,
  readSnapshotHealthActionContext,
  snapshotCandidateFromKeyForHealth,
  snapshotExpectedEvidenceFromEvent,
  snapshotHealthAllowedActions,
  snapshotHealthEntryFromRow,
  snapshotHealthRouteDocMatches,
} from './snapshot-health-query'

/** Logically quarantines one generation while preserving it for inspection. */
export async function handleSnapshotHealthQuarantine(
  room: VaultRoom,
  c: Context,
): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotHealthQuarantineRequestSchema, body)) {
    return c.json(
      apiErrorBody('request/invalid', 'invalid-snapshot-health-quarantine-request'),
      400,
    )
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
  const { db, candidate, actor } = admission
  let quarantineBlocked = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const latest = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
      if (latest.logicalStatus === 'quarantined') {
        return
      }
      const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
      if (
        !snapshotHealthAllowedActions(latest, actionContext).allowedActions.includes('quarantine')
      ) {
        quarantineBlocked = true
        return
      }
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'quarantine',
        actor,
        authorityStatus: latest.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
        expectedByteLength: latest.expectedByteLength ?? null,
        expectedUpdateSha256: latest.expectedUpdateSha256 ?? null,
        expectedStateVectorSha256: latest.expectedStateVectorSha256 ?? null,
        actualByteLength: latest.actualByteLength ?? null,
        actualUpdateSha256: latest.actualUpdateSha256 ?? null,
        actualStateVectorSha256: latest.actualStateVectorSha256 ?? null,
        physicalStatus: latest.physicalStatus,
        logicalStatus: 'quarantined',
        reasons: [body.reason],
        observedAt: Date.now(),
      })
    })
  })
  if (quarantineBlocked) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-quarantine-would-break-floor'),
      409,
    )
  }
  const row = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
  const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
  const response = { ok: true as const, entry: snapshotHealthEntryFromRow(row, actionContext) }
  if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

/** Creates a new authoritative generation from a verified older snapshot. */
/** Creates a new authoritative generation from a verified older snapshot. */
export async function handleSnapshotRollback(room: VaultRoom, c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotRollbackRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-rollback-request'), 400)
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
  return await withDocWriteQueue(room, body.docId, async () => {
    let runId: string | undefined
    let rollbackDoc: Y.Doc | undefined
    let snapshotKey: string | undefined
    try {
      const clock = await readDocClock(room, body.docId)
      const persisted = await readSyncRequestDocState(room, body.docId)
      const currentLatestSeq = clock?.latestSeq
      if (
        currentLatestSeq === undefined ||
        !Number.isSafeInteger(currentLatestSeq) ||
        currentLatestSeq < candidate.upperSeq ||
        (persisted !== undefined && candidate.upperSeq < persisted.minRetainedSeq)
      ) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-stale-source'), 409)
      }

      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      const expected = snapshotExpectedEvidenceFromEvent(latest)
      if (
        latest?.authorityStatus !== 'authoritative' ||
        latest?.logicalStatus !== 'healthy' ||
        expected === undefined
      ) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-unhealthy-source'), 409)
      }
      const pointer = await readSnapshotPointer(room, body.docId)
      const pointerMatches =
        pointer?.latestSnapshotSeq === candidate.upperSeq &&
        pointer.latestSnapshotKey === candidate.key
      const matchingRuns = (
        await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))
      ).filter((run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq)
      const hasCompletedRun = matchingRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (matchingRuns.length > 0 && !hasCompletedRun && !pointerMatches) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-unhealthy-source'), 409)
      }
      const verification = await verifySnapshotObject(bucket, candidate.key, body.docId, expected)
      const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        body.docId,
        candidate,
        verification,
        expected,
      )
      const latestAfterVerification = await getLatestSnapshotHealthEvent(
        db,
        docKey(body.docId),
        candidate.key,
      )
      if (
        verification.status !== 'verified' ||
        verification.stateVector === undefined ||
        logicalStatus === 'quarantined' ||
        latestAfterVerification?.logicalStatus === 'quarantined'
      ) {
        return c.json(
          apiErrorBody(
            'request/conflict',
            `snapshot-rollback-unhealthy-source:${verification.reasons.join(',')}`,
          ),
          409,
        )
      }

      const source = await bucket.get(candidate.key)
      if (source === null)
        return c.json(apiErrorBody('snapshot/not-found', 'snapshot-rollback-source-missing'), 404)
      const sourceBytes = new Uint8Array(await source.arrayBuffer())
      rollbackDoc = new Y.Doc()
      Y.applyUpdate(rollbackDoc, sourceBytes)
      let expectedSeq = candidate.upperSeq + 1
      for (const row of await getOpLogUpdatesBetween(
        db,
        docKey(body.docId),
        candidate.upperSeq,
        currentLatestSeq,
      )) {
        if (row.seq !== expectedSeq) throw new Error('snapshot-rollback-op-log-gap')
        const updateBytes = readSqlUpdateBytes(row.updateBytes)
        if (updateBytes === undefined) throw new Error('snapshot-rollback-op-log-bytes-invalid')
        Y.applyUpdate(rollbackDoc, updateBytes)
        expectedSeq += 1
      }
      if (expectedSeq !== currentLatestSeq + 1) {
        throw new Error('snapshot-rollback-op-log-gap')
      }
      const currentRollbackDoc = room.docs.get(docKey(body.docId))
      if (
        body.docId.kind === 'meta' &&
        (!metaYDocWritable(rollbackDoc) ||
          (currentRollbackDoc !== undefined &&
            !metaIdentityImmutable(currentRollbackDoc, rollbackDoc)))
      ) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(
          apiErrorBody('request/conflict', 'snapshot-rollback-meta-schema-invalid'),
          409,
        )
      }

      const mergedBytes = Y.encodeStateAsUpdate(rollbackDoc)
      const rollbackStateVector = Y.encodeStateVector(rollbackDoc)
      const snapshotSeq = currentLatestSeq + 1
      const vaultId = room.vaultId
      if (vaultId === undefined) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)
      }
      snapshotKey = makeSnapshotObjectKey(vaultId, body.docId, snapshotSeq)
      if ((await bucket.head(snapshotKey)) !== null) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-target-exists'), 409)
      }
      const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(mergedBytes))
      const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(rollbackStateVector))
      const now = Date.now()
      runId = `checkpoint:rollback:${snapshotKey}:${now}`
      const auditId = `rollback:${await sha256Text(`${snapshotKey}:${now}:${actor}`)}`
      const response = {
        ok: true,
        docId: body.docId,
        actor,
        snapshotKey,
        snapshotSeq,
        sourceSnapshotKey: candidate.key,
        sourceSnapshotSeq: candidate.upperSeq,
        auditId,
      } as const
      if (!v.is(SnapshotRollbackResponseSchema, response)) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('server/error', 'invalid-snapshot-rollback-response'), 500)
      }
      await insertCheckpointRun(
        db,
        runId,
        docKey(body.docId),
        snapshotSeq,
        snapshotKey,
        rollbackStateVector,
        'writing',
        now,
      )
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId: body.docId,
          snapshotKey,
          upperSeq: snapshotSeq,
          actor,
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
        },
        now,
      )
      await bucket.put(snapshotKey, mergedBytes)
      const written = await verifySnapshotObject(bucket, snapshotKey, body.docId, {
        byteLength: mergedBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
      const writtenLogicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        body.docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        written,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
      )
      if (written.status !== 'verified' || writtenLogicalStatus === 'quarantined') {
        await updateCheckpointFailed(db, runId)
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(
          apiErrorBody('request/conflict', 'snapshot-rollback-verification-failed'),
          409,
        )
      }
      await updateCheckpointR2Written(db, runId, now)
      let sourceInvalidated = false
      let targetInvalidated = false
      await withSqlTransaction(room, async () => {
        if (snapshotKey === undefined) throw new Error('unreachable: snapshotKey must be assigned')
        if (runId === undefined) throw new Error('unreachable: runId must be assigned')
        const latestSource = await getLatestSnapshotHealthEvent(
          db,
          docKey(body.docId),
          candidate.key,
        )
        const latestTarget = await getLatestSnapshotHealthEvent(db, docKey(body.docId), snapshotKey)
        sourceInvalidated =
          latestSource?.authorityStatus !== 'authoritative' ||
          latestSource.physicalStatus !== 'verified' ||
          latestSource.logicalStatus !== 'healthy'
        targetInvalidated =
          latestTarget?.logicalStatus !== 'healthy' ||
          latestTarget?.physicalStatus !== 'verified' ||
          (latestTarget?.authorityStatus !== 'candidate' &&
            latestTarget?.authorityStatus !== 'authoritative')
        if (sourceInvalidated || targetInvalidated) return
        await updateDocSnapshotPointer(
          db,
          snapshotSeq,
          snapshotKey,
          rollbackStateVector,
          now,
          docKey(body.docId),
          snapshotSeq,
        )
        await updateCheckpointPointerUpdated(db, runId, now)
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey,
          upperSeq: snapshotSeq,
          event: 'rollback',
          actor,
          authorityStatus: 'authoritative',
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
          actualByteLength: written.actualByteLength,
          actualUpdateSha256: written.actualUpdateSha256 || null,
          actualStateVectorSha256: written.actualStateVectorSha256 ?? null,
          physicalStatus: written.status,
          logicalStatus: 'healthy',
          reasons: [body.reason, `source:${candidate.key}`],
          observedAt: now,
        })
      })
      if (sourceInvalidated || targetInvalidated) {
        await updateCheckpointFailed(db, runId)
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-source-changed'), 409)
      }
      rollbackDoc.destroy()
      rollbackDoc = undefined
      await rehydrateAfterDocPointer(room, body.docId)
      return c.json(response, 200)
    } catch (error) {
      rollbackDoc?.destroy()
      if (runId !== undefined) await updateCheckpointFailed(db, runId).catch(() => undefined)
      logEvent('snapshot-rollback-failed', {
        vaultId: room.vaultId,
        docId: body.docId,
        snapshotKey,
        error: retentionErrorMessage(error),
      })
      return c.json(apiErrorBody('server/error', 'snapshot-rollback-failed'), 500)
    }
  })
}

/** Authenticates and validates a snapshot-health mutation target. */
export async function admitSnapshotHealthMutation(
  room: VaultRoom,
  c: Context,
  docId: DocId,
  snapshotKey: string,
  upperSeq: number,
): Promise<
  | {
      readonly response: Response
      readonly db?: undefined
      readonly bucket?: undefined
      readonly candidate?: undefined
    }
  | {
      readonly response?: undefined
      readonly db: NonNullable<ReturnType<typeof getDb>>
      readonly bucket: NonNullable<VaultRoom['env']['SNAPSHOT_BUCKET']>
      readonly candidate: SnapshotCandidate
      readonly actor: string
    }
> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || bucket === undefined || secret === undefined) {
    return {
      response: c.json(
        apiErrorBody('server/degraded', 'snapshot-health-mutation-unavailable'),
        503,
      ),
    }
  }
  await ensureSchema(room)
  const authorization = await authorizeHttpRequestWithClaims(room, c, ['sync:write'])
  if (authorization.action === 'reject') return { response: authorization.response }
  const actor = authorization.claims.sub
  if (!v.is(DeviceIdSchema, actor)) {
    return { response: c.json(apiErrorBody('auth/rejected', 'auth-reject:missing-actor'), 403) }
  }
  const vaultId = room.vaultId
  if (vaultId === undefined)
    return { response: c.json(apiErrorBody('server/error', 'vault-unavailable'), 500) }
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const candidate = snapshotCandidateFromKeyForHealth(prefix, snapshotKey)
  if (candidate === undefined || candidate.upperSeq !== upperSeq) {
    return {
      response: c.json(apiErrorBody('request/invalid', 'snapshot-health-target-mismatch'), 400),
    }
  }
  return { db, bucket, candidate, actor }
}
