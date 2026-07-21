// @vitest-environment jsdom

import { makeDeviceId, makeFileId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { TFile } from 'obsidian'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { applyFileCreate } from '../sync/meta/tree'
import type { LoadedTextDoc } from '../types'
import { handleVaultCreate, handleVaultDelete } from './files'
import { metaMap, readMetaEntries } from './meta'
import KuroflareSpikePlugin from './plugin'

vi.mock('obsidian', () => {
  class FakePlugin {}
  class FakePluginSettingTab {
    readonly containerEl = document.createElement('div')
    constructor(..._args: unknown[]) {}
  }
  class FakeSetting {
    constructor(..._args: unknown[]) {}
    setName(): this {
      return this
    }
    setDesc(): this {
      return this
    }
    addTextArea(): this {
      return this
    }
    addText(): this {
      return this
    }
    addButton(): this {
      return this
    }
  }
  class FakeNotice {
    constructor(..._args: unknown[]) {}
  }
  class FakeTFile {}
  class FakeTFolder {}
  class FakeMarkdownView {}
  class FakeModal {}
  return {
    MarkdownView: FakeMarkdownView,
    Modal: FakeModal,
    Notice: FakeNotice,
    Plugin: FakePlugin,
    PluginSettingTab: FakePluginSettingTab,
    Setting: FakeSetting,
    TFile: FakeTFile,
    TFolder: FakeTFolder,
  }
})

function createTestPlugin(): KuroflareSpikePlugin {
  const value: unknown = Object.create(KuroflareSpikePlugin.prototype)
  if (!(value instanceof KuroflareSpikePlugin)) {
    throw new Error('failed to create test plugin')
  }
  Object.assign(value, {
    materializedPathOwners: new Map(),
    loadingTextDocs: new Map(),
    metadataVaultGeneration: 0,
    metadataSetupStagingCount: 0,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
  })
  return value
}

test('concurrent vault create events recheck meta after async startup work', async () => {
  const plugin = {
    startupSideEffectGate: { canRun: () => true },
    metaDoc: new Y.Doc(),
    materializedPaths: new Map(),
    materializedPathOwners: new Map(),
    metadataVaultGeneration: 0,
    pendingFsRenames: new Set(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('create-race-vault'),
      deviceId: makeDeviceId('create-race-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    } as const,
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    activeFile: null,
    app: {
      workspace: { getActiveFile: () => null },
    },
  }
  const file = { path: 'note.md' }

  await Promise.all([handleVaultCreate(plugin, file), handleVaultCreate(plugin, file)])

  const entries = readMetaEntries(metaMap(plugin)).filter((value) => value.path === 'note.md')
  assert.equal(entries.length, 1)
  plugin.metaDoc.destroy()
})

test('vault delete drops stale evidence when the path is recreated while loading', async () => {
  vi.useFakeTimers()
  try {
    const metaDoc = new Y.Doc()
    const fileId = makeFileId('delete-recreated')
    const ydocId = makeYDocId('delete-recreated-doc')
    const deviceId = makeDeviceId('delete-recreated-device')
    applyFileCreate(metaMap({ metaDoc }), {
      fileId,
      path: 'note.md',
      ydocId,
      deviceId,
      now: 1,
    })
    const doc = new Y.Doc()
    const loaded: LoadedTextDoc = {
      docId: { kind: 'file', ydocId },
      vaultId: makeVaultId('delete-recreated-vault'),
      vaultGeneration: 0,
      doc,
      text: doc.getText('content'),
      persistence: null,
    }
    loaded.text.insert(0, 'original')
    let digestStartedResolve!: () => void
    let releaseDigestResolve!: () => void
    const digestStarted = new Promise<void>((resolve) => {
      digestStartedResolve = resolve
    })
    const releaseDigest = new Promise<void>((resolve) => {
      releaseDigestResolve = resolve
    })
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
        digestStartedResolve()
        await releaseDigest
        return originalDigest(...args)
      })
    let recreated: TFile | null = null
    const plugin = createTestPlugin()
    Object.assign(plugin, {
      startupSideEffectGate: { canRun: () => true, canSendNetwork: () => true },
      metaDoc,
      metadataAccess: 'read-write' as const,
      materializedPaths: new Map([[fileId, 'note.md']]),
      loadedTextDocs: new Map([[ydocId, loaded]]),
      trustedSetupMetadata: {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId('delete-recreated-vault'),
        deviceId,
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 1,
      } as const,
      pendingSetupResponse: null,
      kuroflareSettings: { setupVaultId: '' },
      app: {
        vault: {
          getAbstractFileByPath: () => recreated,
        },
      },
    })
    const pending = handleVaultDelete(plugin, Object.assign(new TFile(), { path: 'note.md' }))
    await digestStarted
    recreated = Object.assign(new TFile(), { path: 'note.md' })
    releaseDigestResolve()
    await pending

    const entry = readMetaEntries(metaMap(plugin))[0]
    assert(entry)
    assert.equal(entry.deleted, false)
    assert.equal(plugin.materializedPaths.get(fileId), 'note.md')
    digestSpy.mockRestore()
    doc.destroy()
    metaDoc.destroy()
  } finally {
    vi.useRealTimers()
  }
})
