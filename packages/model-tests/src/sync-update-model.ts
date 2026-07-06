import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type MessageId,
  type Sha256Hex,
  type SyncUpdate,
} from '@kuroflare/core'
import { decideSyncUpdateAppend, type SyncUpdateAppendDecision } from '@kuroflare/worker'
import { assert } from 'vitest'

/** Message tracked by the sync update model. */
export interface SyncUpdateModelMessage {
  readonly update: SyncUpdate
  readonly updateBytesLength: number
  readonly updateSha256: Sha256Hex
}

/** Durable outcome recorded for a processed sync update message. */
export interface SyncUpdateModelProcessedMessage {
  readonly durableSeq: number
  readonly updateBytesLength: number
  readonly storage: 'op-log' | 'snapshot'
}

/** Durable op_log record visible to the model. */
export interface SyncUpdateModelOpLogRecord {
  readonly seq: number
  readonly messageId: MessageId
  readonly updateSha256: Sha256Hex
  status: 'active' | 'compacted'
}

/** Mutable state for one document's sync update append model. */
export interface SyncUpdateModelState {
  readonly processedMessages: Map<MessageId, SyncUpdateModelProcessedMessage>
  readonly opLogRecords: Map<number, SyncUpdateModelOpLogRecord>
  readonly opLogSeqs: Set<number>
  readonly snapshotSeqs: Set<number>
  readonly ackedMessages: Map<MessageId, number>
  readonly boundaryMessages: Map<MessageId, SyncUpdateAppendDecision['action']>
  readonly restoredUpdateHashes: Set<Sha256Hex>
  latestSeq: number
  latestSnapshotSeq: number
  nextMessage: number
  now: number
  readonly largeUpdateThresholdBytes: number
}

/** Creates a model state for one document in a Durable Object. */
export function createSyncUpdateModelState(
  largeUpdateThresholdBytes = 1_024,
): SyncUpdateModelState {
  return {
    processedMessages: new Map<MessageId, SyncUpdateModelProcessedMessage>(),
    opLogRecords: new Map<number, SyncUpdateModelOpLogRecord>(),
    opLogSeqs: new Set<number>(),
    snapshotSeqs: new Set<number>(),
    ackedMessages: new Map<MessageId, number>(),
    boundaryMessages: new Map<MessageId, SyncUpdateAppendDecision['action']>(),
    restoredUpdateHashes: new Set<Sha256Hex>(),
    latestSeq: 0,
    latestSnapshotSeq: 0,
    nextMessage: 1,
    now: 1,
    largeUpdateThresholdBytes,
  }
}

/** Creates a new update message with deterministic IDs and hash evidence. */
export function createSyncUpdateModelMessage(
  state: SyncUpdateModelState,
  updateBytesLength: number,
): SyncUpdateModelMessage {
  assert(Number.isSafeInteger(updateBytesLength) && updateBytesLength > 0)
  const messageNumber = state.nextMessage
  state.nextMessage += 1

  return {
    update: {
      type: 'sync-update',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-model'),
      deviceId: makeDeviceId('device-model'),
      messageId: makeMessageId(`message-${messageNumber}`),
      docId: { kind: 'file', ydocId: makeYDocId('doc-model') },
      update: 'AQID',
      baseStateVector: 'BAUG',
    },
    updateBytesLength,
    updateSha256: hashFor(messageNumber),
  }
}

/** Applies a message through the real worker append decision and updates the model state. */
export function applySyncUpdateModelMessage(
  state: SyncUpdateModelState,
  message: SyncUpdateModelMessage,
): SyncUpdateAppendDecision {
  state.now += 1
  const duplicate = state.processedMessages.get(message.update.messageId)
  const beforeLatestSeq = state.latestSeq
  const beforeSnapshotSeq = state.latestSnapshotSeq
  const decision = decideSyncUpdateAppend({
    update: message.update,
    doc: state.latestSeq === 0 ? undefined : { latestSeq: state.latestSeq },
    duplicate: duplicate ? { durableSeq: duplicate.durableSeq } : undefined,
    updateBytesLength: message.updateBytesLength,
    updateSha256: message.updateSha256,
    yClientId: 42,
    now: state.now,
    largeUpdateThresholdBytes: state.largeUpdateThresholdBytes,
  })

  switch (decision.action) {
    case 'append-op': {
      assert.equal(decision.opLogAppend.seq, beforeLatestSeq + 1)
      state.latestSeq = decision.docPatch.latestSeq
      state.opLogSeqs.add(decision.opLogAppend.seq)
      state.opLogRecords.set(decision.opLogAppend.seq, {
        seq: decision.opLogAppend.seq,
        messageId: message.update.messageId,
        updateSha256: message.updateSha256,
        status: 'active',
      })
      state.processedMessages.set(message.update.messageId, {
        durableSeq: decision.ack.durableSeq,
        updateBytesLength: message.updateBytesLength,
        storage: 'op-log',
      })
      state.ackedMessages.set(message.update.messageId, decision.ack.durableSeq)
      state.restoredUpdateHashes.add(message.updateSha256)
      break
    }
    case 'snapshot-escape': {
      assert.equal(decision.seq, beforeLatestSeq + 1)
      state.latestSeq = decision.docPatch.latestSeq
      state.latestSnapshotSeq = decision.seq
      state.snapshotSeqs.add(decision.seq)
      state.processedMessages.set(message.update.messageId, {
        durableSeq: decision.ack.durableSeq,
        updateBytesLength: message.updateBytesLength,
        storage: 'snapshot',
      })
      state.ackedMessages.set(message.update.messageId, decision.ack.durableSeq)
      state.boundaryMessages.set(message.update.messageId, decision.action)
      state.restoredUpdateHashes.add(message.updateSha256)
      break
    }
    case 'ack-duplicate': {
      assert(duplicate)
      assert.equal(decision.ack.durableSeq, duplicate.durableSeq)
      assert.equal(state.latestSeq, beforeLatestSeq)
      assert.equal(state.latestSnapshotSeq, beforeSnapshotSeq)
      state.ackedMessages.set(message.update.messageId, decision.ack.durableSeq)
      break
    }
    case 'reject': {
      throw new Error(`model generated rejected update: ${decision.reason}`)
    }
    default: {
      assertNever(decision)
    }
  }

  assertSyncUpdateModelInvariants(state)
  return decision
}

