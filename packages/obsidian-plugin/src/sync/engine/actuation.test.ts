import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeVaultId,
  type ClientStartupLocalState,
  type ClientStartupStep,
  type DeviceTokenClaims,
  type LocalStoreObjectStore,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import {
  applySyncRuntimeShellCommands,
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createSyncRuntimeSetupExchangePort,
  createSyncRuntimeSetupPersistStepPort,
  createSyncRuntimeStartupEffectExecutor,
  createSyncRuntimeStartupStepEffectPort,
  createVerifiedSyncRuntimeSetupPersistStepPort,
  executeRunnableSyncRuntimeShellEffects,
  INITIAL_SYNC_RUNTIME_SHELL_STATE,
  planSyncRuntimeNoNetworkEffectPump,
  planSyncRuntimeStartupActuation,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeStartupEffectExecutorPorts,
  type SyncRuntimeStartupStepExecutorPorts,
} from '../engine/actuation'
import { type SyncEngineStartupEffect } from '../engine/engine'
import {
  type LocalSetupPersistMetadataPort,
  type LocalSetupPersistSecretStoragePort,
} from '../engine/persist'
import { planSyncRuntimeStartup, type SyncRuntimeStartupEffect } from '../engine/startup'
import {
  type LocalStoreIndexedDbFactoryPort,
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbObjectStoreNameList,
  type LocalStoreIndexedDbOpenRequest,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbSchemaDatabasePort,
} from '../store/indexeddb'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  type LocalStoreIndexedDbOpenEffect,
} from '../store/schema'

const vaultId = makeVaultId('actuation-vault-1')
const deviceId = makeDeviceId('actuation-device-1')

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

const setupAccessTokenClaims = {
  iss: 'kuroflare-worker',
  aud: vaultId,
  sub: deviceId,
  scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  iat: 1_000,
  exp: 10_000,
  tokenVersion: 3,
} satisfies DeviceTokenClaims

const baseLocalState = {
  hasIndexedDb: true,
  hasDeviceCredentials: true,
  hasMetaYDoc: true,
  hasLocalVaultFiles: true,
  pendingOutboxCount: 0,
  schemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  supportedSchemaVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  vaultId,
  authState: 'active',
} satisfies ClientStartupLocalState

test('startup actuation blocks queues and exposes repair entry for revoked auth', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: { ...baseLocalState, authState: 'revoked' },
  })

  assert.equal(runtime.action, 'run-sync-without-local-store-gate')
  assert.deepEqual(planSyncRuntimeStartupActuation({ plan: runtime }).commands, [
    { kind: 'stop-background-queues', reason: 'auth-blocked' },
    { kind: 'set-status', status: 'auth-blocked', reason: 'device-revoked' },
    { kind: 'show-repair-entry', entry: 'device-revoked', reason: 'device-revoked' },
    { kind: 'show-notice', notice: 'device-revoked' },
  ])

  assert.deepEqual(
    applySyncRuntimeShellCommands(
      INITIAL_SYNC_RUNTIME_SHELL_STATE,
      planSyncRuntimeStartupActuation({ plan: runtime }).commands,
    ),
    {
      status: 'auth-blocked',
      statusReason: 'device-revoked',
      backgroundQueues: 'stopped',
      backgroundQueueStopReason: 'auth-blocked',
      repairEntries: [{ entry: 'device-revoked', reason: 'device-revoked' }],
      notices: ['device-revoked'],
      runnableEffects: [],
      completedEffects: [],
      lastFailedEffect: undefined,
    },
  )
})

test('startup actuation exposes reauth-required as a distinct repair entry', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: { ...baseLocalState, authState: 'reauth-required' },
  })

  assert.deepEqual(planSyncRuntimeStartupActuation({ plan: runtime }).commands, [
    { kind: 'stop-background-queues', reason: 'auth-blocked' },
    { kind: 'set-status', status: 'auth-blocked', reason: 'reauth-required' },
    { kind: 'show-repair-entry', entry: 'reauth-required', reason: 'reauth-required' },
    { kind: 'show-notice', notice: 'reauth-required' },
  ])

  assert.deepEqual(
    applySyncRuntimeShellCommands(
      INITIAL_SYNC_RUNTIME_SHELL_STATE,
      planSyncRuntimeStartupActuation({ plan: runtime }).commands,
    ).repairEntries,
    [{ entry: 'reauth-required', reason: 'reauth-required' }],
  )
})

test('startup actuation keeps successful startup steps executable', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const actuation = planSyncRuntimeStartupActuation({ plan: runtime })

  assert.equal(runtime.action, 'run-sync-without-local-store-gate')
  assert.deepEqual(
    actuation.commands.map((command) => command.kind),
    [
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
      'clear-repair-entries',
      'set-status',
      'run-runtime-effect',
    ],
  )

  const shell = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, actuation.commands)
  assert.equal(shell.backgroundQueues, 'stopped')
  assert.equal(shell.backgroundQueueStopReason, 'startup-not-ready')
  assert.equal(shell.runnableEffects.length, 6)
  assert.equal(shell.status, 'starting')
  assert.equal(shell.statusReason, 'outbox')
})

