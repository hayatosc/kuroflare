import {
  isClientAuthMetadata,
  planClientAuthMetadataFromSetupResponse,
  type ClientAuthMetadata,
  type ClientAuthMetadataSetupPersistDecision,
} from '@kuroflare/core'
import {
  DeviceIdSchema,
  HttpEndpointSchema,
  SetupBootstrapModeSchema,
  VaultIdSchema,
  WireYClientIdSchema,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

/** Stable metadata row key for the plugin's setup identity record. */
export const LOCAL_SETUP_METADATA_KEY = 'setup'

/** Stable metadata row key for the plugin's auth metadata record. */
export const LOCAL_AUTH_METADATA_KEY = 'auth'

/** Non-secret setup identity metadata stored in the IndexedDB metadata object store. */
export interface LocalSetupMetadata {
  readonly endpoint: string
  readonly vaultId: SetupExchangeResponse['vaultId']
  readonly deviceId: SetupExchangeResponse['deviceId']
  readonly yClientId: SetupExchangeResponse['yClientId']
  readonly protocolVersion: SetupExchangeResponse['protocolVersion']
  readonly bootstrapMode: SetupExchangeResponse['bootstrapMode']
  readonly tokenVersion: SetupExchangeResponse['tokenVersion']
}

/** Input for planning local persistence of a guarded setup exchange response. */
export interface LocalSetupPersistPlanInput {
  readonly response: SetupExchangeResponse
  readonly accessTokenExpiresAt: number
  readonly secretKeyPrefix?: string | undefined
}

/** One secret-storage write that must complete before IndexedDB metadata is committed. */
export interface LocalSetupSecretWriteEffect {
  readonly kind: 'write-secret'
  readonly key: string
  readonly value: string
  readonly token: 'access' | 'refresh'
}

/** One best-effort SecretStorage delete used to compensate a failed metadata commit. */
export interface LocalSetupSecretDeleteEffect {
  readonly kind: 'delete-secret'
  readonly key: string
  readonly token: 'access' | 'refresh'
}

/** One metadata-store put operation for the setup persistence transaction. */
export type LocalSetupMetadataPutOperation =
  | {
      readonly kind: 'put-metadata-record'
      readonly key: typeof LOCAL_SETUP_METADATA_KEY
      readonly value: LocalSetupMetadata
    }
  | {
      readonly kind: 'put-metadata-record'
      readonly key: typeof LOCAL_AUTH_METADATA_KEY
      readonly value: ClientAuthMetadata
    }

/** Trusted setup/auth metadata read from the local IndexedDB metadata object store. */
export interface LocalSetupMetadataSnapshot {
  readonly setup: LocalSetupMetadata
  readonly auth: ClientAuthMetadata
}

/** Candidate metadata values read from the IndexedDB metadata object store. */
export interface LocalSetupMetadataSnapshotInput {
  readonly setup: unknown
  readonly auth: unknown
}

/** Decision for accepting persisted setup/auth metadata at startup. */
export type LocalSetupMetadataSnapshotDecision =
  | {
      readonly ok: true
      readonly snapshot: LocalSetupMetadataSnapshot
    }
  | {
      readonly ok: false
      readonly reason:
        | 'missing-setup-metadata'
        | 'missing-auth-metadata'
        | 'invalid-setup-metadata'
        | 'invalid-auth-metadata'
        | 'setup-auth-device-mismatch'
        | 'setup-auth-token-version-mismatch'
    }

/** Plan for persisting setup response secrets and local metadata. */
export type LocalSetupPersistPlan =
  | {
      readonly ok: true
      readonly secretWrites: readonly LocalSetupSecretWriteEffect[]
      readonly metadataPuts: readonly LocalSetupMetadataPutOperation[]
      readonly authDecision: Extract<
        ClientAuthMetadataSetupPersistDecision,
        { readonly action: 'persist' }
      >
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-token-version'
        | 'invalid-token-expiry'
        | 'invalid-secret-key'
        | 'invalid-secret-key-prefix'
      readonly authDecision?: Extract<
        ClientAuthMetadataSetupPersistDecision,
        { readonly action: 'reject' }
      >
    }

/** Successful setup persistence plan used as the cleanup planner's authority. */
export type SuccessfulLocalSetupPersistPlan = Extract<LocalSetupPersistPlan, { readonly ok: true }>

/** Input for planning setup SecretStorage cleanup after a later metadata commit failure. */
export interface LocalSetupPersistSecretCleanupInput {
  readonly setupPlan: SuccessfulLocalSetupPersistPlan
  readonly completedSecretWrites: readonly LocalSetupSecretWriteEffect[]
}

/** Plan for compensating setup SecretStorage writes that already completed. */
export type LocalSetupPersistSecretCleanupPlan =
  | {
      readonly ok: true
      readonly secretDeletes: readonly LocalSetupSecretDeleteEffect[]
    }
  | {
      readonly ok: false
      readonly reason: 'unexpected-secret-write' | 'duplicate-secret-write'
      readonly secretWrite: LocalSetupSecretWriteEffect
    }

/**
 * Plans setup response persistence without placing token bodies in IndexedDB metadata.
 *
 * @param input Guarded setup response, verified access-token expiry, and optional SecretStorage prefix.
 * @returns Ordered SecretStorage writes and metadata put operations, or the reason persistence must stop.
 */
export function planLocalSetupPersist(input: LocalSetupPersistPlanInput): LocalSetupPersistPlan {
  const secretKeyPrefix = input.secretKeyPrefix ?? 'kuroflare'
  if (!isBoundedNonEmptyString(secretKeyPrefix, 128)) {
    return { ok: false, reason: 'invalid-secret-key-prefix' }
  }

  const accessTokenSecretKey = `${secretKeyPrefix}:${input.response.vaultId}:${input.response.deviceId}:access-token`
  const refreshTokenSecretKey = `${secretKeyPrefix}:${input.response.vaultId}:${input.response.deviceId}:refresh-token`
  const authDecision = planClientAuthMetadataFromSetupResponse({
    response: input.response,
    accessTokenSecretKey,
    refreshTokenSecretKey,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
  })
  if (authDecision.action === 'reject') {
    return { ok: false, reason: authDecision.reason, authDecision }
  }

  return {
    ok: true,
    secretWrites: [
      {
        kind: 'write-secret',
        key: accessTokenSecretKey,
        value: input.response.accessToken,
        token: 'access',
      },
      {
        kind: 'write-secret',
        key: refreshTokenSecretKey,
        value: input.response.refreshToken,
        token: 'refresh',
      },
    ],
    metadataPuts: [
      {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: {
          endpoint: input.response.endpoint,
          vaultId: input.response.vaultId,
          deviceId: input.response.deviceId,
          yClientId: input.response.yClientId,
          protocolVersion: input.response.protocolVersion,
          bootstrapMode: input.response.bootstrapMode,
          tokenVersion: input.response.tokenVersion,
        },
      },
      {
        kind: 'put-metadata-record',
        key: LOCAL_AUTH_METADATA_KEY,
        value: authDecision.metadata,
      },
    ],
    authDecision,
  }
}

/**
 * Returns true when a value is trusted non-secret setup metadata from IndexedDB.
 *
 * @param value Candidate setup metadata record read from the metadata object store.
 * @returns Whether the setup metadata has the persisted shape expected by startup.
 */
export function isLocalSetupMetadata(value: unknown): value is LocalSetupMetadata {
  if (!isRecord(value)) {
    return false
  }
  return (
    v.is(HttpEndpointSchema, value.endpoint) &&
    v.is(VaultIdSchema, value.vaultId) &&
    v.is(DeviceIdSchema, value.deviceId) &&
    v.is(WireYClientIdSchema, value.yClientId) &&
    v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), value.protocolVersion) &&
    v.is(SetupBootstrapModeSchema, value.bootstrapMode) &&
    v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), value.tokenVersion)
  )
}

