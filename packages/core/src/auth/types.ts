import type { RevokeDeviceResponse } from '../http/device'
import type { DeviceTokenClaims, DeviceTokenScope } from '../sync/schemas'
import type { SetupExchangeResponse } from '../sync/setup'
import type { DeviceId, VaultId } from '../utils/ids'

/** Input for deciding whether a refreshed device token may unblock auth-paused local queues. */
export interface ClientAuthRefreshDecisionInput {
  readonly claims: DeviceTokenClaims
  readonly expectedVaultId: VaultId
  readonly expectedDeviceId: DeviceId
  readonly requiredScopes: readonly DeviceTokenScope[]
  readonly previousTokenVersion?: number | undefined
  readonly now: number
}

/** Decision for accepting a refreshed token before emitting an `auth-refresh` resume event. */
export type ClientAuthRefreshDecision =
  | {
      readonly action: 'accept'
      readonly patch: {
        readonly tokenVersion: number
        readonly expiresAt: number
        readonly emitResumeEvent: 'auth-refresh'
      }
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'token-expired'
        | 'token-not-yet-valid'
        | 'token-version-regressed'
        | 'missing-scope'
        | 'invalid-time'
        | 'invalid-previous-token-version'
    }

/** Input for deciding whether an authenticated side effect may start with the current token. */
export interface ClientAuthStartDecisionInput {
  readonly now: number
  readonly tokenExpiresAt: number
  readonly refreshMarginMs: number
  readonly estimatedDurationMs?: number | undefined
}

/** Decision for starting auth-protected outbox side effects with the current token. */
export type ClientAuthStartDecision =
  | { readonly action: 'start'; readonly remainingMs: number }
  | {
      readonly action: 'refresh-first'
      readonly reason: 'token-expired' | 'token-expiring-soon'
      readonly remainingMs: number
      readonly requiredRemainingMs: number
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-time'
        | 'invalid-token-expiry'
        | 'invalid-refresh-margin'
        | 'invalid-estimated-duration'
    }

/** Retryable cause observed while refreshing a client device token. */
export type ClientAuthRefreshRetryableFailure =
  | 'network'
  | 'timeout'
  | 'offline'
  | 'server-retryable'

/** Permanent cause observed while refreshing a client device token. */
export type ClientAuthRefreshPermanentFailure =
  | 'refresh-token-rejected'
  | 'device-revoked'
  | 'invalid-refresh-response'
  | 'reauth-required'

/** Input for applying the outcome of one token refresh attempt to local metadata. */
export interface ClientAuthRefreshAttemptInput {
  readonly now: number
  readonly retryCount: number
  readonly retryAfterMs?: number | undefined
  readonly result:
    | {
        readonly status: 'accepted'
        readonly patch: Extract<ClientAuthRefreshDecision, { readonly action: 'accept' }>['patch']
      }
    | { readonly status: 'retryable-failure'; readonly reason: ClientAuthRefreshRetryableFailure }
    | { readonly status: 'permanent-failure'; readonly reason: ClientAuthRefreshPermanentFailure }
}

/** Input for marking a token refresh attempt as running in local metadata. */
export interface ClientAuthRefreshStartInput {
  readonly metadata: ClientAuthMetadata
  readonly requestedAt: number
}

/** Input for recovering a refresh worker that was left running too long. */
export interface ClientAuthRefreshStaleStartRecoveryInput {
  readonly metadata: ClientAuthMetadata
  readonly now: number
  readonly staleAfterMs: number
}

/** Decision for persisting that one token refresh worker has started. */
export type ClientAuthRefreshStartDecision =
  | {
      readonly action: 'start'
      readonly metadata: ClientAuthMetadata
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-metadata'
        | 'invalid-requested-at'
        | 'device-not-active'
        | 'missing-token-secret-keys'
        | 'refresh-already-running'
        | 'refresh-backoff'
    }

/** Decision for recovering an abandoned token refresh start marker. */
export type ClientAuthRefreshStaleStartRecoveryDecision =
  | {
      readonly action: 'recover'
      readonly metadata: ClientAuthMetadata
    }
  | {
      readonly action: 'wait'
      readonly refreshStartedAt: number
      readonly staleAt: number
    }
  | {
      readonly action: 'noop'
      readonly reason: 'not-refreshing'
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-metadata'
        | 'invalid-clock'
        | 'invalid-stale-timeout'
        | 'invalid-refresh-started-at'
    }