test('startup actuation starts background queues only after resume step is acknowledged', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  let shell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )

  while (shell.runnableEffects.length > 0) {
    const effect = shell.runnableEffects[0]
    assert.notEqual(effect, undefined)
    if (effect === undefined) {
      return
    }
    const wasResume =
      effect.kind === 'run-sync-startup-effect' &&
      effect.effect.kind === 'run-startup-step' &&
      effect.effect.step === 'resume-background-queues'

    shell = applySyncRuntimeShellCommands(shell, [{ kind: 'ack-runtime-effect', effect }])

    if (!wasResume) {
      assert.equal(shell.backgroundQueues, 'stopped')
      assert.equal(shell.backgroundQueueStopReason, 'startup-not-ready')
    }
  }

  assert.equal(shell.backgroundQueues, 'running')
  assert.equal(shell.backgroundQueueStopReason, undefined)
  assert.equal(shell.completedEffects.length, 6)
})

test('startup shell executor acknowledges runnable effects in order', async () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const executor = new RecordingStartupEffectExecutor()

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: queuedShell,
    executor,
  })

  assert.deepEqual(executor.effects, queuedShell.runnableEffects)
  assert.deepEqual(
    result.commands.map((command) => command.kind),
    Array.from({ length: queuedShell.runnableEffects.length }, () => 'ack-runtime-effect'),
  )
  assert.deepEqual(result.executedEffects, queuedShell.runnableEffects)
  assert.deepEqual(result.state.runnableEffects, [])
  assert.deepEqual(result.state.completedEffects, queuedShell.runnableEffects)
  assert.equal(result.state.backgroundQueues, 'running')
  assert.equal(result.state.backgroundQueueStopReason, undefined)
})

test('startup shell executor can pump a bounded number of effects', async () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const executor = new RecordingStartupEffectExecutor()

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: queuedShell,
    executor,
    maxEffects: 2,
  })

  assert.deepEqual(executor.effects, queuedShell.runnableEffects.slice(0, 2))
  assert.deepEqual(result.state.completedEffects, queuedShell.runnableEffects.slice(0, 2))
  assert.deepEqual(result.state.runnableEffects, queuedShell.runnableEffects.slice(2))
  assert.equal(result.state.backgroundQueues, 'stopped')
  assert.equal(result.state.backgroundQueueStopReason, 'startup-not-ready')
})

test('no-network effect pump stops before setup exchange transport', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false },
  })
  const shell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )

  const plan = planSyncRuntimeNoNetworkEffectPump({ state: shell })

  assert.equal(plan.executableEffectCount, 0)
  assert.deepEqual(plan.deferredEffect, {
    effect: shell.runnableEffects[0],
    reason: 'setup-exchange-transport-unimplemented',
  })
})

test('no-network effect pump allows local-store effects before deferring startup steps', () => {
  const localStoreEffect = {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'open',
      dbName: 'kuroflare:actuation-vault-1',
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: [],
    },
  } satisfies SyncRuntimeStartupEffect
  const startupStepEffect = {
    kind: 'run-sync-startup-effect',
    effect: {
      kind: 'run-startup-step',
      vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    },
  } satisfies SyncRuntimeStartupEffect
  const shell = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    { kind: 'run-runtime-effect', effect: localStoreEffect },
    { kind: 'run-runtime-effect', effect: startupStepEffect },
  ])

  const plan = planSyncRuntimeNoNetworkEffectPump({ state: shell })

  assert.equal(plan.executableEffectCount, 1)
  assert.deepEqual(plan.deferredEffect, {
    effect: startupStepEffect,
    reason: 'startup-step-port-unimplemented',
  })
})

test('startup shell executor records failure and stops before later effects', async () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.notEqual(firstEffect, undefined)
  if (firstEffect === undefined) {
    return
  }
  const executor = new RecordingStartupEffectExecutor(
    firstEffect,
    new Error('open-websocket-failed'),
  )

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: queuedShell,
    executor,
  })

  assert.deepEqual(executor.effects, [firstEffect])
  assert.deepEqual(result.commands, [
    { kind: 'fail-runtime-effect', effect: firstEffect, reason: 'open-websocket-failed' },
  ])
  assert.deepEqual(result.executedEffects, [firstEffect])
  assert.equal(result.state.status, 'rejected')
  assert.equal(result.state.statusReason, 'open-websocket-failed')
  assert.equal(result.state.backgroundQueues, 'stopped')
  assert.equal(result.state.backgroundQueueStopReason, 'rejected')
  assert.deepEqual(result.state.runnableEffects, queuedShell.runnableEffects.slice(1))
  assert.deepEqual(result.state.lastFailedEffect, {
    effect: firstEffect,
    reason: 'open-websocket-failed',
  })
})

