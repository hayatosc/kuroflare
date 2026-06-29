import type {
  DeviceId,
  DeviceTokenClaims,
  DeviceTokenScope,
  RevokeDeviceResponse,
  SetupExchangeResponse,
  VaultId,
} from '@kuroflare/protocol'
import { DeviceIdSchema } from '@kuroflare/protocol'
import * as v from 'valibot'

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

/** Backoff policy for retrying client token refresh attempts. */
export const CLIENT_AUTH_REFRESH_RETRY_POLICY = {
  scheduleMs: [1_000, 5_000, 30_000, 300_000],
  maxDelayMs: 300_000,
} as const

/**
 * Decides whether the plugin may persist a refreshed access token and resume auth-paused work.
 *
 * @param input Verified token claims, expected local identity, required queue scopes, and current time.
 * @returns A local metadata patch plus an auth-refresh event, or the reason the token is unsafe.
 */
export function decideClientAuthRefresh(
  input: ClientAuthRefreshDecisionInput,
): ClientAuthRefreshDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (
    input.previousTokenVersion !== undefined &&
    !isPositiveSafeInteger(input.previousTokenVersion)
  ) {
    return { action: 'reject', reason: 'invalid-previous-token-version' }
  }
  if (input.claims.aud !== input.expectedVaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (input.claims.sub !== input.expectedDeviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (input.now < input.claims.iat) {
    return { action: 'reject', reason: 'token-not-yet-valid' }
  }
  if (input.now >= input.claims.exp) {
    return { action: 'reject', reason: 'token-expired' }
  }
  if (
    input.previousTokenVersion !== undefined &&
    input.claims.tokenVersion < input.previousTokenVersion
  ) {
    return { action: 'reject', reason: 'token-version-regressed' }
  }
  if (!hasRequiredScopes(input.claims.scope, input.requiredScopes)) {
    return { action: 'reject', reason: 'missing-scope' }
  }

  return {
    action: 'accept',
    patch: {
      tokenVersion: input.claims.tokenVersion,
      expiresAt: input.claims.exp,
      emitResumeEvent: 'auth-refresh',
    },
  }
}

/**
 * Decides whether an auth-protected side effect may start before the token is refreshed.
 *
 * @param input Current time, token expiry, configured refresh margin, and optional expected duration.
 * @returns Whether to start now, refresh first, or reject invalid local timing evidence.
 */
export function decideClientAuthStart(
  input: ClientAuthStartDecisionInput,
): ClientAuthStartDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (!isNonNegativeSafeInteger(input.tokenExpiresAt)) {
    return { action: 'reject', reason: 'invalid-token-expiry' }
  }
  if (!isNonNegativeSafeInteger(input.refreshMarginMs)) {
    return { action: 'reject', reason: 'invalid-refresh-margin' }
  }
  if (
    input.estimatedDurationMs !== undefined &&
    !isNonNegativeSafeInteger(input.estimatedDurationMs)
  ) {
    return { action: 'reject', reason: 'invalid-estimated-duration' }
  }

  const remainingMs = input.tokenExpiresAt - input.now
  const requiredRemainingMs = input.refreshMarginMs + (input.estimatedDurationMs ?? 0)
  if (remainingMs <= 0) {
    return {
      action: 'refresh-first',
      reason: 'token-expired',
      remainingMs,
      requiredRemainingMs,
    }
  }
  if (remainingMs <= requiredRemainingMs) {
    return {
      action: 'refresh-first',
      reason: 'token-expiring-soon',
      remainingMs,
      requiredRemainingMs,
    }
  }
  return { action: 'start', remainingMs }
}

/**
 * Decides how one token refresh attempt changes local auth refresh worker metadata.
 *
 * @param input Attempt result, current retry count, optional server retry-after, and clock.
 * @returns A persistable metadata patch, or the reason the local attempt evidence is invalid.
 */