/** Decision for persisting the outcome of one token refresh attempt. */
export type ClientAuthRefreshAttemptDecision =
  | {
      readonly action: 'complete'
      readonly patch: {
        readonly refreshState: 'idle'
        readonly retryCount: 0
        readonly tokenVersion: number
        readonly expiresAt: number
        readonly emitResumeEvent: 'auth-refresh'
      }
    }
  | {
      readonly action: 'backoff'
      readonly patch: {
        readonly refreshState: 'backing-off'
        readonly retryCount: number
        readonly nextAllowedRefreshAt: number
        readonly reason: ClientAuthRefreshRetryableFailure
      }
    }
  | {
      readonly action: 'require-reauth'
      readonly patch: {
        readonly refreshState: 'idle'
        readonly retryCount: 0
        readonly reason: ClientAuthRefreshPermanentFailure
      }
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-time'
        | 'invalid-retry-count'
        | 'invalid-retry-after'
        | 'invalid-token-expiry'
        | 'invalid-token-version'
    }

/** Input for applying a successful local device revoke response. */
export interface ClientDeviceRevokeDecisionInput {
  readonly response: RevokeDeviceResponse
  readonly expectedDeviceId: DeviceId
  readonly previousTokenVersion?: number | undefined
}

/** Decision for persisting local state after this device has been revoked. */
export type ClientDeviceRevokeDecision =
  | {
      readonly action: 'mark-revoked'
      readonly patch: {
        readonly authState: 'revoked'
        readonly tokenVersion: number
        readonly revokedAt: number
        readonly clearAccessToken: true
        readonly clearRefreshToken: true
        readonly stopSync: true
        readonly keepOutbox: true
      }
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'device-mismatch'
        | 'token-version-regressed'
        | 'invalid-token-version'
        | 'invalid-revoked-at'
    }

/** Persisted auth state stored in the local metadata object store. */
export interface ClientAuthMetadata {
  readonly deviceId: DeviceId
  readonly authState: 'active' | 'revoked' | 'reauth-required'
  readonly tokenVersion: number
  readonly accessTokenExpiresAt?: number | undefined
  readonly revokedAt?: number | undefined
  readonly refreshState: 'idle' | 'refreshing' | 'backing-off'
  readonly refreshStartedAt?: number | undefined
  readonly retryCount: number
  readonly nextAllowedRefreshAt?: number | undefined
  readonly accessTokenSecretKey?: string | undefined
  readonly refreshTokenSecretKey?: string | undefined
}

/** Input for creating persisted auth metadata from a guarded setup response. */
export interface ClientAuthMetadataSetupPersistInput {
  readonly response: SetupExchangeResponse
  readonly accessTokenSecretKey: string
  readonly refreshTokenSecretKey: string
  readonly accessTokenExpiresAt: number
}

/** Decision for creating the initial persisted client auth metadata record. */
export type ClientAuthMetadataSetupPersistDecision =
  | {
      readonly action: 'persist'
      readonly metadata: ClientAuthMetadata
    }
  | {
      readonly action: 'reject'
      readonly reason: 'invalid-token-version' | 'invalid-token-expiry' | 'invalid-secret-key'
    }

/** Input for applying a local device revoke patch to persisted auth metadata. */
export interface ClientAuthMetadataRevokePatchInput {
  readonly metadata: ClientAuthMetadata
  readonly patch: Extract<ClientDeviceRevokeDecision, { readonly action: 'mark-revoked' }>['patch']
}

/** Input for applying a token refresh attempt decision to persisted auth metadata. */
export interface ClientAuthMetadataRefreshAttemptPatchInput {
  readonly metadata: ClientAuthMetadata
  readonly decision: ClientAuthRefreshAttemptDecision
}

/** Result of applying an auth metadata patch. */
export type ClientAuthMetadataPatchDecision =
  | {
      readonly action: 'apply'
      readonly metadata: ClientAuthMetadata
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-metadata'
        | 'token-version-regressed'
        | 'device-not-active'
        | 'attempt-not-persistable'
    }
