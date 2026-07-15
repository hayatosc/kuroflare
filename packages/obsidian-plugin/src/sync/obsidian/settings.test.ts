import { assert, test } from 'vitest'

import {
  createSyncRuntimeObsidianSetupExchangeEvidenceReader,
  planSyncRuntimeObsidianLegacySettingsSecretCleanup,
  planSyncRuntimeObsidianStartupSettings,
} from '../obsidian/settings'
import { type SetupExchangeStartupEffect } from '../setup-exchange-http'

test('Obsidian startup settings default to reconnect when no setup evidence exists', () => {
  assert.deepEqual(planSyncRuntimeObsidianStartupSettings({}), {
    startup: { intent: 'reconnect' },
    setupExchange: { ok: false, reason: 'setup-settings-not-present' },
  })
})

test('Obsidian startup settings reconnect from persisted device metadata without a setup token', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      endpoint: 'https://sync.example.test',
      setupVaultId: 'settings-vault-1',
      setupToken: '',
      requestedDeviceName: 'phone',
      existingDeviceId: 'settings-device-1',
    }),
    {
      startup: { intent: 'reconnect' },
      setupExchange: { ok: false, reason: 'setup-settings-not-present' },
    },
  )
})

test('Obsidian startup settings trust durable setup metadata after a setup crash window', () => {
  const plan = planSyncRuntimeObsidianStartupSettings({
    endpoint: 'https://sync.example.test',
    setupVaultId: 'settings-vault-1',
    setupToken: 'setup-token-that-must-not-be-replayed',
    requestedDeviceName: 'phone',
    setupBootstrapMode: 'join-existing',
    persistedSetupMetadata: {
      endpoint: 'https://sync.example.test',
      vaultId: 'settings-vault-1',
      deviceId: 'settings-device-1',
      protocolVersion: 1,
      bootstrapMode: 'join-existing',
      tokenVersion: 1,
    },
  })

  assert.deepEqual(plan, {
    startup: { intent: 'reconnect' },
    setupExchange: { ok: false, reason: 'setup-settings-not-present' },
  })
})

test('Obsidian startup settings derive new-vault setup intent and evidence', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      endpoint: ' https://sync.example.test ',
      setupVaultId: 'settings-vault-1',
      setupToken: ' setup-token ',
      requestedDeviceName: ' laptop ',
      setupBootstrapMode: ' new-vault ',
    }),
    {
      startup: { intent: 'setup-new-vault', expectedBootstrapMode: 'new-vault' },
      setupExchange: {
        ok: true,
        evidence: {
          endpoint: 'https://sync.example.test',
          request: {
            vaultId: 'settings-vault-1',
            setupToken: ' setup-token ',
            requestedDeviceName: ' laptop ',
            existingDeviceId: undefined,
          },
        },
      },
    },
  )
})

test('Obsidian startup settings derive join-existing intent by default when setup evidence exists', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      endpoint: 'https://sync.example.test',
      setupVaultId: 'settings-vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'phone',
      existingDeviceId: 'settings-device-1',
    }),
    {
      startup: { intent: 'join-existing-vault', expectedBootstrapMode: 'join-existing' },
      setupExchange: {
        ok: true,
        evidence: {
          endpoint: 'https://sync.example.test',
          request: {
            vaultId: 'settings-vault-1',
            setupToken: 'setup-token',
            requestedDeviceName: 'phone',
            existingDeviceId: 'settings-device-1',
          },
        },
      },
    },
  )
})

test('Obsidian startup settings report non-secret setup request failures', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      endpoint: 'https://sync.example.test',
      setupVaultId: 'settings-vault-1',
      setupToken: ' ',
      requestedDeviceName: 'phone',
      setupBootstrapMode: 'join-existing',
    }),
    {
      startup: { intent: 'join-existing-vault', expectedBootstrapMode: 'join-existing' },
      setupExchange: {
        ok: false,
        reason: 'invalid-setup-request',
        requestReason: 'missing-setup-token',
      },
    },
  )
})