/** Marks op_log rows through `upperSeq` as compacted behind a durable snapshot pointer. */
export function compactSyncUpdateModelThrough(state: SyncUpdateModelState, upperSeq: number): void {
  assert(Number.isSafeInteger(upperSeq) && upperSeq >= 0)
  assert(upperSeq <= state.latestSeq, 'cannot compact beyond latest seq')
  if (upperSeq === 0) {
    return
  }

  state.latestSnapshotSeq = Math.max(state.latestSnapshotSeq, upperSeq)
  state.snapshotSeqs.add(upperSeq)

  for (const record of state.opLogRecords.values()) {
    if (record.seq <= upperSeq) {
      record.status = 'compacted'
    }
  }

  assertSyncUpdateModelInvariants(state)
}

/** Expires duplicate evidence for a compacted op_log message after the dedup TTL. */
export function expireSyncUpdateDedupForMessage(
  state: SyncUpdateModelState,
  message: SyncUpdateModelMessage,
): boolean {
  const processed = state.processedMessages.get(message.update.messageId)
  if (!processed || processed.storage !== 'op-log') {
    return false
  }

  const record = state.opLogRecords.get(processed.durableSeq)
  if (!record || record.status !== 'compacted') {
    return false
  }

  state.processedMessages.delete(message.update.messageId)
  assertSyncUpdateModelInvariants(state)
  return true
}

/** Returns the logical restored content tracked by the model. */
export function restoredSyncUpdateContent(state: SyncUpdateModelState): ReadonlySet<Sha256Hex> {
  return new Set(state.restoredUpdateHashes)
}

/** Asserts durable sync update invariants after arbitrary append/retry sequences. */
export function assertSyncUpdateModelInvariants(state: SyncUpdateModelState): void {
  assert(state.latestSeq >= state.latestSnapshotSeq, 'snapshot pointer advanced past latest seq')
  assert(state.ackedMessages.size >= state.processedMessages.size)

  for (const [messageId, durableSeq] of state.ackedMessages) {
    assert(durableSeq > 0, `non-positive acked durable seq for ${messageId}`)
    assert(durableSeq <= state.latestSeq, `future acked durable seq for ${messageId}`)
  }

  const durableSeqs = new Set<number>()
  for (const [messageId, processed] of state.processedMessages) {
    assert(processed.durableSeq > 0, `non-positive durable seq for ${messageId}`)
    assert(processed.durableSeq <= state.latestSeq, `future durable seq for ${messageId}`)
    assert.equal(state.ackedMessages.get(messageId), processed.durableSeq)
    assert(!durableSeqs.has(processed.durableSeq), `duplicate durable seq ${processed.durableSeq}`)
    durableSeqs.add(processed.durableSeq)

    if (processed.storage === 'op-log') {
      assert(
        state.opLogSeqs.has(processed.durableSeq),
        `missing op_log seq ${processed.durableSeq}`,
      )
      assert(
        state.opLogRecords.has(processed.durableSeq),
        `missing op_log record ${processed.durableSeq}`,
      )
      assert(
        processed.updateBytesLength <= state.largeUpdateThresholdBytes,
        `large update stored in op_log at seq ${processed.durableSeq}`,
      )
    } else {
      assert(
        state.snapshotSeqs.has(processed.durableSeq),
        `missing snapshot seq ${processed.durableSeq}`,
      )
      assert(
        processed.updateBytesLength > state.largeUpdateThresholdBytes,
        `small update escaped to snapshot at seq ${processed.durableSeq}`,
      )
      assert.equal(state.boundaryMessages.get(messageId), 'snapshot-escape')
    }
  }

  for (const [seq, record] of state.opLogRecords) {
    assert.equal(record.seq, seq)
    assert(state.opLogSeqs.has(seq), `op_log record without seq marker ${seq}`)
    assert(state.restoredUpdateHashes.has(record.updateSha256), `op_log content missing for ${seq}`)
    if (record.status === 'compacted') {
      assert(seq <= state.latestSnapshotSeq, `compacted op_log seq ${seq} beyond snapshot pointer`)
    }
  }
}

function hashFor(value: number): Sha256Hex {
  return makeSha256Hex(value.toString(16).padStart(64, '0'))
}

function assertNever(value: never): never {
  throw new Error(`unexpected decision: ${JSON.stringify(value)}`)
}
