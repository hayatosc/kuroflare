import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeVaultId,
  type ClientStartupLocalState,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  applySyncRuntimeShellCommands,
  INITIAL_SYNC_RUNTIME_SHELL_STATE,
  type SyncRuntimeSetupExchangeReplanRequest,
} from '../engine/actuation'
import {
  applySyncRuntimeSetupExchangeShellReplan,
  planSyncRuntimeStartupAfterSetupExchange,
} from '../engine/replan'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  type LocalStoreIndexedDbOpenPlanInput,
} from '../store/schema'

const vaultId = makeVaultId('setup-replan-vault-1')
const deviceId = makeDeviceId('setup-replan-device-1')

const baseLocalState = {
  hasIndexedDb: false,
  hasDeviceCredentials: false,
  hasMetaYDoc: false,
  hasLocalVaultFiles: true,
  pendingOutboxCount: 0,
  schemaVersion: undefined,
  supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  vaultId: undefined,
  authState: undefined,
} satisfies ClientStartupLocalState

const missingLocalStore = {
  dbExists: false,
  currentVersion: undefined,
  presentStores: [],
  pendingOutboxCount: 0,
} satisfies Omit<LocalStoreIndexedDbOpenPlanInput, 'vaultId'>

const newVaultResponse = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

const joinExistingResponse = {
  ...newVaultResponse,
  bootstrapMode: 'join-existing',
} satisfies SetupExchangeResponse

test('setup exchange replan maps reconnect response into new-vault bootstrap startup', () => {
  const request = {
    effect: { kind: 'run-setup-exchange', reason: 'missing-local-credentials' },
    response: newVaultResponse,
  } satisfies SyncRuntimeSetupExchangeReplanRequest

  const plan = planSyncRuntimeStartupAfterSetupExchange({
    request,
    current: {
      intent: 'reconnect',
      local: baseLocalState,
      localStore: missingLocalStore,
    },
  })

  assert.equal(plan.intent, 'setup-new-vault')
  assert.equal(plan.startup.action, 'continue')
  assert.equal(plan.startup.sync.clientPlan.action, 'bootstrap-new-vault')
  assert.deepEqual(plan.startup.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'create',
      dbName: 'kuroflare:setup-replan-vault-1',
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
    },
  })
  assert.deepEqual(
    plan.startup.effects.slice(1).map((effect) => effect.kind),
    Array.from({ length: 8 }, () => 'run-sync-startup-effect'),
  )
  assert.deepEqual(
    plan.actuation.commands.filter((command) => command.kind === 'run-runtime-effect').length,
    9,
  )
})

test('setup exchange replan maps reconnect response into join-existing startup', () => {
  const request = {
    effect: { kind: 'run-setup-exchange', reason: 'missing-local-credentials' },
    response: joinExistingResponse,
  } satisfies SyncRuntimeSetupExchangeReplanRequest

  const plan = planSyncRuntimeStartupAfterSetupExchange({
    request,
    current: {
      intent: 'reconnect',
      local: baseLocalState,
      localStore: missingLocalStore,
    },
  })

  assert.equal(plan.intent, 'join-existing-vault')
  assert.equal(plan.startup.action, 'continue')
  assert.equal(plan.startup.sync.clientPlan.action, 'join-existing-vault')
  assert.deepEqual(
    plan.startup.sync.effects.map((effect) =>
      effect.kind === 'run-startup-step' ? effect.step : effect.kind,
    ),
    [
      'persist-setup-response',
      'fetch-remote-meta-snapshot',
      'apply-remote-meta-snapshot',
      'open-websocket',
      'send-client-hello',
      'adopt-local-files-after-remote-meta',
      'enqueue-missing-downloads',
    ],
  )
})

test('setup exchange replan preserves explicit setup intent so mismatched response is rejected', () => {
  const request = {
    effect: { kind: 'run-setup-exchange', reason: 'setup-required' },
    response: joinExistingResponse,
  } satisfies SyncRuntimeSetupExchangeReplanRequest

  const plan = planSyncRuntimeStartupAfterSetupExchange({
    request,
    current: {
      intent: 'setup-new-vault',
      local: baseLocalState,
      localStore: missingLocalStore,
    },
  })

  assert.equal(plan.intent, 'setup-new-vault')
  assert.equal(plan.startup.action, 'run-sync-without-local-store-gate')
  assert.deepEqual(plan.startup.sync.clientPlan, {
    action: 'reject',
    reason: 'intent-bootstrap-mode-mismatch',
  })
  assert.deepEqual(plan.actuation.commands, [
    { kind: 'stop-background-queues', reason: 'rejected' },
    {
      kind: 'set-status',
      status: 'rejected',
      reason: 'intent-bootstrap-mode-mismatch',
    },
    {
      kind: 'show-repair-entry',
      entry: 'startup-rejected',
      reason: 'intent-bootstrap-mode-mismatch',
    },
    { kind: 'show-notice', notice: 'startup-rejected' },
  ])
})

test('setup exchange shell replan acknowledges completed setup effect and replaces runnable queue', () => {
  const request = {
    effect: { kind: 'run-setup-exchange', reason: 'missing-local-credentials' },
    response: newVaultResponse,
  } satisfies SyncRuntimeSetupExchangeReplanRequest
  const completedSetupRuntimeEffect = {
    kind: 'run-sync-startup-effect',
    effect: request.effect,
  } as const
  const staleRuntimeEffect = {
    kind: 'run-sync-startup-effect',
    effect: { kind: 'enter-degraded', reason: 'missing-indexeddb' },
  } as const
  const state = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    { kind: 'run-runtime-effect', effect: completedSetupRuntimeEffect },
    { kind: 'run-runtime-effect', effect: staleRuntimeEffect },
    {
      kind: 'fail-runtime-effect',
      effect: completedSetupRuntimeEffect,
      reason: 'previous-failure',
    },
    { kind: 'retry-last-failed-effect', reason: 'startup-replan' },
  ])

  const result = applySyncRuntimeSetupExchangeShellReplan({
    state,
    request,
    current: {
      intent: 'reconnect',
      local: baseLocalState,
      localStore: missingLocalStore,
    },
  })

  assert.equal(result.commands[0]?.kind, 'ack-runtime-effect')
  assert.deepEqual(result.state.completedEffects, [completedSetupRuntimeEffect])
  assert.equal(result.state.lastFailedEffect, undefined)
  assert.deepEqual(result.state.repairEntries, [])
  assert.deepEqual(
    result.state.runnableEffects.map((effect) => effect.kind),
    [
      'run-local-store-open-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
      'run-sync-startup-effect',
    ],
  )
  assert.equal(
    result.state.runnableEffects.some((effect) => effect === staleRuntimeEffect),
    false,
  )
})
