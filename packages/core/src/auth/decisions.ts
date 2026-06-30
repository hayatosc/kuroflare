import type {
  ClientAuthRefreshDecisionInput,
  ClientAuthRefreshDecision,
  ClientAuthStartDecisionInput,
  ClientAuthStartDecision,
  ClientAuthRefreshAttemptInput,
  ClientAuthRefreshAttemptDecision,
  ClientAuthRefreshStartInput,
  ClientAuthRefreshStartDecision,
  ClientAuthRefreshStaleStartRecoveryInput,
  ClientAuthRefreshStaleStartRecoveryDecision,
  ClientAuthMetadataSetupPersistInput,
  ClientAuthMetadataSetupPersistDecision,
  ClientDeviceRevokeDecisionInput,
  ClientDeviceRevokeDecision,
  ClientAuthMetadataRevokePatchInput,
  ClientAuthMetadataPatchDecision,
  ClientAuthMetadataRefreshAttemptPatchInput,
} from './types'
import {
  isPositiveSafeInteger,
  isNonNegativeSafeInteger,
  isBoundedNonEmptyString,
  isClientAuthMetadata,
} from './validation'

/** Backoff policy for retrying client token refresh attempts. */
export const CLIENT_AUTH_REFRESH_RETRY_POLICY = {
  scheduleMs: [1_000, 5_000, 30_000, 300_000],
  maxDelayMs: 300_000,
} as const

/**
 * Decides whether the plugin may persist a refreshed access token and resume auth-paused work.
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
 * Applies a revoke patch to persisted auth metadata without touching pending outbox state.
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

function hasRequiredScopes<T>(grantedScopes: readonly T[], requiredScopes: readonly T[]): boolean {
  const granted = new Set(grantedScopes)
  return requiredScopes.every((scope) => granted.has(scope))
}
