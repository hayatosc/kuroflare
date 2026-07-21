import type { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  decodeMetaValue,
  groupedEntryFromMetaFile,
  type MetaFile,
  type MetaGroupedEntry,
} from '@kuroflare/core'
import * as v from 'valibot'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { LocalAwareness } from '../editor/awareness'
import { createYTextEditorExtension, dispatchFullDocumentReplace } from '../editor/editor-binding'
import {
  classifyDocumentEpoch,
  createReadyDocumentEpoch,
  documentEpochMetadataKey,
  isDocumentEpochRecord,
  probeIndexedDbProvider,
  type DocumentEpochRecord,
} from '../recovery/epoch'
import type { FileDocId, LoadedTextDoc, TextDocumentOwner } from '../types'
import { DISK_ORIGIN, REMOTE_ORIGIN, WORKER_ORIGIN, SPIKE_TEXT_NAME } from './constants'
import { filePersistenceDatabaseName, legacyFilePersistenceDatabaseName } from './guards'
import {
  waitForIndexedDbDeleteDatabase,
  waitForIndexedDbRequest,
  waitForIndexedDbTransaction,
} from './helpers'
import type KuroflareSpikePlugin from './plugin'
import { sendDocUpdateToWorker } from './socket'

export function metaMap(plugin: Pick<KuroflareSpikePlugin, 'metaDoc'>): Y.Map<unknown> {
  return plugin.metaDoc.getMap<unknown>('meta')
}

export type MetaGroupName = 'identity' | 'location' | 'content' | 'deletion'

export function readMetaFile(metaMap: Y.Map<unknown>, fileId: string): MetaFile | undefined {
  return decodeMetaValue(metaMap.get(fileId), fileId).metaFile
}

export function readMetaEntries(metaMap: Y.Map<unknown>): readonly MetaFile[] {
  const entries: MetaFile[] = []
  for (const [fileId, value] of metaMap.entries()) {
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.metaFile !== undefined) entries.push(decoded.metaFile)
  }
  return entries
}

/** Local metadata writes are safe only when every root value is grouped v2. */
export function metaDocWritable(doc: Y.Doc): boolean {
  if (hasUnresolvedYjsState(doc)) return false
  const root = doc.getMap<unknown>('meta')
  for (const [fileId, value] of root.entries()) {
    if (decodeMetaValue(value, fileId).disposition !== 'supported-v2') return false
  }
  return true
}

/** Returns true when Yjs retained pending structs or delete ranges beyond its state vector. */
function hasUnresolvedYjsState(doc: Y.Doc): boolean {
  try {
    const stateVector = Y.encodeStateVector(doc)
    const state = Y.decodeStateVector(stateVector)
    const remainder = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, stateVector))
    if (remainder.structs.length > 0) return true
    for (const [clientId, ranges] of remainder.ds.clients) {
      const coveredClock = state.get(clientId) ?? 0
      for (const range of ranges) {
        if (coveredClock < range.clock + range.len) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** Combines negotiated server access with the local grouped-document invariant. */
export function metadataWritesEnabled(input: {
  readonly metadataAccess?: 'read-only' | 'read-write'
  readonly metaDoc: Y.Doc
}): boolean {
  return input.metadataAccess !== 'read-only' && metaDocWritable(input.metaDoc)
}

export function metaDocLegacyOnly(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>('meta')
  if (root.size === 0) return false
  for (const [fileId, value] of root.entries()) {
    if (decodeMetaValue(value, fileId).disposition !== 'legacy-v1') return false
  }
  return true
}

/** Returns true when a legacy v1 tombstone requires read-only/manual recovery. */
export function hasLegacyDeletedTombstones(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>('meta')
  for (const [fileId, value] of root.entries()) {
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.disposition === 'legacy-v1' && decoded.metaFile?.deleted === true) {
      return true
    }
  }
  return false
}

/** Allows remote-v2 adoption only when every local normalized entry is represented unchanged. */
export function metaDocEntriesRepresented(local: Y.Doc, remote: Y.Doc): boolean {
  const localRoot = local.getMap<unknown>('meta')
  const remoteRoot = remote.getMap<unknown>('meta')
  for (const [fileId, value] of localRoot.entries()) {
    const localEntry = decodeMetaValue(value, fileId).metaFile
    const remoteEntry = decodeMetaValue(remoteRoot.get(fileId), fileId).metaFile
    if (
      localEntry === undefined ||
      remoteEntry === undefined ||
      stableMetaFileJson(localEntry) !== stableMetaFileJson(remoteEntry)
    ) {
      return false
    }
  }
  return true
}

/** Remote v2 adoption is safe only for a non-empty grouped document that preserves local entries. */
export function shouldAdoptRemoteMetadata(local: Y.Doc, remote: Y.Doc): boolean {
  return (
    remote.getMap<unknown>('meta').size > 0 &&
    metaDocWritable(remote) &&
    metaDocEntriesRepresented(local, remote)
  )
}

function stableMetaFileJson(value: MetaFile): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  )
}

