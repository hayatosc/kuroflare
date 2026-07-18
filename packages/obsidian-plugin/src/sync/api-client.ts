import type { AppType } from '@kuroflare/worker'
import { hc } from 'hono/client'

/**
 * Typed Hono RPC client bound to a specific worker endpoint.
 *
 * @param endpoint Full worker origin URL (e.g. `https://worker.example`).
 * @param accessToken Optional Bearer token attached to every request.
 * @returns Typed RPC client with per-route intellisense.
 */
export function createWorkerClient(endpoint: string, accessToken?: string) {
  const headers: Record<string, string> = {}
  if (accessToken !== undefined && accessToken.length > 0) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }
  return hc<AppType>(endpoint, { headers })
}

export type WorkerClient = ReturnType<typeof createWorkerClient>
