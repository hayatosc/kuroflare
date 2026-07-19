import {
  canonicalizeTextForYText,
  decideJoinFileAdoption,
  hashCanonicalText,
  VaultRelativePathSchema,
} from '@kuroflare/core'
import { Notice, TFile, TFolder } from 'obsidian'
import * as v from 'valibot'
import * as Y from 'yjs'

import { replaceYText } from '../editor/editor-binding'
import type { MetadataReconcileWriteContext } from '../metadata/evidence'
import type { GenerationMarkerOwner, KuroflareRepairLogEntry, LoadedTextDoc } from '../types'
import { currentSetupMetadata, findActiveFileId, findMetaFileIdForDoc } from './auth'
import { DISK_ORIGIN } from './constants'
import { claimOwnedPathMarker, clearOwnedPathMarker } from './guards'
import { mergeRepairLogEntries, safeLogError } from './helpers'
import { metaMap, readMetaFile } from './meta'
import { metadataReconcileWriteContextStillStable } from './plugin'
import type KuroflareSpikePlugin from './plugin'
import { sendDocUpdateToWorker } from './socket'

export function resolvePendingRemoteTextFile(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
): Promise<void> {
  const operation = resolvePendingRemoteTextFileOperation(plugin, loaded)
  plugin.remoteTextMaterializationOperations.add(operation)
  void operation.then(
    () => plugin.remoteTextMaterializationOperations.delete(operation),
    () => plugin.remoteTextMaterializationOperations.delete(operation),
  )
  return operation
}

async function resolvePendingRemoteTextFileOperation(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
): Promise<void> {
  const context = captureMetadataMaterializationContext(plugin)
  if (context === undefined) return
  if (!loadedTextDocMatchesMetadataContext(plugin, loaded, context)) return
  const path = plugin.pendingRemoteTextFiles.get(loaded.docId.ydocId)
  if (path === undefined) return
  if (!metadataReconcileWriteContextStillStable(plugin, context)) return
  const markerOwner = claimOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    loaded.docId.ydocId,
    path,
    plugin.metadataVaultGeneration,
  )
  if (markerOwner === undefined) return
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }
  if (!v.is(VaultRelativePathSchema, path)) {
    await recordRemoteMaterializeBlocked(plugin, loaded, path, 'invalid-path', context)
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }
  const existing = plugin.app.vault.getAbstractFileByPath(path)
  if (existing instanceof TFile) {
    await resolveJoinAdoptionHashCheck(plugin, existing, loaded)
    return
  }
  if (existing !== null) {
    await recordRemoteMaterializeBlocked(plugin, loaded, path, 'path-collision', context)
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }
  const createdFolders: string[] = []
  const slash = path.lastIndexOf('/')
  if (slash !== -1) {
    const parts = path.slice(0, slash).split('/')
    let current = ''
    for (const part of parts) {
      current = current.length === 0 ? part : `${current}/${part}`
      if (plugin.app.vault.getAbstractFileByPath(current) === null) {
        if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
          clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
          return
        }
        try {
          await plugin.app.vault.createFolder(current)
          createdFolders.push(current)
          if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
            clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
            await cleanupRemoteMaterializeFolders(plugin, createdFolders)
            return
          }
        } catch {
          const existingFolder = plugin.app.vault.getAbstractFileByPath(current)
          if (!(existingFolder instanceof TFolder)) {
            await recordRemoteMaterializeBlocked(plugin, loaded, path, 'parent-collision', context)
            clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
            await cleanupRemoteMaterializeFolders(plugin, createdFolders)
            return
          }
          if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
            clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
            await cleanupRemoteMaterializeFolders(plugin, createdFolders)
            return
          }
        }
      } else if (!(plugin.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
        await recordRemoteMaterializeBlocked(plugin, loaded, path, 'parent-collision', context)
        clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
        return
      }
    }
  }
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    await cleanupRemoteMaterializeFolders(plugin, createdFolders)
    return
  }
  const content = loaded.text.toJSON()
  const contentHash = await hashCanonicalText(content)
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    await cleanupRemoteMaterializeFolders(plugin, createdFolders)
    return
  }
  let createdFile: TFile
  try {
    createdFile = await plugin.app.vault.create(path, content)
  } catch (error: unknown) {
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    try {
      await recordRemoteMaterializeBlocked(plugin, loaded, path, 'path-collision', context)
    } catch (repairError: unknown) {
      console.warn('[kuroflare] failed to record a remote materialization collision', {
        path,
        error: safeLogError(repairError),
      })
    }
    await cleanupRemoteMaterializeFolders(plugin, createdFolders)
    console.warn('[kuroflare] remote text materialization collided with a local file', {
      path,
      competingPathPresent: plugin.app.vault.getAbstractFileByPath(path) !== null,
      error: safeLogError(error),
    })
    return
  }
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, path, markerOwner, context)) {
    await compensateRemoteTextMaterialization(
      plugin,
      loaded,
      path,
      contentHash,
      createdFolders,
      createdFile,
      markerOwner,
      context,
    )
    return
  }
  plugin.lastMaterialized.set(path, {
    diskHash: contentHash,
    ydocHash: contentHash,
    path,
    writtenAt: Date.now(),
  })
  clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
}

