import assert from 'node:assert/strict'

import {
  DEVICE_TOKEN_ISSUER,
  makeDeviceId,
  makeVaultId,
  type DeviceTokenClaims,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { test } from 'vitest'

import {
  CLIENT_AUTH_REFRESH_RETRY_POLICY,
  applyClientAuthMetadataRefreshAttemptPatch,
  applyClientAuthMetadataRevokePatch,
  decideClientDeviceRevoke,
  decideClientAuthRefresh,
  decideClientAuthRefreshAttempt,
  decideClientAuthRefreshStart,
  decideClientAuthRefreshStaleStartRecovery,
  decideClientAuthStart,
  isClientAuthMetadata,
  planClientAuthMetadataFromSetupResponse,
  type ClientAuthMetadata,
} from './auth'

const vaultId = makeVaultId('vault-1')
const otherVaultId = makeVaultId('vault-2')
const deviceId = makeDeviceId('device-1')
const otherDeviceId = makeDeviceId('device-2')

const claims = {
  iss: DEVICE_TOKEN_ISSUER,
  aud: vaultId,
  sub: deviceId,
  scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  iat: 100,
  exp: 1_000,
  tokenVersion: 4,
} satisfies DeviceTokenClaims

const setupResponse = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  yClientId: 1,
  accessToken: 'signed-access-token',
  refreshToken: 'opaque-refresh-token',
  tokenVersion: 4,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

const activeAuthMetadata = {
  deviceId,
  authState: 'active',
  tokenVersion: 4,
  accessTokenExpiresAt: 1_000,
  refreshState: 'idle',
  retryCount: 0,
  accessTokenSecretKey: 'kuroflare:access-token',
  refreshTokenSecretKey: 'kuroflare:refresh-token',
} satisfies ClientAuthMetadata

test('client auth metadata setup persist creates active metadata with secret references', () => {
  assert.deepEqual(
    planClientAuthMetadataFromSetupResponse({
      response: setupResponse,
      accessTokenSecretKey: 'kuroflare:access-token',
      refreshTokenSecretKey: 'kuroflare:refresh-token',
      accessTokenExpiresAt: 1_000,
    }),
    {
      action: 'persist',
      metadata: activeAuthMetadata,
    },
  )
})

test('client auth metadata setup persist rejects unsafe setup evidence', () => {
  assert.deepEqual(
    planClientAuthMetadataFromSetupResponse({
      response: setupResponse,
      accessTokenSecretKey: '',
      refreshTokenSecretKey: 'kuroflare:refresh-token',
      accessTokenExpiresAt: 1_000,
    }),
    { action: 'reject', reason: 'invalid-secret-key' },
  )

  assert.deepEqual(
    planClientAuthMetadataFromSetupResponse({
      response: setupResponse,
      accessTokenSecretKey: 'kuroflare:access-token',
      refreshTokenSecretKey: '',
      accessTokenExpiresAt: 1_000,
    }),
    { action: 'reject', reason: 'invalid-secret-key' },
  )

  assert.deepEqual(
    planClientAuthMetadataFromSetupResponse({
      response: setupResponse,
      accessTokenSecretKey: 'kuroflare:access-token',
      refreshTokenSecretKey: 'kuroflare:refresh-token',
      accessTokenExpiresAt: -1,
    }),
    { action: 'reject', reason: 'invalid-token-expiry' },
  )

  assert.deepEqual(
    planClientAuthMetadataFromSetupResponse({
      response: { ...setupResponse, tokenVersion: 0 },
      accessTokenSecretKey: 'kuroflare:access-token',
      refreshTokenSecretKey: 'kuroflare:refresh-token',
      accessTokenExpiresAt: 1_000,
    }),
    { action: 'reject', reason: 'invalid-token-version' },
  )
})

test('client auth refresh accepts fresh matching tokens and emits resume event', () => {
  assert.deepEqual(
    decideClientAuthRefresh({
      claims,
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read', 'sync:write'],
      previousTokenVersion: 3,
      now: 200,
    }),
    {
      action: 'accept',
      patch: {
        tokenVersion: 4,
        expiresAt: 1_000,
        emitResumeEvent: 'auth-refresh',
      },
    },
  )
})

test('client auth refresh rejects mismatched local identity', () => {
  assert.deepEqual(
    decideClientAuthRefresh({
      claims: { ...claims, aud: otherVaultId },
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'vault-mismatch' },
  )

  assert.deepEqual(
    decideClientAuthRefresh({
      claims: { ...claims, sub: otherDeviceId },
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'device-mismatch' },
  )
})

test('client auth refresh rejects unusable token windows and versions', () => {
  assert.deepEqual(
    decideClientAuthRefresh({
      claims,
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: -1,
    }),
    { action: 'reject', reason: 'invalid-time' },
  )

  assert.deepEqual(
    decideClientAuthRefresh({
      claims,
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: 50,
    }),
    { action: 'reject', reason: 'token-not-yet-valid' },
  )

  assert.deepEqual(
    decideClientAuthRefresh({
      claims,
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: 1_000,
    }),
    { action: 'reject', reason: 'token-expired' },
  )

  assert.deepEqual(
    decideClientAuthRefresh({
      claims: { ...claims, tokenVersion: 2 },
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'token-version-regressed' },
  )

  assert.deepEqual(
    decideClientAuthRefresh({
      claims,
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read'],
      previousTokenVersion: 0,
      now: 200,
    }),
    { action: 'reject', reason: 'invalid-previous-token-version' },
  )
})

test('client auth refresh rejects missing scopes', () => {
  assert.deepEqual(
    decideClientAuthRefresh({
      claims: { ...claims, scope: ['sync:read'] },
      expectedVaultId: vaultId,
      expectedDeviceId: deviceId,
      requiredScopes: ['sync:read', 'sync:write'],
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'missing-scope' },
  )
})

test('client auth refresh attempt completes accepted tokens and emits resume event', () => {
  const refresh = decideClientAuthRefresh({
    claims,
    expectedVaultId: vaultId,
    expectedDeviceId: deviceId,
    requiredScopes: ['sync:read', 'sync:write'],
    previousTokenVersion: 3,
    now: 200,
  })

  assert.equal(refresh.action, 'accept')
  if (refresh.action !== 'accept') {
    throw new Error('expected accepted refresh')
  }

  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 200,
      retryCount: 2,
      result: { status: 'accepted', patch: refresh.patch },
    }),
    {
      action: 'complete',
      patch: {
        refreshState: 'idle',
        retryCount: 0,
        tokenVersion: 4,
        expiresAt: 1_000,
        emitResumeEvent: 'auth-refresh',
      },
    },
  )
})

test('client auth refresh attempt backs off retryable failures', () => {
  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: 0,
      result: { status: 'retryable-failure', reason: 'network' },
    }),
    {
      action: 'backoff',
      patch: {
        refreshState: 'backing-off',
        retryCount: 1,
        nextAllowedRefreshAt: 1_000 + CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[0],
        reason: 'network',
      },
    },
  )

  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: 1,
      retryAfterMs: 60_000,
      result: { status: 'retryable-failure', reason: 'server-retryable' },
    }),
    {
      action: 'backoff',
      patch: {
        refreshState: 'backing-off',
        retryCount: 2,
        nextAllowedRefreshAt: 61_000,
        reason: 'server-retryable',
      },
    },
  )
})

