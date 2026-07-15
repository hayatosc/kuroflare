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
  createSyncRuntimeObsidianResumePort,
  createSyncRuntimeObsidianShellLifecycle,
  type SyncRuntimeObsidianResumePort,
} from '../obsidian/lifecycle'
import { type SyncRuntimeObsidianShellEvidenceReadResult } from '../obsidian/shell'
import { type SyncRuntimeObsidianShellUiPort } from '../obsidian/ui'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from '../store/schema'

const vaultId = makeVaultId('lifecycle-vault-1')
const deviceId = makeDeviceId('lifecycle-device-1')

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

test('Obsidian shell lifecycle runs transport tick, applies UI, and retains driver state', async () => {
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
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const first = await lifecycle.runStartupTick()
  const second = await lifecycle.runStartupTick()

  assert.equal(evidence.readCount, 1)
  assert.equal(first.driver.setupExchangeReplan?.replan.intent, 'setup-new-vault')
  assert.equal(first.driver.executedLocalEffectCount, 1)
  assert.equal(first.driver.executedStartupStepCount, startupStep.effects.length)
  assert.deepEqual(first.ui.shownNotices, ['Kuroflare setup is required before sync can start.'])
  assert.deepEqual(second.ui.shownNotices, [])
  assert.deepEqual(
    ui.operations.map((operation) => operation.kind),
    [
      'set-status-text',
      'show-notice',
      'set-repair-entries',
      'set-retry-enabled',
      'set-status-text',
      'set-repair-entries',
      'set-retry-enabled',
    ],
  )
  assert.equal(lifecycle.snapshot().tickInFlight, false)
  assert.equal(lifecycle.snapshot().driverState.shell.runnableEffects.length, 0)
})

test('Obsidian shell lifecycle serializes concurrent startup ticks', async () => {
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
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const [first, second] = await Promise.all([
    lifecycle.runStartupTick(),
    lifecycle.runStartupTick(),
  ])

  assert.equal(first, second)
  assert.equal(evidence.readCount, 1)
  assert.equal(ui.operations.filter((operation) => operation.kind === 'set-status-text').length, 1)
  assert.equal(lifecycle.snapshot().tickInFlight, false)
})

test('Obsidian shell lifecycle runs foreground resume after startup tick and schedules outbox', async () => {
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
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const result = await lifecycle.runResumeTick('focus')

  assert.equal(result.action, 'ran')
  assert.equal(evidence.readCount, 1)
  assert.deepEqual(resume.operations, [
    { kind: 'can-resume' },
    { kind: 'foreground', reason: 'focus' },
    { kind: 'outbox', reason: 'lifecycle:focus' },
  ])
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
})

test('Obsidian shell lifecycle skips foreground resume after startup failure', async () => {
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
  const startupStep = new FailingStartupStepPort('open-websocket')
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const result = await lifecycle.runResumeTick('focus')

  assert.deepEqual(result, { action: 'skipped' })
  assert.deepEqual(resume.operations, [{ kind: 'can-resume' }])
  const failedEffect = lifecycle.snapshot().driverState.shell.lastFailedEffect?.effect
  assert.equal(failedEffect?.kind, 'run-sync-startup-effect')
  if (failedEffect?.kind === 'run-sync-startup-effect') {
    assert.equal(failedEffect.effect.kind, 'run-startup-step')
    if (failedEffect.effect.kind === 'run-startup-step') {
      assert.equal(failedEffect.effect.step, 'open-websocket')
    }
  }
})

test('Obsidian shell lifecycle does not acknowledge or adopt after snapshot fetch failure', async () => {
  const evidence = new StaticStartupEvidencePort({
    intent: 'join-existing-vault',
    expectedBootstrapMode: 'join-existing',
    setupResponse: { ...setupResponse, bootstrapMode: 'join-existing' },
    local: {
      ...baseLocalState,
      hasIndexedDb: false,
      hasDeviceCredentials: false,
      hasMetaYDoc: false,
      hasLocalVaultFiles: true,
      vaultId: undefined,
      schemaVersion: undefined,
    },
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
  const startupStep = new FailingStartupStepPort('fetch-remote-meta-snapshot')
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const result = await lifecycle.runStartupTick()

  assert.equal(result.driver.state.shell.status, 'rejected')
  assert.equal(result.driver.state.shell.lastFailedEffect?.effect.kind, 'run-sync-startup-effect')
  assert.deepEqual(
    startupStep.effects.map((effect) => effect.step),
    ['persist-setup-response'],
  )
  const failedSnapshotEffect = result.driver.state.shell.lastFailedEffect?.effect
  assert.equal(failedSnapshotEffect?.kind, 'run-sync-startup-effect')
  if (failedSnapshotEffect?.kind === 'run-sync-startup-effect') {
    assert.equal(failedSnapshotEffect.effect.kind, 'run-startup-step')
    if (failedSnapshotEffect.effect.kind === 'run-startup-step') {
      assert.equal(failedSnapshotEffect.effect.step, 'fetch-remote-meta-snapshot')
    }
  }
  assert.equal(
    result.driver.state.shell.completedEffects.some(
      (effect) =>
        effect.kind === 'run-sync-startup-effect' &&
        effect.effect.kind === 'run-startup-step' &&
        effect.effect.step === 'apply-remote-meta-snapshot',
    ),
    false,
  )
})

test('Obsidian shell lifecycle rereads evidence after a local-store rebuild replan', async () => {
  const evidence = new SequenceStartupEvidencePort([
    {
      intent: 'reconnect',
      local: { ...baseLocalState, schemaVersion: 1 },
      localStoreEvidence: {
        ok: true,
        evidence: {
          dbExists: true,
          currentVersion: 1,
          presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
          pendingOutboxCount: 0,
        },
      },
    },
    {
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
    },
  ])
  let lifecycle: ReturnType<typeof createSyncRuntimeObsidianShellLifecycle> | undefined
  const executor: SyncRuntimeShellEffectExecutor = {
    async run(effect) {
      if (effect.kind === 'rerun-startup-after-local-store-rebuild') {
        lifecycle?.requestReplan()
      }
    },
  }
  const startupStep = new RecordingStartupStepPort()
  const resume = new RecordingResumePort()
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: {
      evidence,
      executor,
      setupExchange,
      startupStep,
      resume,
      ui,
    },
  })

  const first = await lifecycle.runStartupTick()
  const second = await lifecycle.runStartupTick()

  assert.equal(first.driver.startupPlan?.action, 'rebuild-local-store')
  assert.equal(second.driver.startupPlan?.action, 'continue')
  assert.equal(evidence.readCount, 2)
  assert.equal(second.driver.state.shell.runnableEffects.length, 0)
  assert.equal(second.driver.state.shell.backgroundQueues, 'running')
  assert.equal(startupStep.effects.length > 0, true)
})