/** Returns whether an inbound metadata state needs the deferred v1 CAS migration. */
export function shouldPrepareMetadataMigration(input: {
  readonly metadataAccess: 'read-only' | 'read-write'
  readonly migrationPending: boolean
  readonly metaDoc: Y.Doc
}): boolean {
  return (
    input.metadataAccess === 'read-write' &&
    input.migrationPending &&
    input.metaDoc.getMap<unknown>('meta').size > 0 &&
    !metaDocWritable(input.metaDoc)
  )
}

function isNestedMetaMap(value: unknown): value is Y.Map<unknown> {
  return value instanceof Y.Map
}

/** Inserts one new grouped entry. A child map is integrated exactly once. */
export function insertMetaFile(metaMap: Y.Map<unknown>, value: MetaFile): void {
  const grouped = groupedEntryFromMetaFile(value)
  const child = new Y.Map<unknown>()
  child.set('identity', grouped.identity)
  child.set('location', grouped.location)
  child.set('content', grouped.content)
  child.set('deletion', grouped.deletion)
  metaMap.set(value.fileId, child)
}

/** Updates only changed grouped children, preserving concurrent writes to other groups. */
export function updateMetaFile(metaMap: Y.Map<unknown>, value: MetaFile): boolean {
  const child = metaMap.get(value.fileId)
  if (!isNestedMetaMap(child)) return false
  const current = decodeMetaValue(child, value.fileId).grouped
  if (current === undefined) return false
  const next = groupedEntryFromMetaFile(value)
  if (JSON.stringify(current.identity) !== JSON.stringify(next.identity)) return false
  for (const group of ['location', 'content', 'deletion'] as const) {
    if (JSON.stringify(current[group]) !== JSON.stringify(next[group])) {
      child.set(group, next[group])
    }
  }
  return true
}

export function updateMetaGroup(
  metaMap: Y.Map<unknown>,
  fileId: string,
  group: MetaGroupName,
  value: MetaGroupedEntry[MetaGroupName],
): boolean {
  const child = metaMap.get(fileId)
  if (!isNestedMetaMap(child)) return false
  child.set(group, value)
  return true
}

/** Migrates a local all-v1 document before any metadata network write is emitted. */
export function migrateLegacyMetaDoc(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>('meta')
  if (root.size === 0) return true
  const entries: Array<[string, MetaFile]> = []
  for (const [fileId, value] of root.entries()) {
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.disposition !== 'legacy-v1' || decoded.metaFile === undefined) return false
    if (decoded.metaFile.deleted) return false
    entries.push([fileId, decoded.metaFile])
  }
  doc.transact(() => {
    for (const [fileId, value] of entries) {
      if (root.has(fileId)) root.delete(fileId)
      insertMetaFile(root, value)
    }
  }, 'metadata-schema-v2-migration')
  return true
}

/** Minimal plugin surface required to activate a loaded text Y.Doc in the editor. */
export interface ActiveTextDocPlugin {
  activeTextDoc: LoadedTextDoc | null
  ydoc: Y.Doc
  ytext: Y.Text
  readonly awareness: LocalAwareness
  readonly activeView: EditorView | null
  readonly cmCompartment: Compartment
  readonly yCollabBoundViews: WeakSet<EditorView>
}

export async function loadTextDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
): Promise<LoadedTextDoc> {
  const owner = plugin.captureTextDocumentOwner()
  if (owner === undefined) throw new Error('text-document-vault-context-unavailable')
  const existing = plugin.loadedTextDocs.get(docId.ydocId)
  if (existing !== undefined && plugin.loadedTextDocStillCurrent(existing, owner)) {
    return existing
  }
  const loadKey = `${owner.vaultId}:${docId.ydocId}`
  const inFlight = plugin.loadingTextDocs.get(loadKey)
  if (inFlight !== undefined) return inFlight

  const loading = loadTextDocForOwner(plugin, docId, owner)
  plugin.loadingTextDocs.set(loadKey, loading)
  try {
    return await loading
  } finally {
    if (plugin.loadingTextDocs.get(loadKey) === loading) plugin.loadingTextDocs.delete(loadKey)
  }
}

