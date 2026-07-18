import {
  CURRENT_PROTOCOL_VERSION,
  makeSha256Hex,
  type DeviceId,
  type DocId,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as Y from 'yjs'

import {
  deleteQuarantinedUpdate,
  getLatestSnapshotHealthEvent,
  getAllLatestSnapshotHealthEvents,
  getSnapshotRetentionCheckpointRuns,
  insertQuarantinedUpdate,
  insertQuarantineAuditEvent,
  insertSnapshotHealthEvent,
} from '../db/checkpointRepo'
import type { SnapshotHealthEventRow } from '../db/checkpointRepo'
import { getOpLogUpdatesBetween, getOpLogUpdatesSince } from '../db/docRepo'
import { insertOpLog, upsertDocClock, upsertMessageDedup } from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import type {
  QuarantinedUpdateDeletePatch,
  QuarantinedUpdateForceApplyDocPatch,
  QuarantinedUpdateForceApplyOpLogAppend,
  QuarantinedUpdateRecord,
} from '../quarantine'
import { decideSyncRequest, type SyncRequestDocState } from '../sync/request'
import {
  verifySnapshotObject,
  SNAPSHOT_HEALTH_SYSTEM_ACTORS,
  type SnapshotVerificationExpectedEvidence,
} from '../sync/snapshot-health'
import { makeSnapshotListPrefix, type SnapshotCandidate } from '../sync/snapshots'
import {
  decideSyncUpdateAppend,
  decideSyncUpdateQuarantine,
  makeSyncUpdateRejected,
} from '../sync/update'
import { readSession, messageMatchesSession } from './auth'
import {
  CHECKPOINT_OP_THRESHOLD,
  CHECKPOINT_ALARM_DELAY_MS,
  LARGE_UPDATE_THRESHOLD_BYTES,
  MAX_HYDRATED_FILE_DOCS,
} from './constants'
import { decideDocLoadAdmission, type DocLoadAdmissionDecision } from './eviction'
import {
  getDb,
  readDocClock,
  readDuplicate,
  readSyncRequestDocState,
  readSnapshotPointer,
  readSnapshotSeq,
  scheduleCheckpointAlarm,
  withSqlTransaction,
} from './storage'
import type {
  R2BucketBinding,
  R2ObjectBinding,
  RuntimeWebSocket,
  RuntimeDocClockRecord,
} from './types'
import {
  docKey,
  makeQuarantineId,
  snapshotCandidateFromKey,
  stateVectorCoversHorizon,
  canApplyYjsUpdateToDoc,
  isEmptyYjsUpdate,
  metaYDocSchemaDisposition,
  metaYDocWritable,
  metaIdentityImmutable,
  metaRootMutationAllowed,
  decodeBase64,
  encodeBase64,
  sha256Hex,
  logEvent,
  retentionErrorMessage,
} from './utils'
import type { VaultRoom } from './vault-room'

export async function handleSyncRequest(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  request: SyncRequest,
): Promise<void> {
  logEvent('debug-sync-request-received', { docId: request.docId, messageId: request.messageId })
  const session = readSession(room, webSocket)
  if (session === undefined) {
    logEvent('debug-sync-request-no-session', { docId: request.docId })
    webSocket.close(1008, 'hello-required')
    return
  }
  if (!messageMatchesSession(session, request)) {
    webSocket.close(1008, 'session-mismatch')
    return
  }
  if (room.state.storage.sql === undefined) {
    webSocket.close(1011, 'sync-storage-unavailable')
    return
  }

  const clientStateVector = decodeBase64(request.stateVector)
  if (clientStateVector === null) {
    webSocket.close(1003, 'invalid-state-vector')
    return
  }

  const persisted = await readSyncRequestDocState(room, request.docId)
  let docState: SyncRequestDocState | undefined
  if (persisted !== undefined) {
    if (admitDocLoad(room, request.docId).action === 'degraded') {
      webSocket.close(1011, 'doc-load-degraded')
      return
    }
    try {
      await ensureDocHydrated(room, request.docId)
    } catch {
      webSocket.close(1011, 'hydrate-failed')
      return
    }
    const doc = room.docs.get(docKey(request.docId))
    if (doc !== undefined) {
      const diffUpdate = Y.encodeStateAsUpdate(doc, clientStateVector)
      const diffIsEmpty = isEmptyYjsUpdate(diffUpdate)
      docState = {
        ...persisted,
        stateVectorCoversHorizon: stateVectorCoversHorizon(
          clientStateVector,
          persisted.horizonStateVector,
        ),
        diffSourceAvailable: true,
        diffUpdateBase64: diffIsEmpty ? undefined : encodeBase64(diffUpdate),
        diffUpdateSha256: diffIsEmpty ? undefined : makeSha256Hex(await sha256Hex(diffUpdate)),
      }
    }
  }

  const decision = decideSyncRequest({
    request,
    doc: docState,
    serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
  })
  logEvent('debug-sync-request-decision', {
    docId: request.docId,
    messageId: request.messageId,
    persisted,
    docState,
    action: decision.action,
  })

  if (decision.action === 'send-update') {
    webSocket.send(JSON.stringify(decision.response))
    return
  }
  if (decision.action === 'need-full-snapshot') {
    webSocket.send(JSON.stringify(decision.response))
    return
  }
  if (decision.action === 'reject') {
    webSocket.close(1011, `sync-request-reject:${decision.reason}`)
  }
}

export async function handleSyncUpdate(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  update: SyncUpdate,
): Promise<
  { readonly action: 'broadcast'; readonly durableSeq: number } | { readonly action: 'stop' }
> {
  const session = readSession(room, webSocket)
  if (session === undefined) {
    webSocket.close(1008, 'hello-required')
    return { action: 'stop' }
  }
  if (!messageMatchesSession(session, update)) {
    webSocket.close(1008, 'session-mismatch')
    return { action: 'stop' }
  }
  if (update.docId.kind === 'meta' && session.metadataAccess !== 'read-write') {
    if (session.metadataCapabilityAdvertised) {
      const candidate = decodeBase64(update.update)
      if (candidate !== null) {
        const updateSha256 = makeSha256Hex(await sha256Hex(candidate))
        webSocket.send(
          JSON.stringify(makeSyncUpdateRejected(update, updateSha256, 'metadata-read-only')),
        )
      }
    }
    webSocket.close(1008, 'metadata-read-only')
    return { action: 'stop' }
  }
  if (room.state.storage.sql === undefined) {
    webSocket.close(1011, 'sync-storage-unavailable')
    return { action: 'stop' }
  }

  const updateBytes = decodeBase64(update.update)
  if (updateBytes === null) {
    webSocket.close(1003, 'invalid-update-base64')
    return { action: 'stop' }
  }

  return await withDocWriteQueue(room, update.docId, async () => {
    return await handleSyncUpdateSerialized(room, webSocket, update, updateBytes)
  })
}

async function handleSyncUpdateSerialized(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  update: SyncUpdate,
  updateBytes: Uint8Array,
): Promise<
  { readonly action: 'broadcast'; readonly durableSeq: number } | { readonly action: 'stop' }
> {
  if (readSession(room, webSocket) === undefined) {
    webSocket.close(1008, 'hello-required')
    return { action: 'stop' }
  }

  const now = Date.now()
  const updateSha256 = makeSha256Hex(await sha256Hex(updateBytes))
  const doc = await readDocClock(room, update.docId)
  const duplicate = await readDuplicate(room, update.docId, update.messageId)
  if (duplicate !== undefined) {
    if (
      duplicate.updateSha256 !== updateSha256 ||
      (update.updateSha256 !== undefined && update.updateSha256 !== updateSha256)
    ) {
      logEvent('sync-duplicate-unsafe', {
        vaultId: room.vaultId,
        docId: update.docId,
        messageId: update.messageId,
        durableSeq: duplicate.durableSeq,
      })
      webSocket.close(1011, 'duplicate-unsafe')
      return { action: 'stop' }
    }
    if (admitDocLoad(room, update.docId).action === 'degraded') {
      webSocket.close(1011, 'doc-load-degraded')
      return { action: 'stop' }
    }
    try {
      await ensureDocHydrated(room, update.docId)
    } catch {
      webSocket.close(1011, 'hydrate-failed')
      return { action: 'stop' }
    }
    const hydratedKey = docKey(update.docId)
    if (!room.hydratedDocs.has(hydratedKey) || room.docs.get(hydratedKey) === undefined) {
      webSocket.close(1011, 'hydrate-failed')
      return { action: 'stop' }
    }
    const duplicateDecision = decideSyncUpdateAppend({
      update,
      doc,
      duplicate,
      updateBytesLength: updateBytes.byteLength,
      updateSha256,
      now,
      largeUpdateThresholdBytes: LARGE_UPDATE_THRESHOLD_BYTES,
    })
    if (duplicateDecision.action === 'ack-duplicate') {
      webSocket.send(JSON.stringify(duplicateDecision.ack))
      return { action: 'stop' }
    }
    webSocket.close(1011, 'duplicate-reject')
    return { action: 'stop' }
  }

  const preflight = decideSyncUpdateAppend({
    update,
    doc,
    duplicate: undefined,
    updateBytesLength: updateBytes.byteLength,
    updateSha256,
    now,
    largeUpdateThresholdBytes: LARGE_UPDATE_THRESHOLD_BYTES,
  })
  if (preflight.action === 'reject') {
    if (preflight.reason === 'large-update-requires-snapshot-import') {
      webSocket.send(
        JSON.stringify(
          makeSyncUpdateRejected(update, updateSha256, 'large-update-requires-snapshot-import'),
        ),
      )
    }
    webSocket.close(1011, `append-reject:${preflight.reason}`)
    return { action: 'stop' }
  }

  if (admitDocLoad(room, update.docId).action === 'degraded') {
    webSocket.close(1011, 'doc-load-degraded')
    return { action: 'stop' }
  }
  try {
    await ensureDocHydrated(room, update.docId)
  } catch {
    webSocket.close(1011, 'hydrate-failed')
    return { action: 'stop' }
  }

  const currentDoc = room.docs.get(docKey(update.docId))
  const yjsApplySucceeded =
    currentDoc !== undefined && canApplyYjsUpdateToDoc(currentDoc, updateBytes)
  const metaSchemaValid =
    update.docId.kind === 'meta' && yjsApplySucceeded
      ? metaSchemaValidAfterUpdate(room, updateBytes)
      : undefined
  const quarantine = decideSyncUpdateQuarantine({
    update,
    quarantineId: makeQuarantineId(update),
    updateBytesLength: updateBytes.byteLength,
    actualUpdateSha256: updateSha256,
    ...(update.updateSha256 === undefined ? {} : { expectedUpdateSha256: update.updateSha256 }),
    yjsApplySucceeded,
    metaSchemaValid,
    now,
  })

  if (quarantine.action === 'reject') {
    webSocket.close(1011, `quarantine-reject:${quarantine.reason}`)
    return { action: 'stop' }
  }
  if (quarantine.action === 'quarantine') {
    await persistQuarantine(room, updateBytes, quarantine.row)
    webSocket.send(
      JSON.stringify(makeSyncUpdateRejected(update, updateSha256, quarantine.row.reason)),
    )
    return { action: 'stop' }
  }

  const append = decideSyncUpdateAppend({
    update,
    doc,
    duplicate: undefined,
    updateBytesLength: quarantine.updateBytesLength,
    updateSha256: quarantine.updateSha256,
    now,
    largeUpdateThresholdBytes: LARGE_UPDATE_THRESHOLD_BYTES,
  })

  if (append.action === 'reject') {
    webSocket.close(1011, `append-reject:${append.reason}`)
    return { action: 'stop' }
  }
  if (append.action === 'ack-duplicate') {
    webSocket.send(JSON.stringify(append.ack))
    return { action: 'stop' }
  }
  await persistAppend(
    room,
    update,
    updateBytes,
    append.opLogAppend.seq,
    { latestSeq: append.docPatch.latestSeq, updatedAt: append.docPatch.updatedAt },
    quarantine.updateSha256,
    now,
  )
  try {
    applyUpdate(room, update.docId, updateBytes)
  } catch (error) {
    logEvent('sync-apply-failed', {
      vaultId: room.vaultId,
      docId: update.docId,
      error: retentionErrorMessage(error),
    })
    try {
      await rehydrateAfterApplyFailure(room, update.docId)
    } catch (rehydrateError) {
      logEvent('sync-rehydrate-failed', {
        vaultId: room.vaultId,
        docId: update.docId,
        error: retentionErrorMessage(rehydrateError),
      })
      webSocket.close(1011, 'hydrate-failed')
      return { action: 'stop' }
    }
  }
  try {
    await scheduleCheckpointAfterAppend(room, update.docId, append.docPatch.latestSeq, now)
  } catch (error) {
    logEvent('checkpoint-schedule-failed', {
      vaultId: room.vaultId,
      docId: update.docId,
      latestSeq: append.docPatch.latestSeq,
      error: retentionErrorMessage(error),
    })
  }
  webSocket.send(JSON.stringify(append.ack))

  return { action: 'broadcast', durableSeq: append.opLogAppend.seq }
}

/**
 * Runs a document mutation in the same serialized turn as inbound updates.
 *
 * The caller may release the queue before performing external I/O by returning
 * a captured value from the task.
 *
 * @param room Runtime room that owns the per-document queues.
 * @param docId Document whose writes must be serialized.
 * @param task Work to run after all earlier document writes complete.
 * @returns The task result after the serialized turn completes.
 */
export async function withDocWriteQueue<T>(
  room: VaultRoom,
  docId: DocId,
  task: () => Promise<T>,
): Promise<T> {
  const key = docKey(docId)
  const previous = room.docWriteQueues.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(
    () => current,
    () => current,
  )
  room.docWriteQueues.set(key, queued)

  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (room.docWriteQueues.get(key) === queued) room.docWriteQueues.delete(key)
  }
}

