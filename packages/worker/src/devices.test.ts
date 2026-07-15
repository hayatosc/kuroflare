import { makeDeviceId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  decideClientHelloRegistry,
  decideDeviceTokenRefresh,
  decideRevokeDevice,
  decideSetupExchange,
  planDeviceRefreshTokenRotation,
  planSetupExchangeCredentials,
  type DeviceRefreshTokenEvidence,
  type DeviceRegistryEntry,
} from './devices'

const deviceId = makeDeviceId('device-a')
const activeDevice: DeviceRegistryEntry = {
  deviceId,
  tokenVersion: 3,
  revokedAt: undefined,
}
const activeRefreshToken: DeviceRefreshTokenEvidence = {
  tokenHashMatches: true,
  issuedAt: 100,
  expiresAt: 1_000,
  revokedAt: undefined,
}

test('setup exchange reuses an active requested device', () => {
  assert.deepEqual(
    decideSetupExchange({
      requestedDeviceId: deviceId,
      registry: {
        existingDevice: activeDevice,
      },
    }),
    { action: 'reuse-device', device: activeDevice },
  )
})

test('setup exchange rejects revoked requested devices', () => {
  assert.deepEqual(
    decideSetupExchange({
      requestedDeviceId: deviceId,
      registry: {
        existingDevice: { ...activeDevice, revokedAt: 100 },
      },
    }),
    { action: 'reject', reason: 'device-revoked' },
  )
})

test('setup exchange registers a new device without an actor claim', () => {
  assert.deepEqual(
    decideSetupExchange({
      requestedDeviceId: undefined,
      registry: {
        existingDevice: undefined,
      },
    }),
    { action: 'register-device' },
  )
})

test('setup exchange credential plan issues initial refresh tokens for new devices', () => {
  const setupDecision = decideSetupExchange({
    requestedDeviceId: undefined,
    registry: {
      existingDevice: undefined,
    },
  })

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision,
      deviceId,
      refreshTokenHash: 'refresh-hash',
      now: 200,
      refreshTokenExpiresAt: 10_000,
    }),
    {
      action: 'issue-credentials',
      deviceId,
      tokenVersion: 1,
      insertRefreshToken: {
        tokenHash: 'refresh-hash',
        deviceId,
        issuedAt: 200,
        expiresAt: 10_000,
      },
    },
  )
})

test('setup exchange credential plan reuses active device identity and token version', () => {
  const setupDecision = decideSetupExchange({
    requestedDeviceId: deviceId,
    registry: {
      existingDevice: activeDevice,
    },
  })

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision,
      deviceId,
      refreshTokenHash: 'refresh-hash',
      now: 200,
      refreshTokenExpiresAt: 10_000,
    }),
    {
      action: 'issue-credentials',
      deviceId,
      tokenVersion: 3,
      insertRefreshToken: {
        tokenHash: 'refresh-hash',
        deviceId,
        issuedAt: 200,
        expiresAt: 10_000,
      },
    },
  )
})

test('setup exchange credential plan rejects unsafe credential evidence', () => {
  const rejectedSetup = { action: 'reject', reason: 'device-revoked' } as const
  const acceptedSetup = decideSetupExchange({
    requestedDeviceId: undefined,
    registry: {
      existingDevice: undefined,
    },
  })
  const reusedSetup = decideSetupExchange({
    requestedDeviceId: deviceId,
    registry: {
      existingDevice: activeDevice,
    },
  })

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision: rejectedSetup,
      deviceId,
      refreshTokenHash: 'refresh-hash',
      now: 200,
      refreshTokenExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'setup-not-accepted' },
  )

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision: acceptedSetup,
      deviceId,
      refreshTokenHash: '',
      now: 200,
      refreshTokenExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'empty-refresh-token-hash' },
  )

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision: acceptedSetup,
      deviceId,
      refreshTokenHash: 'refresh-hash',
      now: 200,
      refreshTokenExpiresAt: 200,
    }),
    { action: 'reject', reason: 'invalid-refresh-token-expiry' },
  )

  assert.deepEqual(
    planSetupExchangeCredentials({
      setupDecision: reusedSetup,
      deviceId: makeDeviceId('other-device'),
      refreshTokenHash: 'refresh-hash',
      now: 200,
      refreshTokenExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'device-id-mismatch' },
  )
})

test('client hello registry accepts matching active devices', () => {
  assert.deepEqual(
    decideClientHelloRegistry({
      device: activeDevice,
      tokenVersion: 3,
    }),
    { action: 'accept' },
  )
})

test('client hello registry rejects missing, revoked, and stale-token devices', () => {
  assert.deepEqual(
    decideClientHelloRegistry({
      device: undefined,
      tokenVersion: 3,
    }),
    { action: 'reject', reason: 'unknown-device' },
  )

  assert.deepEqual(
    decideClientHelloRegistry({
      device: { ...activeDevice, revokedAt: 100 },
      tokenVersion: 3,
    }),
    { action: 'reject', reason: 'device-revoked' },
  )

  assert.deepEqual(
    decideClientHelloRegistry({
      device: activeDevice,
      tokenVersion: 2,
    }),
    { action: 'reject', reason: 'stale-token' },
  )
})

test('device token refresh mints current registry token version', () => {
  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'mint-token', tokenVersion: 3, rotateRefreshToken: true },
  )
})

