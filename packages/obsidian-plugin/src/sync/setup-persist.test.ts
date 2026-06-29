import assert from 'node:assert/strict'

import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/protocol'
import { test } from 'vitest'

import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  isLocalSetupMetadata,
  planLocalSetupMetadataSnapshot,
  planLocalSetupPersist,
  planLocalSetupPersistSecretCleanup,
  type LocalSetupSecretWriteEffect,
  type SuccessfulLocalSetupPersistPlan,
} from './setup-persist.js'

const vaultId = makeVaultId('setup-persist-vault-1')
const deviceId = makeDeviceId('setup-persist-device-1')

const setupResponse = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  yClientId: 1,
  accessToken: 'signed-access-token',
  refreshToken: 'opaque-refresh-token',
  tokenVersion: 3,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

test('local setup persist writes secrets before non-secret metadata records', () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })

  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.secretWrites, [
      {
        kind: 'write-secret',
        key: 'kuroflare:setup-persist-vault-1:setup-persist-device-1:access-token',
        value: 'signed-access-token',
        token: 'access',
      },
      {
        kind: 'write-secret',
        key: 'kuroflare:setup-persist-vault-1:setup-persist-device-1:refresh-token',
        value: 'opaque-refresh-token',
        token: 'refresh',
      },
    ])
    assert.deepEqual(plan.metadataPuts, [
      {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: {
          endpoint: 'https://sync.example.test',
          vaultId,
          deviceId,
          yClientId: 1,
          protocolVersion: 1,
          bootstrapMode: 'new-vault',
          tokenVersion: 3,
        },
      },
      {
        kind: 'put-metadata-record',
        key: LOCAL_AUTH_METADATA_KEY,
        value: {
          deviceId,
          authState: 'active',
          tokenVersion: 3,
          accessTokenExpiresAt: 10_000,
          refreshState: 'idle',
          retryCount: 0,
          accessTokenSecretKey:
            'kuroflare:setup-persist-vault-1:setup-persist-device-1:access-token',
          refreshTokenSecretKey:
            'kuroflare:setup-persist-vault-1:setup-persist-device-1:refresh-token',
        },
      },
    ])
  }
})

test('local setup persist metadata does not contain token bodies', () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    assert.equal(JSON.stringify(plan.metadataPuts).includes(setupResponse.accessToken), false)
    assert.equal(JSON.stringify(plan.metadataPuts).includes(setupResponse.refreshToken), false)
  }
})

test('local setup persist supports vault-scoped secret key prefixes', () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretKeyPrefix: 'custom-prefix',
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    assert.deepEqual(
      plan.secretWrites.map((write) => write.key),
      [
        'custom-prefix:setup-persist-vault-1:setup-persist-device-1:access-token',
        'custom-prefix:setup-persist-vault-1:setup-persist-device-1:refresh-token',
      ],
    )
  }
})

test('local setup persist rejects unsafe local setup evidence', () => {
  assert.deepEqual(
    planLocalSetupPersist({
      response: setupResponse,
      accessTokenExpiresAt: -1,
    }),
    {
      ok: false,
      reason: 'invalid-token-expiry',
      authDecision: { action: 'reject', reason: 'invalid-token-expiry' },
    },
  )

  assert.deepEqual(
    planLocalSetupPersist({
      response: setupResponse,
      accessTokenExpiresAt: 10_000,
      secretKeyPrefix: '',
    }),
    { ok: false, reason: 'invalid-secret-key-prefix' },
  )
})

test('local setup metadata guard validates persisted setup/auth snapshot', () => {
  const plan = requireSuccessfulSetupPlan()
  const setup = plan.metadataPuts[0]?.value
  const auth = plan.metadataPuts[1]?.value

  assert.equal(isLocalSetupMetadata(setup), true)
  assert.deepEqual(planLocalSetupMetadataSnapshot({ setup, auth }), {
    ok: true,
    snapshot: {
      setup,
      auth,
    },
  })
  assert.deepEqual(planLocalSetupMetadataSnapshot({ setup: undefined, auth }), {
    ok: false,
    reason: 'missing-setup-metadata',
  })
  assert.deepEqual(planLocalSetupMetadataSnapshot({ setup: { ...setup, tokenVersion: 0 }, auth }), {
    ok: false,
    reason: 'invalid-setup-metadata',
  })
  assert.deepEqual(
    planLocalSetupMetadataSnapshot({
      setup,
      auth: { ...auth, tokenVersion: 4 },
    }),
    {
      ok: false,
      reason: 'setup-auth-token-version-mismatch',
    },
  )
})

test('local setup persist cleanup deletes completed secrets in reverse order', () => {
  const plan = requireSuccessfulSetupPlan()
  const cleanup = planLocalSetupPersistSecretCleanup({
    setupPlan: plan,
    completedSecretWrites: plan.secretWrites,
  })

  assert.deepEqual(cleanup, {
    ok: true,
    secretDeletes: [
      {
        kind: 'delete-secret',
        key: 'kuroflare:setup-persist-vault-1:setup-persist-device-1:refresh-token',
        token: 'refresh',
      },
      {
        kind: 'delete-secret',
        key: 'kuroflare:setup-persist-vault-1:setup-persist-device-1:access-token',
        token: 'access',
      },
    ],
  })
})

test('local setup persist cleanup deletes only completed secrets', () => {
  const plan = requireSuccessfulSetupPlan()
  const [accessWrite] = requireSecretWrites(plan)
  const cleanup = planLocalSetupPersistSecretCleanup({
    setupPlan: plan,
    completedSecretWrites: [accessWrite],
  })

  assert.deepEqual(cleanup, {
    ok: true,
    secretDeletes: [
      {
        kind: 'delete-secret',
        key: 'kuroflare:setup-persist-vault-1:setup-persist-device-1:access-token',
        token: 'access',
      },
    ],
  })
})

test('local setup persist cleanup rejects unexpected or duplicate secret writes', () => {
  const plan = requireSuccessfulSetupPlan()
  const [accessWrite] = requireSecretWrites(plan)
  const unexpectedWrite = {
    ...accessWrite,
    key: 'kuroflare:other-vault:setup-persist-device-1:access-token',
  } satisfies LocalSetupSecretWriteEffect

  assert.deepEqual(
    planLocalSetupPersistSecretCleanup({
      setupPlan: plan,
      completedSecretWrites: [unexpectedWrite],
    }),
    {
      ok: false,
      reason: 'unexpected-secret-write',
      secretWrite: unexpectedWrite,
    },
  )
  assert.deepEqual(
    planLocalSetupPersistSecretCleanup({
      setupPlan: plan,
      completedSecretWrites: [accessWrite, accessWrite],
    }),
    {
      ok: false,
      reason: 'duplicate-secret-write',
      secretWrite: accessWrite,
    },
  )
})

function requireSuccessfulSetupPlan(): SuccessfulLocalSetupPersistPlan {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)
  return plan
}

function requireSecretWrites(
  plan: SuccessfulLocalSetupPersistPlan,
): readonly [LocalSetupSecretWriteEffect, LocalSetupSecretWriteEffect] {
  const [accessWrite, refreshWrite] = plan.secretWrites
  if (accessWrite === undefined || refreshWrite === undefined) {
    assert.fail('expected setup plan to include access and refresh secret writes')
  }
  return [accessWrite, refreshWrite]
}