async function persistQuarantine(
  room: VaultRoom,
  updateBytes: Uint8Array,
  row: {
    readonly id: string
    readonly docId: DocId
    readonly messageId: string
    readonly deviceId: string
    readonly reason: string
    readonly updateSha256: string
    readonly createdAt: number
  },
): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  await insertQuarantinedUpdate(
    db,
    row.id,
    docKey(row.docId),
    row.messageId,
    row.deviceId,
    row.reason,
    row.updateSha256,
    updateBytes,
    row.createdAt,
  )
  logEvent('quarantine', {
    vaultId: room.vaultId,
    docId: row.docId,
    quarantineId: row.id,
    reason: row.reason,
  })
}

async function persistAppend(
  room: VaultRoom,
  update: SyncUpdate,
  updateBytes: Uint8Array,
  seq: number,
  docPatch: RuntimeDocClockRecord,
  updateSha256: string,
  now: number,
): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  const docId = docKey(update.docId)
  await withSqlTransaction(room, async () => {
    await insertOpLog(
      db,
      docId,
      seq,
      update.messageId,
      update.deviceId,
      updateBytes,
      updateSha256,
      now,
    )
    await upsertDocClock(db, docId, update.docId.kind, docPatch.latestSeq, docPatch.updatedAt)
    await upsertMessageDedup(db, docId, update.messageId, seq, updateSha256, now)
  })
}

