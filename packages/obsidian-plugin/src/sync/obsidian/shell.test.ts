import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeVaultId,
  type ClientStartupLocalState,
  type ClientStartupStep,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  createSyncRuntimeSetupExchangePort,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeStartupStepEffect,
  type SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import {
  type SyncRuntimeStartupEffect,
  type SyncRuntimeStartupFromSchemaEvidenceInput,
} from '../engine/startup'
import {
  INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE,
  runSyncRuntimeObsidianShellDriverSetupExchangeTick,
  runSyncRuntimeObsidianShellDriverStartupStepTick,
  runSyncRuntimeObsidianShellDriverTick,
  runSyncRuntimeObsidianShellDriverTransportTick,
  type SyncRuntimeObsidianShellEvidencePort,
  type SyncRuntimeObsidianShellEvidenceReadResult,
} from '../obsidian/shell'
import {
  LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
} from '../store/schema'

const vaultId = makeVaultId('driver-vault-1')
const deviceId = makeDeviceId('driver-device-1')

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

const setupResponse = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

test('Obsidian shell driver renders setup-required once and leaves setup exchange deferred', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
  })
  const executor = new RecordingShellEffectExecutor()

  const first = await runSyncRuntimeObsidianShellDriverTick({ evidence, executor })
  const second = await runSyncRuntimeObsidianShellDriverTick({
    state: first.state,
    evidence,
    executor,
  })

  assert.equal(first.deferredEffect?.reason, 'setup-exchange-transport-unimplemented')
  assert.deepEqual(first.presentation.noticeTexts, [
    'Kuroflare setup is required before sync can start.',
  ])
  assert.deepEqual(second.presentation.noticeTexts, [])
  assert.equal(evidence.readCount, 1)
  assert.deepEqual(executor.effects, [])
})

test('Obsidian shell driver executes local-store gate before deferring startup steps', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()

  const result = await runSyncRuntimeObsidianShellDriverTick({ evidence, executor })

  assert.equal(result.executedLocalEffectCount, 1)
  assert.equal(executor.effects.length, 1)
  assert.deepEqual(executor.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'open-database',
      mode: 'open',
      dbName: 'kuroflare:driver-vault-1',
      version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      createStores: [],
    },
  })
  assert.equal(result.deferredEffect?.reason, 'startup-step-port-unimplemented')
  assert.equal(
    result.presentation.statusText,
    'Kuroflare: starting / queues stopped (startup-not-ready)',
  )
})

test('Obsidian shell driver can bound local effect pumping', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()

  const result = await runSyncRuntimeObsidianShellDriverTick({
    state: INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE,
    evidence,
    executor,
    maxLocalEffects: 0,
  })

  assert.equal(result.executedLocalEffectCount, 0)
  assert.equal(result.deferredEffect, undefined)
  assert.deepEqual(executor.effects, [])
  assert.equal(result.state.shell.runnableEffects.length > 0, true)
})

test('Obsidian shell driver surfaces local evidence failure without planning setup', async () => {
  const evidence = new StaticStartupEvidencePort({
    ok: false,
    localState: {
      ok: false,
      reason: 'local-store-schema-evidence-failure',
      localStoreReason: 'database-directory-unavailable',
    },
  })
  const executor = new RecordingShellEffectExecutor()

  const result = await runSyncRuntimeObsidianShellDriverTick({ evidence, executor })

  assert.equal(result.startupPlan, undefined)
  assert.deepEqual(result.evidenceFailure, {
    ok: false,
    reason: 'local-store-schema-evidence-failure',
    localStoreReason: 'database-directory-unavailable',
  })
  assert.equal(
    result.presentation.statusText,
    'Kuroflare: local store blocked / queues stopped (local-store-blocked)',
  )
  assert.deepEqual(result.presentation.noticeTexts, [
    'Kuroflare local storage is blocked and sync was not started.',
  ])
  assert.deepEqual(result.presentation.repairEntries, [
    {
      entry: 'local-store-schema',
      title: 'Local store repair required',
      description: 'IndexedDB schema evidence blocked startup: database-directory-unavailable',
    },
  ])
  assert.deepEqual(executor.effects, [])
})

