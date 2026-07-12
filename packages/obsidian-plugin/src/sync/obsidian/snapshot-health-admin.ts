import {
  DocIdSchema,
  SnapshotHealthListResponseSchema,
  SnapshotHealthMutationResponseSchema,
  SnapshotHealthQuarantineRequestSchema,
  SnapshotHealthVerifyRequestSchema,
  SnapshotRollbackRequestSchema,
  SnapshotRollbackResponseSchema,
  type DocId,
  type SnapshotHealthEntry,
  type SnapshotHealthListResponse,
  type SnapshotHealthMutationResponse,
  type SnapshotHealthQuarantineRequest,
  type SnapshotHealthVerifyRequest,
  type SnapshotRollbackResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

import type { LocalSetupMetadata } from '../engine/setup'

/** HTTP boundary used by snapshot health administration requests. */
export interface SnapshotHealthAdminHttpPort {
  /**
   * Sends one request to the worker.
   *
   * @param url Absolute worker URL.
   * @param init Request method, headers, and optional body.
   * @returns Worker response.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/** Result of listing guarded snapshot health entries. */
export type SnapshotHealthListResult =
  | { readonly ok: true; readonly response: SnapshotHealthListResponse }
  | {
      readonly ok: false
      readonly reason: 'invalid-request' | 'http-failed' | 'invalid-response'
      readonly status?: number
    }

/** Result of a guarded verify or quarantine mutation. */
export type SnapshotHealthMutationResult =
  | { readonly ok: true; readonly response: SnapshotHealthMutationResponse }
  | {
      readonly ok: false
      readonly reason: 'invalid-request' | 'http-failed' | 'invalid-response'
      readonly status?: number
    }

/** Result of a guarded rollback mutation. */
export type SnapshotRollbackResult =
  | { readonly ok: true; readonly response: SnapshotRollbackResponse }
  | {
      readonly ok: false
      readonly reason: 'invalid-request' | 'http-failed' | 'invalid-response'
      readonly status?: number
    }

/** Input shared by snapshot health list requests. */
export interface SnapshotHealthListInput {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly docId: DocId
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
  readonly http: SnapshotHealthAdminHttpPort
}

/**
 * Fetches one guarded page of snapshot health entries for an authenticated operator.
 *
 * @param input Setup identity, device token, document pagination, and HTTP port.
 * @returns Guarded list response or a non-secret failure reason.
 */
export async function fetchSnapshotHealthEntries(
  input: SnapshotHealthListInput,
): Promise<SnapshotHealthListResult> {
  const limit = input.limit ?? 64
  if (
    typeof input.accessToken !== 'string' ||
    input.accessToken.trim().length === 0 ||
    !v.is(DocIdSchema, input.docId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 256 ||
    (input.cursor !== undefined && !isSnapshotHealthCursor(input.cursor))
  ) {
    return { ok: false, reason: 'invalid-request' }
  }

  const url = snapshotHealthListUrl(input.setup, input.docId, limit, input.cursor)
  let response: Response
  try {
    response = await input.http.fetch(url, {
      headers: authorizationHeaders(input.accessToken),
    })
  } catch {
    return { ok: false, reason: 'http-failed' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(SnapshotHealthListResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, response: body }
}

/**
 * Verifies and approves one legacy or unverified snapshot generation.
 *
 * @param input Setup identity, device token, guarded request, and HTTP port.
 * @returns Guarded mutation response or a non-secret failure reason.
 */
export async function verifySnapshotHealthEntry(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly request: unknown
  readonly http: SnapshotHealthAdminHttpPort
}): Promise<SnapshotHealthMutationResult> {
  const request: unknown = input.request
  if (
    typeof input.accessToken !== 'string' ||
    input.accessToken.trim().length === 0 ||
    !v.is(SnapshotHealthVerifyRequestSchema, request)
  ) {
    return { ok: false, reason: 'invalid-request' }
  }
  return await postSnapshotHealthMutation(
    input.setup,
    input.accessToken,
    'verify',
    request,
    input.http,
  )
}

/**
 * Logically quarantines one snapshot generation while preserving its evidence.
 *
 * @param input Setup identity, device token, guarded request, and HTTP port.
 * @returns Guarded mutation response or a non-secret failure reason.
 */
export async function quarantineSnapshotHealthEntry(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly request: unknown
  readonly http: SnapshotHealthAdminHttpPort
}): Promise<SnapshotHealthMutationResult> {
  const request: unknown = input.request
  if (
    typeof input.accessToken !== 'string' ||
    input.accessToken.trim().length === 0 ||
    !v.is(SnapshotHealthQuarantineRequestSchema, request)
  ) {
    return { ok: false, reason: 'invalid-request' }
  }
  return await postSnapshotHealthMutation(
    input.setup,
    input.accessToken,
    'quarantine',
    request,
    input.http,
  )
}

/**
 * Creates a new authoritative generation from one verified healthy source.
 *
 * @param input Setup identity, device token, guarded request, and HTTP port.
 * @returns Guarded rollback response or a non-secret failure reason.
 */
export async function rollbackSnapshotHealthEntry(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly request: unknown
  readonly http: SnapshotHealthAdminHttpPort
}): Promise<SnapshotRollbackResult> {
  const request: unknown = input.request
  if (
    typeof input.accessToken !== 'string' ||
    input.accessToken.trim().length === 0 ||
    !v.is(SnapshotRollbackRequestSchema, request)
  ) {
    return { ok: false, reason: 'invalid-request' }
  }
  let response: Response
  try {
    response = await input.http.fetch(snapshotHealthMutationUrl(input.setup, 'rollback'), {
      method: 'POST',
      headers: jsonAuthorizationHeaders(input.accessToken),
      body: JSON.stringify(request),
    })
  } catch {
    return { ok: false, reason: 'http-failed' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(SnapshotRollbackResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, response: body }
}

/**
 * Returns the worker query value accepted by the snapshot health endpoint.
 *
 * @param docId Document identifier selected by the operator.
 * @returns Worker query representation of the document identifier.
 */
export function snapshotHealthDocIdQueryValue(docId: DocId): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
}

/**
 * Narrows an operator-entered cursor to the server's positive integer format.
 *
 * @param value Candidate pagination cursor.
 * @returns Whether the cursor is a positive safe integer string.
 */
export function isSnapshotHealthCursor(value: string): boolean {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
}

/**
 * Returns a short status label for a snapshot health entry.
 *
 * @param entry Guarded snapshot health entry.
 * @returns Combined physical and logical status label.
 */
export function snapshotHealthEntryStatus(entry: SnapshotHealthEntry): string {
  return `${entry.physicalStatus}/${entry.logicalStatus}`
}

async function postSnapshotHealthMutation(
  setup: LocalSetupMetadata,
  accessToken: string,
  action: 'verify' | 'quarantine',
  request: SnapshotHealthVerifyRequest | SnapshotHealthQuarantineRequest,
  http: SnapshotHealthAdminHttpPort,
): Promise<SnapshotHealthMutationResult> {
  let response: Response
  try {
    response = await http.fetch(snapshotHealthMutationUrl(setup, action), {
      method: 'POST',
      headers: jsonAuthorizationHeaders(accessToken),
      body: JSON.stringify(request),
    })
  } catch {
    return { ok: false, reason: 'http-failed' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(SnapshotHealthMutationResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, response: body }
}

function snapshotHealthListUrl(
  setup: LocalSetupMetadata,
  docId: DocId,
  limit: number,
  cursor: string | undefined,
): string {
  const url = new URL(setup.endpoint)
  url.pathname = '/admin/snapshots'
  url.search = ''
  url.hash = ''
  url.searchParams.set('docId', snapshotHealthDocIdQueryValue(docId))
  url.searchParams.set('limit', String(limit))
  if (cursor !== undefined) url.searchParams.set('cursor', cursor)
  return url.toString()
}

function snapshotHealthMutationUrl(
  setup: LocalSetupMetadata,
  action: 'verify' | 'quarantine' | 'rollback',
): string {
  const url = new URL(setup.endpoint)
  url.pathname = `/admin/snapshots/${action}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function authorizationHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` }
}

function jsonAuthorizationHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}