/** Discards a quarantined update: deletes the row and records the resolution audit trail. */
export async function persistQuarantineDiscard(
  room: VaultRoom,
  record: QuarantinedUpdateRecord,
  deletePatch: QuarantinedUpdateDeletePatch,
  actor: DeviceId,
): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  await withSqlTransaction(room, async () => {
    await deleteQuarantinedUpdate(db, deletePatch.id)
    await insertQuarantineAuditEvent(
      db,
      record.id,
      docKey(record.docId),
      record.messageId,
      record.deviceId,
      record.reason,
      deletePatch.reason,
      actor,
      null,
      record.createdAt,
      deletePatch.deletedAt,
    )
  })
  logEvent('quarantine-resolved', {
    vaultId: room.vaultId,
    docId: record.docId,
    quarantineId: record.id,
    action: deletePatch.reason,
    actor,
  })
}

/**
 * Force-applies a quarantined update: appends it to the op log and document clock,
 * registers message dedup (so a later resend of the same messageId acks normally),
 * deletes the quarantine row, and records the resolution audit trail.
 */
export async function persistQuarantineForceApply(
  room: VaultRoom,
  record: QuarantinedUpdateRecord,
  updateBytes: Uint8Array,
  opLogAppend: QuarantinedUpdateForceApplyOpLogAppend,
  docPatch: QuarantinedUpdateForceApplyDocPatch,
  deletePatch: QuarantinedUpdateDeletePatch,
  actor: DeviceId,
): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  const docId = docKey(record.docId)
  await withSqlTransaction(room, async () => {
    await insertOpLog(
      db,
      docId,
      opLogAppend.seq,
      opLogAppend.messageId,
      opLogAppend.deviceId,
      updateBytes,
      opLogAppend.updateSha256,
      opLogAppend.createdAt,
    )
    await upsertDocClock(db, docId, record.docId.kind, docPatch.latestSeq, docPatch.updatedAt)
    await upsertMessageDedup(
      db,
      docId,
      opLogAppend.messageId,
      opLogAppend.seq,
      opLogAppend.updateSha256,
      opLogAppend.createdAt,
    )
    await deleteQuarantinedUpdate(db, deletePatch.id)
    await insertQuarantineAuditEvent(
      db,
      record.id,
      docId,
      record.messageId,
      record.deviceId,
      record.reason,
      deletePatch.reason,
      actor,
      opLogAppend.seq,
      record.createdAt,
      deletePatch.deletedAt,
    )
  })
  logEvent('quarantine-resolved', {
    vaultId: room.vaultId,
    docId: record.docId,
    quarantineId: record.id,
    action: deletePatch.reason,
    actor,
    appliedSeq: opLogAppend.seq,
  })
}

