import assert from 'node:assert/strict'

import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  type ClientStartupLocalState,
  type ClientStartupStep,
} from '@kuroflare/core'
import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/protocol'
import { test } from 'vitest'

import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from './local-store-schema.js'
import { type SyncRuntimeObsidianShellEvidenceReadResult } from './obsidian-shell-driver.js'
import { createSyncRuntimeObsidianShellLifecycle } from './obsidian-shell-lifecycle.js'
import { type SyncRuntimeObsidianShellUiPort } from './obsidian-shell-ui.js'
import {
  createSyncRuntimeSetupExchangePort,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeStartupStepEffect,
  type SyncRuntimeStartupStepEffectPort,
} from './startup-actuation.js'
import {
  type SyncRuntimeStartupEffect,
  type SyncRuntimeStartupFromSchemaEvidenceInput,
} from './startup-runtime.js'

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
  yClientId: 1,
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
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      return setupResponse
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, ui },
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
  const ui = new RecordingObsidianShellUiPort()
  const setupExchange = createSyncRuntimeSetupExchangePort({
    async exchange() {
      throw new Error('setup-exchange-should-not-run')
    },
    async scheduleReplan() {},
  })
  const lifecycle = createSyncRuntimeObsidianShellLifecycle({
    ports: { evidence, executor, setupExchange, startupStep, ui },
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
