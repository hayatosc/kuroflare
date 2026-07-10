import {
  type OutboxWorkerManifestPutSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
} from '../../sync/engine/worker'
import { safeLogError, retryAfterMsFromHeader, responseErrorCode } from '../helpers'
import type KuroflareSpikePlugin from '../plugin'

export async function fetchJsonSideEffect(
  plugin: KuroflareSpikePlugin,
  request: OutboxWorkerManifestPutSideEffectPlan['putManifestRequest'],
): Promise<
  | { readonly kind: 'success'; readonly body: unknown }
  | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
> {
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    }
    if (request.bodyJson !== undefined) {
      init.body = JSON.stringify(request.bodyJson)
    }
    const response = await fetch(request.url, init)
    if (!response.ok) {
      return await httpFailureResult(response)
    }
    return { kind: 'success', body: await response.json().catch(() => undefined) }
  } catch (error: unknown) {
    console.warn('[kuroflare] JSON side effect failed before HTTP response', {
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function httpFailureResult(
  response: Response,
): Promise<Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>> {
  return {
    kind: 'http-response',
    status: response.status,
    retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
    code: await responseErrorCode(response),
  }
}
