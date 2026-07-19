import {
  hashBytesSha256,
  makeSha256Hex,
  SnapshotImportRequestSchema,
  YDocIdSchema,
  type DocId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  getLatestSnapshotHealthEvent,
  insertCheckpointRun,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
  updateCheckpointFailed,
  updateCheckpointPointerUpdated,
  updateCheckpointR2Written,
} from '../../db/checkpointRepo'
import { insertDoc } from '../../db/docRepo'
import { authorizeHttpRequest } from '../../runtime/auth'
import {
  getDb,
  ensureSchema,
  readDocClock,
  readSnapshotPointer,
  withSqlTransaction,
} from '../../runtime/storage'
import {
  admitDocLoad,
  appendSnapshotVerificationEventPreservingLogical,
  ensureDocHydrated,
  withDocWriteQueue,
} from '../../runtime/sync'
import { AdminSnapshotSeedRequestSchema } from '../../runtime/types'
import {
  apiErrorBody,
  decodeBase64,
  docKey,
  encodeBase64,
  logEvent,
  retentionErrorMessage,
  sha256Hex,
} from '../../runtime/utils'
import type { VaultRoom } from '../../runtime/vault-room'
import {
  canApplyYjsUpdate,
  canApplyYjsUpdateToDoc,
  metaIdentityImmutable,
  metaRootMutationAllowed,
  metaYDocSchemaDisposition,
  metaYDocWritable,
} from '../../runtime/yjs-validation'
import { SNAPSHOT_HEALTH_SYSTEM_ACTORS, verifySnapshotObject } from '../../sync/snapshot-health'
import { makeSnapshotObjectKey } from '../../sync/snapshots'

export async function handleAdminSnapshotSeed(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'admin-snapshot-seed-unavailable'), 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(AdminSnapshotSeedRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-snapshot-seed-request'), 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  room.vaultId = body.vaultId

  const update = decodeBase64(body.update)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-snapshot-seed-update'), 400)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  const stateVector = Y.encodeStateVector(doc)
  doc.destroy()

  const now = Date.now()
  const latestSeq = body.latestSeq ?? 1
  const snapshotKey = makeSnapshotObjectKey(body.vaultId, body.docId, latestSeq)
  const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(update))
  const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))
  await insertSnapshotExpectedEvidence(
    db,
    {
      docId: body.docId,
      snapshotKey,
      upperSeq: latestSeq,
      actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.import,
      expectedByteLength: update.byteLength,
      expectedUpdateSha256,
      expectedStateVectorSha256,
    },
    now,
  )
  await bucket.put(snapshotKey, update)
  await insertSnapshotHealthEvent(db, {
    docId: docKey(body.docId),
    snapshotKey,
    upperSeq: latestSeq,
    event: 'verification',
    actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
    authorityStatus: 'authoritative',
    expectedByteLength: update.byteLength,
    expectedUpdateSha256,
    expectedStateVectorSha256,
    actualByteLength: update.byteLength,
    actualUpdateSha256: expectedUpdateSha256,
    actualStateVectorSha256: expectedStateVectorSha256,
    physicalStatus: 'verified',
    logicalStatus: 'healthy',
    observedAt: now,
  })
  await insertDoc(
    db,
    docKey(body.docId),
    body.docId.kind,
    latestSeq,
    latestSeq,
    snapshotKey,
    stateVector,
    0,
    now,
  )

  return c.json({ ok: true, vaultId: body.vaultId, docId: body.docId, snapshotKey }, 200)
}

export async function handleMetaLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-fetch-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'meta' })
}

export async function handleFileLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-fetch-unavailable'), 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'file', ydocId: rawYDocId })
}

export async function handleMetaSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-import-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return handleSnapshotImportRequest(room, c, { kind: 'meta' })
}

export async function handleFileSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-import-unavailable'), 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return handleSnapshotImportRequest(room, c, { kind: 'file', ydocId: rawYDocId })
}