/**
 * Validates the setup/auth metadata pair read during startup.
 *
 * @param input Raw setup and auth metadata records read by stable metadata keys.
 * @returns A trusted metadata snapshot, or the reason startup must not use it.
 */
export function planLocalSetupMetadataSnapshot(
  input: LocalSetupMetadataSnapshotInput,
): LocalSetupMetadataSnapshotDecision {
  if (input.setup === undefined) {
    return { ok: false, reason: 'missing-setup-metadata' }
  }
  if (input.auth === undefined) {
    return { ok: false, reason: 'missing-auth-metadata' }
  }
  if (!isLocalSetupMetadata(input.setup)) {
    return { ok: false, reason: 'invalid-setup-metadata' }
  }
  if (!isClientAuthMetadata(input.auth)) {
    return { ok: false, reason: 'invalid-auth-metadata' }
  }
  if (input.setup.deviceId !== input.auth.deviceId) {
    return { ok: false, reason: 'setup-auth-device-mismatch' }
  }
  if (input.setup.tokenVersion !== input.auth.tokenVersion) {
    return { ok: false, reason: 'setup-auth-token-version-mismatch' }
  }
  return {
    ok: true,
    snapshot: {
      setup: input.setup,
      auth: input.auth,
    },
  }
}

/**
 * Plans best-effort cleanup for setup secrets already written before metadata commit failed.
 *
 * @param input Successful setup plan and the SecretStorage writes confirmed by the runtime.
 * @returns Delete effects in reverse completion order, or a rejection for writes not owned by the setup plan.
 */
export function planLocalSetupPersistSecretCleanup(
  input: LocalSetupPersistSecretCleanupInput,
): LocalSetupPersistSecretCleanupPlan {
  const allowedWrites = new Map<string, LocalSetupSecretWriteEffect>()
  for (const write of input.setupPlan.secretWrites) {
    allowedWrites.set(secretWriteIdentity(write), write)
  }

  const seenWrites = new Set<string>()
  for (const completedWrite of input.completedSecretWrites) {
    const identity = secretWriteIdentity(completedWrite)
    const expectedWrite = allowedWrites.get(identity)
    if (expectedWrite === undefined || expectedWrite.value !== completedWrite.value) {
      return { ok: false, reason: 'unexpected-secret-write', secretWrite: completedWrite }
    }
    if (seenWrites.has(identity)) {
      return { ok: false, reason: 'duplicate-secret-write', secretWrite: completedWrite }
    }
    seenWrites.add(identity)
  }

  return {
    ok: true,
    secretDeletes: [...input.completedSecretWrites].reverse().map(
      (write): LocalSetupSecretDeleteEffect => ({
        kind: 'delete-secret',
        key: write.key,
        token: write.token,
      }),
    ),
  }
}

function isBoundedNonEmptyString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength
}

function secretWriteIdentity(write: LocalSetupSecretWriteEffect): string {
  return `${write.token}\0${write.key}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