test('client auth refresh start marks active metadata as refreshing', () => {
  assert.deepEqual(
    decideClientAuthRefreshStart({
      metadata: activeAuthMetadata,
      requestedAt: 2_000,
    }),
    {
      action: 'start',
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
    },
  )
})

test('client auth refresh start rejects unsafe or duplicate starts', () => {
  assert.deepEqual(
    decideClientAuthRefreshStart({
      metadata: { ...activeAuthMetadata, refreshState: 'refreshing' },
      requestedAt: 2_000,
    }),
    { action: 'reject', reason: 'refresh-already-running' },
  )

  assert.deepEqual(
    decideClientAuthRefreshStart({
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'backing-off',
        nextAllowedRefreshAt: 3_000,
      },
      requestedAt: 2_000,
    }),
    { action: 'reject', reason: 'refresh-backoff' },
  )

  assert.deepEqual(
    decideClientAuthRefreshStart({
      metadata: { ...activeAuthMetadata, accessTokenSecretKey: undefined },
      requestedAt: 2_000,
    }),
    { action: 'reject', reason: 'missing-token-secret-keys' },
  )
})

test('client auth refresh stale start recovery waits then backs off abandoned refreshing metadata', () => {
  assert.deepEqual(
    decideClientAuthRefreshStaleStartRecovery({
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
      now: 6_000,
      staleAfterMs: 5_000,
    }),
    { action: 'wait', refreshStartedAt: 2_000, staleAt: 7_000 },
  )

  assert.deepEqual(
    decideClientAuthRefreshStaleStartRecovery({
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
      now: 7_000,
      staleAfterMs: 5_000,
    }),
    {
      action: 'recover',
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'backing-off',
        retryCount: 1,
        nextAllowedRefreshAt: 7_000 + CLIENT_AUTH_REFRESH_RETRY_POLICY.scheduleMs[0],
      },
    },
  )
})