test('startup effect executor dispatches runnable effects to concrete runtime ports', async () => {
  const localStoreEffect = {
    kind: 'open-database',
    mode: 'open',
    dbName: 'kuroflare:actuation-vault-1',
    version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
    createStores: [],
  } satisfies LocalStoreIndexedDbOpenEffect
  const setupExchangeEffect = {
    kind: 'run-setup-exchange',
    reason: 'missing-local-credentials',
  } satisfies SyncEngineStartupEffect
  const startupStepEffect = {
    kind: 'run-startup-step',
    vaultId,
    step: 'resume-background-queues',
    phase: 'outbox',
  } satisfies SyncEngineStartupEffect
  const rebuildEffect = {
    kind: 'rerun-startup-after-local-store-rebuild',
    vaultId,
    dbName: 'kuroflare:actuation-vault-1',
  } satisfies SyncRuntimeStartupEffect
  const effects = [
    { kind: 'run-local-store-open-effect', effect: localStoreEffect },
    { kind: 'run-sync-startup-effect', effect: setupExchangeEffect },
    { kind: 'run-sync-startup-effect', effect: startupStepEffect },
    rebuildEffect,
  ] satisfies readonly SyncRuntimeStartupEffect[]
  const recorded = createRecordingStartupEffectPorts()

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: effects },
    executor: createSyncRuntimeStartupEffectExecutor(recorded.ports),
  })

  assert.deepEqual(recorded.localStoreEffects, [localStoreEffect])
  assert.deepEqual(recorded.setupExchangeEffects, [setupExchangeEffect])
  assert.deepEqual(recorded.startupStepEffects, [startupStepEffect])
  assert.deepEqual(recorded.rebuildEffects, [rebuildEffect])
  assert.deepEqual(result.state.runnableEffects, [])
  assert.deepEqual(result.state.completedEffects, effects)
  assert.equal(result.state.backgroundQueues, 'running')
})

test('startup effect executor rejects non-runnable terminal effects instead of acknowledging them', async () => {
  const effect = {
    kind: 'run-sync-startup-effect',
    effect: { kind: 'enter-degraded', reason: 'missing-indexeddb' },
  } satisfies SyncRuntimeStartupEffect
  const recorded = createRecordingStartupEffectPorts()

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [effect] },
    executor: createSyncRuntimeStartupEffectExecutor(recorded.ports),
  })

  assert.deepEqual(result.commands, [
    {
      kind: 'fail-runtime-effect',
      effect,
      reason: 'Non-runnable sync startup effect: enter-degraded',
    },
  ])
  assert.deepEqual(result.state.completedEffects, [])
  assert.deepEqual(result.state.lastFailedEffect, {
    effect,
    reason: 'Non-runnable sync startup effect: enter-degraded',
  })
})

test('setup exchange port schedules startup replan with returned setup response', async () => {
  const setupExchangeEffect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SyncEngineStartupEffect
  const runtimeEffect = {
    kind: 'run-sync-startup-effect',
    effect: setupExchangeEffect,
  } satisfies SyncRuntimeStartupEffect
  const exchanged: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>[] = []
  const scheduled: {
    readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>
    readonly response: SetupExchangeResponse
  }[] = []
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange(effect) {
      exchanged.push(effect)
      return setupResponse
    },
    async scheduleReplan(request) {
      scheduled.push(request)
    },
  })

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [runtimeEffect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...createRecordingStartupEffectPorts().ports,
      setupExchange,
    }),
  })

  assert.deepEqual(exchanged, [setupExchangeEffect])
  assert.deepEqual(scheduled, [{ effect: setupExchangeEffect, response: setupResponse }])
  assert.deepEqual(setupExchange.snapshot().completed, [
    { effect: setupExchangeEffect, response: setupResponse },
  ])
  assert.deepEqual(result.commands, [{ kind: 'ack-runtime-effect', effect: runtimeEffect }])
  assert.deepEqual(result.state.completedEffects, [runtimeEffect])
  assert.deepEqual(result.state.lastFailedEffect, undefined)
})

test('setup exchange port fails startup effect when replan scheduling is rejected', async () => {
  const setupExchangeEffect = {
    kind: 'run-setup-exchange',
    reason: 'missing-local-credentials',
  } satisfies SyncEngineStartupEffect
  const runtimeEffect = {
    kind: 'run-sync-startup-effect',
    effect: setupExchangeEffect,
  } satisfies SyncRuntimeStartupEffect
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {
      throw new Error('setup-exchange-replan-failed')
    },
  })

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [runtimeEffect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...createRecordingStartupEffectPorts().ports,
      setupExchange,
    }),
  })

  assert.deepEqual(setupExchange.snapshot().completed, [])
  assert.deepEqual(result.commands, [
    {
      kind: 'fail-runtime-effect',
      effect: runtimeEffect,
      reason: 'setup-exchange-replan-failed',
    },
  ])
  assert.deepEqual(result.state.completedEffects, [])
  assert.deepEqual(result.state.lastFailedEffect, {
    effect: runtimeEffect,
    reason: 'setup-exchange-replan-failed',
  })
})

