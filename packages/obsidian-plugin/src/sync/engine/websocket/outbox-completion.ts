import {
  type SyncRuntimeWebSocketInboundRoutePorts,
  type SyncRuntimeWebSocketOutboxCompletionInput,
  type SyncRuntimeWebSocketOutboxCompletionPlan,
  type SyncRuntimeWebSocketOutboxCompletionPortInput,
} from '../../engine/websocket.types'
import { planOutboxWorkerAckCompletion } from '../../engine/worker'
import { outboxCompletionCandidateMatches } from './inbound'

/**
 * Plans how an inbound ack-like WebSocket message completes a local outbox item.
 *
 * @param input Guarded server message, owner identity, clock, and current local-store snapshot.
 * @returns Successful completion plan, or a precise reason the message cannot mutate local state.
 */
export function planSyncRuntimeWebSocketOutboxCompletion(
  input: SyncRuntimeWebSocketOutboxCompletionInput,
): SyncRuntimeWebSocketOutboxCompletionPlan {
  const candidates = input.snapshot.outboxRecords.filter((record) =>
    outboxCompletionCandidateMatches(record, input.message),
  )
  if (candidates.length === 0) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-matching-outbox-record', candidates }
  }

  const record = candidates[0]
  if (record === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  const messageId = record.messageId
  if (messageId === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates: [] }
  }
  const completion = planOutboxWorkerAckCompletion({
    itemId: record.id,
    kind: record.kind,
    status: record.status,
    vaultId: input.message.vaultId,
    deviceId: input.message.deviceId,
    docId: input.message.docId,
    messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    currentOutboxRecords: input.snapshot.outboxRecords,
    currentLeaseRows: input.snapshot.leaseRows,
  })
  if (!completion.ok) {
    return { ok: false, reason: completion.reason, candidates, completion }
  }

  return { ok: true, record, completion }
}

/**
 * Creates the inbound outbox-completion port used by the WebSocket dispatcher.
 *
 * @param input Snapshot reader, durable committer, owner identity, and clock.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.completeOutbox`.
 */
export function createSyncRuntimeWebSocketOutboxCompletionPort(
  input: SyncRuntimeWebSocketOutboxCompletionPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'completeOutbox'> {
  return {
    async completeOutbox(message) {
      const plan = planSyncRuntimeWebSocketOutboxCompletion({
        message,
        ownerId: input.ownerId,
        now: input.now(),
        snapshot: await input.snapshot.read(),
        minDurableSeqExclusive: input.minDurableSeqExclusive,
      })
      if (!plan.ok) {
        return
      }
      await input.commit.commit(plan.completion)
    },
  }
}
