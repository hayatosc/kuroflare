import assert from 'node:assert/strict'

import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/protocol'
import { test } from 'vitest'

import { planClientStartup, type ClientStartupLocalState } from './startup.js'

const vaultId = makeVaultId('vault-1')
const otherVaultId = makeVaultId('vault-2')
const deviceId = makeDeviceId('device-1')

const baseLocalState = {
  hasIndexedDb: true,
  hasDeviceCredentials: true,
  hasMetaYDoc: true,
  hasLocalVaultFiles: true,
  pendingOutboxCount: 0,
  schemaVersion: 1,
  supportedSchemaVersion: 1,
  vaultId,
  authState: 'active',
} satisfies ClientStartupLocalState

const newVaultSetupResponse = {
  endpoint: 'https://example.com',
  vaultId,
  deviceId,
  yClientId: 1,
  accessToken: 'token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

const joinSetupResponse = {
  ...newVaultSetupResponse,
  bootstrapMode: 'join-existing',
} satisfies SetupExchangeResponse

test('client startup plans new vault bootstrap without remote meta adoption', () => {
  assert.deepEqual(
    planClientStartup({
      intent: 'setup-new-vault',
      local: { ...baseLocalState, vaultId: undefined },
      setupResponse: newVaultSetupResponse,
    }),
    {
      action: 'bootstrap-new-vault',
      vaultId,
      steps: [
        'persist-setup-response',
        'scan-local-vault',
        'create-local-meta-ydoc',
        'enqueue-initial-file-uploads',
        'send-meta-update',
        'open-websocket',
      ],
    },
  )
})

test('client startup plans existing vault join before local file adoption', () => {
  const plan = planClientStartup({
    intent: 'join-existing-vault',
    local: { ...baseLocalState, vaultId: undefined },
    setupResponse: joinSetupResponse,
  })

  assert.equal(plan.action, 'join-existing-vault')
  if (plan.action === 'join-existing-vault') {
    assert.equal(plan.steps[0], 'persist-setup-response')
    assert.equal(plan.steps[1], 'fetch-remote-meta-snapshot')
    assert.equal(plan.steps[2], 'apply-remote-meta-snapshot')
    assert.ok(
      plan.steps.indexOf('adopt-local-files-after-remote-meta') >
        plan.steps.indexOf('apply-remote-meta-snapshot'),
    )
    assert.equal(plan.steps.includes('create-local-meta-ydoc'), false)
  }
})

test('client startup plans reconnect and local meta restore paths', () => {
  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: baseLocalState,
    }),
    {
      action: 'reconnect',
      vaultId,
      steps: [
        'load-indexeddb-ydocs',
        'open-websocket',
        'send-client-hello',
        'sync-meta-state-vector',
        'sync-active-file-state-vector',
        'resume-background-queues',
      ],
    },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasMetaYDoc: false },
    }),
    {
      action: 'restore-local-meta-snapshot',
      vaultId,
      steps: [
        'fetch-remote-meta-snapshot',
        'apply-remote-meta-snapshot',
        'load-indexeddb-ydocs',
        'open-websocket',
        'send-client-hello',
        'sync-meta-state-vector',
        'resume-background-queues',
      ],
    },
  )
})

test('client startup keeps setup intent, response mode, and local vault identity aligned', () => {
  assert.deepEqual(
    planClientStartup({
      intent: 'setup-new-vault',
      local: { ...baseLocalState, vaultId: undefined },
      setupResponse: joinSetupResponse,
    }),
    { action: 'reject', reason: 'intent-bootstrap-mode-mismatch' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'join-existing-vault',
      local: { ...baseLocalState, vaultId: undefined },
      setupResponse: joinSetupResponse,
      expectedBootstrapMode: 'new-vault',
    }),
    { action: 'reject', reason: 'setup-response-mode-mismatch' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'setup-new-vault',
      local: { ...baseLocalState, vaultId: otherVaultId },
      setupResponse: newVaultSetupResponse,
    }),
    { action: 'reject', reason: 'local-vault-mismatch' },
  )
})

test('client startup degrades or requests setup when local evidence is not usable', () => {
  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false },
    }),
    { action: 'run-setup-exchange', reason: 'missing-local-credentials' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, schemaVersion: 2 },
    }),
    { action: 'degraded', reason: 'local-schema-too-new' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, pendingOutboxCount: -1 },
    }),
    { action: 'reject', reason: 'invalid-pending-outbox-count' },
  )
})

test('client startup blocks revoked and reauth-required devices without setup exchange', () => {
  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false, authState: 'revoked' },
    }),
    { action: 'auth-blocked', reason: 'device-revoked' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false, authState: 'reauth-required' },
    }),
    { action: 'auth-blocked', reason: 'reauth-required' },
  )

  assert.deepEqual(
    planClientStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: true, authState: 'revoked' },
    }),
    { action: 'auth-blocked', reason: 'device-revoked' },
  )
})