test('local-store rebuild replan port records accepted startup replan requests', async () => {
  const scheduled: { readonly vaultId: typeof vaultId; readonly dbName: string }[] = []
  const port = createSyncRuntimeLocalStoreRebuildReplanPort({
    async scheduleReplan(request) {
      scheduled.push(request)
    },
  })
  const effect = {
    kind: 'rerun-startup-after-local-store-rebuild',
    vaultId,
    dbName: 'kuroflare:actuation-vault-1',
  } satisfies SyncRuntimeStartupEffect

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [effect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...createRecordingStartupEffectPorts().ports,
      localStoreRebuild: port,
    }),
  })

  assert.deepEqual(scheduled, [{ vaultId, dbName: 'kuroflare:actuation-vault-1' }])
  assert.deepEqual(port.snapshot().requests, scheduled)
  assert.deepEqual(result.commands, [{ kind: 'ack-runtime-effect', effect }])
  assert.deepEqual(result.state.completedEffects, [effect])
})

test('local-store rebuild replan port fails startup effect when scheduling is rejected', async () => {
  const port = createSyncRuntimeLocalStoreRebuildReplanPort({
    async scheduleReplan() {
      throw new Error('startup-replan-scheduler-failed')
    },
  })
  const effect = {
    kind: 'rerun-startup-after-local-store-rebuild',
    vaultId,
    dbName: 'kuroflare:actuation-vault-1',
  } satisfies SyncRuntimeStartupEffect

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [effect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...createRecordingStartupEffectPorts().ports,
      localStoreRebuild: port,
    }),
  })

  assert.deepEqual(port.snapshot().requests, [])
  assert.deepEqual(result.commands, [
    {
      kind: 'fail-runtime-effect',
      effect,
      reason: 'startup-replan-scheduler-failed',
    },
  ])
  assert.deepEqual(result.state.lastFailedEffect, {
    effect,
    reason: 'startup-replan-scheduler-failed',
  })
})

test('indexeddb local-store effect port applies executable schema effects', async () => {
  const factory = new FakeIndexedDbFactory([])
  const port = createSyncRuntimeIndexedDbLocalStoreEffectPort({ indexedDb: factory })
  const effect = {
    kind: 'open-database',
    mode: 'create',
    dbName: 'kuroflare:actuation-vault-1',
    version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
    createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
  } satisfies LocalStoreIndexedDbOpenEffect

  await port.runOpenEffect(effect)

  assert.deepEqual(factory.operations, [
    {
      kind: 'open',
      name: 'kuroflare:actuation-vault-1',
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
    },
  ])
  assert.deepEqual(factory.database.storeNames(), DEFAULT_LOCAL_STORE_OBJECT_STORES)
  assert.deepEqual(port.snapshot().appliedEffects, [effect])
  assert.deepEqual(
    port.snapshot().openPlans.map((plan) => plan.kind),
    ['open-database'],
  )
})

test('indexeddb local-store effect port fails closed for non-executable schema effects', async () => {
  const factory = new FakeIndexedDbFactory([])
  const localStore = createSyncRuntimeIndexedDbLocalStoreEffectPort({ indexedDb: factory })
  const effect = {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'hold-degraded',
      dbName: 'kuroflare:actuation-vault-1',
      reason: 'local-store-too-new',
    },
  } satisfies SyncRuntimeStartupEffect

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [effect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...createRecordingStartupEffectPorts().ports,
      localStore,
    }),
  })

  assert.deepEqual(factory.operations, [])
  assert.deepEqual(localStore.snapshot(), { appliedEffects: [], openPlans: [] })
  assert.deepEqual(result.commands, [
    {
      kind: 'fail-runtime-effect',
      effect,
      reason: 'Non-runnable local-store open effect: hold-degraded',
    },
  ])
})

test('setup persist step port persists setup response through concrete storage ports', async () => {
  const secretStorage = new FakeSetupSecretStorage()
  const metadata = new FakeSetupMetadataPort()
  const port = createSyncRuntimeSetupPersistStepPort({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretStorage,
    metadata,
  })

  await port.persistSetupResponse({
    kind: 'run-startup-step',
    vaultId,
    step: 'persist-setup-response',
    phase: 'setup',
  })

  assert.deepEqual(
    secretStorage.operations.map((operation) => operation.kind),
    ['set', 'set'],
  )
  assert.deepEqual(
    metadata.commits.map((commit) => commit.map((write) => write.key)),
    [['setup', 'auth']],
  )
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.accessToken), false)
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.refreshToken), false)
  assert.equal(port.snapshot().results.length, 1)
  assert.equal(port.snapshot().results[0]?.ok, true)
})