test('Obsidian shell driver transport tick reads failed evidence once', async () => {
  const evidence = new StaticStartupEvidencePort({
    ok: false,
    localState: {
      ok: false,
      reason: 'local-store-schema-evidence-failure',
      localStoreReason: 'database-directory-unavailable',
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverTransportTick({
    evidence,
    executor,
    setupExchange,
    startupStep,
  })

  assert.equal(evidence.readCount, 1)
  assert.equal(result.executedLocalEffectCount, 0)
  assert.equal(result.executedStartupStepCount, 0)
  assert.equal(result.evidenceFailure?.reason, 'local-store-schema-evidence-failure')
  assert.deepEqual(setupExchange.snapshot().completed, [])
  assert.deepEqual(startupStep.effects, [])
})

test('Obsidian shell driver can run setup exchange, replan startup, and pump local-store gate', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: false,
        currentVersion: undefined,
        presentStores: [],
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange(effect) {
      assert.equal(effect.reason, 'missing-local-credentials')
      return setupResponse
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverSetupExchangeTick({
    evidence,
    executor,
    setupExchange,
  })

  assert.equal(result.setupExchangeReplan?.replan.intent, 'setup-new-vault')
  assert.equal(result.startupPlan?.action, 'continue')
  assert.deepEqual(setupExchange.snapshot().completed, [
    {
      effect: { kind: 'run-setup-exchange', reason: 'missing-local-credentials' },
      response: setupResponse,
    },
  ])
  assert.equal(result.executedLocalEffectCount, 1)
  assert.deepEqual(executor.effects, [
    {
      kind: 'run-local-store-open-effect',
      effect: {
        kind: 'open-database',
        mode: 'create',
        dbName: 'kuroflare:driver-vault-1',
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
      },
    },
  ])
  assert.equal(result.deferredEffect?.reason, 'startup-step-port-unimplemented')
  assert.deepEqual(result.presentation.noticeTexts, [
    'Kuroflare setup is required before sync can start.',
  ])
})

test('Obsidian shell driver leaves setup exchange failure as a retryable runtime effect failure', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
  })
  const executor = new RecordingShellEffectExecutor()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-http:401')
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverSetupExchangeTick({
    evidence,
    executor,
    setupExchange,
  })

  assert.equal(result.setupExchangeReplan, undefined)
  assert.equal(result.startupPlan?.action, 'run-sync-without-local-store-gate')
  assert.deepEqual(result.state.shell.lastFailedEffect, {
    effect: {
      kind: 'run-sync-startup-effect',
      effect: { kind: 'run-setup-exchange', reason: 'missing-local-credentials' },
    },
    reason: 'setup-exchange-failed',
  })
  assert.deepEqual(setupExchange.snapshot().completed, [])
  assert.equal(result.deferredEffect, undefined)
})

test('Obsidian shell driver can execute startup steps after local-store gate is acknowledged', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort()
  const noNetwork = await runSyncRuntimeObsidianShellDriverTick({ evidence, executor })

  const result = await runSyncRuntimeObsidianShellDriverStartupStepTick({
    state: noNetwork.state,
    evidence,
    executor,
    startupStep,
  })

  assert.equal(evidence.readCount, 1)
  assert.equal(noNetwork.executedLocalEffectCount, 1)
  assert.equal(result.executedLocalEffectCount, 0)
  assert.equal(result.executedStartupStepCount, startupStep.effects.length)
  assert.deepEqual(
    startupStep.effects.map((effect) => effect.step),
    [
      'load-indexeddb-ydocs',
      'open-websocket',
      'send-client-hello',
      'sync-meta-state-vector',
      'sync-active-file-state-vector',
      'resume-background-queues',
    ],
  )
  assert.equal(result.state.shell.runnableEffects.length, 0)
  assert.equal(result.state.shell.backgroundQueues, 'running')
  assert.equal(result.deferredEffect, undefined)
})

test('Obsidian shell driver stops startup step pumping on first startup step failure', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: baseLocalState,
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort('open-websocket')
  const noNetwork = await runSyncRuntimeObsidianShellDriverTick({ evidence, executor })

  const result = await runSyncRuntimeObsidianShellDriverStartupStepTick({
    state: noNetwork.state,
    evidence,
    executor,
    startupStep,
  })

  assert.equal(result.executedStartupStepCount, 1)
  assert.deepEqual(
    startupStep.effects.map((effect) => effect.step),
    ['load-indexeddb-ydocs', 'open-websocket'],
  )
  assert.deepEqual(result.state.shell.lastFailedEffect, {
    effect: {
      kind: 'run-sync-startup-effect',
      effect: {
        kind: 'run-startup-step',
        vaultId,
        step: 'open-websocket',
        phase: 'websocket',
      },
    },
    reason: 'startup-step-failed',
  })
  assert.equal(result.state.shell.backgroundQueues, 'stopped')
  assert.equal(result.state.shell.backgroundQueueStopReason, 'rejected')
})