async function handleLatestSnapshotRequest(
  room: VaultRoom,
  c: Context,
  docId: DocId,
): Promise<Response> {
  const clock = await readDocClock(room, docId)
  if (clock === undefined) return c.json(apiErrorBody('snapshot/not-found', 'doc-not-found'), 404)

  if (admitDocLoad(room, docId).action === 'degraded') {
    return c.json(apiErrorBody('server/degraded', 'doc-load-degraded'), 503)
  }
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    logEvent('snapshot-hydrate-failed', {
      vaultId: room.vaultId,
      docId,
      error: retentionErrorMessage(error),
    })
    return c.json(apiErrorBody('server/error', 'snapshot-hydrate-failed'), 500)
  }

  const doc = room.docs.get(docKey(docId))
  const vaultId = room.vaultId
  if (doc === undefined || vaultId === undefined)
    return c.json(apiErrorBody('snapshot/not-found', 'doc-not-found'), 404)

  const updateBytes = Y.encodeStateAsUpdate(doc)
  const stateVectorBytes = Y.encodeStateVector(doc)
  const snapshotKey = makeSnapshotObjectKey(vaultId, docId, clock.latestSeq)
  const body = {
    manifestSeq: clock.latestSeq,
    snapshotKey,
    snapshotSeq: clock.latestSeq,
    updateSha256: makeSha256Hex(await sha256Hex(updateBytes)),
    stateVectorSha256: makeSha256Hex(await sha256Hex(stateVectorBytes)),
    stateVector: encodeBase64(stateVectorBytes),
    updateBytesBase64: encodeBase64(updateBytes),
  }
  return c.json(docId.kind === 'meta' ? body : { ...body, docId }, 200)
}