test('setup persist step port fails startup effect when setup evidence is rejected', async () => {
  const setup = createSyncRuntimeSetupPersistStepPort({
    response: setupResponse,
    accessTokenExpiresAt: -1,
    secretStorage: new FakeSetupSecretStorage(),
    metadata: new FakeSetupMetadataPort(),
  })
  const recorded = createRecordingStartupEffectPorts()
  const startupStep = createSyncRuntimeStartupStepEffectPort({
    ...createRecordingStartupStepPorts().ports,
    setup,
  })
  const effect = {
    kind: 'run-sync-startup-effect',
    effect: {
      kind: 'run-startup-step',
      vaultId,
      step: 'persist-setup-response',
      phase: 'setup',
    },
  } satisfies SyncRuntimeStartupEffect

  const result = await executeRunnableSyncRuntimeShellEffects({
    state: { ...INITIAL_SYNC_RUNTIME_SHELL_STATE, runnableEffects: [effect] },
    executor: createSyncRuntimeStartupEffectExecutor({
      ...recorded.ports,
      startupStep,
    }),
  })

  assert.deepEqual(result.commands, [
    {
      kind: 'fail-runtime-effect',
      effect,
      reason: 'setup-persist-plan:invalid-token-expiry',
    },
  ])
  assert.equal(setup.snapshot().results.length, 1)
  assert.equal(setup.snapshot().results[0]?.ok, false)
})

test('verified setup persist step port derives expiry from verified access-token claims', async () => {
  const secretStorage = new FakeSetupSecretStorage()
  const metadata = new FakeSetupMetadataPort()
  const verifiedTokens: string[] = []
  const port = createVerifiedSyncRuntimeSetupPersistStepPort({
    response: setupResponse,
    now: 2_000,
    verifier: {
      async verify(accessToken) {
        verifiedTokens.push(accessToken)
        return setupAccessTokenClaims
      },
    },
    secretStorage,
    metadata,
  })

  await port.persistSetupResponse({
    kind: 'run-startup-step',
    vaultId,
    step: 'persist-setup-response',
    phase: 'setup',
  })

  assert.deepEqual(verifiedTokens, [setupResponse.accessToken])
  assert.equal(port.snapshot().verificationFailures.length, 0)
  assert.equal(port.snapshot().results[0]?.ok, true)
  const authWrite = metadata.commits[0]?.find((write) => write.key === 'auth')
  assert.equal(authWrite?.key, 'auth')
  if (authWrite !== undefined && 'accessTokenExpiresAt' in authWrite.value) {
    assert.equal(authWrite.value.accessTokenExpiresAt, setupAccessTokenClaims.exp)
  }
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.accessToken), false)
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.refreshToken), false)
})

test('verified setup persist step port rejects token claims before writing secrets', async () => {
  const secretStorage = new FakeSetupSecretStorage()
  const metadata = new FakeSetupMetadataPort()
  const port = createVerifiedSyncRuntimeSetupPersistStepPort({
    response: setupResponse,
    now: 2_000,
    verifier: {
      async verify() {
        return { ...setupAccessTokenClaims, tokenVersion: 2 }
      },
    },
    secretStorage,
    metadata,
  })

  await expect(
    port.persistSetupResponse({
      kind: 'run-startup-step',
      vaultId,
      step: 'persist-setup-response',
      phase: 'setup',
    }),
  ).rejects.toThrow(/setup-persist-token:token-version-mismatch/)

  assert.deepEqual(port.snapshot().verificationFailures, [{ reason: 'token-version-mismatch' }])
  assert.deepEqual(port.snapshot().results, [])
  assert.deepEqual(secretStorage.operations, [])
  assert.deepEqual(metadata.commits, [])
})

test('startup step executor dispatches every accepted startup step to the matching port', async () => {
  const steps = [
    'persist-setup-response',
    'scan-local-vault',
    'create-local-meta-ydoc',
    'adopt-local-files-after-remote-meta',
    'publish-local-meta-snapshot',
    'fetch-remote-meta-snapshot',
    'apply-remote-meta-snapshot',
    'sync-meta-state-vector',
    'sync-active-file-state-vector',
    'load-indexeddb-ydocs',
    'open-websocket',
    'send-client-hello',
    'publish-initial-file-snapshots',
    'send-meta-update',
    'enqueue-missing-downloads',
    'resume-background-queues',
  ] satisfies readonly ClientStartupStep[]
  const recorded = createRecordingStartupStepPorts()
  const port = createSyncRuntimeStartupStepEffectPort(recorded.ports)

  for (const step of steps) {
    await port.run({ kind: 'run-startup-step', vaultId, step, phase: 'outbox' })
  }

  assert.deepEqual(recorded.calls, [
    'setup.persistSetupResponse:persist-setup-response',
    'localScan.scanLocalVault:scan-local-vault',
    'localScan.createLocalMetaYDoc:create-local-meta-ydoc',
    'localScan.adoptLocalFilesAfterRemoteMeta:adopt-local-files-after-remote-meta',
    'snapshot.publishLocalMetaSnapshot:publish-local-meta-snapshot',
    'snapshot.fetchRemoteMetaSnapshot:fetch-remote-meta-snapshot',
    'snapshot.applyRemoteMetaSnapshot:apply-remote-meta-snapshot',
    'snapshot.syncMetaStateVector:sync-meta-state-vector',
    'snapshot.syncActiveFileStateVector:sync-active-file-state-vector',
    'localStore.loadIndexedDbYDocs:load-indexeddb-ydocs',
    'websocket.openWebSocket:open-websocket',
    'websocket.sendClientHello:send-client-hello',
    'snapshot.publishInitialFileSnapshots:publish-initial-file-snapshots',
    'outbox.sendMetaUpdate:send-meta-update',
    'outbox.enqueueMissingDownloads:enqueue-missing-downloads',
    'outbox.resumeBackgroundQueues:resume-background-queues',
  ])
})