async function cleanupRemoteMaterializeFolders(
  plugin: KuroflareSpikePlugin,
  paths: readonly string[],
): Promise<void> {
  for (const path of [...paths].reverse()) {
    const folder = plugin.app.vault.getAbstractFileByPath(path)
    if (!(folder instanceof TFolder) || folder.children.length !== 0) continue
    try {
      await plugin.app.vault.delete(folder)
    } catch (error: unknown) {
      console.warn('[kuroflare] failed to clean up an empty materialization folder', {
        path,
        error: safeLogError(error),
      })
    }
  }
}

async function compensateRemoteTextMaterialization(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
  path: string,
  expectedHash: string,
  createdFolders: readonly string[],
  createdFile: TFile,
  markerOwner: GenerationMarkerOwner,
  context: MetadataReconcileWriteContext,
): Promise<void> {
  const stillOwnsMarker = () =>
    plugin.pendingRemoteTextFiles.get(loaded.docId.ydocId) === path &&
    plugin.pendingRemoteTextFileOwners.get(loaded.docId.ydocId) === markerOwner
  if (!stillOwnsMarker() || plugin.app.vault.getAbstractFileByPath(path) !== createdFile) {
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }
  let actualHash: string
  try {
    actualHash = await hashCanonicalText(await plugin.app.vault.read(createdFile))
  } catch (error: unknown) {
    console.warn('[kuroflare] could not verify a raced remote text materialization', {
      path,
      error: safeLogError(error),
    })
    await recordRemoteMaterializeBlocked(plugin, loaded, path, 'path-collision', context)
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }

  if (
    !stillOwnsMarker() ||
    plugin.app.vault.getAbstractFileByPath(path) !== createdFile ||
    actualHash !== expectedHash
  ) {
    await recordRemoteMaterializeBlocked(plugin, loaded, path, 'path-collision', context)
    new Notice(
      `Kuroflare sync: preserved a raced local edit at ${path}; resolve the remote materialization repair manually.`,
    )
    clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
    return
  }

  plugin.pendingFsDeletes.add(path)
  try {
    await plugin.app.vault.delete(createdFile)
  } catch (error: unknown) {
    plugin.pendingFsDeletes.delete(path)
    console.warn('[kuroflare] failed to compensate a raced remote text materialization', {
      path,
      error: safeLogError(error),
    })
    await recordRemoteMaterializeBlocked(plugin, loaded, path, 'path-collision', context)
  } finally {
    plugin.pendingFsDeletes.delete(path)
  }
  clearPendingRemoteTextFile(plugin, loaded, path, markerOwner)
  await cleanupRemoteMaterializeFolders(plugin, createdFolders)
}

function clearPendingRemoteTextFile(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
  path: string,
  markerOwner: GenerationMarkerOwner,
): void {
  clearOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    loaded.docId.ydocId,
    path,
    markerOwner,
  )
}

function captureMetadataMaterializationContext(
  plugin: KuroflareSpikePlugin,
): MetadataReconcileWriteContext | undefined {
  if (plugin.metadataReconcileTransitionPending()) return undefined
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined || !plugin.startupSideEffectGate.canSendNetwork()) return undefined
  return {
    metaDoc: plugin.metaDoc,
    generation: plugin.metadataVaultGeneration,
    vaultId: setup.vaultId,
  }
}

function pendingRemoteTextMatchesMeta(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
  path: string,
  markerOwner: GenerationMarkerOwner,
  context: MetadataReconcileWriteContext,
): boolean {
  if (!metadataReconcileWriteContextStillStable(plugin, context)) return false
  if (!loadedTextDocMatchesMetadataContext(plugin, loaded, context)) return false
  if (plugin.pendingRemoteTextFileOwners.get(loaded.docId.ydocId) !== markerOwner) return false
  const fileId = findMetaFileIdForDoc(plugin, loaded.docId)
  if (fileId === undefined) return false
  const value = readMetaFile(metaMap(plugin), fileId)
  return (
    value !== undefined &&
    !value.deleted &&
    value.type === 'text' &&
    value.ydocId === loaded.docId.ydocId &&
    value.path === path
  )
}