async function loadTextDocForOwner(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
  owner: TextDocumentOwner,
): Promise<LoadedTextDoc> {
  const doc = new Y.Doc()
  const text = doc.getText(SPIKE_TEXT_NAME)
  const loaded: LoadedTextDoc = {
    docId,
    vaultId: owner.vaultId,
    vaultGeneration: owner.generation,
    doc,
    text,
    persistence: null,
  }
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === DISK_ORIGIN || origin === REMOTE_ORIGIN || origin === WORKER_ORIGIN) return
    if (!plugin.loadedTextDocStillCurrent(loaded, owner)) return
    void sendDocUpdateToWorker(plugin, docId, update, 'local-update', () =>
      plugin.loadedTextDocStillCurrent(loaded, owner),
    )
  })
  const providerDbName = filePersistenceDatabaseName(owner.vaultId, docId.ydocId)
  try {
    await migrateLegacyFilePersistence(plugin, docId, owner, providerDbName)
    assertTextDocumentOwner(plugin, owner)
    const epoch = await prepareDocumentProvider(plugin, docId, providerDbName)
    assertTextDocumentOwner(plugin, owner)
    const persistence = new IndexeddbPersistence(providerDbName, doc)
    loaded.persistence = persistence
    await persistence.whenSynced
    assertTextDocumentOwner(plugin, owner)
    plugin.loadedTextDocs.set(docId.ydocId, loaded)
    if (epoch === undefined) await establishInitialDocumentEpoch(plugin, docId, providerDbName)
    assertTextDocumentOwner(plugin, owner)
    return loaded
  } catch (error: unknown) {
    if (plugin.loadedTextDocs.get(docId.ydocId) === loaded) {
      plugin.loadedTextDocs.delete(docId.ydocId)
    }
    await loaded.persistence?.destroy()
    doc.destroy()
    throw error
  }
}

function assertTextDocumentOwner(plugin: KuroflareSpikePlugin, owner: TextDocumentOwner): void {
  if (!plugin.textDocumentOwnerStillCurrent(owner)) {
    throw new Error('text-document-vault-context-stale')
  }
}

async function migrateLegacyFilePersistence(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
  owner: TextDocumentOwner,
  providerDbName: string,
): Promise<void> {
  const scoped = await probeIndexedDbProvider(indexedDB, providerDbName)
  assertTextDocumentOwner(plugin, owner)
  if (!scoped.ok) throw new Error(`file-provider-probe-failed:${scoped.reason}`)
  if (scoped.status === 'present') return
  const legacyName = legacyFilePersistenceDatabaseName(docId.ydocId)
  const legacy = await probeIndexedDbProvider(indexedDB, legacyName)
  assertTextDocumentOwner(plugin, owner)
  if (!legacy.ok) throw new Error(`legacy-file-provider-probe-failed:${legacy.reason}`)
  if (legacy.status !== 'present') return

  const localStore = plugin.localStoreDb
  const evidence =
    localStore === null ? undefined : await readDocumentEpochEvidence(localStore, docId)
  assertTextDocumentOwner(plugin, owner)
  const legacyEpoch = evidence?.epoch
  if (!legacyFilePersistenceMigrationIsOwned(legacyEpoch, docId, legacyName)) {
    // The old database name carries no vault identity. Leave it untouched and let
    // vault-scoped local-store/remote recovery establish the new provider safely.
    console.warn('[kuroflare] ignored unowned legacy file persistence', {
      vaultId: owner.vaultId,
      ydocId: docId.ydocId,
    })
    return
  }

  const migrationDoc = new Y.Doc()
  const legacyPersistence = new IndexeddbPersistence(legacyName, migrationDoc)
  let scopedPersistence: IndexeddbPersistence | null = null
  let scopedDoc: Y.Doc | null = null
  try {
    await legacyPersistence.whenSynced
    assertTextDocumentOwner(plugin, owner)
    scopedDoc = new Y.Doc()
    Y.applyUpdate(scopedDoc, Y.encodeStateAsUpdate(migrationDoc), WORKER_ORIGIN)
    scopedPersistence = new IndexeddbPersistence(providerDbName, scopedDoc)
    await scopedPersistence.whenSynced
    assertTextDocumentOwner(plugin, owner)
    if (localStore === null) throw new Error('legacy-file-provider-owner-store-unavailable')
    const transaction = localStore.transaction(['metadata'], 'readwrite')
    await waitForIndexedDbRequest(
      transaction
        .objectStore('metadata')
        .put(
          { ...legacyEpoch, providerDbName, updatedAt: Date.now() },
          documentEpochMetadataKey(docId),
        ),
    )
    await waitForIndexedDbTransaction(transaction)
    assertTextDocumentOwner(plugin, owner)
  } catch (error: unknown) {
    await scopedPersistence?.destroy()
    scopedPersistence = null
    await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(providerDbName))
    throw error
  } finally {
    await scopedPersistence?.destroy()
    scopedDoc?.destroy()
    migrationDoc.destroy()
  }
}

