import {
  parseControlMessage,
  type ControlMessage,
  type DeviceId,
  type DocId,
  type HelloAccepted,
  type MessageId,
  type OutboxRunningLease,
  type VaultId,
} from '@kuroflare/core'

import { type LocalSetupMetadata } from '../engine/setup'
import {
  planOutboxWorkerAckCompletion,
  planOutboxWorkerSyncUpdateRejectedCompletion,
  type OutboxWorkerCompletionPlan,
} from '../engine/worker'
import { type LocalStoreOutboxRecord } from '../store/store'
import { type SyncRuntimeWebSocketConnection } from './socket'

/** Reason an inbound WebSocket frame is rejected before sync decisions. */
export type SyncRuntimeWebSocketInboundRejectionReason =
  | 'unsupported-binary-message'
  | 'invalid-control-message'

/** Result of parsing one inbound WebSocket message at the trust boundary. */
export type SyncRuntimeWebSocketInboundMessage =
  | { readonly ok: true; readonly message: ControlMessage }
  | {
      readonly ok: false
      readonly reason: SyncRuntimeWebSocketInboundRejectionReason
    }

/** Input for routing one guarded inbound control message inside the plugin runtime. */
export interface SyncRuntimeWebSocketInboundRouteInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  /**
   * Message IDs of sync-requests this device has sent and is still awaiting a
   * reply for. The server addresses a sync-request's direct reply using the
   * requesting device's own `deviceId` (see `decideSyncRequest`), which is
   * otherwise indistinguishable from the server re-broadcasting this device's
   * own past edit to a reconnected session, so a match here overrides the
   * self-broadcast drop.
   */
  readonly pendingSyncRequestMessageIds?: ReadonlySet<MessageId> | undefined
}

/** Local runtime route selected for one inbound WebSocket control message. */
export type SyncRuntimeWebSocketInboundRoute =
  | {
      readonly action: 'outbox-completion'
      readonly message: Extract<
        ControlMessage,
        { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
      >
    }
  | {
      readonly action: 'apply-remote-update'
      readonly message: Extract<ControlMessage, { readonly type: 'sync-update' }>
    }
  | {
      readonly action: 'answer-sync-request'
      readonly message: Extract<ControlMessage, { readonly type: 'sync-request' }>
    }
  | {
      readonly action: 'apply-remote-awareness'
      readonly message: Extract<ControlMessage, { readonly type: 'awareness-update' }>
    }
  | {
      readonly action: 'drop'
      readonly reason:
        | SyncRuntimeWebSocketInboundRejectionReason
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'self-broadcast'
        | 'unexpected-server-hello'
        | 'unexpected-hello-accepted'
    }

/** Input for validating the server admission response after sending ClientHello. */
export interface SyncRuntimeWebSocketHelloAdmissionInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly metadata: LocalSetupMetadata
}

/** Decision for one inbound message observed while waiting for hello admission. */
export type SyncRuntimeWebSocketHelloAdmissionPlan =
  | { readonly action: 'accepted'; readonly message: HelloAccepted }
  | {
      readonly action: 'reject'
      readonly reason:
        | SyncRuntimeWebSocketInboundRejectionReason
        | 'unexpected-message'
        | 'vault-mismatch'
        | 'device-mismatch'
    }

/** Ports that own local side effects for routed inbound WebSocket messages. */
export interface SyncRuntimeWebSocketInboundRoutePorts {
  /** Commits an outbound queue completion or full-snapshot pause after a server response. */
  completeOutbox(
    message: Extract<
      ControlMessage,
      { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
    >,
  ): Promise<void>
  /** Applies a peer update to the local YDoc and follow-up materialization pipeline. */
  applyRemoteUpdate(
    message: Extract<ControlMessage, { readonly type: 'sync-update' }>,
  ): Promise<void>
  /** Answers a peer state-vector request with a local update or full-snapshot response. */
  answerSyncRequest(
    message: Extract<ControlMessage, { readonly type: 'sync-request' }>,
  ): Promise<void>
  /** Applies a peer's broadcast presence state to the local awareness instance. */
  applyRemoteAwareness(
    message: Extract<ControlMessage, { readonly type: 'awareness-update' }>,
  ): Promise<void>
  /** Observes dropped inbound messages without receiving token material or raw payloads. */
  drop(route: Extract<SyncRuntimeWebSocketInboundRoute, { readonly action: 'drop' }>): Promise<void>
}

/** Input for dispatching one inbound WebSocket message to runtime ports. */
export interface SyncRuntimeWebSocketInboundDispatchInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly pendingSyncRequestMessageIds?: ReadonlySet<MessageId> | undefined
  readonly ports: SyncRuntimeWebSocketInboundRoutePorts
}

/** Result of dispatching one inbound WebSocket message. */
export interface SyncRuntimeWebSocketInboundDispatchResult {
  readonly route: SyncRuntimeWebSocketInboundRoute
}