test('startup actuation clears stale repair entries when startup progresses again', () => {
  const blockedRuntime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: { ...baseLocalState, authState: 'revoked' },
  })
  const blockedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: blockedRuntime }).commands,
  )

  const resumedRuntime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const resumedShell = applySyncRuntimeShellCommands(
    blockedShell,
    planSyncRuntimeStartupActuation({ plan: resumedRuntime }).commands,
  )

  assert.deepEqual(blockedShell.repairEntries, [
    { entry: 'device-revoked', reason: 'device-revoked' },
  ])
  assert.deepEqual(resumedShell.repairEntries, [])
  assert.equal(resumedShell.backgroundQueues, 'stopped')
  assert.equal(resumedShell.backgroundQueueStopReason, 'startup-not-ready')
})

test('startup actuation keeps background queues stopped before resume command', () => {
  const shell = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    {
      kind: 'run-runtime-effect',
      effect: {
        kind: 'run-sync-startup-effect',
        effect: { kind: 'run-setup-exchange', reason: 'setup-required' },
      },
    },
  ])

  assert.equal(shell.backgroundQueues, 'stopped')
  assert.equal(shell.backgroundQueueStopReason, 'startup-not-ready')
  assert.equal(shell.runnableEffects.length, 1)
})

test('startup actuation acknowledges completed runtime effects in order', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.notEqual(firstEffect, undefined)
  if (firstEffect === undefined) {
    return
  }

  const ackedShell = applySyncRuntimeShellCommands(queuedShell, [
    { kind: 'ack-runtime-effect', effect: firstEffect },
  ])

  assert.equal(ackedShell.runnableEffects.length, queuedShell.runnableEffects.length - 1)
  assert.deepEqual(ackedShell.completedEffects, [firstEffect])
  assert.equal(ackedShell.lastFailedEffect, undefined)
})

test('startup actuation acknowledges structurally equal reconstructed effects', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.equal(firstEffect?.kind, 'run-sync-startup-effect')
  if (firstEffect?.kind !== 'run-sync-startup-effect') {
    return
  }

  const reconstructedEffect = {
    kind: 'run-sync-startup-effect',
    effect: { ...firstEffect.effect },
  } satisfies typeof firstEffect
  const ackedShell = applySyncRuntimeShellCommands(queuedShell, [
    { kind: 'ack-runtime-effect', effect: reconstructedEffect },
  ])

  assert.equal(ackedShell.runnableEffects.length, queuedShell.runnableEffects.length - 1)
  assert.deepEqual(ackedShell.completedEffects, [reconstructedEffect])
})

test('startup actuation ignores ack for non-head runtime effects', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const secondEffect = queuedShell.runnableEffects[1]
  assert.notEqual(secondEffect, undefined)
  if (secondEffect === undefined) {
    return
  }

  assert.equal(
    applySyncRuntimeShellCommands(queuedShell, [
      { kind: 'ack-runtime-effect', effect: secondEffect },
    ]),
    queuedShell,
  )
})

test('startup actuation records runtime effect failures and stops queues', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.notEqual(firstEffect, undefined)
  if (firstEffect === undefined) {
    return
  }

  const failedShell = applySyncRuntimeShellCommands(queuedShell, [
    { kind: 'fail-runtime-effect', effect: firstEffect, reason: 'open-websocket-failed' },
  ])

  assert.equal(failedShell.status, 'rejected')
  assert.equal(failedShell.statusReason, 'open-websocket-failed')
  assert.equal(failedShell.backgroundQueues, 'stopped')
  assert.equal(failedShell.backgroundQueueStopReason, 'rejected')
  assert.equal(failedShell.runnableEffects.length, queuedShell.runnableEffects.length - 1)
  assert.deepEqual(failedShell.repairEntries, [
    { entry: 'startup-rejected', reason: 'open-websocket-failed' },
  ])
  assert.deepEqual(failedShell.notices, ['startup-rejected'])
  assert.deepEqual(failedShell.lastFailedEffect, {
    effect: firstEffect,
    reason: 'open-websocket-failed',
  })
})

test('startup actuation removes structurally equal failed runtime effects from the runnable queue', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.equal(firstEffect?.kind, 'run-sync-startup-effect')
  if (firstEffect?.kind !== 'run-sync-startup-effect') {
    return
  }

  const reconstructedEffect = {
    kind: 'run-sync-startup-effect',
    effect: { ...firstEffect.effect },
  } satisfies typeof firstEffect
  const failedShell = applySyncRuntimeShellCommands(queuedShell, [
    { kind: 'fail-runtime-effect', effect: reconstructedEffect, reason: 'startup-effect-failed' },
  ])

  assert.equal(failedShell.runnableEffects.length, queuedShell.runnableEffects.length - 1)
  assert.deepEqual(failedShell.lastFailedEffect, {
    effect: reconstructedEffect,
    reason: 'startup-effect-failed',
  })
})