export function applyUpdate(room: VaultRoom, docId: DocId, updateBytes: Uint8Array): void {
  const key = docKey(docId)
  const doc = room.docs.get(key) ?? new Y.Doc()
  room.docs.set(key, doc)
  Y.applyUpdate(doc, updateBytes)
}

export async function rehydrateAfterApplyFailure(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  current?.destroy()
  await ensureDocHydrated(room, docId)
}

/** Invalidates stale hydration state and reloads the document from its durable pointer. */
export async function rehydrateAfterDocPointer(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const inFlight = room.hydrationInFlight.get(key)
  if (inFlight !== undefined) {
    try {
      await inFlight
    } catch (error) {
      logEvent('pointer-rehydrate-stale-hydration-failed', {
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
  await ensureDocHydrated(room, docId)
}

export function metaSchemaValidAfterUpdate(room: VaultRoom, updateBytes: Uint8Array): boolean {
  const doc = room.docs.get(docKey({ kind: 'meta' }))
  if (doc === undefined) return false
  const currentDisposition = metaYDocSchemaDisposition(doc)
  if (currentDisposition !== 'supported-v2' && currentDisposition !== 'legacy-v1') {
    return false
  }

  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(candidate, updateBytes)
    return metaYDocWritableCandidate(room, candidate) && metaRootMutationAllowed(doc, updateBytes)
  } catch {
    return false
  } finally {
    candidate.destroy()
  }
}

function metaYDocWritableCandidate(room: VaultRoom, candidate: Y.Doc): boolean {
  const current = room.docs.get(docKey({ kind: 'meta' }))
  if (current === undefined) return metaYDocWritable(candidate)
  return metaIdentityImmutable(current, candidate)
}

/** Decides whether a doc load may proceed, given the room's current residency. */
export function admitDocLoad(room: VaultRoom, docId: DocId): DocLoadAdmissionDecision {
  const key = docKey(docId)
  return decideDocLoadAdmission({
    isMeta: docId.kind === 'meta',
    alreadyHydrated: room.hydratedDocs.has(key),
    hydratedFileDocCount: [...room.hydratedDocs].filter((hydratedKey) => hydratedKey !== 'meta')
      .length,
    maxHydratedFileDocs: MAX_HYDRATED_FILE_DOCS,
  })
}

export async function ensureDocHydrated(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  room.docLastAccessedAt.set(key, Date.now())
  if (room.hydratedDocs.has(key)) return

  const existing = room.hydrationInFlight.get(key)
  if (existing !== undefined) return existing

  const attempt = hydrateDoc(room, docId, key).finally(() => {
    room.hydrationInFlight.delete(key)
  })
  room.hydrationInFlight.set(key, attempt)
  return attempt
}

async function hydrateDoc(room: VaultRoom, docId: DocId, key: string): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  const persisted = await readSyncRequestDocState(room, docId)
  const pointer = await readSnapshotPointer(room, docId)
  const snapshot = await chooseSnapshot(room, docId, persisted, pointer)
  const doc = new Y.Doc()
  let installed = false
  try {
    if (snapshot !== undefined) {
      const snapshotKey = snapshot.latestSnapshotKey
      const bucket = room.env.SNAPSHOT_BUCKET
      if (bucket === undefined) throw new Error('snapshot-bucket-unavailable')
      const snapshotObject = await bucket.get(snapshotKey)
      if (snapshotObject === null) throw new Error('snapshot-missing')
      Y.applyUpdate(doc, new Uint8Array(await snapshotObject.arrayBuffer()))
    }

    const minSeq = snapshot?.latestSnapshotSeq ?? 0
    if (
      snapshot === undefined &&
      persisted !== undefined &&
      persisted.minRetainedSeq > 0 &&
      persisted.latestSeq > 0
    ) {
      throw new Error('snapshot-health:no-verified-generation')
    }
    const updates =
      persisted === undefined
        ? await getOpLogUpdatesSince(db, key, minSeq)
        : await getOpLogUpdatesBetween(db, key, minSeq, persisted.latestSeq)
    let expectedSeq = minSeq + 1
    for (const row of updates) {
      if (row.seq !== expectedSeq) {
        throw new Error('op_log sequence gap')
      }
      const updateBytes = readSqlUpdateBytes(row.updateBytes)
      if (updateBytes === undefined) {
        throw new Error('invalid op_log update_bytes')
      }
      Y.applyUpdate(doc, updateBytes)
      expectedSeq += 1
    }
    if (persisted !== undefined && expectedSeq !== persisted.latestSeq + 1) {
      throw new Error('op_log sequence gap')
    }
    if (persisted === undefined && expectedSeq !== 1) {
      throw new Error('snapshot-health:no-verified-generation')
    }
    room.docs.set(key, doc)
    room.hydratedDocs.add(key)
    installed = true
  } finally {
    if (!installed) doc.destroy()
  }
}

async function chooseSnapshot(
  room: VaultRoom,
  docId: DocId,
  persisted: Awaited<ReturnType<typeof readSyncRequestDocState>>,
  pointer: Awaited<ReturnType<typeof readSnapshotPointer>>,
): Promise<{ readonly latestSnapshotKey: string; readonly latestSnapshotSeq: number } | undefined> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (db === undefined || bucket === undefined || vaultId === undefined) return undefined
  const listed = await listSnapshotCandidates(room, docId)
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  if (persisted === undefined && listed.length > 0) {
    throw new Error('snapshot-health:no-verified-generation')
  }
  const durableAuthorities = new Set<string>()
  if (persisted !== undefined) {
    for (const row of await getAllLatestSnapshotHealthEvents(db, docKey(docId))) {
      const candidate = snapshotCandidateFromKey(prefix, row.snapshotKey)
      if (
        candidate !== undefined &&
        candidate.upperSeq === row.upperSeq &&
        row.authorityStatus === 'authoritative' &&
        candidate.upperSeq >= persisted.minRetainedSeq &&
        candidate.upperSeq <= persisted.latestSeq
      ) {
        durableAuthorities.add(candidate.key)
      }
    }
  }
  const pointerCandidate =
    pointer === undefined ? undefined : snapshotCandidateFromKey(prefix, pointer.latestSnapshotKey)
  if (
    pointerCandidate !== undefined &&
    pointer !== undefined &&
    pointerCandidate.upperSeq === pointer.latestSnapshotSeq &&
    (persisted === undefined ||
      (pointerCandidate.upperSeq >= persisted.minRetainedSeq &&
        pointerCandidate.upperSeq <= persisted.latestSeq))
  ) {
    durableAuthorities.add(pointerCandidate.key)
  }
  if (persisted !== undefined) {
    for (const run of await getSnapshotRetentionCheckpointRuns(db, docKey(docId))) {
      if (
        run.status !== 'pointer-updated' &&
        run.status !== 'compacted' &&
        run.status !== 'completed'
      ) {
        continue
      }
      if (run.snapshotKey === null) continue
      const runCandidate = snapshotCandidateFromKey(prefix, run.snapshotKey)
      if (runCandidate === undefined || runCandidate.upperSeq !== run.upperSeq) continue
      if (
        runCandidate.upperSeq < persisted.minRetainedSeq ||
        runCandidate.upperSeq > persisted.latestSeq
      )
        continue
      durableAuthorities.add(runCandidate.key)
    }
  }
  const candidates = [...(pointerCandidate === undefined ? [] : [pointerCandidate]), ...listed]
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.key, candidate])).values(),
  ].sort((left, right) => right.upperSeq - left.upperSeq)

  for (const candidate of uniqueCandidates) {
    if (!durableAuthorities.has(candidate.key)) continue
    const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    const expected = findExpectedEvidence(latest)
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, expected)
    const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      expected,
    )
    const latestAfterRecord = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    if (
      verification.status === 'verified' &&
      logicalStatus !== 'quarantined' &&
      latestAfterRecord?.logicalStatus !== 'quarantined' &&
      (durableAuthorities.has(candidate.key) ||
        latestAfterRecord?.authorityStatus === 'authoritative')
    ) {
      return { latestSnapshotKey: candidate.key, latestSnapshotSeq: candidate.upperSeq }
    }
  }
  return undefined
}

