import type {
  ClientAuthMetadata,
  ClientAuthMetadataPatchDecision,
  ClientAuthRefreshAttemptDecision,
  ClientAuthRefreshDecision,
  ClientAuthRefreshPermanentFailure,
  ClientAuthRefreshStartDecision,
  ClientAuthRefreshStaleStartRecoveryDecision,
  ClientAuthRefreshRetryableFailure,
  OutboxAuthRefreshRequestDecision,
} from '@kuroflare/core'
import type {
  DeviceTokenClaims,
  DeviceTokenRefreshRequest,
  DeviceTokenRefreshResponse,
  DeviceTokenScope,
  VaultId,
} from '@kuroflare/core'

import type { LocalSetupMetadataPutOperation, LocalSetupSecretWriteEffect } from '../engine/setup'

/** SecretStorage surface required by auth refresh persistence. */
export interface AuthRefreshSecretStoragePort {
  /** Reads one secret token by key. */
  get(key: string): Promise<string | undefined>
  /** Stores one refreshed secret token body under an existing key. */
  set(key: string, value: string): Promise<void>
  /** Deletes a partially stored refreshed token during best-effort cleanup. */
  delete(key: string): Promise<void>
}

/** HTTP surface required to exchange a refresh token for a new access token. */
export interface AuthRefreshHttpPort {
  /** Sends one guarded refresh-token exchange request to the sync service. */
  refresh(request: DeviceTokenRefreshRequest): Promise<AuthRefreshHttpResult>
}

/** Access-token verifier used before local metadata accepts a refresh response. */
export interface AuthRefreshAccessTokenVerifierPort {
  /** Verifies the access token signature and returns guarded claims. */
  verify(accessToken: string): Promise<DeviceTokenClaims | undefined>
}

/** Metadata persistence surface required by auth refresh. */
export interface AuthRefreshMetadataPort {
  /** Commits the updated auth metadata record in one durable transaction. */
  commit(write: LocalSetupMetadataPutOperation): Promise<void>
}

/** HTTP result returned by the auth refresh port. */
export type AuthRefreshHttpResult =
  | { readonly ok: true; readonly response: unknown }
  | {
      readonly ok: false
      readonly reason: ClientAuthRefreshRetryableFailure | ClientAuthRefreshPermanentFailure
      readonly retryAfterMs?: number | undefined
    }

/** Input for executing one client auth refresh attempt. */
export interface AuthRefreshRuntimeInput {
  readonly endpoint: string
  readonly vaultId: VaultId
  readonly metadata: ClientAuthMetadata
  readonly requiredScopes: readonly DeviceTokenScope[]
  readonly now: number
  readonly secretStorage: AuthRefreshSecretStoragePort
  readonly http: AuthRefreshHttpPort
  readonly verifier: AuthRefreshAccessTokenVerifierPort
  readonly metadataStore: AuthRefreshMetadataPort
}

/** Input for persisting that an outbox-triggered auth refresh has started. */
export interface AuthRefreshStartRuntimeInput {
  readonly metadata: ClientAuthMetadata
  readonly request: OutboxAuthRefreshRequestDecision
  readonly metadataStore: AuthRefreshMetadataPort
}

/** Input for recovering an abandoned auth refresh start marker. */
export interface AuthRefreshStaleStartRecoveryRuntimeInput {
  readonly metadata: ClientAuthMetadata
  readonly now: number
  readonly staleAfterMs: number
  readonly metadataStore: AuthRefreshMetadataPort
}

/** One rollback operation used after refreshed secrets were written but metadata did not commit. */
export type AuthRefreshSecretRollbackEffect =
  | {
      readonly kind: 'restore-secret'
      readonly key: string
      readonly value: string
      readonly token: 'access' | 'refresh'
    }
  | {
      readonly kind: 'delete-secret'
      readonly key: string
      readonly token: 'access' | 'refresh'
    }

/** One rollback operation that failed after refreshed secrets were written. */
export interface AuthRefreshCleanupFailure {
  readonly key: string
  readonly token: 'access' | 'refresh'
  readonly operation: AuthRefreshSecretRollbackEffect['kind']
  readonly error: unknown
}

/** Successful auth refresh result after token secrets and metadata are durable. */
export interface SuccessfulAuthRefreshRuntimePlan {
  readonly ok: true
  readonly response: DeviceTokenRefreshResponse
  readonly refreshDecision: Extract<ClientAuthRefreshDecision, { readonly action: 'accept' }>
  readonly attemptDecision: Extract<
    ClientAuthRefreshAttemptDecision,
    { readonly action: 'complete' }
  >
  readonly metadataPatch: Extract<ClientAuthMetadataPatchDecision, { readonly action: 'apply' }>
  readonly secretWrites: readonly LocalSetupSecretWriteEffect[]
  readonly metadataPut: LocalSetupMetadataPutOperation
  readonly emitResumeEvent: 'auth-refresh'
}

