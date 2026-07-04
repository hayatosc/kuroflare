import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { type SetupExchangeCredentialPlan } from '../devices'
import { planSetupExchangeHttpResponse } from './setup'

const vaultId = makeVaultId('vault-a')
const deviceId = makeDeviceId('device-a')
const credentialPlan = {
  action: 'issue-credentials',
  deviceId,
  yClientId: 12,
  tokenVersion: 3,
  insertRefreshToken: {
    tokenHash: 'refresh-hash',
    deviceId,
    issuedAt: 200,
    expiresAt: 10_000,
  },
} satisfies SetupExchangeCredentialPlan

test('setup exchange HTTP response plan builds claims and guarded response', () => {
  assert.deepEqual(
    planSetupExchangeHttpResponse({
      credentialPlan,
      endpoint: 'https://sync.example.test',
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
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
        endpoint: 'https://sync.example.test',
        vaultId,
        deviceId,
        yClientId: 12,
        accessToken: 'signed-access-token',
        refreshToken: 'refresh-token',
        tokenVersion: 3,
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
      },
    },
  )
})

test('setup exchange HTTP response plan rejects unsafe inputs before responding', () => {
  assert.deepEqual(
    planSetupExchangeHttpResponse({
      credentialPlan: { action: 'reject', reason: 'empty-refresh-token-hash' },
      endpoint: 'https://sync.example.test',
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    }),
    { action: 'reject', reason: 'credentials-not-issued' },
  )

  assert.deepEqual(
    planSetupExchangeHttpResponse({
      credentialPlan,
      endpoint: 'https://sync.example.test',
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 200,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    }),
    { action: 'reject', reason: 'invalid-token-window' },
  )

  assert.deepEqual(
    planSetupExchangeHttpResponse({
      credentialPlan,
      endpoint: 'https://u:p@example.test',
      vaultId,
      accessToken: 'signed-access-token',
      refreshToken: 'refresh-token',
      accessTokenIssuedAt: 200,
      accessTokenExpiresAt: 500,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    }),
    { action: 'reject', reason: 'invalid-response' },
  )
})