/** Handler invoked after one inbound WebSocket frame has crossed parser validation. */
export type SyncRuntimeWebSocketInboundMessageHandler = (
  message: SyncRuntimeWebSocketInboundMessage,
) => void | Promise<void>

/** Minimal presence surface the WebSocket layer needs from `LocalAwareness`. */
export interface SyncRuntimeWebSocketAwarenessPort {
  /** Applies a peer's awareness state, or its removal when `state` is null. */
  applyRemoteState(clientId: number, state: Record<string, unknown> | null): void
}

/** Input for creating the inbound awareness-update apply port. */
export interface SyncRuntimeWebSocketAwarenessApplyPortInput {
  readonly awareness: SyncRuntimeWebSocketAwarenessPort
}

/** Snapshot needed to commit one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshot {
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}

/** Port that reads the current local outbox state before committing an inbound ack. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort {
  /** Reads the current outbox records and running leases needed for completion planning. */
  read(): Promise<SyncRuntimeWebSocketOutboxCompletionSnapshot>
}

/** Port that durably commits a successful inbound outbox completion plan. */
export type SyncRuntimeWebSocketOutboxCompletionCommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export interface SyncRuntimeWebSocketOutboxCompletionCommitPort {
  /** Commits a successful completion plan to the local store. */
  commit(
    plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>,
  ): Promise<void | SyncRuntimeWebSocketOutboxCompletionCommitResult>
}

/** Input for planning one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionInput {
  readonly message: Extract<
    ControlMessage,
    { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
  >
  readonly ownerId: string
  readonly now: number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshot
  readonly minDurableSeqExclusive?: number | undefined
}

/** Result of matching and planning one inbound outbox completion. */
export type SyncRuntimeWebSocketOutboxCompletionPlan =
  | {
      readonly ok: true
      readonly record: LocalStoreOutboxRecord
      readonly completion: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason:
        | 'matching-outbox-record-not-found'
        | 'ambiguous-matching-outbox-record'
        | Extract<OutboxWorkerCompletionPlan, { readonly ok: false }>['reason']
      readonly candidates: readonly LocalStoreOutboxRecord[]
      readonly completion?: Extract<OutboxWorkerCompletionPlan, { readonly ok: false }> | undefined
    }

/** Input for creating the inbound outbox completion dispatch port. */
export interface SyncRuntimeWebSocketOutboxCompletionPortInput {
  readonly ownerId: string
  readonly now: () => number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort
  readonly commit: SyncRuntimeWebSocketOutboxCompletionCommitPort
  readonly minDurableSeqExclusive?: number | undefined
}

/**
 * Parses one inbound WebSocket message before it reaches sync runtime decisions.
 *
 * @param event Browser WebSocket message event.
 * @returns Guarded control message, or a rejection reason for unsupported payloads.
 */
export function parseSyncRuntimeWebSocketMessage(
  event: MessageEvent,
): SyncRuntimeWebSocketInboundMessage {
  if (typeof event.data !== 'string') {
    return { ok: false, reason: 'unsupported-binary-message' }
  }
  const message = parseControlMessage(event.data)
  if (message === null) {
    return { ok: false, reason: 'invalid-control-message' }
  }
  return { ok: true, message }
}

/**
 * Routes a guarded inbound WebSocket message to the next local runtime boundary.
 *
 * @param input Parsed inbound message plus the trusted local vault and device identity.
 * @returns The local boundary that should handle the message, or a safe drop reason.
 */
export function planSyncRuntimeWebSocketInboundRoute(
  input: SyncRuntimeWebSocketInboundRouteInput,
): SyncRuntimeWebSocketInboundRoute {
  if (!input.inbound.ok) {
    return { action: 'drop', reason: input.inbound.reason }
  }

  const message = input.inbound.message
  if (message.vaultId !== input.vaultId) {
    return { action: 'drop', reason: 'vault-mismatch' }
  }

  switch (message.type) {
    case 'ack':
    case 'need-full-snapshot':
    case 'sync-update-rejected':
      if (message.deviceId !== input.deviceId) {
        return { action: 'drop', reason: 'device-mismatch' }
      }
      return { action: 'outbox-completion', message }
    case 'sync-update':
      if (
        message.deviceId === input.deviceId &&
        !(input.pendingSyncRequestMessageIds?.has(message.messageId) ?? false)
      ) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'apply-remote-update', message }
    case 'sync-request':
      if (message.deviceId === input.deviceId) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'answer-sync-request', message }
    case 'awareness-update':
      return { action: 'apply-remote-awareness', message }
    case 'hello':
      return { action: 'drop', reason: 'unexpected-server-hello' }
    case 'hello-accepted':
      return { action: 'drop', reason: 'unexpected-hello-accepted' }
  }
}

/**
 * Validates the server response that proves ClientHello admission succeeded.
 *
 * @param input Parsed inbound message plus trusted local setup metadata.
 * @returns Accepted admission evidence, or a non-secret rejection reason.
 */
