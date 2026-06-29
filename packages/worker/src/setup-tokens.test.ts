import assert from 'node:assert/strict'

import { makeVaultId } from '@kuroflare/protocol'
import { test } from 'vitest'

import { decideSetupTokenConsume, type SetupTokenEntry } from './setup-tokens.js'

const vaultId = makeVaultId('vault-1')
const otherVaultId = makeVaultId('vault-2')
const token: SetupTokenEntry = {
  vaultId,
  issuedAt: 100,
  expiresAt: 700,
  consumedAt: undefined,
}

test('setup token consume accepts a fresh unconsumed token', () => {
  assert.deepEqual(
    decideSetupTokenConsume({
      token,
      requestedVaultId: vaultId,
      now: 200,
    }),
    { action: 'consume', consumedAt: 200, token },
  )
})

test('setup token consume rejects missing and mismatched tokens', () => {
  assert.deepEqual(
    decideSetupTokenConsume({
      token: undefined,
      requestedVaultId: vaultId,
      now: 200,
    }),
    { action: 'reject', reason: 'unknown-token' },
  )

  assert.deepEqual(
    decideSetupTokenConsume({
      token,
      requestedVaultId: otherVaultId,
      now: 200,
    }),
    { action: 'reject', reason: 'vault-mismatch' },
  )
})

test('setup token consume rejects invalid clocks and token windows', () => {
  assert.deepEqual(
    decideSetupTokenConsume({
      token,
      requestedVaultId: vaultId,
      now: -1,
    }),
    { action: 'reject', reason: 'invalid-time' },
  )

  assert.deepEqual(
    decideSetupTokenConsume({
      token: { ...token, expiresAt: 100 },
      requestedVaultId: vaultId,
      now: 100,
    }),
    { action: 'reject', reason: 'invalid-token-window' },
  )
})

test('setup token consume rejects tokens outside their validity window', () => {
  assert.deepEqual(
    decideSetupTokenConsume({
      token,
      requestedVaultId: vaultId,
      now: 99,
    }),
    { action: 'reject', reason: 'token-not-yet-valid' },
  )

  assert.deepEqual(
    decideSetupTokenConsume({
      token,
      requestedVaultId: vaultId,
      now: 700,
    }),
    { action: 'reject', reason: 'token-expired' },
  )
})

test('setup token consume rejects already consumed tokens', () => {
  assert.deepEqual(
    decideSetupTokenConsume({
      token: { ...token, consumedAt: 250 },
      requestedVaultId: vaultId,
      now: 300,
    }),
    { action: 'reject', reason: 'token-already-consumed' },
  )
})