async function handleSnapshotImportRequest(
  room: VaultRoom,
  c: Context,
  docId: DocId,
): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (db === undefined || bucket === undefined || vaultId === undefined)
    return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotImportRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-request'), 400)
  if (docId.kind === 'meta' && body.metadataSchemaVersion !== 2) {
    return c.json(apiErrorBody('request/invalid', 'metadata-schema-v2-evidence-required'), 400)
  }

  const update = decodeBase64(body.updateBytesBase64)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-update'), 400)

  return await withDocWriteQueue(room, docId, async () => {
    let existingLatestSeq: number
    try {
      existingLatestSeq = (await readDocClock(room, docId))?.latestSeq ?? 0
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-import-hydrate-failed'), 500)
    }
    if (existingLatestSeq > 0 && body.latestSeq === undefined) {
      return c.json(
        {
          ...apiErrorBody('request/conflict', 'snapshot-import-latest-seq-required'),
          latestSeq: existingLatestSeq,
        },
        409,
      )
    }
    if (body.latestSeq !== undefined && body.latestSeq !== existingLatestSeq) {
      return c.json(
        {
          ...apiErrorBody('request/conflict', 'snapshot-import-stale-seq'),
          latestSeq: existingLatestSeq,
        },
        409,
      )
    }
    const initialSnapshotKey = makeSnapshotObjectKey(vaultId, docId, existingLatestSeq + 1)
    if ((await bucket.head(initialSnapshotKey)) !== null) {
      return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-exists'), 409)
    }
    if (admitDocLoad(room, docId).action === 'degraded') {
      return c.json(apiErrorBody('server/degraded', 'doc-load-degraded'), 503)
    }
    try {
      await ensureDocHydrated(room, docId)
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-import-hydrate-failed'), 500)
    }

    const key = docKey(docId)
    const importedDoc = new Y.Doc()
    const existingDoc = room.docs.get(key)
    if (
      docId.kind === 'meta' &&
      existingDoc !== undefined &&
      !['supported-v2', 'legacy-v1'].includes(metaYDocSchemaDisposition(existingDoc))
    ) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-meta-schema'), 400)
    }
    if (!canApplyYjsUpdateToDoc(existingDoc ?? importedDoc, update)) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-update'), 400)
    }
    if (existingDoc !== undefined) Y.applyUpdate(importedDoc, Y.encodeStateAsUpdate(existingDoc))
    Y.applyUpdate(importedDoc, update)
    if (
      docId.kind === 'meta' &&
      (!metaYDocWritable(importedDoc) ||
        (existingDoc !== undefined &&
          (!metaIdentityImmutable(existingDoc, importedDoc) ||
            !metaRootMutationAllowed(existingDoc, update, true))))
    ) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-meta-schema'), 400)
    }
    const mergedBytes = Y.encodeStateAsUpdate(importedDoc)
    const stateVector = Y.encodeStateVector(importedDoc)

    const now = Date.now()
    const snapshotSeq = existingLatestSeq + 1
    const snapshotKey = makeSnapshotObjectKey(vaultId, docId, snapshotSeq)
    if ((await bucket.head(snapshotKey)) !== null) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-exists'), 409)
    }
    const runId = `checkpoint:import:${snapshotKey}:${now}`
    let pointerPersisted = false
    try {
      await insertCheckpointRun(
        db,
        runId,
        key,
        snapshotSeq,
        snapshotKey,
        stateVector,
        'writing',
        now,
      )
      const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(mergedBytes))
      const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId,
          snapshotKey,
          upperSeq: snapshotSeq,
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.import,
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
        },
        now,
      )
      await bucket.put(snapshotKey, mergedBytes)
      const verification = await verifySnapshotObject(bucket, snapshotKey, docId, {
        byteLength: mergedBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
      const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        verification,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
      )
      if (verification.status !== 'verified' || logicalStatus === 'quarantined') {
        await updateCheckpointFailed(db, runId)
        throw new Error(`snapshot-verification-failed:${verification.reasons.join(',')}`)
      }
      await updateCheckpointR2Written(db, runId, now)
      let pointerInvalidated = false
      await withSqlTransaction(room, async () => {
        const latest = await getLatestSnapshotHealthEvent(db, key, snapshotKey)
        if (
          latest?.logicalStatus !== 'healthy' ||
          latest?.physicalStatus !== 'verified' ||
          latest.expectedByteLength !== mergedBytes.byteLength ||
          latest.expectedUpdateSha256 !== expectedUpdateSha256 ||
          latest.expectedStateVectorSha256 !== expectedStateVectorSha256
        ) {
          pointerInvalidated = true
          await updateCheckpointFailed(db, runId)
          return
        }
        await insertDoc(
          db,
          key,
          docId.kind,
          snapshotSeq,
          snapshotSeq,
          snapshotKey,
          stateVector,
          0,
          now,
        )
        pointerPersisted = true
      })
      if (pointerInvalidated) {
        importedDoc.destroy()
        return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-changed'), 409)
      }
      await updateCheckpointPointerUpdated(db, runId, now)
      await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        verification,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
        'authoritative',
      )
    } catch (error) {
      const pointerAdvanced =
        pointerPersisted ||
        (await snapshotPointerMatchesImport(room, docId, snapshotSeq, snapshotKey))
      if (pointerAdvanced) {
        await activateImportedDoc(room, docId, importedDoc)
      } else {
        importedDoc.destroy()
      }
      throw error
    }
    room.docs.set(key, importedDoc)
    room.hydratedDocs.add(key)

    return c.json({ ok: true, vaultId, docId, snapshotKey, snapshotSeq }, 200)
  })
}

async function snapshotPointerMatchesImport(
  room: VaultRoom,
  docId: DocId,
  snapshotSeq: number,
  snapshotKey: string,
): Promise<boolean> {
  try {
    const pointer = await readSnapshotPointer(room, docId)
    return pointer?.latestSnapshotSeq === snapshotSeq && pointer.latestSnapshotKey === snapshotKey
  } catch {
    return false
  }
}

async function activateImportedDoc(
  room: VaultRoom,
  docId: DocId,
  importedDoc: Y.Doc,
): Promise<void> {
  const key = docKey(docId)
  const inFlight = room.hydrationInFlight.get(key)
  if (inFlight !== undefined) {
    try {
      await inFlight
    } catch (error) {
      // The stale hydration is superseded by the durable imported snapshot.
      logEvent('snapshot-import-stale-hydration-failed', {
        vaultId: room.vaultId,
        docId,
        error: retentionErrorMessage(error),
      })
    }
  }
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  if (inFlight !== undefined && room.hydrationInFlight.get(key) === inFlight) {
    room.hydrationInFlight.delete(key)
  }
  current?.destroy()
  room.docs.set(key, importedDoc)
  room.hydratedDocs.add(key)
}

/** Lists paginated snapshot health generations for an authenticated operator. */