export function planSyncRuntimeWebSocketHelloAdmission(
  input: SyncRuntimeWebSocketHelloAdmissionInput,
): SyncRuntimeWebSocketHelloAdmissionPlan {
  if (!input.inbound.ok) {
    return { action: 'reject', reason: input.inbound.reason }
  }
  const message = input.inbound.message
  if (message.type !== 'hello-accepted') {
    return { action: 'reject', reason: 'unexpected-message' }
  }
  if (message.vaultId !== input.metadata.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (message.deviceId !== input.metadata.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  return { action: 'accepted', message }
}

/**
 * Dispatches one guarded inbound WebSocket message to the runtime port selected by routing.
 *
 * @param input Guarded inbound message, trusted local identity, and side-effect ports.
 * @returns The route that was executed.
 */
export async function dispatchSyncRuntimeWebSocketInboundMessage(
  input: SyncRuntimeWebSocketInboundDispatchInput,
): Promise<SyncRuntimeWebSocketInboundDispatchResult> {
  const route = planSyncRuntimeWebSocketInboundRoute(input)
  switch (route.action) {
    case 'outbox-completion':
      await input.ports.completeOutbox(route.message)
      break
    case 'apply-remote-update':
      await input.ports.applyRemoteUpdate(route.message)
      break
    case 'answer-sync-request':
      await input.ports.answerSyncRequest(route.message)
      break
    case 'apply-remote-awareness':
      await input.ports.applyRemoteAwareness(route.message)
      break
    case 'drop':
      await input.ports.drop(route)
      break
  }
  return { route }
}

/**
 * Connects one WebSocket connection to the guarded inbound control-message handler.
 *
 * @param socket Open or opening WebSocket connection.
 * @param handler Handler that receives parsed control messages or rejection reasons.
 */
export function attachSyncRuntimeWebSocketInboundMessageHandler(
  socket: SyncRuntimeWebSocketConnection,
  handler: SyncRuntimeWebSocketInboundMessageHandler,
): void {
  socket.onmessage = (event) => {
    void handler(parseSyncRuntimeWebSocketMessage(event))
  }
}

export function outboxCompletionCandidateMatches(
  record: LocalStoreOutboxRecord,
  message: Extract<
    ControlMessage,
    { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
  >,
): boolean {
  // `meta-ref-update` items (the DAG-scheduled meta write after a binary upload's
  // blob-put/manifest-put chain) go over the wire as the same sync-update frame as
  // `y-update` and must be completable by the same ack, or their lease never
  // releases and permanently starves the single-slot `sync-control` concurrency lane.
  if (record.kind !== 'y-update' && record.kind !== 'meta-ref-update') {
    return false
  }
  if (record.status !== 'pending' && record.status !== 'retrying') {
    return false
  }
  if (record.docId === undefined || !sameDocId(record.docId, message.docId)) {
    return false
  }
  if (message.type === 'ack') {
    return record.messageId === message.messageId
  }
  if (message.type === 'sync-update-rejected') {
    return (
      record.messageId === message.messageId &&
      record.updateSha256 !== undefined &&
      record.updateSha256 === message.updateSha256
    )
  }
  return record.messageId !== undefined
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta' || right.kind === 'meta') {
    return true
  }
  return left.ydocId === right.ydocId
}

/**
 * Creates the inbound awareness-update apply port used by dispatch.
 *
 * @param input Local awareness instance to feed peer presence into.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.applyRemoteAwareness`.
 */
export function createSyncRuntimeWebSocketAwarenessApplyPort(
  input: SyncRuntimeWebSocketAwarenessApplyPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'applyRemoteAwareness'> {
  return {
    async applyRemoteAwareness(message) {
      input.awareness.applyRemoteState(message.clientId, message.state)
    },
  }
}

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
  const completion =
    input.message.type === 'sync-update-rejected'
      ? planOutboxWorkerSyncUpdateRejectedCompletion({
          itemId: record.id,
          kind: record.kind,
          status: record.status,
          vaultId: input.message.vaultId,
          deviceId: input.message.deviceId,
          docId: input.message.docId,
          messageId,
          updateSha256: record.updateSha256,
          rejection: input.message,
          ownerId: input.ownerId,
          now: input.now,
          currentOutboxRecords: input.snapshot.outboxRecords,
          currentLeaseRows: input.snapshot.leaseRows,
        })
      : planOutboxWorkerAckCompletion({
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
      for (let attempt = 0; attempt < 3; attempt += 1) {
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
        const committed = await input.commit.commit(plan.completion)
        if (committed === undefined || committed.ok) {
          return
        }
        if (attempt === 2) {
          console.warn('[kuroflare] inbound outbox completion retries exhausted', {
            itemId: plan.record.id,
            reason: committed.reason,
          })
        }
      }
    },
  }
}
