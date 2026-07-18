// @vitest-environment jsdom

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  hashCanonicalText,
  makeDeviceId,
  makeFileId,
  makeYDocId,
  type MetaFile,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { LocalAwareness } from '../editor/awareness'
import type { LoadedTextDoc } from '../main-types'
import { createReadyDocumentEpoch, documentEpochMetadataKey } from '../recovery/epoch'
import { flushYTextToDisk } from './editor'
import {
  activateLoadedTextDoc,
  createFreshMetaDocForVaultSwitch,
  hasLegacyDeletedTombstones,
  migrateLegacyMetaDoc,
  insertMetaFile,
  metaDocWritable,
  metaDocEntriesRepresented,
  prepareDocumentProvider,
  shouldAdoptRemoteMetadata,
  shouldPrepareMetadataMigration,
} from './meta'
import type KuroflareSpikePlugin from './plugin'

function createEvidenceReadDatabase(epoch: unknown): IDBDatabase {
  const metadata = new Map([[documentEpochMetadataKey({ kind: 'meta' }), epoch]])
  const requestFor = (result: unknown): IDBRequest<unknown> => {
    const request: { result: unknown; onsuccess: (() => void) | null; onerror: null } = {
      result,
      onsuccess: null,
      onerror: null,
    }
    queueMicrotask(() => request.onsuccess?.())
    return v.parse(
      v.custom<IDBRequest<unknown>>((v) => typeof v === 'object' && v !== null),
      request,
    )
  }
  const database = {
    transaction: () => {
      const transaction = {
        objectStore: (name: string) => ({
          get: (key: string) =>
            requestFor(
              name === 'metadata'
                ? metadata.get(key)
                : name === 'meta-ydoc'
                  ? { docId: { kind: 'meta' }, updateBytes: new Uint8Array() }
                  : undefined,
            ),
          getAll: () => requestFor([]),
        }),
        oncomplete: null as (() => void) | null,
        onabort: null,
        onerror: null,
      }
      setTimeout(() => transaction.oncomplete?.(), 0)
      return transaction
    },
  }
  return v.parse(
    v.custom<IDBDatabase>((v) => typeof v === 'object' && v !== null),
    database,
  )
}

test('active full-snapshot replacement rebinds editor, active doc, and disk to remote text', async () => {
  const compartment = new Compartment()
  const editorView = new EditorView({
    state: EditorState.create({
      doc: 'local',
      extensions: [compartment.of([])],
    }),
    parent: document.body,
  })

  const oldDoc = new Y.Doc()
  const oldText = oldDoc.getText('content')
  oldText.insert(0, 'local')
  const oldLoaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId: 'file-snapshot-replacement' },
    doc: oldDoc,
    text: oldText,
    persistence: null,
  }

  const remoteDoc = new Y.Doc()
  const remoteText = remoteDoc.getText('content')
  remoteText.insert(0, 'remote')
  const remoteLoaded: LoadedTextDoc = {
    docId: oldLoaded.docId,
    doc: remoteDoc,
    text: remoteText,
    persistence: null,
  }

  let diskText = 'local'
  const localHash = await hashCanonicalText(diskText)
  const plugin = {
    activeTextDoc: oldLoaded,
    ydoc: oldDoc,
    ytext: oldText,
    awareness: new LocalAwareness(),
    activeView: editorView,
    cmCompartment: compartment,
    yCollabBoundViews: new WeakSet<EditorView>([editorView]),
    activeFile: {
      path: 'note.md',
      basename: 'note',
      extension: 'md',
      parent: null,
    },
    lastMaterialized: new Map([
      [
        'note.md',
        {
          diskHash: localHash,
          ydocHash: localHash,
          path: 'note.md',
          writtenAt: 1,
        },
      ],
    ]),
    startupSideEffectGate: { canRun: () => true },
    app: {
      vault: {
        read: async () => diskText,
        modify: async (_file: unknown, text: string) => {
          diskText = text
        },
        create: async () => undefined,
        getAbstractFileByPath: () => null,
        adapter: { exists: async () => false },
      },
    },
  }

  activateLoadedTextDoc(plugin, remoteLoaded)
  assert.equal(plugin.activeTextDoc, remoteLoaded)
  assert.equal(plugin.ydoc, remoteDoc)
  assert.equal(plugin.ytext, remoteText)
  assert.equal(editorView.state.doc.toString(), 'remote')

  await flushYTextToDisk(plugin, 'full-snapshot-test')
  assert.equal(diskText, 'remote')

  editorView.destroy()
  oldDoc.destroy()
  remoteDoc.destroy()
})

