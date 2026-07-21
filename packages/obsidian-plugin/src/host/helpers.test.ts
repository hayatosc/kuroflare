import { assert, test } from 'vitest'

import { redactSecretText, safeLogError } from './helpers'

test('redactSecretText strips bearer JWTs, kuroflare access tokens, and token query params', () => {
  const accessJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXZpY2UtMSJ9.c2lnbmF0dXJl'
  const kuroflareToken = 'kuroflare-token.abc123.def456.ghi789'

  assert.equal(
    redactSecretText(`request failed: Authorization: Bearer ${accessJwt}`),
    'request failed: Authorization: Bearer [redacted]',
  )
  assert.equal(
    redactSecretText(`stored ${kuroflareToken} for device`),
    'stored kuroflare-token.[redacted] for device',
  )
  assert.equal(
    redactSecretText(`bare jwt ${accessJwt} in message`),
    'bare jwt [redacted-jwt] in message',
  )
  assert.equal(
    redactSecretText('GET /setup?vaultId=v1&setupToken=super-secret-value'),
    'GET /setup?vaultId=v1&setupToken=[redacted]',
  )
  assert.equal(
    redactSecretText('websocket url ?vaultId=v1&accessToken=abcDEF-123_456'),
    'websocket url ?vaultId=v1&accessToken=[redacted]',
  )
  assert.equal(redactSecretText('vaultId=v1&deviceId=d1'), 'vaultId=v1&deviceId=d1')
})

test('safeLogError never surfaces a raw bearer JWT from an Error message', () => {
  const jwt = 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccc'
  const error = new Error(`auth refresh rejected: Authorization Bearer ${jwt}`)

  const logged = safeLogError(error)

  assert.equal(logged.name, 'Error')
  assert.equal(logged.message.includes(jwt), false)
  assert(logged.message.includes('[redacted]'))
})

test('safeLogError redacts non-Error values coerced to text', () => {
  const secret = 'kuroflare-token.a1a1a1.b2b2b2.c3c3c3'

  const logged = safeLogError(`connection closed: ${secret}`)

  assert.equal(logged.message.includes(secret), false)
})