test('startup actuation ignores fail for non-head runtime effects', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const secondEffect = queuedShell.runnableEffects[1]
  assert.notEqual(secondEffect, undefined)
  if (secondEffect === undefined) {
    return
  }

  assert.equal(
    applySyncRuntimeShellCommands(queuedShell, [
      { kind: 'fail-runtime-effect', effect: secondEffect, reason: 'out-of-order-failure' },
    ]),
    queuedShell,
  )
})

test('startup actuation retries the last failed runtime effect explicitly', () => {
  const runtime = planSyncRuntimeStartup({
    intent: 'reconnect',
    local: baseLocalState,
  })
  const queuedShell = applySyncRuntimeShellCommands(
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
    planSyncRuntimeStartupActuation({ plan: runtime }).commands,
  )
  const firstEffect = queuedShell.runnableEffects[0]
  assert.notEqual(firstEffect, undefined)
  if (firstEffect === undefined) {
    return
  }
  const failedShell = applySyncRuntimeShellCommands(queuedShell, [
    { kind: 'fail-runtime-effect', effect: firstEffect, reason: 'startup-effect-failed' },
  ])

  const retryShell = applySyncRuntimeShellCommands(failedShell, [
    { kind: 'retry-last-failed-effect', reason: 'user-requested-retry' },
  ])

  assert.equal(retryShell.status, 'starting')
  assert.equal(retryShell.statusReason, 'user-requested-retry')
  assert.deepEqual(retryShell.runnableEffects[0], firstEffect)
  assert.equal(retryShell.runnableEffects.length, queuedShell.runnableEffects.length)
  assert.deepEqual(retryShell.repairEntries, [])
  assert.equal(retryShell.lastFailedEffect, undefined)
  assert.equal(retryShell.backgroundQueues, 'stopped')
})

test('startup actuation retry command is a no-op without a failed effect', () => {
  assert.equal(
    applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
      { kind: 'retry-last-failed-effect', reason: 'user-requested-retry' },
    ]),
    INITIAL_SYNC_RUNTIME_SHELL_STATE,
  )
})

class RecordingStartupEffectExecutor implements SyncRuntimeShellEffectExecutor {
  readonly effects: SyncRuntimeStartupEffect[] = []

  constructor(
    private readonly failingEffect?: SyncRuntimeStartupEffect,
    private readonly failure?: Error,
  ) {}

  async run(effect: SyncRuntimeStartupEffect): Promise<void> {
    this.effects.push(effect)
    if (this.failingEffect === effect && this.failure !== undefined) {
      throw this.failure
    }
  }
}

function createRecordingStartupEffectPorts(): {
  readonly ports: SyncRuntimeStartupEffectExecutorPorts
  readonly localStoreEffects: LocalStoreIndexedDbOpenEffect[]
  readonly setupExchangeEffects: Extract<
    SyncEngineStartupEffect,
    { readonly kind: 'run-setup-exchange' }
  >[]
  readonly startupStepEffects: Extract<
    SyncEngineStartupEffect,
    { readonly kind: 'run-startup-step' }
  >[]
  readonly rebuildEffects: Extract<
    SyncRuntimeStartupEffect,
    { readonly kind: 'rerun-startup-after-local-store-rebuild' }
  >[]
} {
  const localStoreEffects: LocalStoreIndexedDbOpenEffect[] = []
  const setupExchangeEffects: Extract<
    SyncEngineStartupEffect,
    { readonly kind: 'run-setup-exchange' }
  >[] = []
  const startupStepEffects: Extract<
    SyncEngineStartupEffect,
    { readonly kind: 'run-startup-step' }
  >[] = []
  const rebuildEffects: Extract<
    SyncRuntimeStartupEffect,
    { readonly kind: 'rerun-startup-after-local-store-rebuild' }
  >[] = []

  return {
    localStoreEffects,
    setupExchangeEffects,
    startupStepEffects,
    rebuildEffects,
    ports: {
      localStore: {
        async runOpenEffect(effect) {
          localStoreEffects.push(effect)
        },
      },
      setupExchange: {
        async run(effect) {
          setupExchangeEffects.push(effect)
          return { effect, response: setupResponse }
        },
      },
      startupStep: {
        async run(effect) {
          startupStepEffects.push(effect)
        },
      },
      localStoreRebuild: {
        async rerunStartup(effect) {
          rebuildEffects.push(effect)
        },
      },
    },
  }
}

