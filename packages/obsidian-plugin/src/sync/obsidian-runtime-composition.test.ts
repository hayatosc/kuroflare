import assert from 'node:assert/strict'

import { DEFAULT_LOCAL_STORE_OBJECT_STORES, type ClientStartupLocalState } from '@kuroflare/core'
import { makeDeviceId, makeVaultId } from '@kuroflare/protocol'
import { test } from 'vitest'

import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from './local-store-schema.js'
import { createSyncRuntimeObsidianComposition } from './obsidian-runtime-composition.js'
import { type SyncRuntimeObsidianShellUiPort } from './obsidian-shell-ui.js'
import {
  type SyncRuntimeLocalStoreEffectPort,
  type SyncRuntimeStartupStepEffectPort,
} from './startup-actuation.js'

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
    localStore: new NoopLocalStoreEffectPort(),
    startupStep,
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

test('Obsidian runtime composition fails fast for unwired startup ports', async () => {
  const ui = new RecordingUiPort()
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
              pendingOutboxCount: 0,
            },
          },
          hasMetaYDoc: true,
          hasLocalVaultFiles: true,
        }
      },
    },
    ui,
  })

  const result = await composition.lifecycle.runStartupTick()

  assert.equal(result.driver.executedStartupStepCount, 0)
  assert.equal(result.driver.state.shell.status, 'rejected')
  assert.equal(result.driver.state.shell.statusReason, 'startup-step-failed')
  assert.equal(ui.statusTexts.at(-1), 'Kuroflare: rejected / queues stopped (rejected)')
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