test('intentional provider replacement bypasses loss recovery while reopening the provider', async () => {
  const docId = { kind: 'meta' } as const
  const providerDbName = 'kuroflare-meta:replacement'
  const epoch = createReadyDocumentEpoch({ docId, providerDbName, now: 1, epochId: 'epoch-1' })
  const plugin = {
    localStoreDb: createEvidenceReadDatabase(epoch),
    documentRecoveryHydrating: new Set<string>(),
    documentReplacementInProgress: new Set([documentEpochMetadataKey(docId)]),
    documentRecoveryRequired: new Set<string>(),
    startupSideEffectGate: { setPermission: vi.fn() },
  }
  vi.stubGlobal('indexedDB', { databases: async () => [] })
  try {
    const recoveredEpoch = await prepareDocumentProvider(
      v.parse(
        v.custom<KuroflareSpikePlugin>((v) => typeof v === 'object' && v !== null),
        plugin,
      ),
      docId,
      providerDbName,
    )
    assert.deepEqual(recoveredEpoch, epoch)
    assert.deepEqual(plugin.documentRecoveryRequired, new Set())
    plugin.documentReplacementInProgress.clear()
    try {
      await prepareDocumentProvider(
        v.parse(
          v.custom<KuroflareSpikePlugin>((v) => typeof v === 'object' && v !== null),
          plugin,
        ),
        docId,
        providerDbName,
      )
      throw new Error('expected provider-loss recovery to remain guarded')
    } catch (error: unknown) {
      assert.match(String(error), /document-provider-recovery-required/)
    }
  } finally {
    vi.unstubAllGlobals()
  }
})

test('deferred metadata migration starts after an empty hello receives legacy metadata', () => {
  const doc = new Y.Doc()
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: doc,
    }),
    false,
  )

  const fileId = makeFileId('deferred-migration')
  doc.getMap('meta').set(fileId, legacyText(fileId))
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: doc,
    }),
    true,
  )

  const grouped = new Y.Doc()
  insertMetaFile(grouped.getMap('meta'), legacyText(fileId))
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: grouped,
    }),
    false,
  )
  doc.destroy()
  grouped.destroy()
})

test('remote v2 adoption is rejected when local legacy metadata would be lost or changed', () => {
  const fileId = makeFileId('adoption-check')
  const local = new Y.Doc()
  local.getMap('meta').set(fileId, legacyText(fileId))

  const equivalent = new Y.Doc()
  insertMetaFile(equivalent.getMap('meta'), legacyText(fileId))
  assert.equal(metaDocEntriesRepresented(local, equivalent), true)

  const remoteOnly = new Y.Doc()
  insertMetaFile(remoteOnly.getMap('meta'), legacyText(fileId))
  const extraId = makeFileId('adoption-remote-only')
  insertMetaFile(remoteOnly.getMap('meta'), legacyText(extraId))
  assert.equal(metaDocEntriesRepresented(local, remoteOnly), true)

  const localOnly = new Y.Doc()
  assert.equal(metaDocEntriesRepresented(local, localOnly), false)
  assert.equal(shouldAdoptRemoteMetadata(local, localOnly), false)
  assert.equal(shouldAdoptRemoteMetadata(local, equivalent), true)

  const divergent = new Y.Doc()
  const changed = legacyText(fileId)
  changed.path = 'Notes/Changed.md'
  changed.canonicalPath = 'notes/changed.md'
  insertMetaFile(divergent.getMap('meta'), changed)
  assert.equal(metaDocEntriesRepresented(local, divergent), false)

  local.destroy()
  equivalent.destroy()
  remoteOnly.destroy()
  localOnly.destroy()
  divergent.destroy()
})

