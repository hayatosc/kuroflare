import {
  SyncUpdateSchema,
  type NeedFullSnapshot,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/protocol'
import * as v from 'valibot'

/** Server-side evidence for answering a client sync request for one document. */
export interface SyncRequestDocState {
  readonly latestSeq: number
  readonly minRetainedSeq: number
  readonly stateVectorCoversHorizon: boolean
  readonly diffSourceAvailable: boolean
  readonly diffUpdateBase64: string | undefined
}

/** Input for deciding how a Durable Object should answer a sync request. */
export interface SyncRequestDecisionInput {
  readonly request: SyncRequest
  readonly doc: SyncRequestDocState | undefined
  readonly serverProtocolVersion: number
}

/** Decision for a sync request before the caller writes to WebSocket or fetches snapshots. */
export type SyncRequestDecision =
  | { readonly action: 'send-update'; readonly response: SyncUpdate; readonly durableSeq: number }
  | {
      readonly action: 'no-update'
      readonly durableSeq: number
      readonly reason: 'doc-not-found' | 'empty-diff'
    }
  | { readonly action: 'need-full-snapshot'; readonly response: NeedFullSnapshot }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-server-protocol-version'
        | 'invalid-doc-sequence'
        | 'invalid-diff-update'
    }

/**
 * Decides how to answer a guard-validated `sync-request` control message.
 *
 * @param input Request metadata plus caller-provided document retention and diff evidence.
 * @returns A pure response decision. The caller remains responsible for Yjs diff generation and I/O.
 */
export function decideSyncRequest(input: SyncRequestDecisionInput): SyncRequestDecision {
  if (!isNonNegativeSafeInteger(input.serverProtocolVersion)) {
    return { action: 'reject', reason: 'invalid-server-protocol-version' }
  }

  if (input.request.protocolVersion !== input.serverProtocolVersion) {
    return {
      action: 'need-full-snapshot',
      response: makeNeedFullSnapshot(input.request, 'protocol-upgrade'),
    }
  }

  if (!input.doc) {
    return { action: 'no-update', durableSeq: 0, reason: 'doc-not-found' }
  }

  if (!isValidDocStateClock(input.doc)) {
    return { action: 'reject', reason: 'invalid-doc-sequence' }
  }

  if (!input.doc.stateVectorCoversHorizon) {
    return {
      action: 'need-full-snapshot',
      response: makeNeedFullSnapshot(input.request, 'state-vector-too-old'),
    }
  }

  if (!input.doc.diffSourceAvailable) {
    return {
      action: 'need-full-snapshot',
      response: makeNeedFullSnapshot(input.request, 'missing-log'),
    }
  }

  if (input.doc.diffUpdateBase64 === undefined) {
    return { action: 'no-update', durableSeq: input.doc.latestSeq, reason: 'empty-diff' }
  }

  const response: SyncUpdate = {
    type: 'sync-update',
    protocolVersion: input.request.protocolVersion,
    vaultId: input.request.vaultId,
    deviceId: input.request.deviceId,
    messageId: input.request.messageId,
    docId: input.request.docId,
    update: input.doc.diffUpdateBase64,
    baseStateVector: input.request.stateVector,
    durableSeq: input.doc.latestSeq,
  }

  if (!v.is(SyncUpdateSchema, response)) {
    return { action: 'reject', reason: 'invalid-diff-update' }
  }

  return { action: 'send-update', response, durableSeq: input.doc.latestSeq }
}

function makeNeedFullSnapshot(
  request: SyncRequest,
  reason: NeedFullSnapshot['reason'],
): NeedFullSnapshot {
  return {
    type: 'need-full-snapshot',
    protocolVersion: request.protocolVersion,
    vaultId: request.vaultId,
    deviceId: request.deviceId,
    docId: request.docId,
    reason,
  }
}

function isValidDocStateClock(doc: SyncRequestDocState): boolean {
  return (
    isNonNegativeSafeInteger(doc.latestSeq) &&
    isNonNegativeSafeInteger(doc.minRetainedSeq) &&
    doc.minRetainedSeq <= doc.latestSeq
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
