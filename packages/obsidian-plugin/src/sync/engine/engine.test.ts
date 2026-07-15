import {
  makeDeviceId,
  makeVaultId,
  type ClientStartupLocalState,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { planSyncEngineStartup, startupStepPhase } from '../engine/engine'

const vaultId = makeVaultId('vault-1')
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
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

test('sync engine converts new-vault startup into ordered plugin effects', () => {
  const plan = planSyncEngineStartup({
    intent: 'setup-new-vault',
    local: { ...baseLocalState, vaultId: undefined },
    setupResponse: newVaultSetupResponse,
  })

  assert.equal(plan.clientPlan.action, 'bootstrap-new-vault')
  assert.deepEqual(
    plan.effects.map((effect) => effect.kind),
    [
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
      'run-startup-step',
    ],
  )
  assert.deepEqual(plan.effects, [
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'persist-setup-response',
      phase: 'setup',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'scan-local-vault',
      phase: 'local-scan',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'create-local-meta-ydoc',
      phase: 'local-scan',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'publish-local-meta-snapshot',
      phase: 'snapshot',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'publish-initial-file-snapshots',
      phase: 'snapshot',
    },
    {
      kind: 'run-startup-step',
      vaultId,
      step: 'send-meta-update',
      phase: 'outbox',
    },
  ])
})

test('sync engine exposes setup, degraded, and reject decisions as terminal effects', () => {
  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false },
    }).effects,
    [{ kind: 'run-setup-exchange', reason: 'missing-local-credentials' }],
  )

  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, schemaVersion: 2 },
    }).effects,
    [{ kind: 'enter-degraded', reason: 'local-schema-too-new' }],
  )

  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, pendingOutboxCount: -1 },
    }).effects,
    [{ kind: 'reject-startup', reason: 'invalid-pending-outbox-count' }],
  )
})

test('sync engine exposes revoked and reauth states as auth-blocked effects', () => {
  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false, authState: 'revoked' },
    }).effects,
    [{ kind: 'enter-auth-blocked', reason: 'device-revoked' }],
  )

  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: false, authState: 'reauth-required' },
    }).effects,
    [{ kind: 'enter-auth-blocked', reason: 'reauth-required' }],
  )

  assert.deepEqual(
    planSyncEngineStartup({
      intent: 'reconnect',
      local: { ...baseLocalState, hasDeviceCredentials: true, authState: 'revoked' },
    }).effects,
    [{ kind: 'enter-auth-blocked', reason: 'device-revoked' }],
  )
})

test('startup step phases keep local, websocket, snapshot, and outbox work separate', () => {
  assert.equal(startupStepPhase('load-indexeddb-ydocs'), 'local-store')
  assert.equal(startupStepPhase('send-client-hello'), 'websocket')
  assert.equal(startupStepPhase('publish-local-meta-snapshot'), 'snapshot')
  assert.equal(startupStepPhase('publish-initial-file-snapshots'), 'snapshot')
  assert.equal(startupStepPhase('sync-meta-state-vector'), 'snapshot')
  assert.equal(startupStepPhase('resume-background-queues'), 'outbox')
})
