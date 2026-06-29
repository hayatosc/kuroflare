import assert from 'node:assert/strict'

import { makeDeviceId } from '@kuroflare/protocol'
import { test } from 'vitest'

import { planRevokeDeviceHttpResponse } from './device-http.js'

const deviceId = makeDeviceId('device-a')

test('device revoke HTTP response plan maps revoke decisions to guarded responses', () => {
  assert.deepEqual(
    planRevokeDeviceHttpResponse({
      deviceId,
      revokeDecision: {
        action: 'revoke-device',
        tokenVersion: 4,
        revokedAt: 100,
      },
    }),
    {
      action: 'respond',
      response: {
        deviceId,
        status: 'revoked',
        revokedAt: 100,
        tokenVersion: 4,
      },
    },
  )

  assert.deepEqual(
    planRevokeDeviceHttpResponse({
      deviceId,
      revokeDecision: {
        action: 'already-revoked',
        tokenVersion: 4,
        revokedAt: 100,
      },
    }),
    {
      action: 'respond',
      response: {
        deviceId,
        status: 'already-revoked',
        revokedAt: 100,
        tokenVersion: 4,
      },
    },
  )
})

test('device revoke HTTP response plan rejects unsafe decisions before responding', () => {
  assert.deepEqual(
    planRevokeDeviceHttpResponse({
      deviceId,
      revokeDecision: {
        action: 'reject',
        reason: 'unknown-device',
      },
    }),
    { action: 'reject', reason: 'revoke-not-accepted' },
  )

  assert.deepEqual(
    planRevokeDeviceHttpResponse({
      deviceId,
      revokeDecision: {
        action: 'revoke-device',
        tokenVersion: 0,
        revokedAt: 100,
      },
    }),
    { action: 'reject', reason: 'invalid-response' },
  )
})