function loadedTextDocMatchesMetadataContext(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
  context: MetadataReconcileWriteContext,
): boolean {
  if (context.vaultId === undefined) return false
  return plugin.loadedTextDocStillCurrent(loaded, {
    vaultId: context.vaultId,
    generation: context.generation,
  })
}

export async function resolveJoinAdoptionHashCheck(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  loaded: LoadedTextDoc,
): Promise<void> {
  const context = captureMetadataMaterializationContext(plugin)
  if (context === undefined) return
  if (!loadedTextDocMatchesMetadataContext(plugin, loaded, context)) return
  const markerPath = plugin.pendingRemoteTextFiles.get(loaded.docId.ydocId)
  if (markerPath === undefined) return
  if (!metadataReconcileWriteContextStillStable(plugin, context)) return
  const markerOwner = claimOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    loaded.docId.ydocId,
    markerPath,
    plugin.metadataVaultGeneration,
  )
  if (markerOwner === undefined) return
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) {
    clearPendingRemoteTextFile(plugin, loaded, markerPath, markerOwner)
    return
  }
  const fileId = findActiveFileId(plugin, file.path)
  if (fileId === undefined) {
    clearPendingRemoteTextFile(plugin, loaded, markerPath, markerOwner)
    return
  }

  const remoteContentHash = await hashCanonicalText(loaded.text.toJSON())
  const localContentHash = await hashCanonicalText(await plugin.app.vault.read(file))
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) {
    clearPendingRemoteTextFile(plugin, loaded, markerPath, markerOwner)
    return
  }
  const decision = decideJoinFileAdoption({
    remoteEntry: { fileId, contentHash: remoteContentHash },
    localContentHash,
  })
  if (decision.action === 'adopt-matching-content') {
    plugin.lastMaterialized.set(file.path, {
      diskHash: localContentHash,
      ydocHash: remoteContentHash,
      path: file.path,
      writtenAt: Date.now(),
      diskMtimeMs: file.stat.mtime,
      diskSize: file.stat.size,
    })
    clearPendingRemoteTextFile(plugin, loaded, markerPath, markerOwner)
    return
  }
  try {
    await importJoinAdoptionTextIfActive(plugin, file, loaded, markerOwner, context)
  } finally {
    clearPendingRemoteTextFile(plugin, loaded, markerPath, markerOwner)
  }
}

async function importJoinAdoptionTextIfActive(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  loaded: LoadedTextDoc,
  markerOwner: GenerationMarkerOwner,
  context: MetadataReconcileWriteContext,
): Promise<void> {
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) return
  const diskText = await plugin.app.vault.read(file)
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) return
  const canonicalText = canonicalizeTextForYText(diskText)
  const textHash = await hashCanonicalText(canonicalText)
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) return
  replaceYText(loaded.doc, loaded.text, canonicalText, DISK_ORIGIN)
  plugin.lastMaterialized.set(file.path, {
    diskHash: textHash,
    ydocHash: textHash,
    path: file.path,
    writtenAt: Date.now(),
    diskMtimeMs: file.stat.mtime,
    diskSize: file.stat.size,
  })
  if (!pendingRemoteTextMatchesMeta(plugin, loaded, file.path, markerOwner, context)) return
  await sendDocUpdateToWorker(
    plugin,
    loaded.docId,
    Y.encodeStateAsUpdate(loaded.doc),
    'join-adoption-hash-mismatch',
    () => loadedTextDocMatchesMetadataContext(plugin, loaded, context),
  )
}

async function recordRemoteMaterializeBlocked(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
  path: string,
  reason: 'invalid-path' | 'path-collision' | 'parent-collision',
  context: MetadataReconcileWriteContext,
): Promise<void> {
  if (!metadataReconcileWriteContextStillStable(plugin, context)) return
  const fileId = findMetaFileIdForDoc(plugin, loaded.docId)
  const entry: KuroflareRepairLogEntry = {
    id: `remote-materialize-blocked:${loaded.docId.ydocId}:${reason}`,
    kind: 'remote-materialize-blocked',
    fileId: fileId ?? loaded.docId.ydocId,
    path,
    reason,
    createdAt: Date.now(),
  }
  await plugin.updateMetadataReconcileSettings(
    (current) => ({
      repairLog: mergeRepairLogEntries(current.repairLog ?? [], [entry]),
    }),
    context,
  )
}