/** Allows legacy provider adoption only when this vault's durable epoch claims it exactly. */
export function legacyFilePersistenceMigrationIsOwned(
  epoch: DocumentEpochRecord | undefined,
  docId: FileDocId,
  legacyName: string,
): epoch is DocumentEpochRecord {
  return (
    epoch?.status === 'ready' &&
    epoch.providerDbName === legacyName &&
    epoch.docId.kind === 'file' &&
    epoch.docId.ydocId === docId.ydocId
  )
}

/** Inspects provider/local evidence before y-indexeddb is allowed to open. */
export async function prepareDocumentProvider(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId | { readonly kind: 'meta' },
  providerDbName: string,
): Promise<DocumentEpochRecord | undefined> {
  const provider = await probeIndexedDbProvider(indexedDB, providerDbName)
  const localStore = plugin.localStoreDb
  const evidence =
    localStore === null
      ? { epoch: undefined, malformedEpoch: false, hasLocalYDoc: false, hasPendingOutbox: false }
      : await readDocumentEpochEvidence(localStore, docId)
  if (evidence.malformedEpoch) {
    plugin.documentRecoveryRequired.add(documentEpochMetadataKey(docId))
    plugin.startupSideEffectGate.setPermission('blocked')
    throw new Error(`document-epoch-evidence-malformed:${documentEpochMetadataKey(docId)}`)
  }
  const classification = classifyDocumentEpoch({
    provider,
    epoch: evidence.epoch,
    hasLocalYDoc: evidence.hasLocalYDoc,
    hasPendingOutbox: evidence.hasPendingOutbox,
  })
  if (classification.action === 'blocked' || classification.action === 'recover') {
    const epochKey = documentEpochMetadataKey(docId)
    if (
      plugin.documentRecoveryHydrating.has(epochKey) ||
      plugin.documentReplacementInProgress.has(epochKey)
    ) {
      return evidence.epoch
    }
    plugin.documentRecoveryRequired.add(documentEpochMetadataKey(docId))
    plugin.startupSideEffectGate.setPermission('blocked')
    throw new Error(`document-provider-recovery-required:${documentEpochMetadataKey(docId)}`)
  }
  return evidence.epoch
}

/** Persists the first ready epoch only after provider synchronization has completed. */
export async function establishInitialDocumentEpoch(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId | { readonly kind: 'meta' },
  providerDbName: string,
): Promise<void> {
  const db = plugin.localStoreDb
  if (db === null) return
  const epoch = createReadyDocumentEpoch({ docId, providerDbName, now: Date.now() })
  const transaction = db.transaction(['metadata'], 'readwrite')
  await waitForIndexedDbRequest(
    transaction.objectStore('metadata').put(epoch, documentEpochMetadataKey(docId)),
  )
  await waitForIndexedDbTransaction(transaction)
}

