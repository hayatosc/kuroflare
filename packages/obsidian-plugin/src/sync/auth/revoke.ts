import {
  applyClientAuthMetadataRevokePatch,
  decideClientDeviceRevoke,
  RevokeDeviceResponseSchema,
  type ClientAuthMetadata,
  type ClientAuthMetadataPatchDecision,
  type ClientDeviceRevokeDecision,
  type RevokeDeviceResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

import { LOCAL_AUTH_METADATA_KEY, type LocalSetupMetadataPutOperation } from '../engine/setup'
import {
  commitLocalStoreIndexedDbMetadataTransaction,
  planLocalStoreIndexedDbMetadataWrites,
  type LocalStoreIndexedDbMetadataDatabasePort,
} from '../store/indexeddb'

/** SecretStorage surface required by local device revoke persistence. */
export interface AuthRevokeSecretStoragePort {
  /** Deletes one local token secret by key. */
  delete(key: string): Promise<void>
}

/** Metadata persistence surface required by local device revoke. */
export interface AuthRevokeMetadataPort {
  /** Commits the revoked auth metadata record in one durable transaction. */
  commit(write: LocalSetupMetadataPutOperation): Promise<void>
}

/** Input for applying a successful local device revoke response. */
export interface AuthRevokeRuntimeInput {
  readonly response: unknown
  readonly metadata: ClientAuthMetadata
  readonly secretStorage: AuthRevokeSecretStoragePort
  readonly metadataStore: AuthRevokeMetadataPort
}

/** One local token secret delete requested by a revoke patch. */
export interface AuthRevokeSecretDeleteEffect {
  readonly kind: 'delete-secret'
  readonly key: string
  readonly token: 'access' | 'refresh'
}

/** One local token secret delete that failed while persisting revoke state. */
export interface AuthRevokeSecretDeleteFailure {
  readonly key: string
  readonly token: 'access' | 'refresh'
  readonly error: unknown
}

/** Successful local revoke result after metadata is durable. */
export interface SuccessfulAuthRevokeRuntimePlan {
  readonly ok: true
  readonly response: RevokeDeviceResponse
  readonly revokeDecision: Extract<ClientDeviceRevokeDecision, { readonly action: 'mark-revoked' }>
  readonly metadataPatch: Extract<ClientAuthMetadataPatchDecision, { readonly action: 'apply' }>
  readonly secretDeletes: readonly AuthRevokeSecretDeleteEffect[]
  readonly secretDeleteFailures: readonly AuthRevokeSecretDeleteFailure[]
  readonly metadataPut: LocalSetupMetadataPutOperation
  readonly stopSync: true
}

/** Failed local revoke result before revoked metadata became durable. */
export type FailedAuthRevokeRuntimePlan =
  | {
      readonly ok: false
      readonly phase: 'response'
      readonly reason: 'invalid-revoke-response'
    }
  | {
      readonly ok: false
      readonly phase: 'revoke-decision'
      readonly response: RevokeDeviceResponse
      readonly revokeDecision: Extract<ClientDeviceRevokeDecision, { readonly action: 'reject' }>
    }
  | {
      readonly ok: false
      readonly phase: 'metadata-patch'
      readonly response: RevokeDeviceResponse
      readonly revokeDecision: Extract<
        ClientDeviceRevokeDecision,
        { readonly action: 'mark-revoked' }
      >
      readonly metadataPatch: Extract<
        ClientAuthMetadataPatchDecision,
        { readonly action: 'reject' }
      >
    }
  | {
      readonly ok: false
      readonly phase: 'metadata-commit'
      readonly response: RevokeDeviceResponse
      readonly revokeDecision: Extract<
        ClientDeviceRevokeDecision,
        { readonly action: 'mark-revoked' }
      >
      readonly metadataPatch: Extract<ClientAuthMetadataPatchDecision, { readonly action: 'apply' }>
      readonly secretDeletes: readonly AuthRevokeSecretDeleteEffect[]
      readonly secretDeleteFailures: readonly AuthRevokeSecretDeleteFailure[]
      readonly metadataPut: LocalSetupMetadataPutOperation
      readonly error: unknown
    }

/** Result of applying a local device revoke response. */
export type AuthRevokeRuntimePlan = SuccessfulAuthRevokeRuntimePlan | FailedAuthRevokeRuntimePlan

/**
 * Adapts the concrete IndexedDB metadata transaction runner to the auth revoke runtime port.
 *
 * @param database Database port that opens the metadata object-store transaction.
 * @returns Metadata runtime port that commits revoked auth metadata in one IndexedDB transaction.
 */
export function createAuthRevokeIndexedDbMetadataPort(
  database: LocalStoreIndexedDbMetadataDatabasePort,
): AuthRevokeMetadataPort {
  return {
    async commit(write) {
      const writes = planLocalStoreIndexedDbMetadataWrites([write])
      await commitLocalStoreIndexedDbMetadataTransaction({ database, writes })
    },
  }
}

/**
 * Persists local auth state after this device has been revoked.
 *
 * Token secrets are deleted before revoked metadata is committed. Delete failures are reported but
 * do not restore token material or keep the device active; the revoked metadata drops secret key
 * references so later startup cannot use stale secrets.
 *
 * @param input Guarded or raw revoke response, current auth metadata, and concrete storage ports.
 * @returns Revoke persistence evidence, or the phase that rejected/failed.
 */
export async function persistLocalDeviceRevoke(
  input: AuthRevokeRuntimeInput,
): Promise<AuthRevokeRuntimePlan> {
  if (!v.is(RevokeDeviceResponseSchema, input.response)) {
    return { ok: false, phase: 'response', reason: 'invalid-revoke-response' }
  }
  const response = input.response

  const revokeDecision = decideClientDeviceRevoke({
    response,
    expectedDeviceId: input.metadata.deviceId,
    previousTokenVersion: input.metadata.tokenVersion,
  })
  if (revokeDecision.action === 'reject') {
    return { ok: false, phase: 'revoke-decision', response, revokeDecision }
  }

  const metadataPatch = applyClientAuthMetadataRevokePatch({
    metadata: input.metadata,
    patch: revokeDecision.patch,
  })
  if (metadataPatch.action === 'reject') {
    return { ok: false, phase: 'metadata-patch', response, revokeDecision, metadataPatch }
  }

  const secretDeletes = planAuthRevokeSecretDeletes(input.metadata)
  const secretDeleteFailures = await runAuthRevokeSecretDeletes(input.secretStorage, secretDeletes)
  const metadataPut: LocalSetupMetadataPutOperation = {
    kind: 'put-metadata-record',
    key: LOCAL_AUTH_METADATA_KEY,
    value: metadataPatch.metadata,
  }

  try {
    await input.metadataStore.commit(metadataPut)
  } catch (error: unknown) {
    return {
      ok: false,
      phase: 'metadata-commit',
      response,
      revokeDecision,
      metadataPatch,
      secretDeletes,
      secretDeleteFailures,
      metadataPut,
      error,
    }
  }

  return {
    ok: true,
    response,
    revokeDecision,
    metadataPatch,
    secretDeletes,
    secretDeleteFailures,
    metadataPut,
    stopSync: revokeDecision.patch.stopSync,
  }
}

function planAuthRevokeSecretDeletes(
  metadata: ClientAuthMetadata,
): readonly AuthRevokeSecretDeleteEffect[] {
  const deletes: AuthRevokeSecretDeleteEffect[] = []
  if (metadata.accessTokenSecretKey !== undefined) {
    deletes.push({
      kind: 'delete-secret',
      key: metadata.accessTokenSecretKey,
      token: 'access',
    })
  }
  if (metadata.refreshTokenSecretKey !== undefined) {
    deletes.push({
      kind: 'delete-secret',
      key: metadata.refreshTokenSecretKey,
      token: 'refresh',
    })
  }
  return deletes
}

async function runAuthRevokeSecretDeletes(
  secretStorage: AuthRevokeSecretStoragePort,
  deletes: readonly AuthRevokeSecretDeleteEffect[],
): Promise<readonly AuthRevokeSecretDeleteFailure[]> {
  const failures: AuthRevokeSecretDeleteFailure[] = []
  for (const effect of deletes) {
    try {
      await secretStorage.delete(effect.key)
    } catch (error: unknown) {
      failures.push({ key: effect.key, token: effect.token, error })
    }
  }
  return failures
}