/** Appends a physical verification while preserving a concurrent logical verdict. */
export async function appendSnapshotVerificationEventPreservingLogical(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  candidate: SnapshotCandidate,
  verification: Awaited<ReturnType<typeof verifySnapshotObject>>,
  expected: SnapshotVerificationExpectedEvidence | undefined,
  authorityStatus?: 'candidate' | 'authoritative',
): Promise<'healthy' | 'quarantined'> {
  let logicalStatus: 'healthy' | 'quarantined' = 'healthy'
  await withSqlTransaction(room, async () => {
    const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    logicalStatus = latest?.logicalStatus === 'quarantined' ? 'quarantined' : 'healthy'
    const effectiveAuthorityStatus =
      authorityStatus ??
      (latest?.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate')
    const preservedReasons = latest === undefined ? [] : parseSnapshotHealthReasons(latest.reasons)
    const expectedByteLength = expected?.byteLength ?? latest?.expectedByteLength ?? null
    const expectedUpdateSha256 = expected?.updateSha256 ?? latest?.expectedUpdateSha256 ?? null
    const expectedStateVectorSha256 =
      expected?.stateVectorSha256 ?? latest?.expectedStateVectorSha256 ?? null
    const actualUpdateSha256 = verification.actualUpdateSha256 || null
    const actualStateVectorSha256 = verification.actualStateVectorSha256 ?? null
    const nextReasons = [...new Set([...preservedReasons, ...verification.reasons])]
    if (
      latest !== undefined &&
      latest.authorityStatus === effectiveAuthorityStatus &&
      latest.expectedByteLength === expectedByteLength &&
      latest.expectedUpdateSha256 === expectedUpdateSha256 &&
      latest.expectedStateVectorSha256 === expectedStateVectorSha256 &&
      latest.actualByteLength === verification.actualByteLength &&
      latest.actualUpdateSha256 === actualUpdateSha256 &&
      latest.actualStateVectorSha256 === actualStateVectorSha256 &&
      latest.physicalStatus === verification.status &&
      latest.logicalStatus === logicalStatus &&
      JSON.stringify(parseSnapshotHealthReasons(latest.reasons)) === JSON.stringify(nextReasons)
    ) {
      return
    }
    await insertSnapshotHealthEvent(db, {
      docId: docKey(docId),
      snapshotKey: candidate.key,
      upperSeq: candidate.upperSeq,
      event: 'verification',
      actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
      authorityStatus: effectiveAuthorityStatus,
      expectedByteLength,
      expectedUpdateSha256,
      expectedStateVectorSha256,
      actualByteLength: verification.actualByteLength,
      actualUpdateSha256,
      actualStateVectorSha256,
      physicalStatus: verification.status,
      logicalStatus,
      reasons: nextReasons,
      observedAt: Date.now(),
    })
  })
  return logicalStatus
}

function parseSnapshotHealthReasons(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is string => typeof reason === 'string')
      : []
  } catch {
    return []
  }
}