test('client auth refresh stale start recovery rejects invalid evidence', () => {
  assert.deepEqual(
    decideClientAuthRefreshStaleStartRecovery({
      metadata: activeAuthMetadata,
      now: 7_000,
      staleAfterMs: 5_000,
    }),
    { action: 'noop', reason: 'not-refreshing' },
  )

  assert.deepEqual(
    decideClientAuthRefreshStaleStartRecovery({
      metadata: { ...activeAuthMetadata, refreshState: 'refreshing' },
      now: 7_000,
      staleAfterMs: 5_000,
    }),
    { action: 'reject', reason: 'invalid-refresh-started-at' },
  )

  assert.deepEqual(
    decideClientAuthRefreshStaleStartRecovery({
      metadata: {
        ...activeAuthMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
      now: 7_000,
      staleAfterMs: 0,
    }),
    { action: 'reject', reason: 'invalid-stale-timeout' },
  )
})

test('client auth refresh attempt requires reauth for permanent failures', () => {
  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: 3,
      result: { status: 'permanent-failure', reason: 'device-revoked' },
    }),
    {
      action: 'require-reauth',
      patch: {
        refreshState: 'idle',
        retryCount: 0,
        reason: 'device-revoked',
      },
    },
  )
})

test('client device revoke clears token material and stops sync without dropping outbox', () => {
  assert.deepEqual(
    decideClientDeviceRevoke({
      response: {
        deviceId,
        status: 'revoked',
        revokedAt: 1_000,
        tokenVersion: 5,
      },
      expectedDeviceId: deviceId,
      previousTokenVersion: 4,
    }),
    {
      action: 'mark-revoked',
      patch: {
        authState: 'revoked',
        tokenVersion: 5,
        revokedAt: 1_000,
        clearAccessToken: true,
        clearRefreshToken: true,
        stopSync: true,
        keepOutbox: true,
      },
    },
  )

  assert.equal(
    decideClientDeviceRevoke({
      response: {
        deviceId,
        status: 'already-revoked',
        revokedAt: 1_000,
        tokenVersion: 5,
      },
      expectedDeviceId: deviceId,
      previousTokenVersion: 5,
    }).action,
    'mark-revoked',
  )
})

test('client device revoke rejects mismatched or regressed responses', () => {
  assert.deepEqual(
    decideClientDeviceRevoke({
      response: {
        deviceId: otherDeviceId,
        status: 'revoked',
        revokedAt: 1_000,
        tokenVersion: 5,
      },
      expectedDeviceId: deviceId,
      previousTokenVersion: 4,
    }),
    { action: 'reject', reason: 'device-mismatch' },
  )

  assert.deepEqual(
    decideClientDeviceRevoke({
      response: {
        deviceId,
        status: 'revoked',
        revokedAt: 1_000,
        tokenVersion: 3,
      },
      expectedDeviceId: deviceId,
      previousTokenVersion: 4,
    }),
    { action: 'reject', reason: 'token-version-regressed' },
  )

  assert.deepEqual(
    decideClientDeviceRevoke({
      response: {
        deviceId,
        status: 'revoked',
        revokedAt: -1,
        tokenVersion: 5,
      },
      expectedDeviceId: deviceId,
      previousTokenVersion: 4,
    }),
    { action: 'reject', reason: 'invalid-revoked-at' },
  )
})