test('Obsidian startup settings reject invalid setup mode before using setup token', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      endpoint: 'https://sync.example.test',
      setupVaultId: 'settings-vault-1',
      setupToken: 'secret-token-that-must-not-appear',
      requestedDeviceName: 'phone',
      setupBootstrapMode: 'unexpected-mode',
    }),
    {
      startup: { intent: 'reconnect' },
      setupExchange: { ok: false, reason: 'invalid-setup-bootstrap-mode' },
    },
  )
})

test('Obsidian startup settings keep setup intent visible when endpoint is missing', () => {
  assert.deepEqual(
    planSyncRuntimeObsidianStartupSettings({
      setupVaultId: 'settings-vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'phone',
      setupBootstrapMode: 'new-vault',
    }),
    {
      startup: { intent: 'setup-new-vault', expectedBootstrapMode: 'new-vault' },
      setupExchange: { ok: false, reason: 'missing-setup-endpoint' },
    },
  )
})

test('Obsidian startup settings evidence reader returns latest setup exchange evidence', () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SetupExchangeStartupEffect
  const seenEffects: SetupExchangeStartupEffect[] = []
  const reader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
    readSettings(startupEffect) {
      seenEffects.push(startupEffect)
      return {
        endpoint: 'https://sync.example.test',
        setupVaultId: 'settings-vault-1',
        setupToken: 'setup-token',
        requestedDeviceName: 'tablet',
        setupBootstrapMode: 'join-existing',
      }
    },
  })

  assert.deepEqual(reader.readEvidence(effect), {
    endpoint: 'https://sync.example.test',
    request: {
      vaultId: 'settings-vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'tablet',
      existingDeviceId: undefined,
    },
  })
  assert.deepEqual(seenEffects, [effect])
})

test('Obsidian startup settings evidence reader throws non-secret errors', () => {
  const token = 'secret-token-that-must-not-leak'
  const reader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
    readSettings() {
      return {
        endpoint: 'https://sync.example.test',
        setupVaultId: 'settings-vault-1',
        setupToken: token,
        requestedDeviceName: '',
        setupBootstrapMode: 'join-existing',
      }
    },
  })

  try {
    reader.readEvidence({ kind: 'run-setup-exchange', reason: 'setup-required' })
    throw new Error('expected setup evidence read to fail')
  } catch (error) {
    assert.instanceOf(error, Error)
    assert.equal(
      error.message,
      'setup-exchange-settings:invalid-setup-request:invalid-requested-device-name',
    )
    assert.equal(error.message.includes(token), false)
  }
})

test('legacy settings secret cleanup removes plaintext token fields and keeps other settings', () => {
  const plan = planSyncRuntimeObsidianLegacySettingsSecretCleanup({
    endpoint: 'https://sync.example.test',
    setupVaultId: 'settings-vault-1',
    accessToken: 'leaked-access-token',
    refreshToken: 'leaked-refresh-token',
    setupResponse: { accessToken: 'leaked-access-token', refreshToken: 'leaked-refresh-token' },
  })

  assert.deepEqual(plan.settings, {
    endpoint: 'https://sync.example.test',
    setupVaultId: 'settings-vault-1',
  })
  assert.deepEqual(
    [...plan.removedLegacySecretKeys].sort(),
    ['accessToken', 'refreshToken', 'setupResponse'].sort(),
  )
})

test('legacy settings secret cleanup is a no-op when no legacy secret fields are present', () => {
  const loaded = { endpoint: 'https://sync.example.test', setupVaultId: 'settings-vault-1' }
  const plan = planSyncRuntimeObsidianLegacySettingsSecretCleanup(loaded)

  assert.deepEqual(plan.settings, loaded)
  assert.deepEqual(plan.removedLegacySecretKeys, [])
})