async function readDocumentEpochEvidence(
  db: IDBDatabase,
  docId: FileDocId | { readonly kind: 'meta' },
): Promise<{
  readonly epoch: DocumentEpochRecord | undefined
  readonly malformedEpoch: boolean
  readonly hasLocalYDoc: boolean
  readonly hasPendingOutbox: boolean
}> {
  const transaction = db.transaction(
    ['metadata', docId.kind === 'meta' ? 'meta-ydoc' : 'file-ydocs', 'outbox'],
    'readonly',
  )
  const epochRequest = transaction.objectStore('metadata').get(documentEpochMetadataKey(docId))
  const ydocRequest = transaction
    .objectStore(docId.kind === 'meta' ? 'meta-ydoc' : 'file-ydocs')
    .get(docId.kind === 'meta' ? 'meta' : docId.ydocId)
  const outboxRequest = transaction.objectStore('outbox').getAll()
  const [epochValue, ydocValue, outboxValues] = await Promise.all([
    waitForIndexedDbRequest(epochRequest),
    waitForIndexedDbRequest(ydocRequest),
    waitForIndexedDbRequest(outboxRequest),
  ])
  await waitForIndexedDbTransaction(transaction)
  const epoch = isDocumentEpochRecord(epochValue) ? epochValue : undefined
  const PendingOutboxRowSchema = v.object({
    docId: v.object({
      kind: v.picklist(['meta', 'file']),
      ydocId: v.optional(v.string()),
    }),
    status: v.picklist(['pending', 'retrying', 'paused']),
  })
  const hasPendingOutbox =
    Array.isArray(outboxValues) &&
    outboxValues.some((value) => {
      if (!v.is(PendingOutboxRowSchema, value)) return false
      if (value.docId.kind !== docId.kind) return false
      if (docId.kind === 'meta') return true
      return value.docId.ydocId === docId.ydocId
    })
  return {
    epoch,
    malformedEpoch: epochValue !== undefined && !isDocumentEpochRecord(epochValue),
    hasLocalYDoc: ydocValue !== undefined,
    hasPendingOutbox,
  }
}

export async function replaceTextDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
  updateBytes: Uint8Array,
  origin: unknown,
): Promise<LoadedTextDoc> {
  const owner = plugin.captureTextDocumentOwner()
  if (owner === undefined) throw new Error('text-document-vault-context-unavailable')
  const existing = plugin.loadedTextDocs.get(docId.ydocId)
  const epochKey = documentEpochMetadataKey(docId)
  const ownsReplacementMarker = !plugin.documentReplacementInProgress.has(epochKey)
  plugin.documentReplacementInProgress.add(epochKey)
  try {
    if (existing !== undefined) {
      await existing.persistence?.clearData()
      await waitForIndexedDbDeleteDatabase(
        indexedDB.deleteDatabase(filePersistenceDatabaseName(owner.vaultId, docId.ydocId)),
      )
      existing.doc.destroy()
      plugin.loadedTextDocs.delete(docId.ydocId)
      if (plugin.activeTextDoc === existing) {
        plugin.activeTextDoc = null
      }
    }
    assertTextDocumentOwner(plugin, owner)
    const loaded = await loadTextDoc(plugin, docId)
    assertTextDocumentOwner(plugin, owner)
    Y.applyUpdate(loaded.doc, updateBytes, origin)
    return loaded
  } finally {
    if (ownsReplacementMarker) plugin.documentReplacementInProgress.delete(epochKey)
  }
}

export function setActiveTextDoc(plugin: ActiveTextDocPlugin, loaded: LoadedTextDoc): void {
  plugin.activeTextDoc = loaded
  plugin.ydoc = loaded.doc
  plugin.ytext = loaded.text
}

/** Activates a replacement text document and rebinds the current CodeMirror view to it. */
export function activateLoadedTextDoc(plugin: ActiveTextDocPlugin, loaded: LoadedTextDoc): void {
  setActiveTextDoc(plugin, loaded)
  const editorView = plugin.activeView
  if (editorView === null) return

  if (plugin.yCollabBoundViews.has(editorView)) {
    editorView.dispatch({ effects: plugin.cmCompartment.reconfigure([]) })
    plugin.yCollabBoundViews.delete(editorView)
  }
  const replacementText = loaded.text.toJSON()
  if (editorView.state.doc.toString() !== replacementText) {
    dispatchFullDocumentReplace(editorView, replacementText)
  }
  editorView.dispatch({
    effects: plugin.cmCompartment.reconfigure(
      createYTextEditorExtension(loaded.text, plugin.awareness),
    ),
  })
  plugin.yCollabBoundViews.add(editorView)
}

/** Creates an empty in-memory meta document when switching persisted vault namespaces. */
export function createFreshMetaDocForVaultSwitch(previous: Y.Doc): Y.Doc {
  previous.destroy()
  return new Y.Doc()
}
