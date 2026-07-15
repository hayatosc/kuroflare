import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { handleVaultCreate } from './file-tree'
import { metaMap, readMetaEntries } from './meta'

test('concurrent vault create events recheck meta after async startup work', async () => {
  const plugin = {
    startupSideEffectGate: { canRun: () => true },
    metaDoc: new Y.Doc(),
    materializedPaths: new Map(),
    pendingFsRenames: new Set(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('create-race-vault'),
      deviceId: makeDeviceId('create-race-device'),
      yClientId: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    } as const,
    pendingSetupResponse: null,
    kuroflareSettings: { setupMetadata: undefined, setupVaultId: '' },
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