test('device token refresh rejects unknown or revoked devices', () => {
  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: undefined,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'unknown-device' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: { ...activeDevice, revokedAt: 150 },
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'device-revoked' },
  )
})

test('device token refresh rejects unusable refresh token evidence', () => {
  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: undefined,
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'missing-refresh-token' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: { ...activeRefreshToken, tokenHashMatches: false },
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'refresh-token-mismatch' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: { ...activeRefreshToken, revokedAt: 150 },
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'refresh-token-revoked' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: 50,
    }),
    { action: 'reject', reason: 'refresh-token-not-yet-valid' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: 1_000,
    }),
    { action: 'reject', reason: 'refresh-token-expired' },
  )
})

test('device token refresh rejects stale, impossible, or invalid versions', () => {
  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 2,
      now: 200,
    }),
    { action: 'reject', reason: 'stale-token' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 4,
      now: 200,
    }),
    { action: 'reject', reason: 'token-version-ahead' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 0,
      now: 200,
    }),
    { action: 'reject', reason: 'invalid-previous-token-version' },
  )
})

test('device token refresh rejects invalid clocks and refresh token windows', () => {
  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: activeRefreshToken,
      previousTokenVersion: 3,
      now: -1,
    }),
    { action: 'reject', reason: 'invalid-time' },
  )

  assert.deepEqual(
    decideDeviceTokenRefresh({
      device: activeDevice,
      refreshToken: { ...activeRefreshToken, expiresAt: 100 },
      previousTokenVersion: 3,
      now: 200,
    }),
    { action: 'reject', reason: 'invalid-refresh-token-window' },
  )
})

test('device refresh token rotation revokes current hash and inserts next hash', () => {
  const refreshDecision = decideDeviceTokenRefresh({
    device: activeDevice,
    refreshToken: activeRefreshToken,
    previousTokenVersion: 3,
    now: 200,
  })

  assert.deepEqual(
    planDeviceRefreshTokenRotation({
      refreshDecision,
      deviceId,
      currentTokenHash: 'old-hash',
      nextTokenHash: 'new-hash',
      now: 200,
      nextExpiresAt: 10_000,
    }),
    {
      action: 'rotate',
      revoke: { tokenHash: 'old-hash', revokedAt: 200 },
      insert: {
        tokenHash: 'new-hash',
        deviceId,
        issuedAt: 200,
        expiresAt: 10_000,
      },
    },
  )
})

test('device refresh token rotation rejects unsafe rotation evidence', () => {
  const acceptedRefresh = decideDeviceTokenRefresh({
    device: activeDevice,
    refreshToken: activeRefreshToken,
    previousTokenVersion: 3,
    now: 200,
  })
  const rejectedRefresh = decideDeviceTokenRefresh({
    device: activeDevice,
    refreshToken: activeRefreshToken,
    previousTokenVersion: 2,
    now: 200,
  })

  assert.deepEqual(
    planDeviceRefreshTokenRotation({
      refreshDecision: rejectedRefresh,
      deviceId,
      currentTokenHash: 'old-hash',
      nextTokenHash: 'new-hash',
      now: 200,
      nextExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'refresh-not-accepted' },
  )

  assert.deepEqual(
    planDeviceRefreshTokenRotation({
      refreshDecision: acceptedRefresh,
      deviceId,
      currentTokenHash: '',
      nextTokenHash: 'new-hash',
      now: 200,
      nextExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'empty-current-token-hash' },
  )

  assert.deepEqual(
    planDeviceRefreshTokenRotation({
      refreshDecision: acceptedRefresh,
      deviceId,
      currentTokenHash: 'same-hash',
      nextTokenHash: 'same-hash',
      now: 200,
      nextExpiresAt: 10_000,
    }),
    { action: 'reject', reason: 'token-hash-not-rotated' },
  )

  assert.deepEqual(
    planDeviceRefreshTokenRotation({
      refreshDecision: acceptedRefresh,
      deviceId,
      currentTokenHash: 'old-hash',
      nextTokenHash: 'new-hash',
      now: 200,
      nextExpiresAt: 200,
    }),
    { action: 'reject', reason: 'invalid-next-expiry' },
  )
})

test('device revoke decisions reject unknown or invalid requests', () => {
  assert.deepEqual(
    decideRevokeDevice({
      device: undefined,
      revokedAt: 100,
    }),
    { action: 'reject', reason: 'unknown-device' },
  )

  assert.deepEqual(
    decideRevokeDevice({
      device: activeDevice,
      revokedAt: -1,
    }),
    { action: 'reject', reason: 'invalid-revoked-at' },
  )
})

test('device revoke decisions bump tokenVersion for active devices', () => {
  assert.deepEqual(
    decideRevokeDevice({
      device: activeDevice,
      revokedAt: 100,
    }),
    { action: 'revoke-device', tokenVersion: 4, revokedAt: 100 },
  )
})

test('device revoke decisions are idempotent for already revoked devices', () => {
  assert.deepEqual(
    decideRevokeDevice({
      device: { ...activeDevice, tokenVersion: 4, revokedAt: 100 },
      revokedAt: 200,
    }),
    { action: 'already-revoked', tokenVersion: 4, revokedAt: 100 },
  )
})
