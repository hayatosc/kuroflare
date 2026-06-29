import assert from 'node:assert/strict'

import { test } from 'vitest'

import { signHs256DeviceToken, verifyHs256DeviceToken } from '../sync/jwt'
import { makeDeviceId, makeVaultId, type DeviceTokenClaims } from '../index'

const vaultId = makeVaultId('jwt-vault-1')
const deviceId = makeDeviceId('jwt-device-1')
const secret = 'device-token-secret'
const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

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
  await assert.rejects(
    signHs256DeviceToken({ claims: { ...claims, exp: 100 }, secret }),
    /invalid-device-token-claims/,
  )
})

test('HS256 device token helper rejects non-canonical base64url signature encoding', async () => {
  const token = await signHs256DeviceToken({ claims, secret })
  const parts = token.split('.')
  assert.equal(parts.length, 3)
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    assert.fail('expected compact JWT to have three segments')
  }

  assert.equal(
    await verifyHs256DeviceToken({
      token: `${encodedHeader}.${encodedPayload}.${makeNonCanonicalTrailingBits(encodedSignature)}`,
      secret,
    }),
    undefined,
  )
})

function makeNonCanonicalTrailingBits(value: string): string {
  assert.equal(value.length % 4, 3)
  const lastCharacter = value.charAt(value.length - 1)
  const lastIndex = base64UrlAlphabet.indexOf(lastCharacter)
  assert.notEqual(lastIndex, -1)
  return `${value.slice(0, -1)}${base64UrlAlphabet.charAt(lastIndex ^ 1)}`
}
