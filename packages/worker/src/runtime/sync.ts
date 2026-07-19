import {
  CURRENT_PROTOCOL_VERSION,
  makeSha256Hex,
  type AwarenessUpdate,
  type DeviceId,
  type DocId,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as Y from 'yjs'

import {
  deleteQuarantinedUpdate,
  insertQuarantinedUpdate,
  insertQuarantineAuditEvent,
} from '../db/checkpointRepo'
import { insertOpLog, upsertDocClock, upsertMessageDedup } from '../db/docRepo'
import type {
  QuarantinedUpdateDeletePatch,
  QuarantinedUpdateForceApplyDocPatch,
  QuarantinedUpdateForceApplyOpLogAppend,
  QuarantinedUpdateRecord,
} from '../quarantine'
import { decideSyncRequest, type SyncRequestDocState } from '../sync/request'
import {
  decideSyncUpdateAppend,
  decideSyncUpdateQuarantine,
  makeSyncUpdateRejected,
} from '../sync/update'
import {
  stateVectorCoversHorizon,
  canApplyYjsUpdateToDoc,
  isEmptyYjsUpdate,
  metaYDocSchemaDisposition,
  metaYDocWritable,
  metaIdentityImmutable,
  metaRootMutationAllowed,
} from '../sync/yjs'
import {
  broadcast,
  messageMatchesSession,
  readAwarenessAttachment,
  readSession,
  rememberAwarenessAttachment,
} from './auth'
import {
  CHECKPOINT_OP_THRESHOLD,
  CHECKPOINT_ALARM_DELAY_MS,
  LARGE_UPDATE_THRESHOLD_BYTES,
} from './constants'
import { admitDocLoad, ensureDocHydrated, rehydrateAfterApplyFailure } from './documents'
import type { VaultRoom } from './room'
import {
  getDb,
  readDocClock,
  readDuplicate,
  readSyncRequestDocState,
  readSnapshotSeq,
  scheduleCheckpointAlarm,
  withSqlTransaction,
} from './storage'
import type { RuntimeWebSocket, RuntimeDocClockRecord } from './types'
import {
  docKey,
  makeQuarantineId,
  decodeBase64,
  encodeBase64,
  sha256Hex,
  logEvent,
  retentionErrorMessage,
} from './utils'

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
      logEvent('sync-duplicate-ignored', {
        vaultId: room.vaultId,
        docId: update.docId,
        messageId: update.messageId,
        durableSeq: duplicate.durableSeq,
      })
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
  const startedAt = Date.now()
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
  logEvent('op-append-latency', {
    vaultId: room.vaultId,
    docId: update.docId,
    durationMs: Date.now() - startedAt,
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

/** Broadcasts an awareness frame to every other authenticated socket in the vault. */
export function handleAwarenessUpdate(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  update: AwarenessUpdate,
): void {
  const session = readSession(room, webSocket)
  if (session === undefined) {
    webSocket.close(1008, 'hello-required')
    return
  }
  if (!messageMatchesSession(session, update)) {
    webSocket.close(1008, 'session-mismatch')
    return
  }
  rememberAwarenessAttachment(room, webSocket, { docId: update.docId, clientId: update.clientId })
  broadcast(room, webSocket, JSON.stringify(update))
}

/** Broadcasts a synthetic leave frame when a connection closes. */
export function broadcastAwarenessLeave(room: VaultRoom, webSocket: RuntimeWebSocket): void {
  const session = readSession(room, webSocket)
  const awareness = readAwarenessAttachment(room, webSocket)
  room.awarenessByWebSocket.delete(webSocket)
  if (session === undefined || awareness === undefined) return

  const leave: AwarenessUpdate = {
    type: 'awareness-update',
    vaultId: session.vaultId,
    deviceId: session.deviceId,
    docId: awareness.docId,
    clientId: awareness.clientId,
    state: null,
  }
  broadcast(room, webSocket, JSON.stringify(leave))
}
