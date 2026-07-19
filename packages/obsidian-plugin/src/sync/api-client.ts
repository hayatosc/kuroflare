import type { AppType } from '@kuroflare/worker'
import { hc } from 'hono/client'
import type { ClientRequestOptions } from 'hono/client'

/**
 * Typed Hono RPC client bound to a specific worker endpoint.
 *
 * The endpoint's pathname and search are stripped before creating the client so that
 * all route paths are relative to the origin. This matches the legacy URL construction
 * that always replaced pathname with the target route.
 *
 * @param endpoint Full worker origin URL (e.g. `https://worker.example` or `https://worker.example/base`).
 * @param accessToken Optional Bearer token attached to every request.
 * @param fetchImpl Optional fetch override used for testing.
 * @returns Typed RPC client with per-route intellisense.
 */
export function createWorkerClient(
  endpoint: string,
  accessToken?: string,
  fetchImpl?: typeof fetch,
) {
  const options: ClientRequestOptions = {}
  const headers: Record<string, string> = {}
  if (accessToken !== undefined && accessToken.length > 0) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }
  if (Object.keys(headers).length > 0) {
    options.headers = headers
  }
  if (fetchImpl !== undefined) {
    options.fetch = fetchImpl
  }
  return hc<AppType>(normalizeEndpointOrigin(endpoint), options)
}

export type WorkerClient = ReturnType<typeof createWorkerClient>

function normalizeEndpointOrigin(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}
