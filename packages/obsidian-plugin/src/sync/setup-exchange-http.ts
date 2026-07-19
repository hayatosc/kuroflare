import {
  DeviceIdSchema,
  SetupExchangeRequestSchema,
  SetupExchangeResponseSchema,
  VaultIdSchema,
  type DeviceId,
  type SetupExchangeRequest,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

import { createWorkerClient } from './api-client'
import {
  createSyncRuntimeSetupExchangePort,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeSetupExchangeReplanRequest,
} from './engine/actuation'
import { type SyncEngineStartupEffect } from './engine/engine'

/** Startup setup exchange effect accepted by the HTTP-backed setup exchange port. */
export type SetupExchangeStartupEffect = Extract<
  SyncEngineStartupEffect,
  { readonly kind: 'run-setup-exchange' }
>

/** Input for exchanging a setup token for local device credentials. */
export interface SetupExchangeHttpInput {
  readonly endpoint: string
  readonly request: SetupExchangeRequest
}

/** Raw setup request evidence read from plugin settings or setup UI fields. */
export interface SetupExchangeRequestEvidence {
  readonly vaultId: string
  readonly setupToken: string
  readonly requestedDeviceName: string
  readonly existingDeviceId?: string | undefined
}

/** Runtime setup exchange evidence read just-in-time from plugin settings or setup UI. */
export interface SetupExchangeRuntimeEvidence {
  readonly endpoint: string
  readonly request: SetupExchangeRequestEvidence
}

/** Planned setup exchange request without exposing setup-token material on failures. */
export type SetupExchangeRequestBuildPlan =
  | {
      readonly ok: true
      readonly request: SetupExchangeRequest
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-vault-id'
        | 'missing-setup-token'
        | 'invalid-requested-device-name'
        | 'invalid-existing-device-id'
        | 'invalid-setup-exchange-request'
    }

/** Input for creating an HTTP-backed startup setup exchange port. */
export interface HttpSyncRuntimeSetupExchangePortInput {
  readonly endpoint: string
  readonly buildRequest: (effect: SetupExchangeStartupEffect) => SetupExchangeRequest
  readonly scheduleReplan: (request: SyncRuntimeSetupExchangeReplanRequest) => Promise<void>
}

/** Input for creating a settings-backed HTTP startup setup exchange port. */
export interface EvidenceBackedHttpSyncRuntimeSetupExchangePortInput {
  readonly readEvidence: (effect: SetupExchangeStartupEffect) => SetupExchangeRuntimeEvidence
  readonly scheduleReplan: (request: SyncRuntimeSetupExchangeReplanRequest) => Promise<void>
}

const INVALID_OPTIONAL_DEVICE_ID = Symbol('invalid-optional-device-id')

/**
 * Exchanges a setup token with the worker and validates the setup response.
 *
 * @param input Worker endpoint, guarded setup request.
 * @param fetchImpl Optional fetch override for testability.
 * @returns Validated setup response ready for startup replan.
 * @throws When the endpoint/request is invalid, HTTP fails, JSON parsing fails, or response validation fails.
 */
export async function requestSetupExchange(
  input: SetupExchangeHttpInput,
  fetchImpl?: typeof fetch,
): Promise<SetupExchangeResponse> {
  if (!v.is(SetupExchangeRequestSchema, input.request)) {
    throw new Error('invalid-setup-exchange-request')
  }

  const normalizedEndpoint = validateEndpoint(input.endpoint)
  const client = createWorkerClient(normalizedEndpoint, undefined, fetchImpl)
  const response = await client.setup.exchange.$post({ json: input.request })
  if (!response.ok) {
    throw new Error(`setup-exchange-http:${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    throw new Error('setup-exchange-invalid-json', { cause: error })
  }

  if (!v.is(SetupExchangeResponseSchema, body)) {
    throw new Error('invalid-setup-exchange-response')
  }
  return body
}

/**
 * Builds a guarded setup exchange request from raw setup UI/settings evidence.
 *
 * @param evidence Raw setup values supplied by the user or plugin settings.
 * @returns A valid protocol request, or a non-secret failure reason.
 */
export function buildSetupExchangeRequest(
  evidence: SetupExchangeRequestEvidence,
): SetupExchangeRequestBuildPlan {
  const vaultId = evidence.vaultId.trim()
  if (!v.is(VaultIdSchema, vaultId)) {
    return { ok: false, reason: 'invalid-vault-id' }
  }

  const setupToken = evidence.setupToken.trim()
  if (setupToken.length === 0) {
    return { ok: false, reason: 'missing-setup-token' }
  }

  const requestedDeviceName = evidence.requestedDeviceName.trim()
  if (requestedDeviceName.length === 0) {
    return { ok: false, reason: 'invalid-requested-device-name' }
  }

  const existingDeviceId = optionalDeviceId(evidence.existingDeviceId)
  if (existingDeviceId === INVALID_OPTIONAL_DEVICE_ID) {
    return { ok: false, reason: 'invalid-existing-device-id' }
  }

  const request =
    existingDeviceId === undefined
      ? {
          vaultId,
          setupToken,
          requestedDeviceName,
        }
      : {
          vaultId,
          setupToken,
          requestedDeviceName,
          existingDeviceId,
        }
  if (!v.is(SetupExchangeRequestSchema, request)) {
    return { ok: false, reason: 'invalid-setup-exchange-request' }
  }
  return { ok: true, request }
}

/**
 * Creates a startup setup exchange port backed by the worker HTTP API.
 *
 * @param input Endpoint, request builder, and replan scheduler.
 * @returns Setup exchange startup port that validates the HTTP response before scheduling replan.
 */
export function createHttpSyncRuntimeSetupExchangePort(
  input: HttpSyncRuntimeSetupExchangePortInput,
): SyncRuntimeSetupExchangePort {
  return createSyncRuntimeSetupExchangePort({
    async exchange(effect) {
      return requestSetupExchange({
        endpoint: input.endpoint,
        request: input.buildRequest(effect),
      })
    },
    scheduleReplan: input.scheduleReplan,
  })
}

/**
 * Creates a startup setup exchange port backed by raw setup UI/settings evidence.
 *
 * @param input Evidence reader and replan scheduler.
 * @returns Setup exchange startup port that guards setup request evidence before HTTP exchange.
 */
export function createEvidenceBackedHttpSyncRuntimeSetupExchangePort(
  input: EvidenceBackedHttpSyncRuntimeSetupExchangePortInput,
): SyncRuntimeSetupExchangePort {
  return createSyncRuntimeSetupExchangePort({
    async exchange(effect) {
      const evidence = input.readEvidence(effect)
      const requestPlan = buildSetupExchangeRequest(evidence.request)
      if (!requestPlan.ok) {
        throw new Error(`setup-exchange-request:${requestPlan.reason}`)
      }
      return requestSetupExchange({
        endpoint: evidence.endpoint,
        request: requestPlan.request,
      })
    },
    scheduleReplan: input.scheduleReplan,
  })
}

function validateEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (error: unknown) {
    throw new Error('invalid-setup-exchange-endpoint', { cause: error })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('invalid-setup-exchange-endpoint')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('invalid-setup-exchange-endpoint')
  }
  // Normalize: strip pathname/search so hc treats it as a clean origin.
  url.pathname = ''
  url.search = ''
  return url.toString()
}

function optionalDeviceId(
  value: string | undefined,
): typeof INVALID_OPTIONAL_DEVICE_ID | DeviceId | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim()
  if (normalized.length === 0) {
    return undefined
  }
  if (!v.is(DeviceIdSchema, normalized)) {
    return INVALID_OPTIONAL_DEVICE_ID
  }
  return normalized
}
