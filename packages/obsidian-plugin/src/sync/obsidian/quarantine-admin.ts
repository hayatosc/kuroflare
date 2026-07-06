import {
  QuarantinedUpdateActionDryRunResponseSchema,
  QuarantinedUpdateActionResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  type QuarantinedUpdateActionDryRunResponse,
  type QuarantinedUpdateActionRequest,
  type QuarantinedUpdateActionResponse,
  type QuarantinedUpdateDetailResponse,
  type QuarantinedUpdateEntry,
} from '@kuroflare/core'
import * as v from 'valibot'

import type { LocalSetupMetadata } from '../engine/setup'

export type QuarantineAdminAction = QuarantinedUpdateActionRequest['action']

export interface QuarantineAdminHttpPort {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export type QuarantineAdminListResult =
  | { readonly ok: true; readonly entries: readonly QuarantinedUpdateEntry[] }
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

/** Fetches the server-side quarantine list for settings-panel inspection. */
export async function fetchQuarantineAdminEntries(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminListResult> {
  const response = await input.http.fetch(quarantineAdminUrl(input.setup), {
    headers: authorizationHeaders(input.accessToken),
  })
  if (!response.ok) {
    return { ok: false, reason: 'http-failed', status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateListResponseSchema, body)) {
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: true, entries: body.entries }
}

/** Fetches one quarantined update detail, including update bytes when the server allows it. */
export async function fetchQuarantineAdminDetail(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly id: string
  readonly http: QuarantineAdminHttpPort
}): Promise<QuarantineAdminDetailResult> {
  const response = await input.http.fetch(quarantineAdminUrl(input.setup, input.id), {
    headers: authorizationHeaders(input.accessToken),
  })
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
  const response = await input.http.fetch(
    quarantineAdminActionUrl(input.setup, input.id, input.action),
    {
      method: 'POST',
      headers: jsonAuthorizationHeaders(input.accessToken),
      body: JSON.stringify({ mode: 'dry-run' }),
    },
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
  const response = await input.http.fetch(
    quarantineAdminActionUrl(input.setup, input.id, input.action),
    {
      method: 'POST',
      headers: jsonAuthorizationHeaders(input.accessToken),
      body: JSON.stringify({
        mode: 'execute',
        confirmationToken: input.confirmationToken,
        reason: 'obsidian-plugin-admin',
      }),
    },
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

function quarantineAdminUrl(setup: LocalSetupMetadata, id?: string): string {
  const url = new URL(setup.endpoint)
  url.pathname =
    id === undefined ? '/admin/quarantine' : `/admin/quarantine/${encodeURIComponent(id)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function quarantineAdminActionUrl(
  setup: LocalSetupMetadata,
  id: string,
  action: QuarantineAdminAction,
): string {
  const url = new URL(setup.endpoint)
  url.pathname = `/admin/quarantine/${encodeURIComponent(id)}/${action}`
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