test('client auth metadata guard validates persisted auth state', () => {
  assert.equal(isClientAuthMetadata(activeAuthMetadata), true)
  assert.equal(isClientAuthMetadata({ ...activeAuthMetadata, deviceId: '/bad' }), false)
  assert.equal(isClientAuthMetadata({ ...activeAuthMetadata, authState: 'other' }), false)
  assert.equal(isClientAuthMetadata({ ...activeAuthMetadata, tokenVersion: 0 }), false)
  assert.equal(isClientAuthMetadata({ ...activeAuthMetadata, retryCount: -1 }), false)
  assert.equal(isClientAuthMetadata({ ...activeAuthMetadata, accessTokenSecretKey: '' }), false)
})

test('client auth metadata revoke patch clears token references and keeps outbox external', () => {
  const revoke = decideClientDeviceRevoke({
    response: {
      deviceId,
      status: 'revoked',
      revokedAt: 1_000,
      tokenVersion: 5,
    },
    expectedDeviceId: deviceId,
    previousTokenVersion: 4,
  })

  assert.equal(revoke.action, 'mark-revoked')
  if (revoke.action !== 'mark-revoked') {
    throw new Error('expected revoke patch')
  }

  assert.deepEqual(
    applyClientAuthMetadataRevokePatch({
      metadata: activeAuthMetadata,
      patch: revoke.patch,
    }),
    {
      action: 'apply',
      metadata: {
        deviceId,
        authState: 'revoked',
        tokenVersion: 5,
        revokedAt: 1_000,
        refreshState: 'idle',
        retryCount: 0,
      },
    },
  )
})

test('client auth metadata revoke patch rejects unsafe persisted state', () => {
  const patch = {
    authState: 'revoked',
    tokenVersion: 3,
    revokedAt: 1_000,
    clearAccessToken: true,
    clearRefreshToken: true,
    stopSync: true,
    keepOutbox: true,
  } as const

  assert.deepEqual(
    applyClientAuthMetadataRevokePatch({
      metadata: { ...activeAuthMetadata, tokenVersion: 4 },
      patch,
    }),
    { action: 'reject', reason: 'token-version-regressed' },
  )

  assert.deepEqual(
    applyClientAuthMetadataRevokePatch({
      metadata: { ...activeAuthMetadata, authState: 'revoked' },
      patch: { ...patch, tokenVersion: 5 },
    }),
    { action: 'reject', reason: 'device-not-active' },
  )

  assert.deepEqual(
    applyClientAuthMetadataRevokePatch({
      metadata: { ...activeAuthMetadata, retryCount: -1 },
      patch: { ...patch, tokenVersion: 5 },
    }),
    { action: 'reject', reason: 'invalid-metadata' },
  )
})

test('client auth metadata refresh attempt patch persists accepted tokens', () => {
  const attempt = decideClientAuthRefreshAttempt({
    now: 200,
    retryCount: 2,
    result: {
      status: 'accepted',
      patch: {
        tokenVersion: 5,
        expiresAt: 2_000,
        emitResumeEvent: 'auth-refresh',
      },
    },
  })

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: activeAuthMetadata,
      decision: attempt,
    }),
    {
      action: 'apply',
      metadata: {
        deviceId,
        authState: 'active',
        tokenVersion: 5,
        accessTokenExpiresAt: 2_000,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: 'kuroflare:access-token',
        refreshTokenSecretKey: 'kuroflare:refresh-token',
      },
    },
  )
})

test('client auth metadata refresh attempt patch persists backoff', () => {
  const attempt = decideClientAuthRefreshAttempt({
    now: 1_000,
    retryCount: 1,
    retryAfterMs: 60_000,
    result: { status: 'retryable-failure', reason: 'server-retryable' },
  })

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: activeAuthMetadata,
      decision: attempt,
    }),
    {
      action: 'apply',
      metadata: {
        deviceId,
        authState: 'active',
        tokenVersion: 4,
        accessTokenExpiresAt: 1_000,
        refreshState: 'backing-off',
        retryCount: 2,
        nextAllowedRefreshAt: 61_000,
        accessTokenSecretKey: 'kuroflare:access-token',
        refreshTokenSecretKey: 'kuroflare:refresh-token',
      },
    },
  )
})

test('client auth metadata refresh attempt patch marks permanent failures for reauth', () => {
  const attempt = decideClientAuthRefreshAttempt({
    now: 1_000,
    retryCount: 3,
    result: { status: 'permanent-failure', reason: 'refresh-token-rejected' },
  })

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: activeAuthMetadata,
      decision: attempt,
    }),
    {
      action: 'apply',
      metadata: {
        deviceId,
        authState: 'reauth-required',
        tokenVersion: 4,
        refreshState: 'idle',
        retryCount: 0,
      },
    },
  )
})