test('Obsidian shell driver transport tick runs setup exchange, local-store gate, and startup steps in order', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: false,
        currentVersion: undefined,
        presentStores: [],
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverTransportTick({
    evidence,
    executor,
    setupExchange,
    startupStep,
  })

  assert.equal(evidence.readCount, 1)
  assert.equal(result.setupExchangeReplan?.replan.intent, 'setup-new-vault')
  assert.equal(result.executedLocalEffectCount, 1)
  assert.equal(result.executedStartupStepCount, startupStep.effects.length)
  assert.deepEqual(
    executor.effects.map((effect) => effect.kind),
    ['run-local-store-open-effect'],
  )
  assert.deepEqual(
    startupStep.effects.map((effect) => effect.step),
    [
      'persist-setup-response',
      'scan-local-vault',
      'open-websocket',
      'send-client-hello',
      'create-local-meta-ydoc',
      'publish-local-meta-snapshot',
      'publish-initial-file-snapshots',
      'send-meta-update',
    ],
  )
  assert.equal(result.state.shell.runnableEffects.length, 0)
  assert.equal(result.state.shell.backgroundQueues, 'stopped')
  assert.equal(result.state.shell.backgroundQueueStopReason, 'startup-not-ready')
  assert.equal(result.deferredEffect, undefined)
})

test('setup response persistence remains after a planned local-store rebuild', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION - 1,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        pendingOutboxCount: 0,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverTransportTick({
    evidence,
    executor,
    setupExchange,
    startupStep,
  })

  assert.equal(result.startupPlan?.action, 'rebuild-local-store')
  assert.deepEqual(
    executor.effects.map((effect) => effect.kind),
    [
      'run-local-store-open-effect',
      'run-local-store-open-effect',
      'rerun-startup-after-local-store-rebuild',
    ],
  )
  assert.deepEqual(startupStep.effects, [])
})

test('setup response persistence is withheld when the existing outbox store is unsafe', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'reconnect',
    local: { ...baseLocalState, hasDeviceCredentials: false, vaultId: undefined },
    localStoreEvidence: {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox'),
        pendingOutboxCount: 1,
      },
    },
  })
  const executor = new RecordingShellEffectExecutor()
  const startupStep = new RecordingStartupStepPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {},
  })

  const result = await runSyncRuntimeObsidianShellDriverTransportTick({
    evidence,
    executor,
    setupExchange,
    startupStep,
  })

  assert.equal(result.startupPlan?.action, 'hold-local-store-degraded')
  assert.deepEqual(startupStep.effects, [])
  assert.deepEqual(
    executor.effects.map((effect) => effect.kind),
    ['run-local-store-open-effect'],
  )
  assert.deepEqual(executor.effects[0], {
    kind: 'run-local-store-open-effect',
    effect: {
      kind: 'hold-degraded',
      dbName: `kuroflare:${vaultId}`,
      reason: 'missing-required-store-with-pending-outbox',
    },
  })
})

class StaticStartupEvidencePort implements SyncRuntimeObsidianShellEvidencePort {
  readCount = 0

  constructor(
    private readonly input:
      | SyncRuntimeStartupFromSchemaEvidenceInput
      | SyncRuntimeObsidianShellEvidenceReadResult,
  ) {}

  async readStartupInput(): Promise<SyncRuntimeObsidianShellEvidenceReadResult> {
    this.readCount += 1
    return 'ok' in this.input ? this.input : { ok: true, startupInput: this.input }
  }
}

class RecordingShellEffectExecutor implements SyncRuntimeShellEffectExecutor {
  readonly effects: SyncRuntimeStartupEffect[] = []

  async run(effect: SyncRuntimeStartupEffect): Promise<void> {
    this.effects.push(effect)
  }
}

class RecordingStartupStepPort implements SyncRuntimeStartupStepEffectPort {
  readonly effects: SyncRuntimeStartupStepEffect<ClientStartupStep>[] = []

  constructor(private readonly failStep?: string) {}

  async run(effect: SyncRuntimeStartupStepEffect<ClientStartupStep>): Promise<void> {
    this.effects.push(effect)
    if (effect.step === this.failStep) {
      throw new Error(`startup-step-${effect.step}-failed`)
    }
  }
}
