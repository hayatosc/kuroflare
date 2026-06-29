import assert from 'node:assert/strict'

import {
  DEVICE_TOKEN_ISSUER,
  makeDeviceId,
  makeVaultId,
  type DeviceTokenClaims,
} from '@kuroflare/core'
import { test } from 'vitest'

import { decideAuthAdmission } from './auth'
import type { DeviceRegistryEntry } from './devices'

const vaultId = makeVaultId('vault-1')
const otherVaultId = makeVaultId('vault-2')
const deviceId = makeDeviceId('device-1')
const claims: DeviceTokenClaims = {
  iss: DEVICE_TOKEN_ISSUER,
  aud: vaultId,
  sub: deviceId,
  scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  iat: 100,
  exp: 200,
  tokenVersion: 3,
}
const device: DeviceRegistryEntry = {
  deviceId,
  yClientId: 10,
  tokenVersion: 3,
  revokedAt: undefined,
}

test('auth admission accepts fresh claims for an active registry row', () => {
  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read', 'sync:write'],
      now: 150,
    }),
    { action: 'accept', device },
  )
})

test('auth admission rejects wrong vaults and invalid clocks', () => {
  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: otherVaultId,
      device,
      requiredScopes: ['sync:read'],
      now: 150,
    }),
    { action: 'reject', reason: 'vault-mismatch' },
  )

  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read'],
      now: -1,
    }),
    { action: 'reject', reason: 'invalid-time' },
  )
})

test('auth admission rejects tokens outside their validity window', () => {
  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read'],
      now: 99,
    }),
    { action: 'reject', reason: 'token-not-yet-valid' },
  )

  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read'],
      now: 200,
    }),
    { action: 'reject', reason: 'token-expired' },
  )
})

test('auth admission rejects missing scopes', () => {
  assert.deepEqual(
    decideAuthAdmission({
      claims: { ...claims, scope: ['sync:read'] },
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read', 'sync:write'],
      now: 150,
    }),
    { action: 'reject', reason: 'missing-scope' },
  )
})

test('auth admission rejects unknown, mismatched, revoked, and stale devices', () => {
  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device: undefined,
      requiredScopes: ['sync:read'],
      now: 150,
    }),
    { action: 'reject', reason: 'unknown-device' },
  )

  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device: { ...device, deviceId: makeDeviceId('device-2') },
      requiredScopes: ['sync:read'],
      now: 150,
    }),
    { action: 'reject', reason: 'device-subject-mismatch' },
  )

  assert.deepEqual(
    decideAuthAdmission({
      claims,
      expectedVaultId: vaultId,
      device: { ...device, revokedAt: 125 },
      requiredScopes: ['sync:read'],
      now: 150,
    }),
    { action: 'reject', reason: 'device-revoked' },
  )

  assert.deepEqual(
    decideAuthAdmission({
      claims: { ...claims, tokenVersion: 2 },
      expectedVaultId: vaultId,
      device,
      requiredScopes: ['sync:read'],
      now: 150,
    }),
    { action: 'reject', reason: 'stale-token' },
  )
})
