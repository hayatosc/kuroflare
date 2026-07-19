import * as v from 'valibot'

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
  ClientAuthMetadataRefreshAttemptPatchSchema,
  ClientAuthMetadataRevokePatchSchema,
  ClientAuthRefreshAttemptAcceptedSchema,
  ClientAuthRefreshAttemptInputSchema,
  ClientAuthRefreshInputSchema,
  ClientAuthRefreshStaleStartRecoveryInputSchema,
  ClientAuthRefreshStartInputSchema,
  ClientAuthStartInputSchema,
  ClientDeviceRevokeEvidenceSchema,
  SetupPersistInputSchema,
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
  const result = v.safeParse(ClientAuthRefreshInputSchema, {
    now: input.now,
    previousTokenVersion: input.previousTokenVersion,
  })
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'now':
        return { action: 'reject', reason: 'invalid-time' }
      case 'previousTokenVersion':
        return { action: 'reject', reason: 'invalid-previous-token-version' }
      default:
        return { action: 'reject', reason: 'invalid-time' }
    }
  }
  const { now, previousTokenVersion } = result.output

  if (input.claims.aud !== input.expectedVaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (input.claims.sub !== input.expectedDeviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (now < input.claims.iat) {
    return { action: 'reject', reason: 'token-not-yet-valid' }
  }
  if (now >= input.claims.exp) {
    return { action: 'reject', reason: 'token-expired' }
  }
  if (previousTokenVersion !== undefined && input.claims.tokenVersion < previousTokenVersion) {
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
  const result = v.safeParse(ClientAuthStartInputSchema, input)
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'now':
        return { action: 'reject', reason: 'invalid-time' }
      case 'tokenExpiresAt':
        return { action: 'reject', reason: 'invalid-token-expiry' }
      case 'refreshMarginMs':
        return { action: 'reject', reason: 'invalid-refresh-margin' }
      case 'estimatedDurationMs':
        return { action: 'reject', reason: 'invalid-estimated-duration' }
      default:
        return { action: 'reject', reason: 'invalid-time' }
    }
  }
  const { now, tokenExpiresAt, refreshMarginMs, estimatedDurationMs } = result.output

  const remainingMs = tokenExpiresAt - now
  const requiredRemainingMs = refreshMarginMs + (estimatedDurationMs ?? 0)
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
  const result = v.safeParse(ClientAuthRefreshAttemptInputSchema, input)
  if (!result.success) {
    const firstIssue = result.issues[0]
    const firstKey = String(firstIssue?.path?.[0]?.key)
    if (firstKey === 'now') return { action: 'reject', reason: 'invalid-time' }
    if (firstKey === 'retryCount') return { action: 'reject', reason: 'invalid-retry-count' }
    if (firstKey === 'retryAfterMs') return { action: 'reject', reason: 'invalid-retry-after' }
    return { action: 'reject', reason: 'invalid-time' }
  }

  const { now, retryCount, retryAfterMs } = result.output

  if (input.result.status === 'accepted') {
    const acceptedResult = v.safeParse(ClientAuthRefreshAttemptAcceptedSchema, input.result)
    if (!acceptedResult.success) {
      const firstIssue = acceptedResult.issues[0]
      const path = firstIssue?.path
      const lastKey = String(path?.[path.length - 1]?.key)
      if (lastKey === 'expiresAt') return { action: 'reject', reason: 'invalid-token-expiry' }
      return { action: 'reject', reason: 'invalid-token-version' }
    }
    const { patch } = acceptedResult.output
    return {
      action: 'complete',
      patch: {
        refreshState: 'idle',
        retryCount: 0,
        tokenVersion: patch.tokenVersion,
        expiresAt: patch.expiresAt,
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

  const nextRetryCount = retryCount + 1
  const scheduledDelayMs =
    CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[
      Math.min(retryCount, CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs.length - 1)
    ] ?? CLIENT_AUTH_REFRESH_RETRY_POLICY.maxDelayMs
  const delayMs = Math.max(scheduledDelayMs, retryAfterMs ?? 0)
  return {
    action: 'backoff',
    patch: {
      refreshState: 'backing-off',
      retryCount: nextRetryCount,
      nextAllowedRefreshAt: now + delayMs,
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
  const result = v.safeParse(ClientAuthRefreshStartInputSchema, input)
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'metadata':
        return { action: 'reject', reason: 'invalid-metadata' }
      case 'requestedAt':
        return { action: 'reject', reason: 'invalid-requested-at' }
      default:
        return { action: 'reject', reason: 'invalid-metadata' }
    }
  }
  const { metadata, requestedAt } = result.output

  if (metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }
  if (metadata.accessTokenSecretKey === undefined || metadata.refreshTokenSecretKey === undefined) {
    return { action: 'reject', reason: 'missing-token-secret-keys' }
  }
  if (metadata.refreshState === 'refreshing') {
    return { action: 'reject', reason: 'refresh-already-running' }
  }
  if (
    metadata.refreshState === 'backing-off' &&
    metadata.nextAllowedRefreshAt !== undefined &&
    requestedAt < metadata.nextAllowedRefreshAt
  ) {
    return { action: 'reject', reason: 'refresh-backoff' }
  }

  return {
    action: 'start',
    metadata: {
      deviceId: metadata.deviceId,
      authState: 'active',
      tokenVersion: metadata.tokenVersion,
      accessTokenExpiresAt: metadata.accessTokenExpiresAt,
      refreshState: 'refreshing',
      refreshStartedAt: requestedAt,
      retryCount: metadata.retryCount,
      accessTokenSecretKey: metadata.accessTokenSecretKey,
      refreshTokenSecretKey: metadata.refreshTokenSecretKey,
    },
  }
}

/**
 * Recovers an abandoned `refreshing` marker after a bounded timeout.
 */
export function decideClientAuthRefreshStaleStartRecovery(
  input: ClientAuthRefreshStaleStartRecoveryInput,
): ClientAuthRefreshStaleStartRecoveryDecision {
  const result = v.safeParse(ClientAuthRefreshStaleStartRecoveryInputSchema, input)
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'metadata':
        return { action: 'reject', reason: 'invalid-metadata' }
      case 'now':
        return { action: 'reject', reason: 'invalid-clock' }
      case 'staleAfterMs':
        return { action: 'reject', reason: 'invalid-stale-timeout' }
      default:
        return { action: 'reject', reason: 'invalid-metadata' }
    }
  }
  const { metadata, now, staleAfterMs } = result.output

  if (metadata.refreshState !== 'refreshing') {
    return { action: 'noop', reason: 'not-refreshing' }
  }
  const refreshStartedAt = metadata.refreshStartedAt
  if (refreshStartedAt === undefined) {
    return { action: 'reject', reason: 'invalid-refresh-started-at' }
  }

  const staleAt = refreshStartedAt + staleAfterMs
  if (now < staleAt) {
    return { action: 'wait', refreshStartedAt, staleAt }
  }

  const retryCount = metadata.retryCount + 1
  const scheduledDelayMs =
    CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[
      Math.min(metadata.retryCount, CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs.length - 1)
    ] ?? CLIENT_AUTH_REFRESH_RETRY_POLICY.maxDelayMs
  return {
    action: 'recover',
    metadata: {
      deviceId: metadata.deviceId,
      authState: 'active',
      tokenVersion: metadata.tokenVersion,
      accessTokenExpiresAt: metadata.accessTokenExpiresAt,
      refreshState: 'backing-off',
      retryCount,
      nextAllowedRefreshAt: now + scheduledDelayMs,
      accessTokenSecretKey: metadata.accessTokenSecretKey,
      refreshTokenSecretKey: metadata.refreshTokenSecretKey,
    },
  }
}

/**
 * Creates the initial persisted auth metadata after setup tokens have been placed in SecretStorage.
 */
export function planClientAuthMetadataFromSetupResponse(
  input: ClientAuthMetadataSetupPersistInput,
): ClientAuthMetadataSetupPersistDecision {
  const result = v.safeParse(SetupPersistInputSchema, input)
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'response':
        return { action: 'reject', reason: 'invalid-token-version' }
      case 'accessTokenExpiresAt':
        return { action: 'reject', reason: 'invalid-token-expiry' }
      case 'accessTokenSecretKey':
        return { action: 'reject', reason: 'invalid-secret-key' }
      case 'refreshTokenSecretKey':
        return { action: 'reject', reason: 'invalid-secret-key' }
      default:
        return { action: 'reject', reason: 'invalid-token-version' }
    }
  }
  const { response, accessTokenExpiresAt, accessTokenSecretKey, refreshTokenSecretKey } =
    result.output

  return {
    action: 'persist',
    metadata: {
      deviceId: input.response.deviceId,
      authState: 'active',
      tokenVersion: response.tokenVersion,
      accessTokenExpiresAt,
      refreshState: 'idle',
      retryCount: 0,
      accessTokenSecretKey,
      refreshTokenSecretKey,
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
  const result = v.safeParse(ClientDeviceRevokeEvidenceSchema, {
    tokenVersion: input.response.tokenVersion,
    revokedAt: input.response.revokedAt,
    previousTokenVersion: input.previousTokenVersion,
  })
  if (!result.success) {
    switch (String(result.issues[0]?.path?.[0]?.key)) {
      case 'tokenVersion':
        return { action: 'reject', reason: 'invalid-token-version' }
      case 'revokedAt':
        return { action: 'reject', reason: 'invalid-revoked-at' }
      case 'previousTokenVersion':
        return { action: 'reject', reason: 'invalid-token-version' }
      default:
        return { action: 'reject', reason: 'invalid-token-version' }
    }
  }
  const { tokenVersion, revokedAt, previousTokenVersion } = result.output

  if (previousTokenVersion !== undefined && tokenVersion < previousTokenVersion) {
    return { action: 'reject', reason: 'token-version-regressed' }
  }

  return {
    action: 'mark-revoked',
    patch: {
      authState: 'revoked',
      tokenVersion,
      revokedAt,
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
  const result = v.safeParse(ClientAuthMetadataRevokePatchSchema, input)
  if (!result.success) return { action: 'reject', reason: 'invalid-metadata' }
  const { metadata } = result.output

  if (metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }
  if (input.patch.tokenVersion < metadata.tokenVersion) {
    return { action: 'reject', reason: 'token-version-regressed' }
  }

  return {
    action: 'apply',
    metadata: {
      deviceId: metadata.deviceId,
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
  const result = v.safeParse(ClientAuthMetadataRefreshAttemptPatchSchema, input)
  if (!result.success) return { action: 'reject', reason: 'invalid-metadata' }
  const metadata = result.output.metadata

  if (metadata.authState !== 'active') {
    return { action: 'reject', reason: 'device-not-active' }
  }

  if (input.decision.action === 'reject') {
    return { action: 'reject', reason: 'attempt-not-persistable' }
  }

  if (input.decision.action === 'complete') {
    if (input.decision.patch.tokenVersion < metadata.tokenVersion) {
      return { action: 'reject', reason: 'token-version-regressed' }
    }

    return {
      action: 'apply',
      metadata: {
        deviceId: metadata.deviceId,
        authState: 'active',
        tokenVersion: input.decision.patch.tokenVersion,
        accessTokenExpiresAt: input.decision.patch.expiresAt,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: metadata.accessTokenSecretKey,
        refreshTokenSecretKey: metadata.refreshTokenSecretKey,
      },
    }
  }

  if (input.decision.action === 'backoff') {
    return {
      action: 'apply',
      metadata: {
        deviceId: metadata.deviceId,
        authState: 'active',
        tokenVersion: metadata.tokenVersion,
        accessTokenExpiresAt: metadata.accessTokenExpiresAt,
        refreshState: 'backing-off',
        retryCount: input.decision.patch.retryCount,
        nextAllowedRefreshAt: input.decision.patch.nextAllowedRefreshAt,
        accessTokenSecretKey: metadata.accessTokenSecretKey,
        refreshTokenSecretKey: metadata.refreshTokenSecretKey,
      },
    }
  }

  return {
    action: 'apply',
    metadata: {
      deviceId: metadata.deviceId,
      authState: 'reauth-required',
      tokenVersion: metadata.tokenVersion,
      refreshState: 'idle',
      retryCount: 0,
    },
  }
}

function hasRequiredScopes<T>(grantedScopes: readonly T[], requiredScopes: readonly T[]): boolean {
  const granted = new Set(grantedScopes)
  return requiredScopes.every((scope) => granted.has(scope))
}
