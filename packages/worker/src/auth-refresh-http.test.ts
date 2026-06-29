import assert from 'node:assert/strict'

import { makeDeviceId, makeVaultId } from '@kuroflare/protocol'
import { test } from 'vitest'

import { planDeviceTokenRefreshHttpResponse } from './auth-refresh-http.js'
import { type DeviceRefreshTokenRotationPlan, type DeviceTokenRefreshDecision } from './devices.js'

const vaultId = makeVaultId('vault-a')
const deviceId = makeDeviceId('device-a')
const refreshDecision = {
  action: 'mint-token',
  tokenVersion: 3,
  rotateRefreshToken: true,
} satisfies DeviceTokenRefreshDecision
const rotationPlan = {
  action: 'rotate',
  revoke: {
    tokenHash: 'old-hash',
    revokedAt: 200,
  },
  insert: {
    tokenHash: 'new-hash',
    deviceId,
    issuedAt: 200,
    expiresAt: 10_000,
  },
} satisfies DeviceRefreshTokenRotationPlan

test('device token refresh HTTP response plan builds claims and guarded response', () => {
  assert.deepEqual(
    planDeviceTokenRefreshHttpResponse({
      refreshDecision,
      rotationPlan,
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'rotated-refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
    }),
    {
      action: 'respond',
      claims: {
        iss: 'kuroflare-worker',
        aud: vaultId,
        sub: deviceId,
        scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
        iat: 200,
        exp: 500,
        tokenVersion: 3,
      },
      response: {
        accessToken: 'signed-access-token',
        tokenVersion: 3,
        expiresAt: 500,
        protocolVersion: 1,
        refreshToken: 'rotated-refresh-token',
      },
    },
  )
})

test('device token refresh HTTP response plan rejects unsafe inputs before responding', () => {
  assert.deepEqual(
    planDeviceTokenRefreshHttpResponse({
      refreshDecision: { action: 'reject', reason: 'stale-token' },
      rotationPlan,
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'rotated-refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
    }),
    { action: 'reject', reason: 'refresh-not-accepted' },
  )

  assert.deepEqual(
    planDeviceTokenRefreshHttpResponse({
      refreshDecision,
      rotationPlan: { action: 'reject', reason: 'empty-next-token-hash' },
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'rotated-refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
    }),
    { action: 'reject', reason: 'rotation-not-accepted' },
  )

  assert.deepEqual(
    planDeviceTokenRefreshHttpResponse({
      refreshDecision,
      rotationPlan,
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'rotated-refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 200,
      protocolVersion: 1,
    }),
    { action: 'reject', reason: 'invalid-token-window' },
  )

  assert.deepEqual(
    planDeviceTokenRefreshHttpResponse({
      refreshDecision,
      rotationPlan,
      vaultId,
      accessToken: '',
      refreshToken: 'rotated-refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
    }),
    { action: 'reject', reason: 'invalid-response' },
  )
})