test('metadata writes fail closed for pending persisted Yjs structs', () => {
  const parent = new Y.Doc()
  parent.getMap('root').set('child', new Y.Map<unknown>())
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const child = client.getMap<Y.Map<unknown>>('root').get('child')
  assert.ok(child instanceof Y.Map)
  child.set('value', 'pending')
  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent)))
  assert.equal(metaDocWritable(poisoned), false)

  const tombstone = new Y.Doc()
  const map = tombstone.getMap('meta')
  const tombstoneId = makeFileId('tombstone')
  map.set(tombstoneId, { value: 'deleted' })
  map.delete(tombstoneId)
  assert.equal(metaDocWritable(tombstone), true)
  poisoned.destroy()
  tombstone.destroy()
  client.destroy()
  parent.destroy()
})

test('legacy deleted tombstones are detected for read-only manual recovery', () => {
  const doc = new Y.Doc()
  const fileId = makeFileId('legacy-deleted')
  const value = {
    ...legacyText(fileId),
    deleted: true as const,
    deletedAt: 2,
    deletedBy: makeDeviceId('legacy-deleter'),
  }
  doc.getMap('meta').set(fileId, value)

  assert.equal(hasLegacyDeletedTombstones(doc), true)
  doc.destroy()
})

test('legacy tombstone migration fails closed without replacing the v1 value', () => {
  const doc = new Y.Doc()
  const fileId = makeFileId('legacy-migration-tombstone')
  const value = {
    ...legacyText(fileId),
    deleted: true as const,
    deletedAt: 2,
    deletedBy: makeDeviceId('legacy-migration-deleter'),
  }
  doc.getMap('meta').set(fileId, value)

  assert.equal(migrateLegacyMetaDoc(doc), false)
  assert.deepEqual(doc.getMap('meta').get(fileId), value)
  doc.destroy()
})

test('legacy tombstones remain read-only even when a witness-shaped field is present', () => {
  for (const [suffix, deletedContentVersion] of [
    [
      'text-witness',
      {
        kind: 'text' as const,
        stateVectorBase64: 'AQ==',
        contentSha256: '0'.repeat(64),
      },
    ],
    [
      'wrong-kind-witness',
      {
        kind: 'binary' as const,
        blobManifestHash: '0'.repeat(64),
      },
    ],
  ] as const) {
    const doc = new Y.Doc()
    const fileId = makeFileId(`legacy-migration-${suffix}`)
    const value = {
      ...legacyText(fileId),
      deleted: true as const,
      deletedAt: 2,
      deletedBy: makeDeviceId('legacy-migration-deleter'),
      deletedContentVersion,
    }
    doc.getMap('meta').set(fileId, value)

    assert.equal(hasLegacyDeletedTombstones(doc), true)
    assert.equal(migrateLegacyMetaDoc(doc), false)
    assert.deepEqual(doc.getMap('meta').get(fileId), value)
    doc.destroy()
  }
})

function legacyText(fileId: string): MetaFile {
  const deviceId = makeDeviceId('deferred-device')
  return {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Deferred.md',
    canonicalPath: 'notes/deferred.md',
    type: 'text',
    ydocId: makeYDocId('deferred-doc'),
    deleted: false,
    createdAt: 1,
    createdBy: deviceId,
    contentUpdatedAt: 1,
    contentUpdatedBy: deviceId,
    updatedAt: 1,
    updatedBy: deviceId,
    mtime: 1,
  }
}

test('vault namespace switch starts with a fresh Y.Doc and no prior vault structs', () => {
  const vaultADoc = new Y.Doc()
  vaultADoc.getMap('meta').set('vault-a-file', { path: 'A.md' })

  const vaultBDoc = createFreshMetaDocForVaultSwitch(vaultADoc)

  assert.equal(vaultBDoc.getMap('meta').has('vault-a-file'), false)
  vaultBDoc.getMap('meta').set('vault-b-file', { path: 'B.md' })
  assert.equal(vaultBDoc.getMap('meta').has('vault-a-file'), false)
  assert.equal(vaultBDoc.getMap('meta').has('vault-b-file'), true)
  vaultBDoc.destroy()
})