test('Obsidian shell lifecycle skips resume side effects when the resume gate is closed', async () => {
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
  const resume = new RecordingResumePort(false)
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, resume, ui },
  })

  const result = await lifecycle.runResumeTick('hidden')

  assert.deepEqual(result, { action: 'skipped' })
  assert.equal(evidence.readCount, 0)
  assert.deepEqual(resume.operations, [{ kind: 'can-resume' }])
})

test('Obsidian resume port gates hidden or blocked documents and forwards runnable effects', async () => {
  const operations: (
    | { readonly kind: 'foreground'; readonly reason: string }
    | { readonly kind: 'outbox'; readonly reason: string }
  )[] = []
  let hidden = false
  let blocked = false
  const port = createSyncRuntimeObsidianResumePort({
    isDocumentHidden: () => hidden,
    isSyncBlocked: () => blocked,
    runForegroundResume: async (reason) => {
      operations.push({ kind: 'foreground', reason })
    },
    scheduleOutboxTick: (reason) => {
      operations.push({ kind: 'outbox', reason })
    },
  })

  assert.equal(port.canResume(), true)
  await port.runForegroundResume('focus')
  port.scheduleOutboxTick('lifecycle:focus')
  assert.deepEqual(operations, [
    { kind: 'foreground', reason: 'focus' },
    { kind: 'outbox', reason: 'lifecycle:focus' },
  ])

  hidden = true
  assert.equal(port.canResume(), false)
  hidden = false
  blocked = true
  assert.equal(port.canResume(), false)
})

class StaticStartupEvidencePort {
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

class SequenceStartupEvidencePort {
  readCount = 0

  constructor(private readonly inputs: readonly SyncRuntimeStartupFromSchemaEvidenceInput[]) {}

  async readStartupInput(): Promise<SyncRuntimeObsidianShellEvidenceReadResult> {
    const input = this.inputs[Math.min(this.readCount, this.inputs.length - 1)]
    this.readCount += 1
    if (input === undefined) throw new Error('startup-evidence-sequence-empty')
    return { ok: true, startupInput: input }
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

  async run(effect: SyncRuntimeStartupStepEffect<ClientStartupStep>): Promise<void> {
    this.effects.push(effect)
  }
}

class FailingStartupStepPort extends RecordingStartupStepPort {
  constructor(private readonly failingStep: ClientStartupStep) {
    super()
  }

  override async run(effect: SyncRuntimeStartupStepEffect<ClientStartupStep>): Promise<void> {
    if (effect.step === this.failingStep) {
      throw new Error(`startup-step-failed:${this.failingStep}`)
    }
    await super.run(effect)
  }
}

class RecordingResumePort implements SyncRuntimeObsidianResumePort {
  readonly operations: (
    | { readonly kind: 'can-resume' }
    | { readonly kind: 'foreground'; readonly reason: string }
    | { readonly kind: 'outbox'; readonly reason: string }
  )[] = []

  constructor(private readonly allowed = true) {}

  canResume(): boolean {
    this.operations.push({ kind: 'can-resume' })
    return this.allowed
  }

  async runForegroundResume(reason: string): Promise<void> {
    this.operations.push({ kind: 'foreground', reason })
  }

  scheduleOutboxTick(reason: string): void {
    this.operations.push({ kind: 'outbox', reason })
  }
}

class RecordingObsidianShellUiPort implements SyncRuntimeObsidianShellUiPort {
  readonly operations: (
    | { readonly kind: 'set-status-text'; readonly text: string }
    | { readonly kind: 'show-notice'; readonly text: string }
    | {
        readonly kind: 'set-repair-entries'
        readonly entries: Parameters<SyncRuntimeObsidianShellUiPort['setRepairEntries']>[0]
      }
    | { readonly kind: 'set-retry-enabled'; readonly enabled: boolean }
  )[] = []

  setStatusText(text: string): void {
    this.operations.push({ kind: 'set-status-text', text })
  }

  showNotice(text: string): void {
    this.operations.push({ kind: 'show-notice', text })
  }

  setRepairEntries(
    entries: Parameters<SyncRuntimeObsidianShellUiPort['setRepairEntries']>[0],
  ): void {
    this.operations.push({ kind: 'set-repair-entries', entries })
  }

  setRetryEnabled(enabled: boolean): void {
    this.operations.push({ kind: 'set-retry-enabled', enabled })
  }
}