export function decideClientAuthRefreshAttempt(
  input: ClientAuthRefreshAttemptInput,
): ClientAuthRefreshAttemptDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (!isNonNegativeSafeInteger(input.retryCount)) {
    return { action: 'reject', reason: 'invalid-retry-count' }
  }
  if (input.retryAfterMs !== undefined && !isNonNegativeSafeInteger(input.retryAfterMs)) {
    return { action: 'reject', reason: 'invalid-retry-after' }
  }

  if (input.result.status === 'accepted') {
    if (!isPositiveSafeInteger(input.result.patch.tokenVersion)) {
      return { action: 'reject', reason: 'invalid-token-version' }
    }
    if (!isNonNegativeSafeInteger(input.result.patch.expiresAt)) {
      return { action: 'reject', reason: 'invalid-token-expiry' }
    }
    return {
      action: 'complete',
      patch: {
        refreshState: 'idle',
        retryCount: 0,
        tokenVersion: input.result.patch.tokenVersion,
        expiresAt: input.result.patch.expiresAt,
        emitResumeEvent: input.result.patch.emitResumeEvent,
      },
    }
  }

  if (input.result.status === 'permanent-failure') {
    return {
      action: 'require-reauth',
      patch: {
        refreshState: 'idle',
        retryCount: 0,
        reason: input.result.reason,
      },
    }
  }

  const nextRetryCount = input.retryCount + 1
  const scheduledDelayMs =
    CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[
      Math.min(input.retryCount, CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs.length - 1)
    ] ?? CLIENT_AUTH_REFRESH_RETRY_POLICY.maxDelayMs
  const delayMs = Math.max(scheduledDelayMs, input.retryAfterMs ?? 0)
  return {
    action: 'backoff',
    patch: {
      refreshState: 'backing-off',
      retryCount: nextRetryCount,
      nextAllowedRefreshAt: input.now + delayMs,
      reason: input.result.reason,
    },
  }
}

/**
 * Marks auth refresh as running before the refresh HTTP side effect starts.
 *
 * @param input Current auth metadata and the scheduler request timestamp.
 * @returns Updated metadata with `refreshState="refreshing"`, or the reason refresh must not start.
 */
export function decideClientAuthRefreshStart(
  input: ClientAuthRefreshStartInput,
): ClientAuthRefreshStartDecision {
  if (!isClientAuthMetadata(input.metadata)) {
    return { action: 'reject', reason: 'invalid-metadata' }
  }
  if (!isNonNegativeSafeInteger(input.requestedAt)) {
    return { action: 'reject', reason: 'invalid-requested-at' }
  }
  if (input.metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }
  if (
    input.metadata.accessTokenSecretKey === undefined ||
    input.metadata.refreshTokenSecretKey === undefined
  ) {
    return { action: 'reject', reason: 'missing-token-secret-keys' }
  }
  if (input.metadata.refreshState === 'refreshing') {
    return { action: 'reject', reason: 'refresh-already-running' }
  }
  if (
    input.metadata.refreshState === 'backing-off' &&
    input.metadata.nextAllowedRefreshAt !== undefined &&
    input.requestedAt < input.metadata.nextAllowedRefreshAt
  ) {
    return { action: 'reject', reason: 'refresh-backoff' }
  }

  return {
    action: 'start',
    metadata: {
      deviceId: input.metadata.deviceId,
      authState: 'active',
      tokenVersion: input.metadata.tokenVersion,
      accessTokenExpiresAt: input.metadata.accessTokenExpiresAt,
      refreshState: 'refreshing',
      refreshStartedAt: input.requestedAt,
      retryCount: input.metadata.retryCount,
      accessTokenSecretKey: input.metadata.accessTokenSecretKey,
      refreshTokenSecretKey: input.metadata.refreshTokenSecretKey,
    },
  }
}

/**
 * Recovers an abandoned `refreshing` marker after a bounded timeout.
 *
 * @param input Current auth metadata, clock, and stale timeout.
 * @returns Backoff metadata for a stale refresh, a wait/noop decision, or invalid evidence.
 */
export function decideClientAuthRefreshStaleStartRecovery(
  input: ClientAuthRefreshStaleStartRecoveryInput,
): ClientAuthRefreshStaleStartRecoveryDecision {
  if (!isClientAuthMetadata(input.metadata)) {
    return { action: 'reject', reason: 'invalid-metadata' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.staleAfterMs)) {
    return { action: 'reject', reason: 'invalid-stale-timeout' }
  }
  if (input.metadata.refreshState !== 'refreshing') {
    return { action: 'noop', reason: 'not-refreshing' }
  }
  const refreshStartedAt = input.metadata.refreshStartedAt
  if (refreshStartedAt === undefined || !isNonNegativeSafeInteger(refreshStartedAt)) {
    return { action: 'reject', reason: 'invalid-refresh-started-at' }
  }

  const staleAt = refreshStartedAt + input.staleAfterMs
  if (input.now < staleAt) {
    return { action: 'wait', refreshStartedAt, staleAt }
  }

  const retryCount = input.metadata.retryCount + 1
  const scheduledDelayMs =
    CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[
      Math.min(input.metadata.retryCount, CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs.length - 1)
    ] ?? CLIENT_AUTH_REFRESH_RETRY_POLICY.maxDelayMs
  return {
    action: 'recover',
    metadata: {
      deviceId: input.metadata.deviceId,
      authState: 'active',
      tokenVersion: input.metadata.tokenVersion,
      accessTokenExpiresAt: input.metadata.accessTokenExpiresAt,
      refreshState: 'backing-off',
      retryCount,
      nextAllowedRefreshAt: input.now + scheduledDelayMs,
      accessTokenSecretKey: input.metadata.accessTokenSecretKey,
      refreshTokenSecretKey: input.metadata.refreshTokenSecretKey,
    },
  }
}

