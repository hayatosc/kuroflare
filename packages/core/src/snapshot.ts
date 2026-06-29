import { type DocId } from './ids'
import { type DocLatestSnapshotResponse, type MetaLatestSnapshotResponse } from './snapshot-http'
import { makeSha256Hex, type Sha256Hex } from './meta'

import { hashBytesSha256 } from './hashing'

/** Input for deciding whether a fetched full snapshot may replace local doc state. */
export interface FullSnapshotApplyInput {
  readonly requestedDocId: DocId
  readonly snapshotDocId: DocId
  readonly snapshotSeq: number
  readonly stateVectorBase64: string
  readonly currentSnapshotSeq?: number | undefined
  readonly expectedUpdateSha256: Sha256Hex
  readonly actualUpdateSha256: Sha256Hex
  readonly hasPendingLocalUpdates: boolean
  readonly activeEditorBound: boolean
}

/** Input for normalizing a latest snapshot HTTP response into an apply decision input. */
export interface FullSnapshotApplyInputFromResponseInput {
  readonly requestedDocId: DocId
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly actualUpdateSha256: Sha256Hex
  readonly currentSnapshotSeq?: number | undefined
  readonly hasPendingLocalUpdates: boolean
  readonly activeEditorBound: boolean
}

/** Input for decoding and verifying a latest snapshot HTTP response body. */
export interface FullSnapshotBytesFromResponseInput {
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly maxUpdateBytes?: number | undefined
  readonly maxStateVectorBytes?: number | undefined
}

/** Persistable patch after a full snapshot has been accepted for local application. */
export interface FullSnapshotApplyPatch {
  readonly docId: DocId
  readonly snapshotSeq: number
  readonly remoteCursorSeq: number
  readonly stateVectorBase64: string
  readonly clearPendingForDoc: true
}

/** Decision for applying a full snapshot fetched after a snapshot boundary. */
export type FullSnapshotApplyDecision =
  | { readonly action: 'apply'; readonly patch: FullSnapshotApplyPatch }
  | {
      readonly action: 'wait'
      readonly reason: 'pending-local-updates' | 'active-editor-bound'
    }
  | {
      readonly action: 'skip'
      readonly reason: 'stale-snapshot'
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'doc-mismatch'
        | 'hash-mismatch'
        | 'invalid-snapshot-seq'
        | 'invalid-current-snapshot-seq'
    }

/** Result of decoding and hashing a snapshot response update payload. */
export type FullSnapshotBytesFromResponseResult =
  | {
      readonly ok: true
      readonly updateBytes: Uint8Array
      readonly stateVectorBytes: Uint8Array
      readonly actualUpdateSha256: Sha256Hex
      readonly actualStateVectorSha256: Sha256Hex
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-base64'
        | 'snapshot-too-large'
        | 'state-vector-too-large'
        | 'hash-mismatch'
        | 'state-vector-hash-mismatch'
        | 'invalid-size-limit'
    }

/**
 * Decodes snapshot update bytes from a validated latest snapshot response and verifies its hash.
 *
 * @param input Validated response and optional byte limit.
 * @returns Decoded bytes with their SHA-256 hash, or the reason they cannot be trusted.
 */
export async function decodeFullSnapshotBytesFromResponse(
  input: FullSnapshotBytesFromResponseInput,
): Promise<FullSnapshotBytesFromResponseResult> {
  if (
    input.maxUpdateBytes !== undefined &&
    (!Number.isSafeInteger(input.maxUpdateBytes) || input.maxUpdateBytes < 0)
  ) {
    return { ok: false, reason: 'invalid-size-limit' }
  }
  if (
    input.maxStateVectorBytes !== undefined &&
    (!Number.isSafeInteger(input.maxStateVectorBytes) || input.maxStateVectorBytes < 0)
  ) {
    return { ok: false, reason: 'invalid-size-limit' }
  }

  const updateBytes = decodeBase64Bytes(input.response.updateBytesBase64)
  if (updateBytes === null) {
    return { ok: false, reason: 'invalid-base64' }
  }
  const stateVectorBytes = decodeBase64Bytes(input.response.stateVector)
  if (stateVectorBytes === null) {
    return { ok: false, reason: 'invalid-base64' }
  }
  if (input.maxUpdateBytes !== undefined && updateBytes.byteLength > input.maxUpdateBytes) {
    return { ok: false, reason: 'snapshot-too-large' }
  }
  if (
    input.maxStateVectorBytes !== undefined &&
    stateVectorBytes.byteLength > input.maxStateVectorBytes
  ) {
    return { ok: false, reason: 'state-vector-too-large' }
  }

  const actualUpdateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  if (actualUpdateSha256 !== input.response.updateSha256) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  const actualStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVectorBytes))
  if (actualStateVectorSha256 !== input.response.stateVectorSha256) {
    return { ok: false, reason: 'state-vector-hash-mismatch' }
  }

  return { ok: true, updateBytes, stateVectorBytes, actualUpdateSha256, actualStateVectorSha256 }
}