function createRecordingStartupStepPorts(): {
  readonly ports: SyncRuntimeStartupStepExecutorPorts
  readonly calls: string[]
} {
  const calls: string[] = []
  const record =
    (name: string) =>
    async (effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>) => {
      calls.push(`${name}:${effect.step}`)
    }

  return {
    calls,
    ports: {
      setup: {
        persistSetupResponse: record('setup.persistSetupResponse'),
      },
      localScan: {
        scanLocalVault: record('localScan.scanLocalVault'),
        createLocalMetaYDoc: record('localScan.createLocalMetaYDoc'),
        adoptLocalFilesAfterRemoteMeta: record('localScan.adoptLocalFilesAfterRemoteMeta'),
      },
      snapshot: {
        publishLocalMetaSnapshot: record('snapshot.publishLocalMetaSnapshot'),
        publishInitialFileSnapshots: record('snapshot.publishInitialFileSnapshots'),
        fetchRemoteMetaSnapshot: record('snapshot.fetchRemoteMetaSnapshot'),
        applyRemoteMetaSnapshot: record('snapshot.applyRemoteMetaSnapshot'),
        syncMetaStateVector: record('snapshot.syncMetaStateVector'),
        syncActiveFileStateVector: record('snapshot.syncActiveFileStateVector'),
      },
      localStore: {
        loadIndexedDbYDocs: record('localStore.loadIndexedDbYDocs'),
      },
      websocket: {
        openWebSocket: record('websocket.openWebSocket'),
        sendClientHello: record('websocket.sendClientHello'),
      },
      outbox: {
        sendMetaUpdate: record('outbox.sendMetaUpdate'),
        enqueueMissingDownloads: record('outbox.enqueueMissingDownloads'),
        resumeBackgroundQueues: record('outbox.resumeBackgroundQueues'),
      },
    },
  }
}

type FakeSetupSecretOperation =
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'delete'; readonly key: string }

class FakeSetupSecretStorage implements LocalSetupPersistSecretStoragePort {
  readonly operations: FakeSetupSecretOperation[] = []

  async set(key: string, value: string): Promise<void> {
    this.operations.push({ kind: 'set', key, value })
  }

  async delete(key: string): Promise<void> {
    this.operations.push({ kind: 'delete', key })
  }
}

class FakeSetupMetadataPort implements LocalSetupPersistMetadataPort {
  readonly commits: LocalStoreIndexedDbMetadataWriteOperation[][] = []

  async commit(writes: readonly LocalStoreIndexedDbMetadataWriteOperation[]): Promise<void> {
    this.commits.push([...writes])
  }
}

type FakeIndexedDbFactoryOperation =
  | { readonly kind: 'open'; readonly name: string; readonly version: number }
  | { readonly kind: 'deleteDatabase'; readonly name: string }

class FakeIndexedDbFactory implements LocalStoreIndexedDbFactoryPort<FakeIndexedDbSchemaDatabase> {
  readonly database: FakeIndexedDbSchemaDatabase
  readonly operations: FakeIndexedDbFactoryOperation[] = []

  constructor(storeNames: readonly LocalStoreObjectStore[]) {
    this.database = new FakeIndexedDbSchemaDatabase(storeNames)
  }

  open(name: string, version: number): LocalStoreIndexedDbOpenRequest<FakeIndexedDbSchemaDatabase> {
    this.operations.push({ kind: 'open', name, version })
    return new SuccessfulIndexedDbOpenRequest(this.database)
  }

  deleteDatabase(name: string): LocalStoreIndexedDbRequest<undefined> {
    this.operations.push({ kind: 'deleteDatabase', name })
    this.database.clearStores()
    return new SuccessfulIndexedDbRequest(undefined)
  }
}

class FakeIndexedDbSchemaDatabase implements LocalStoreIndexedDbSchemaDatabasePort {
  readonly objectStoreNames: LocalStoreIndexedDbObjectStoreNameList
  readonly createdStores: LocalStoreObjectStore[] = []
  readonly #storeNames = new Set<LocalStoreObjectStore>()

  constructor(storeNames: readonly LocalStoreObjectStore[]) {
    for (const storeName of storeNames) {
      this.#storeNames.add(storeName)
    }
    this.objectStoreNames = {
      contains: (name) => this.#storeNames.has(localStoreObjectStoreName(name)),
    }
  }

  createObjectStore(name: LocalStoreObjectStore): unknown {
    this.#storeNames.add(name)
    this.createdStores.push(name)
    return {}
  }

  clearStores(): void {
    this.#storeNames.clear()
    this.createdStores.length = 0
  }

  storeNames(): readonly LocalStoreObjectStore[] {
    return DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((storeName) => this.#storeNames.has(storeName))
  }
}

class SuccessfulIndexedDbOpenRequest implements LocalStoreIndexedDbOpenRequest<FakeIndexedDbSchemaDatabase> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null
  onupgradeneeded: ((event: Event) => void) | null = null

  constructor(readonly result: FakeIndexedDbSchemaDatabase) {
    queueMicrotask(() => {
      if (this.onupgradeneeded !== null) {
        this.onupgradeneeded(new Event('upgradeneeded'))
      }
      if (this.onsuccess !== null) {
        this.onsuccess(new Event('success'))
      }
    })
  }
}

class SuccessfulIndexedDbRequest<Result> implements LocalStoreIndexedDbRequest<Result> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null

  constructor(readonly result: Result) {
    queueMicrotask(() => {
      if (this.onsuccess !== null) {
        this.onsuccess(new Event('success'))
      }
    })
  }
}

function localStoreObjectStoreName(name: string): LocalStoreObjectStore {
  for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
    if (storeName === name) {
      return storeName
    }
  }
  assert.fail(`unexpected local store object store name: ${name}`)
}
