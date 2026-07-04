import {
  makeDeviceId,
  makeVaultId,
  signHs256DeviceToken,
  type DeviceTokenClaims,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { createHs256AccessTokenVerifier } from '../auth/verifier'

const vaultId = makeVaultId('verifier-vault-1')
const deviceId = makeDeviceId('verifier-device-1')
const secret = 'test-device-token-secret'

const claims = {
  iss: 'kuroflare-worker',
  aud: vaultId,
  sub: deviceId,
  scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  iat: 1_000,
  exp: 10_000,
  tokenVersion: 1,
} satisfies DeviceTokenClaims

test('HS256 access token verifier accepts worker-issued guarded claims', async () => {
  const token = await signHs256DeviceToken({ claims, secret })
  const verifier = createHs256AccessTokenVerifier({ secret })

  assert.deepEqual(await verifier.verify(token), claims)
})

test('HS256 access token verifier rejects bad signature and wrong secret', async () => {
  const token = await signHs256DeviceToken({ claims, secret })
  const verifier = createHs256AccessTokenVerifier({ secret })

  assert.equal(await verifier.verify(`${token}x`), undefined)
  assert.equal(await createHs256AccessTokenVerifier({ secret: 'other' }).verify(token), undefined)
})