/**
 * Creates the initial persisted auth metadata after setup tokens have been placed in SecretStorage.
 *
 * @param input Guarded setup response, SecretStorage key references, and verified access token expiry.
 * @returns Initial active auth metadata, or the reason the setup evidence is unsafe.
 */
export function planClientAuthMetadataFromSetupResponse(
  input: ClientAuthMetadataSetupPersistInput,
): ClientAuthMetadataSetupPersistDecision {
  if (!isPositiveSafeInteger(input.response.tokenVersion)) {
    return { action: 'reject', reason: 'invalid-token-version' }
  }
  if (!isNonNegativeSafeInteger(input.accessTokenExpiresAt)) {
    return { action: 'reject', reason: 'invalid-token-expiry' }
  }
  if (
    !isBoundedNonEmptyString(input.accessTokenSecretKey, 256) ||
    !isBoundedNonEmptyString(input.refreshTokenSecretKey, 256)
  ) {
    return { action: 'reject', reason: 'invalid-secret-key' }
  }

  return {
    action: 'persist',
    metadata: {
      deviceId: input.response.deviceId,
      authState: 'active',
      tokenVersion: input.response.tokenVersion,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshState: 'idle',
      retryCount: 0,
      accessTokenSecretKey: input.accessTokenSecretKey,
      refreshTokenSecretKey: input.refreshTokenSecretKey,
    },
  }
}

/**
 * Decides how a successful device revoke response changes local auth state.
 *
 * @param input Guarded revoke response, expected local device identity, and optional previous token version.
 * @returns A patch that clears local token material and stops sync, or the reason the response is unsafe.
 */
export function decideClientDeviceRevoke(
  input: ClientDeviceRevokeDecisionInput,
): ClientDeviceRevokeDecision {
  if (input.response.deviceId !== input.expectedDeviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!isPositiveSafeInteger(input.response.tokenVersion)) {
    return { action: 'reject', reason: 'invalid-token-version' }
  }
  if (!isNonNegativeSafeInteger(input.response.revokedAt)) {
    return { action: 'reject', reason: 'invalid-revoked-at' }
  }
  if (
    input.previousTokenVersion !== undefined &&
    !isPositiveSafeInteger(input.previousTokenVersion)
  ) {
    return { action: 'reject', reason: 'invalid-token-version' }
  }
  if (
    input.previousTokenVersion !== undefined &&
    input.response.tokenVersion < input.previousTokenVersion
  ) {
    return { action: 'reject', reason: 'token-version-regressed' }
  }

  return {
    action: 'mark-revoked',
    patch: {
      authState: 'revoked',
      tokenVersion: input.response.tokenVersion,
      revokedAt: input.response.revokedAt,
      clearAccessToken: true,
      clearRefreshToken: true,
      stopSync: true,
      keepOutbox: true,
    },
  }
}

/**
 * Returns true when a value is a valid persisted client auth metadata record.
 *
 * @param value Candidate metadata read from IndexedDB.
 * @returns Whether the metadata can be trusted by auth decisions.
 */
