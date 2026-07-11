import {
  CURRENT_PROTOCOL_VERSION,
  makeSha256Hex,
  type DocId,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as Y from 'yjs'

import { insertQuarantinedUpdate } from '../db/checkpointRepo'
import { getOpLogUpdatesSince } from '../db/docRepo'
import { insertOpLog, upsertDocClock, upsertMessageDedup } from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import type { YClientId } from '../devices'
import { decideSyncRequest, type SyncRequestDocState } from '../sync/request'
import {
  chooseSnapshotForRestore,
  makeSnapshotListPrefix,
  type SnapshotCandidate,
} from '../sync/snapshots'
import { decideSyncUpdateAppend, decideSyncUpdateQuarantine } from '../sync/update'
import { readSession, messageMatchesSession } from './auth'
import {
  CHECKPOINT_OP_THRESHOLD,
  CHECKPOINT_ALARM_DELAY_MS,
  LARGE_UPDATE_THRESHOLD_BYTES,
} from './constants'
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
  SessionState,
  RuntimeDocClockRecord,
} from './types'
import {
  docKey,
  makeQuarantineId,
  snapshotCandidateFromKey,
  stateVectorCoversHorizon,
  canApplyYjsUpdate,
  isEmptyYjsUpdate,
  metaYDocSchemaValid,
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
    return await handleSyncUpdateSerialized(room, webSocket, update, updateBytes, session)
  })
}

async function handleSyncUpdateSerialized(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  update: SyncUpdate,
  updateBytes: Uint8Array,
  session: SessionState,
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
      yClientId: session.yClientId,
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

  try {
    await ensureDocHydrated(room, update.docId)
  } catch {
    webSocket.close(1011, 'hydrate-failed')
    return { action: 'stop' }
  }

  const yjsApplySucceeded = canApplyYjsUpdate(updateBytes)
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
    return { action: 'stop' }
  }

  const append = decideSyncUpdateAppend({
    update,
    doc,
    duplicate: undefined,
    updateBytesLength: quarantine.updateBytesLength,
    updateSha256: quarantine.updateSha256,
    yClientId: session.yClientId,
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
    session.yClientId,
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
  logEvent('quarantine', { vaultId: room.vaultId, docId: row.docId, reason: row.reason })
}

async function persistAppend(
  room: VaultRoom,
  update: SyncUpdate,
  updateBytes: Uint8Array,
  seq: number,
  docPatch: RuntimeDocClockRecord,
  yClientId: YClientId,
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
      yClientId,
      updateBytes,
      updateSha256,
      now,
    )
    await upsertDocClock(db, docId, update.docId.kind, docPatch.latestSeq, docPatch.updatedAt)
    await upsertMessageDedup(db, docId, update.messageId, seq, updateSha256, now)
  })
}

function applyUpdate(room: VaultRoom, docId: DocId, updateBytes: Uint8Array): void {
  const key = docKey(docId)
  const doc = room.docs.get(key) ?? new Y.Doc()
  room.docs.set(key, doc)
  Y.applyUpdate(doc, updateBytes)
}

async function rehydrateAfterApplyFailure(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  current?.destroy()
  await ensureDocHydrated(room, docId)
}

function metaSchemaValidAfterUpdate(room: VaultRoom, updateBytes: Uint8Array): boolean {
  const doc = room.docs.get(docKey({ kind: 'meta' }))
  if (doc === undefined) return false

  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(candidate, updateBytes)
    return metaYDocSchemaValid(candidate)
  } catch {
    return false
  } finally {
    candidate.destroy()
  }
}

export async function ensureDocHydrated(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
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

  const doc = new Y.Doc()
  const snapshot = await chooseSnapshot(room, docId)
  if (snapshot !== undefined) {
    const snapshotKey = snapshot.latestSnapshotKey
    const bucket = room.env.SNAPSHOT_BUCKET
    if (bucket === undefined) throw new Error('snapshot-bucket-unavailable')
    const snapshotObject = await bucket.get(snapshotKey)
    if (snapshotObject === null) throw new Error('snapshot-missing')
    Y.applyUpdate(doc, new Uint8Array(await snapshotObject.arrayBuffer()))
  }

  const minSeq = snapshot?.latestSnapshotSeq ?? 0
  for (const row of await getOpLogUpdatesSince(db, key, minSeq)) {
    const updateBytes = readSqlUpdateBytes(row.updateBytes)
    if (updateBytes === undefined) throw new Error('invalid op_log update_bytes')
    Y.applyUpdate(doc, updateBytes)
  }
  room.docs.set(key, doc)
  room.hydratedDocs.add(key)
}

async function chooseSnapshot(
  room: VaultRoom,
  docId: DocId,
): Promise<{ readonly latestSnapshotKey: string; readonly latestSnapshotSeq: number } | undefined> {
  const pointer = await readSnapshotPointer(room, docId)
  const listed = await listSnapshotCandidates(room, docId)
  if (listed.length === 0) return pointer

  const choice = chooseSnapshotForRestore(
    pointer === undefined
      ? undefined
      : { key: pointer.latestSnapshotKey, upperSeq: pointer.latestSnapshotSeq, healthy: true },
    listed,
  )
  return { latestSnapshotKey: choice.key, latestSnapshotSeq: choice.upperSeq }
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

async function scheduleCheckpointAfterAppend(
  room: VaultRoom,
  docId: DocId,
  latestSeq: number,
  now: number,
): Promise<void> {
  const snapshotSeq = await readSnapshotSeq(room, docId)
  const delay = latestSeq - snapshotSeq >= CHECKPOINT_OP_THRESHOLD ? 0 : CHECKPOINT_ALARM_DELAY_MS
  await scheduleCheckpointAlarm(room, now + delay)
}
