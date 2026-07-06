import { DEFAULT_LOCAL_STORE_OBJECT_STORES, type ClientStartupLocalState } from '@kuroflare/core'
import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  type SyncRuntimeLocalStoreEffectPort,
  type SyncRuntimeLocalStoreRebuildEffectPort,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import { createSyncRuntimeObsidianComposition } from '../obsidian/composition'
import { type SyncRuntimeObsidianResumePort } from '../obsidian/lifecycle'
import { type SyncRuntimeObsidianShellUiPort } from '../obsidian/ui'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from '../store/schema'

const vaultId = makeVaultId('composition-vault-1')
const deviceId = makeDeviceId('composition-device-1')

const activeLocalState = {
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

test('Obsidian runtime composition wires startup evidence through the lifecycle', async () => {
  const ui = new RecordingUiPort()
  const startupStep = new RecordingStartupStepPort()
  const composition = createSyncRuntimeObsidianComposition({
    settings: {
      async readSettings() {
        return {}
      },
    },
    local: {
      async readLocalEvidence() {
        return {
          metadataSnapshot: {
            ok: true,
            snapshot: {
              setup: {
                endpoint: 'https://sync.example.test',
                vaultId,
                deviceId,
                yClientId: 1,
                protocolVersion: 1,
                bootstrapMode: 'join-existing',
                tokenVersion: 1,
              },
              auth: {
                deviceId,
                tokenVersion: 1,
                authState: 'active',
                accessTokenSecretKey: 'kuroflare/access',
                refreshTokenSecretKey: 'kuroflare/refresh',
                accessTokenExpiresAt: 10_000,
                refreshState: 'idle',
                retryCount: 0,
              },
            },
          },
          localStoreEvidence: {
            ok: true,
            evidence: {
              dbExists: true,
              currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
              presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
              pendingOutboxCount: activeLocalState.pendingOutboxCount,
            },
          },
          hasMetaYDoc: activeLocalState.hasMetaYDoc,
          hasLocalVaultFiles: activeLocalState.hasLocalVaultFiles,
        }
      },
    },
    ui,
    setupExchange: new NoopSetupExchangePort(),
    localStore: new NoopLocalStoreEffectPort(),
    localStoreRebuild: new NoopLocalStoreRebuildEffectPort(),
    startupStep,
    resume: new NoopResumePort(),
  })

  const result = await composition.lifecycle.runStartupTick()

  assert.equal(result.driver.executedStartupStepCount, startupStep.effects.length)
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
  assert.equal(ui.statusTexts.at(-1), 'Kuroflare: starting / queues running')
})

class RecordingStartupStepPort implements SyncRuntimeStartupStepEffectPort {
  readonly effects: Parameters<SyncRuntimeStartupStepEffectPort['run']>[0][] = []

  async run(effect: Parameters<SyncRuntimeStartupStepEffectPort['run']>[0]): Promise<void> {
    this.effects.push(effect)
  }
}

class NoopLocalStoreEffectPort implements SyncRuntimeLocalStoreEffectPort {
  async runOpenEffect(): Promise<void> {}
}

class NoopSetupExchangePort implements SyncRuntimeSetupExchangePort {
  async run(): Promise<never> {
    throw new Error('setup-exchange-should-not-run')
  }

  snapshot(): ReturnType<SyncRuntimeSetupExchangePort['snapshot']> {
    return { completed: [] }
  }
}

class NoopLocalStoreRebuildEffectPort implements SyncRuntimeLocalStoreRebuildEffectPort {
  async rerunStartup(): Promise<void> {}
}

class NoopResumePort implements SyncRuntimeObsidianResumePort {
  canResume(): boolean {
    return true
  }

  async runForegroundResume(): Promise<void> {}

  scheduleOutboxTick(): void {}
}

class RecordingUiPort implements SyncRuntimeObsidianShellUiPort {
  readonly statusTexts: string[] = []
  readonly notices: string[] = []

  setStatusText(text: string): void {
    this.statusTexts.push(text)
  }

  showNotice(text: string): void {
    this.notices.push(text)
  }

  setRepairEntries(): void {}

  setRetryEnabled(): void {}
}