export function isClientAuthMetadata(value: unknown): value is ClientAuthMetadata {
  if (!isRecord(value)) {
    return false
  }

  if (
    !v.is(DeviceIdSchema, value.deviceId) ||
    !isClientAuthState(value.authState) ||
    !isPositiveSafeInteger(value.tokenVersion) ||
    !isClientRefreshState(value.refreshState) ||
    !isNonNegativeSafeInteger(value.retryCount)
  ) {
    return false
  }

  return (
    (value.accessTokenExpiresAt === undefined ||
      isNonNegativeSafeInteger(value.accessTokenExpiresAt)) &&
    (value.revokedAt === undefined || isNonNegativeSafeInteger(value.revokedAt)) &&
    (value.refreshStartedAt === undefined || isNonNegativeSafeInteger(value.refreshStartedAt)) &&
    (value.nextAllowedRefreshAt === undefined ||
      isNonNegativeSafeInteger(value.nextAllowedRefreshAt)) &&
    (value.accessTokenSecretKey === undefined ||
      isBoundedNonEmptyString(value.accessTokenSecretKey, 256)) &&
    (value.refreshTokenSecretKey === undefined ||
      isBoundedNonEmptyString(value.refreshTokenSecretKey, 256))
  )
}

/**
 * Applies a revoke patch to persisted auth metadata without touching pending outbox state.
 *
 * @param input Current auth metadata and an accepted revoke patch.
 * @returns Updated metadata, or the reason the persisted evidence is unsafe.
 */
export function applyClientAuthMetadataRevokePatch(
  input: ClientAuthMetadataRevokePatchInput,
): ClientAuthMetadataPatchDecision {
  if (!isClientAuthMetadata(input.metadata)) {
    return { action: 'reject', reason: 'invalid-metadata' }
  }
  if (input.metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }
  if (input.patch.tokenVersion < input.metadata.tokenVersion) {
    return { action: 'reject', reason: 'token-version-regressed' }
  }

  return {
    action: 'apply',
    metadata: {
      deviceId: input.metadata.deviceId,
      authState: 'revoked',
      tokenVersion: input.patch.tokenVersion,
      revokedAt: input.patch.revokedAt,
      refreshState: 'idle',
      retryCount: 0,
    },
  }
}

/**
 * Applies a refresh attempt decision to persisted auth metadata.
 *
 * @param input Current auth metadata and a refresh attempt persistence decision.
 * @returns Updated metadata, or the reason the decision cannot be applied safely.
 */
export function applyClientAuthMetadataRefreshAttemptPatch(
  input: ClientAuthMetadataRefreshAttemptPatchInput,
): ClientAuthMetadataPatchDecision {
  if (!isClientAuthMetadata(input.metadata)) {
    return { action: 'reject', reason: 'invalid-metadata' }
  }
  if (input.metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }

  if (input.decision.action === 'reject') {
    return { action: 'reject', reason: 'attempt-not-persistable' }
  }

  if (input.decision.action === 'complete') {
    if (input.decision.patch.tokenVersion < input.metadata.tokenVersion) {
      return { action: 'reject', reason: 'token-version-regressed' }
    }

    return {
      action: 'apply',
      metadata: {
        deviceId: input.metadata.deviceId,
        authState: 'active',
        tokenVersion: input.decision.patch.tokenVersion,
        accessTokenExpiresAt: input.decision.patch.expiresAt,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: input.metadata.accessTokenSecretKey,
        refreshTokenSecretKey: input.metadata.refreshTokenSecretKey,
      },
    }
  }

  if (input.decision.action === 'backoff') {
    return {
      action: 'apply',
      metadata: {
        deviceId: input.metadata.deviceId,
        authState: 'active',
        tokenVersion: input.metadata.tokenVersion,
        accessTokenExpiresAt: input.metadata.accessTokenExpiresAt,
        refreshState: 'backing-off',
        retryCount: input.decision.patch.retryCount,
        nextAllowedRefreshAt: input.decision.patch.nextAllowedRefreshAt,
        accessTokenSecretKey: input.metadata.accessTokenSecretKey,
        refreshTokenSecretKey: input.metadata.refreshTokenSecretKey,
      },
    }
  }

  return {
    action: 'apply',
    metadata: {
      deviceId: input.metadata.deviceId,
      authState: 'reauth-required',
      tokenVersion: input.metadata.tokenVersion,
      refreshState: 'idle',
      retryCount: 0,
    },
  }
}

function hasRequiredScopes(
  grantedScopes: readonly DeviceTokenScope[],
  requiredScopes: readonly DeviceTokenScope[],
): boolean {
  const granted = new Set(grantedScopes)
  return requiredScopes.every((scope) => granted.has(scope))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isClientAuthState(value: unknown): value is ClientAuthMetadata['authState'] {
  return value === 'active' || value === 'revoked' || value === 'reauth-required'
}

function isClientRefreshState(value: unknown): value is ClientAuthMetadata['refreshState'] {
  return value === 'idle' || value === 'refreshing' || value === 'backing-off'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
