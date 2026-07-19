import {
  QuarantineAuditListResponseSchema,
  QuarantinedUpdateActionDryRunResponseSchema,
  QuarantinedUpdateActionResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  type QuarantineAuditListResponse,
  type QuarantinedUpdateActionDryRunResponse,
  type QuarantinedUpdateActionRequest,
  type QuarantinedUpdateActionResponse,
  type QuarantinedUpdateDetailResponse,
  type QuarantinedUpdateListResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

import type { WorkerClient } from '../api-client'
import type { LocalSetupMetadata } from '../engine/setup'

export type QuarantineAdminAction = QuarantinedUpdateActionRequest['action']

export type QuarantineAdminHttpPort = WorkerClient

export type QuarantineAdminListResult =
  | { readonly ok: true; readonly response: QuarantinedUpdateListResponse }
  | {
      readonly ok: false
      readonly reason: 'http-failed' | 'invalid-response'
      readonly status?: number
    }

export type QuarantineAdminAuditResult =
  | { readonly ok: true; readonly response: QuarantineAuditListResponse }
  | {
      readonly ok: false
      readonly reason: 'http-failed' | 'invalid-response'
      readonly status?: number
    }

export type QuarantineAdminDetailResult =
  | { readonly ok: true; readonly detail: QuarantinedUpdateDetailResponse }
  | {
      readonly ok: false
      readonly reason: 'http-failed' | 'invalid-response'
      readonly status?: number
    }

export type QuarantineAdminPrepareResult =
  | { readonly ok: true; readonly dryRun: QuarantinedUpdateActionDryRunResponse }
  | {
      readonly ok: false
      readonly reason: 'http-failed' | 'invalid-response' | 'mismatched-response'
      readonly status?: number
    }

export type QuarantineAdminExecuteResult =
  | { readonly ok: true; readonly response: QuarantinedUpdateActionResponse }
  | {
      readonly ok: false
      readonly reason: 'http-failed' | 'invalid-response' | 'mismatched-response'
      readonly status?: number
    }

/** Fetches one guarded page of the server-side quarantine list for settings-panel inspection. */
export async function fetchQuarantineAdminEntries(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminListResult> {
  const query: Record<string, string> = {}
  if (input.limit !== undefined) query.limit = String(input.limit)
  if (input.cursor !== undefined) query.cursor = input.cursor

  const response = await input.http.admin.quarantine.$get(
    { query },
    { headers: authorizationHeaders(input.accessToken) },
  )
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateListResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, response: body }
}

/** Fetches one guarded page of the resolved-quarantine audit trail. */
export async function fetchQuarantineAdminAudit(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminAuditResult> {
  const query: Record<string, string> = {}
  if (input.limit !== undefined) query.limit = String(input.limit)
  if (input.cursor !== undefined) query.cursor = input.cursor

  const response = await input.http.admin.quarantine.audit.$get(
    { query },
    { headers: authorizationHeaders(input.accessToken) },
  )
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantineAuditListResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, response: body }
}

/** Fetches one quarantined update detail, including update bytes when the server allows it. */
export async function fetchQuarantineAdminDetail(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly id: string
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminDetailResult> {
  const response = await input.http.admin.quarantine[':id'].$get(
    { param: { id: input.id } },
    { headers: authorizationHeaders(input.accessToken) },
  )
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateDetailResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, detail: body }
}

/** Runs a destructive quarantine action dry-run and validates the target echo. */
export async function prepareQuarantineAdminAction(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly id: string
  readonly action: QuarantineAdminAction
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminPrepareResult> {
  const response = await input.http.admin.quarantine[':id'][input.action].$post(
    { param: { id: input.id }, json: { mode: 'dry-run' } },
    { headers: authorizationHeaders(input.accessToken) },
  )
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateActionDryRunResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  if (body.id !== input.id || body.action !== input.action) {
    return { ok: false, reason: 'mismatched-response' }
  }
  return { ok: true, dryRun: body }
}

/** Executes a previously prepared quarantine action with its server confirmation token. */
export async function executeQuarantineAdminAction(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly id: string
  readonly action: QuarantineAdminAction
  readonly confirmationToken: string
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminExecuteResult> {
  const response = await input.http.admin.quarantine[':id'][input.action].$post(
    {
      param: { id: input.id },
      json: {
        mode: 'execute',
        confirmationToken: input.confirmationToken,
        reason: 'obsidian-plugin-admin',
      },
    },
    { headers: authorizationHeaders(input.accessToken) },
  )
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateActionResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  if (body.id !== input.id || body.action !== input.action) {
    return { ok: false, reason: 'mismatched-response' }
  }
  return { ok: true, response: body }
}

function authorizationHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` }
}
