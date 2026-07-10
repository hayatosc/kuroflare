import { v } from 'valibot'

import type KuroflareSpikePlugin from './plugin'

export async function applyWorkerSyncUpdate(
  plugin: KuroflareSpikePlugin,
  message: SyncUpdate,
): Promise<void> {
  if (message.docId.kind === 'file') {
    await plugin.loadTextDoc(message.docId)
  }
  const setup = plugin.requireSetupMetadata()
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  let applied = false
  const ydocPort = createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort({
    registry: {
      getYDoc: (docId) => {
        if (docId.kind === 'meta') {
          return plugin.metaDoc
        }
        return plugin.loadedTextDocs.get(docId.ydocId)?.doc
      },
    },
    origin: WORKER_ORIGIN,
  })
  const port = createSyncRuntimeWebSocketRemoteUpdateApplyPort({
    ydoc: {
      applyRemoteUpdate: async (input) => {
        const state = await ydocPort.applyRemoteUpdate(input)
        applied = true
        return state
      },
    },
    commit: createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
      createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(db),
    ),
    reject: {
      rejectRemoteUpdate: async (rejected, reason) => {
        console.warn('[kuroflare] dropped worker sync update', {
          reason,
          docId: rejected.docId,
          messageId: rejected.messageId,
        })
      },
    },
  })
  await port.applyRemoteUpdate(message)
  if (!applied) {
    return
  }
  if (message.docId.kind === 'meta') {
    return
  }
  const loaded = await plugin.loadTextDoc(message.docId)
  await plugin.resolvePendingRemoteTextFile(loaded)
  if (sameDocId(message.docId, await plugin.activeDocId())) {
    await plugin.flushYTextToDisk('worker-update')
  }
}

export async function resolvePendingRemoteTextFile(
  plugin: KuroflareSpikePlugin,
  loaded: LoadedTextDoc,
): Promise<void> {
  const path = plugin.pendingRemoteTextFiles.get(loaded.docId.ydocId)
  if (path === undefined) {
    return
  }
  if (!v.is(VaultRelativePathSchema, path)) {
    console.warn('[kuroflare] skipped remote text resolution for invalid path', { path })
    await plugin.recordRemoteMaterializeBlocked(loaded, path, 'invalid-path')
    plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    return
  }
  const existing = plugin.app.vault.getAbstractFileByPath(path)
  if (existing instanceof TFile) {
    await plugin.resolveJoinAdoptionHashCheck(existing, loaded)
    return
  }
  if (existing !== null) {
    console.warn('[kuroflare] skipped remote text materialize due to path collision', { path })
    await plugin.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
    return
  }
  if (await plugin.app.vault.adapter.exists(path)) {
    console.warn('[kuroflare] skipped remote text materialize due to adapter path collision', {
      path,
    })
    await plugin.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
    return
  }

  const content = loaded.text.toJSON()
  if (!(await plugin.ensureVaultParentFolders(path))) {
    console.warn('[kuroflare] skipped remote text materialize due to parent collision', { path })
    await plugin.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
    return
  }
  const textHash = await hashCanonicalText(content)
  try {
    await plugin.app.vault.create(path, content)
  } catch (error: unknown) {
    if (!isFileAlreadyExistsError(error)) {
      throw error
    }
    const racedExisting = plugin.app.vault.getAbstractFileByPath(path)
    if (racedExisting instanceof TFile) {
      const diskText = await plugin.app.vault.read(racedExisting)
      if ((await hashCanonicalText(diskText)) === textHash) {
        plugin.lastMaterialized.set(path, {
          diskHash: textHash,
          ydocHash: textHash,
          path,
          writtenAt: Date.now(),
        })
        plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
        return
      }
      await plugin.resolveJoinAdoptionHashCheck(racedExisting, loaded)
      return
    }
    if (await plugin.app.vault.adapter.exists(path)) {
      const diskText = await plugin.app.vault.adapter.read(path)
      if ((await hashCanonicalText(diskText)) === textHash) {
        plugin.lastMaterialized.set(path, {
          diskHash: textHash,
          ydocHash: textHash,
          path,
          writtenAt: Date.now(),
        })
        plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
        return
      }
    }
    console.warn('[kuroflare] skipped remote text materialize due to create race collision', {
      path,
    })
    await plugin.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
    plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    return
  }
  plugin.lastMaterialized.set(path, {
    diskHash: textHash,
    ydocHash: textHash,
    path,
    writtenAt: Date.now(),
  })
  plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
  console.info('[kuroflare] materialized remote text file', { path, docId: loaded.docId })
}

export async function resolveJoinAdoptionHashCheck(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  loaded: LoadedTextDoc,
): Promise<void> {
  const fileId = plugin.findActiveFileId(file.path)
  plugin.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
  if (fileId === undefined) {
    console.warn('[kuroflare] skipped join adoption hash check for unknown meta entry', {
      path: file.path,
    })
    return
  }

  const remoteContentHash = await hashCanonicalText(loaded.text.toJSON())
  const localContentHash = await hashCanonicalText(await plugin.app.vault.read(file))
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
    console.info('[kuroflare] adopted local file matching remote content', {
      path: file.path,
      fileId,
    })
    return
  }

  console.warn('[kuroflare] adopting local file with divergent remote content', {
    path: file.path,
    fileId,
  })
  await plugin.importFileTextIntoDocAndSend(file, loaded.docId, 'join-adoption-hash-mismatch')
}

export async function answerWorkerSyncRequest(
  plugin: KuroflareSpikePlugin,
  message: SyncRequest,
): Promise<void> {
  const setup = plugin.requireSetupMetadata()
  const port = createSyncRuntimeWebSocketSyncRequestAnswerPort({
    deviceId: setup.deviceId,
    session: plugin.workerWebSocketSession,
    registry: {
      getYDoc: (docId) => {
        if (docId.kind === 'meta') {
          return plugin.metaDoc
        }
        return plugin.loadedTextDocs.get(docId.ydocId)?.doc
      },
    },
    reject: {
      rejectSyncRequestAnswer: async (request, reason) => {
        console.warn('[kuroflare] skipped sync-request answer', {
          reason,
          docId: request.docId,
          messageId: request.messageId,
        })
      },
    },
  })
  await port.answerSyncRequest(message)
}