/**
 * Normalizes a validated latest snapshot HTTP response into a local apply decision input.
 *
 * @param input Requested doc, validated response, computed update hash, and local safety evidence.
 * @returns Input suitable for `decideFullSnapshotApply`.
 */
export function makeFullSnapshotApplyInputFromResponse(
  input: FullSnapshotApplyInputFromResponseInput,
): FullSnapshotApplyInput {
  const snapshotDocId =
    'docId' in input.response ? input.response.docId : ({ kind: 'meta' } as const)
  return {
    requestedDocId: input.requestedDocId,
    snapshotDocId,
    snapshotSeq: input.response.snapshotSeq,
    stateVectorBase64: input.response.stateVector,
    currentSnapshotSeq: input.currentSnapshotSeq,
    expectedUpdateSha256: input.response.updateSha256,
    actualUpdateSha256: input.actualUpdateSha256,
    hasPendingLocalUpdates: input.hasPendingLocalUpdates,
    activeEditorBound: input.activeEditorBound,
  }
}

/**
 * Decides whether a fetched full snapshot may replace local YDoc state.
 *
 * @param input Snapshot identity, integrity evidence, and local safety gates.
 * @returns Whether to apply, wait, skip, or reject the snapshot.
 */
export function decideFullSnapshotApply(input: FullSnapshotApplyInput): FullSnapshotApplyDecision {
  if (!sameDocId(input.requestedDocId, input.snapshotDocId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }
  if (!isNonNegativeSafeInteger(input.snapshotSeq)) {
    return { action: 'reject', reason: 'invalid-snapshot-seq' }
  }
  if (
    input.currentSnapshotSeq !== undefined &&
    !isNonNegativeSafeInteger(input.currentSnapshotSeq)
  ) {
    return { action: 'reject', reason: 'invalid-current-snapshot-seq' }
  }
  if (input.expectedUpdateSha256 !== input.actualUpdateSha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }
  if (input.currentSnapshotSeq !== undefined && input.snapshotSeq <= input.currentSnapshotSeq) {
    return { action: 'skip', reason: 'stale-snapshot' }
  }
  if (input.hasPendingLocalUpdates) {
    return { action: 'wait', reason: 'pending-local-updates' }
  }
  if (input.activeEditorBound) {
    return { action: 'wait', reason: 'active-editor-bound' }
  }

  return {
    action: 'apply',
    patch: {
      docId: input.snapshotDocId,
      snapshotSeq: input.snapshotSeq,
      remoteCursorSeq: input.snapshotSeq,
      stateVectorBase64: input.stateVectorBase64,
      clearPendingForDoc: true,
    },
  }
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta') {
    return true
  }
  return right.kind === 'file' && left.ydocId === right.ydocId
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const BASE64_DECODE_TABLE = new Int16Array(128).fill(-1)
for (const [index, char] of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  .split('')
  .entries()) {
  BASE64_DECODE_TABLE[char.charCodeAt(0)] = index
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) {
    return null
  }
  if (value.length === 0) {
    return new Uint8Array()
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const outputLength = (value.length / 4) * 3 - padding
  const output = new Uint8Array(outputLength)
  let outputOffset = 0

  for (let offset = 0; offset < value.length; offset += 4) {
    const finalChunk = offset === value.length - 4
    const first = decodeBase64Char(value.charCodeAt(offset))
    const second = decodeBase64Char(value.charCodeAt(offset + 1))
    const third = value[offset + 2] === '=' ? -2 : decodeBase64Char(value.charCodeAt(offset + 2))
    const fourth = value[offset + 3] === '=' ? -2 : decodeBase64Char(value.charCodeAt(offset + 3))

    if (first < 0 || second < 0 || third === -1 || fourth === -1) {
      return null
    }
    if ((third === -2 || fourth === -2) && !finalChunk) {
      return null
    }
    if (third === -2 && fourth !== -2) {
      return null
    }

    const thirdValue = third < 0 ? 0 : third
    const fourthValue = fourth < 0 ? 0 : fourth
    const triple = (first << 18) | (second << 12) | (thirdValue << 6) | fourthValue

    if (outputOffset < output.length) {
      output[outputOffset] = (triple >> 16) & 0xff
      outputOffset += 1
    }
    if (third !== -2 && outputOffset < output.length) {
      output[outputOffset] = (triple >> 8) & 0xff
      outputOffset += 1
    }
    if (fourth !== -2 && outputOffset < output.length) {
      output[outputOffset] = triple & 0xff
      outputOffset += 1
    }
  }

  return outputOffset === output.length ? output : null
}

function decodeBase64Char(charCode: number): number {
  return charCode < BASE64_DECODE_TABLE.length ? (BASE64_DECODE_TABLE[charCode] ?? -1) : -1
}