/** Successful auth refresh start result after metadata is durable. */
export interface SuccessfulAuthRefreshStartRuntimePlan {
  readonly ok: true
  readonly refreshStart: Extract<ClientAuthRefreshStartDecision, { readonly action: 'start' }>
  readonly metadataPut: LocalSetupMetadataPutOperation
}

/** Failed auth refresh start result before metadata became durable. */
export type FailedAuthRefreshStartRuntimePlan =
  | {
      readonly ok: false
      readonly phase: 'request'
      readonly reason: Exclude<
        OutboxAuthRefreshRequestDecision,
        { readonly action: 'request-refresh' }
      >['action']
      readonly request: Exclude<
        OutboxAuthRefreshRequestDecision,
        { readonly action: 'request-refresh' }
      >
    }
  | {
      readonly ok: false
      readonly phase: 'refresh-start'
      readonly refreshStart: Extract<ClientAuthRefreshStartDecision, { readonly action: 'reject' }>
    }
  | {
      readonly ok: false
      readonly phase: 'metadata-commit'
      readonly refreshStart: Extract<ClientAuthRefreshStartDecision, { readonly action: 'start' }>
      readonly metadataPut: LocalSetupMetadataPutOperation
      readonly error: unknown
    }

/** Successful stale refresh start recovery after metadata is durable. */
export interface SuccessfulAuthRefreshStaleStartRecoveryRuntimePlan {
  readonly ok: true
  readonly recovery: Extract<
    ClientAuthRefreshStaleStartRecoveryDecision,
    { readonly action: 'recover' }
  >
  readonly metadataPut: LocalSetupMetadataPutOperation
}

/** Stale refresh start recovery result when no metadata write was needed. */
export type SkippedAuthRefreshStaleStartRecoveryRuntimePlan =
  | {
      readonly ok: false
      readonly phase: 'recovery'
      readonly recovery: Exclude<
        ClientAuthRefreshStaleStartRecoveryDecision,
        { readonly action: 'recover' }
      >
    }
  | {
      readonly ok: false
      readonly phase: 'metadata-commit'
      readonly recovery: Extract<
        ClientAuthRefreshStaleStartRecoveryDecision,
        { readonly action: 'recover' }
      >
      readonly metadataPut: LocalSetupMetadataPutOperation
      readonly error: unknown
    }

/** Auth refresh result when the attempt failed before refreshed secrets were written. */
export interface FailedAuthRefreshRuntimePlan {
  readonly ok: false
  readonly phase:
    | 'metadata'
    | 'secret-read'
    | 'http'
    | 'response'
    | 'claims'
    | 'refresh-decision'
    | 'attempt-decision'
    | 'metadata-patch'
    | 'secret-write'
    | 'failure-metadata-commit'
  readonly attemptDecision?: ClientAuthRefreshAttemptDecision | undefined
  readonly metadataPatch?: ClientAuthMetadataPatchDecision | undefined
  readonly metadataPut?: LocalSetupMetadataPutOperation | undefined
  readonly secretWrites?: readonly LocalSetupSecretWriteEffect[] | undefined
  readonly cleanup?: readonly AuthRefreshSecretRollbackEffect[] | undefined
  readonly cleanupFailures?: readonly AuthRefreshCleanupFailure[] | undefined
  readonly error?: unknown
  readonly reason?: string | undefined
}

/** Auth refresh result when metadata commit failed after refreshed secrets were written. */
export interface FailedAuthRefreshMetadataCommitRuntimePlan {
  readonly ok: false
  readonly phase: 'metadata-commit'
  readonly response: DeviceTokenRefreshResponse
  readonly refreshDecision: Extract<ClientAuthRefreshDecision, { readonly action: 'accept' }>
  readonly attemptDecision: Extract<
    ClientAuthRefreshAttemptDecision,
    { readonly action: 'complete' }
  >
  readonly metadataPatch: Extract<ClientAuthMetadataPatchDecision, { readonly action: 'apply' }>
  readonly metadataPut: LocalSetupMetadataPutOperation
  readonly secretWrites: readonly LocalSetupSecretWriteEffect[]
  readonly cleanup: readonly AuthRefreshSecretRollbackEffect[]
  readonly cleanupFailures: readonly AuthRefreshCleanupFailure[]
  readonly error: unknown
}

/** Result of executing one client auth refresh attempt. */
export type AuthRefreshRuntimePlan =
  | SuccessfulAuthRefreshRuntimePlan
  | FailedAuthRefreshRuntimePlan
  | FailedAuthRefreshMetadataCommitRuntimePlan

/** Result of persisting an auth refresh start marker. */
export type AuthRefreshStartRuntimePlan =
  | SuccessfulAuthRefreshStartRuntimePlan
  | FailedAuthRefreshStartRuntimePlan

/** Result of recovering an abandoned auth refresh start marker. */
export type AuthRefreshStaleStartRecoveryRuntimePlan =
  | SuccessfulAuthRefreshStaleStartRecoveryRuntimePlan
  | SkippedAuthRefreshStaleStartRecoveryRuntimePlan
