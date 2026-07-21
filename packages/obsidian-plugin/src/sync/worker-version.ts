import { WorkerVersionResponseSchema, type WorkerVersionResponse } from '@kuroflare/core'
import * as v from 'valibot'

/** Result of the unauthenticated public Worker version probe. */
export type WorkerVersionFetchResult =
  | { readonly ok: true; readonly value: WorkerVersionResponse }
  | {
      readonly ok: false
      readonly reason: 'network' | 'http' | 'invalid-response'
      readonly status?: number | undefined
    }

/**
 * Fetches and validates the public Worker version document.
 *
 * This endpoint is deliberately unauthenticated. The request must never carry
 * the sync access token or any other secret material.
 */
export async function fetchWorkerVersion(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerVersionFetchResult> {
  let url: string
  try {
    url = versionEndpoint(endpoint)
  } catch {
    return { ok: false, reason: 'network' }
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!response.ok) {
    return { ok: false, reason: 'http', status: response.status }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'invalid-response', status: response.status }
  }

  const parsed = v.safeParse(WorkerVersionResponseSchema, body)
  return parsed.success
    ? { ok: true, value: parsed.output }
    : { ok: false, reason: 'invalid-response', status: response.status }
}

function versionEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = '/version'
  url.search = ''
  url.hash = ''
  return url.toString()
}