test('client auth metadata refresh attempt patch rejects unsafe updates', () => {
  const regressed = decideClientAuthRefreshAttempt({
    now: 200,
    retryCount: 0,
    result: {
      status: 'accepted',
      patch: {
        tokenVersion: 3,
        expiresAt: 2_000,
        emitResumeEvent: 'auth-refresh',
      },
    },
  })
  const invalidAttempt = decideClientAuthRefreshAttempt({
    now: -1,
    retryCount: 0,
    result: { status: 'retryable-failure', reason: 'network' },
  })

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: activeAuthMetadata,
      decision: regressed,
    }),
    { action: 'reject', reason: 'token-version-regressed' },
  )

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: activeAuthMetadata,
      decision: invalidAttempt,
    }),
    { action: 'reject', reason: 'attempt-not-persistable' },
  )

  assert.deepEqual(
    applyClientAuthMetadataRefreshAttemptPatch({
      metadata: { ...activeAuthMetadata, authState: 'revoked' },
      decision: regressed,
    }),
    { action: 'reject', reason: 'device-not-active' },
  )
})

test('client auth refresh attempt rejects invalid attempt evidence', () => {
  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: -1,
      retryCount: 0,
      result: { status: 'retryable-failure', reason: 'network' },
    }),
    { action: 'reject', reason: 'invalid-time' },
  )

  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: -1,
      result: { status: 'retryable-failure', reason: 'network' },
    }),
    { action: 'reject', reason: 'invalid-retry-count' },
  )

  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: 0,
      retryAfterMs: -1,
      result: { status: 'retryable-failure', reason: 'server-retryable' },
    }),
    { action: 'reject', reason: 'invalid-retry-after' },
  )

  assert.deepEqual(
    decideClientAuthRefreshAttempt({
      now: 1_000,
      retryCount: 0,
      result: {
        status: 'accepted',
        patch: { tokenVersion: 0, expiresAt: 1_000, emitResumeEvent: 'auth-refresh' },
      },
    }),
    { action: 'reject', reason: 'invalid-token-version' },
  )
})

test('client auth start allows side effects only with enough token lifetime', () => {
  assert.deepEqual(
    decideClientAuthStart({
      now: 100,
      tokenExpiresAt: 1_000,
      refreshMarginMs: 200,
      estimatedDurationMs: 300,
    }),
    { action: 'start', remainingMs: 900 },
  )

  assert.deepEqual(
    decideClientAuthStart({
      now: 800,
      tokenExpiresAt: 1_000,
      refreshMarginMs: 200,
      estimatedDurationMs: 1,
    }),
    {
      action: 'refresh-first',
      reason: 'token-expiring-soon',
      remainingMs: 200,
      requiredRemainingMs: 201,
    },
  )

  assert.deepEqual(
    decideClientAuthStart({
      now: 1_000,
      tokenExpiresAt: 1_000,
      refreshMarginMs: 200,
      estimatedDurationMs: 0,
    }),
    {
      action: 'refresh-first',
      reason: 'token-expired',
      remainingMs: 0,
      requiredRemainingMs: 200,
    },
  )
})

test('client auth start rejects invalid local timing evidence', () => {
  assert.deepEqual(
    decideClientAuthStart({ now: -1, tokenExpiresAt: 1_000, refreshMarginMs: 200 }),
    { action: 'reject', reason: 'invalid-time' },
  )

  assert.deepEqual(decideClientAuthStart({ now: 100, tokenExpiresAt: -1, refreshMarginMs: 200 }), {
    action: 'reject',
    reason: 'invalid-token-expiry',
  })

  assert.deepEqual(
    decideClientAuthStart({ now: 100, tokenExpiresAt: 1_000, refreshMarginMs: -1 }),
    { action: 'reject', reason: 'invalid-refresh-margin' },
  )

  assert.deepEqual(
    decideClientAuthStart({
      now: 100,
      tokenExpiresAt: 1_000,
      refreshMarginMs: 200,
      estimatedDurationMs: -1,
    }),
    { action: 'reject', reason: 'invalid-estimated-duration' },
  )
})
