import { assert, expect, test } from 'vitest'

import { makeDeviceId, makeVaultId, type DeviceTokenClaims } from '../index'
import { signHs256DeviceToken, verifyHs256DeviceToken } from '../sync/jwt'

const vaultId = makeVaultId('jwt-vault-1')
const deviceId = makeDeviceId('jwt-device-1')
const secret = 'device-token-secret'

const claims = {
  iss: 'kuroflare-worker',
  aud: vaultId,
  sub: deviceId,
  scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  iat: 1_000,
  exp: 10_000,
  tokenVersion: 1,
} satisfies DeviceTokenClaims

test('HS256 device token helper signs and verifies guarded claims', async () => {
  const token = await signHs256DeviceToken({ claims, secret })

  assert.deepEqual(await verifyHs256DeviceToken({ token, secret }), claims)
})

test('HS256 device token helper rejects bad signature, secret, and payload', async () => {
  const token = await signHs256DeviceToken({ claims, secret })

  assert.equal(await verifyHs256DeviceToken({ token: `${token}x`, secret }), undefined)
  assert.equal(await verifyHs256DeviceToken({ token, secret: 'other' }), undefined)
  await expect(signHs256DeviceToken({ claims: { ...claims, exp: 100 }, secret })).rejects.toThrow(
    /invalid-device-token-claims/,
  )
})