async function listSnapshotCandidates(
  room: VaultRoom,
  docId: DocId,
): Promise<readonly SnapshotCandidate[]> {
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) return []

  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const objects = await listR2Objects(bucket, prefix)
  return objects
    .map((object) => snapshotCandidateFromKey(prefix, object.key))
    .filter((c): c is SnapshotCandidate => c !== undefined)
    .sort((left, right) => right.upperSeq - left.upperSeq)
}

function findExpectedEvidence(
  event: SnapshotHealthEventRow | undefined,
): SnapshotVerificationExpectedEvidence | undefined {
  if (
    event === undefined ||
    event.expectedByteLength === null ||
    event.expectedUpdateSha256 === null ||
    event.expectedStateVectorSha256 === null
  ) {
    return undefined
  }
  return {
    byteLength: event.expectedByteLength,
    updateSha256: event.expectedUpdateSha256,
    stateVectorSha256: event.expectedStateVectorSha256,
  }
}

/**
 * Lists every object under an R2 prefix, following opaque continuation cursors.
 *
 * @param bucket R2 bucket to query.
 * @param prefix Prefix to list.
 * @returns All listed object metadata in page order.
 * @throws If a truncated response omits a usable continuation cursor or loops.
 */
export async function listR2Objects(
  bucket: R2BucketBinding,
  prefix: string,
): Promise<readonly R2ObjectBinding[]> {
  const objects: R2ObjectBinding[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const result = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor })
    objects.push(...result.objects)
    if (typeof result.truncated !== 'boolean') throw new Error('invalid-r2-list-result')
    if (!result.truncated) return objects
    if (
      typeof result.cursor !== 'string' ||
      result.cursor.length === 0 ||
      seenCursors.has(result.cursor)
    ) {
      throw new Error('invalid-r2-list-cursor')
    }
    seenCursors.add(result.cursor)
    cursor = result.cursor
  }
}

export async function scheduleCheckpointAfterAppend(
  room: VaultRoom,
  docId: DocId,
  latestSeq: number,
  now: number,
): Promise<void> {
  const snapshotSeq = await readSnapshotSeq(room, docId)
  const delay = latestSeq - snapshotSeq >= CHECKPOINT_OP_THRESHOLD ? 0 : CHECKPOINT_ALARM_DELAY_MS
  await scheduleCheckpointAlarm(room, now + delay)
}
