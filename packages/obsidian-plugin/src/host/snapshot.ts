import {
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotImportResponseSchema,
  decodeFullSnapshotBytesFromResponse,
  type DocId,
  type DocLatestSnapshotResponse,
  type MetaLatestSnapshotResponse,
  type NeedFullSnapshotReason,
} from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

import { documentEpochMetadataKey } from '../recovery/epoch'
import { createWorkerClient } from '../sync/api-client'
import {
  commitFullSnapshotApplyIndexedDbTransaction,
  createFullSnapshotApplyIndexedDbDatabasePort,
  planFullSnapshotApplyRuntime,
  runNeedFullSnapshotRecovery,
  type VerifiedFullSnapshotBytes,
} from '../sync/engine/snapshot'
import type { TextDocumentOwner } from '../types'
import { activeDocId, currentSetupMetadata, readAccessToken, requireSetupMetadata } from './auth'
import {
  NEED_FULL_SNAPSHOT_RECOVERY_BACKOFF_MS,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
} from './constants'
import { flushYTextToDisk } from './editor'
import {
  accessTokenSecretKeyForSetup,
  encodeBase64,
  hasPendingRunnableOutboxUpdate,
  safeLogError,
  sameDocId,
} from './helpers'
import { activateLoadedTextDoc, metadataWritesEnabled, replaceTextDoc } from './meta'
import type KuroflareSpikePlugin from './plugin'
import { requestDocFromWorker } from './socket'
import { openLocalStoreDatabase, readOutboxWorkerSnapshot, readRemoteCursorSeq } from './store'
import { replaceMetaDoc } from './vault'

type LatestSnapshotPayload = {
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly verifiedBytes: VerifiedFullSnapshotBytes
}

export async function publishLocalMetaSnapshot(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  await importLocalSnapshot(plugin, META_SYNC_DOC_ID, Y.encodeStateAsUpdate(plugin.metaDoc), reason)
}

export async function publishInitialFileSnapshots(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  for (const loaded of plugin.loadedTextDocs.values()) {
    const owner = { vaultId: loaded.vaultId, generation: loaded.vaultGeneration }
    const isCurrent = () => plugin.loadedTextDocStillCurrent(loaded, owner)
    if (!isCurrent()) return
    await importLocalSnapshot(
      plugin,
      loaded.docId,
      Y.encodeStateAsUpdate(loaded.doc),
      reason,
      isCurrent,
    )
  }
}

async function importLocalSnapshot(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  updateBytes: Uint8Array,
  reason: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  if (docId.kind === 'meta' && !metadataWritesEnabled(plugin)) return
  const setup = requireSetupMetadata(plugin)
  const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
  if (!isCurrent()) return
  if (accessToken === undefined) throw new Error('snapshot-import-token-missing')
  const workerClient = createWorkerClient(setup.endpoint, accessToken)
  const importBody = {
    updateBytesBase64: encodeBase64(updateBytes),
    ...(docId.kind === 'meta' ? { metadataSchemaVersion: 2 as const } : {}),
  }
  const response =
    docId.kind === 'meta'
      ? await workerClient.vaults[':vaultId'].meta.snapshot.$put({
          param: { vaultId: setup.vaultId },
          json: importBody,
        })
      : await workerClient.vaults[':vaultId'].files[':ydocId'].snapshot.$put({
          param: { vaultId: setup.vaultId, ydocId: docId.ydocId },
          json: importBody,
        })
  if (!isCurrent()) return
  if (!response.ok) {
    console.warn('[kuroflare] local snapshot import failed', {
      status: response.status,
      docId,
      reason,
    })
    throw new Error('snapshot-import-http-failed')
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isCurrent()) return
  if (!v.is(SnapshotImportResponseSchema, body)) {
    throw new Error('snapshot-import-response-invalid')
  }
}

export async function fetchLatestSnapshotPayload(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  reason: string,
  isCurrent: () => boolean = () => true,
): Promise<LatestSnapshotPayload | null> {
  if (!isCurrent()) return null
  const setup = requireSetupMetadata(plugin)
  const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
  if (!isCurrent()) return null
  if (accessToken === undefined) return null
  const workerClient = createWorkerClient(setup.endpoint, accessToken)
  const response =
    docId.kind === 'meta'
      ? await workerClient.vaults[':vaultId'].meta.latest.$get({
          param: { vaultId: setup.vaultId },
        })
      : await workerClient.vaults[':vaultId'].files[':ydocId'].latest.$get({
          param: { vaultId: setup.vaultId, ydocId: docId.ydocId },
        })
  if (!isCurrent()) return null
  if (!response.ok) {
    console.warn('[kuroflare] latest snapshot fetch failed', {
      status: response.status,
      reason,
      docId,
    })
    return null
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isCurrent()) return null
  const schema =
    docId.kind === 'meta' ? MetaLatestSnapshotResponseSchema : DocLatestSnapshotResponseSchema
  if (!v.is(schema, body)) return null
  const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
  if (!isCurrent()) return null
  if (!decoded.ok) return null
  return { response: body, verifiedBytes: decoded }
}

export async function applyLatestSnapshot(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  snapshot: LatestSnapshotPayload,
  _reason: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  const setup = requireSetupMetadata(plugin)
  const db = await openLocalStoreDatabase(plugin, setup.vaultId, isCurrent)
  if (!isCurrent()) return
  const localStore = await readOutboxWorkerSnapshot(db)
  if (!isCurrent()) return
  const currentSnapshotSeq = await readRemoteCursorSeq(db, docId)
  if (!isCurrent()) return
  const activeEditorBound = docId.kind === 'file' && sameDocId(docId, await activeDocId(plugin))
  if (!isCurrent()) return
  const plan = planFullSnapshotApplyRuntime({
    requestedDocId: docId,
    response: snapshot.response,
    verifiedBytes: snapshot.verifiedBytes,
    currentSnapshotSeq,
    hasPendingLocalUpdates: hasPendingRunnableOutboxUpdate(localStore.outboxRecords, docId),
    activeEditorBound,
    currentOutboxRecords: localStore.outboxRecords,
    currentLeaseRows: localStore.leaseRows,
  })
  if (!plan.ok) {
    console.warn('[kuroflare] latest snapshot apply deferred', {
      action: plan.action,
      reason: plan.reason,
      docId,
    })
    throw new Error(`latest-snapshot-apply:${plan.action}:${plan.reason}`)
  }
  const cursorSeqBeforeCommit = await readRemoteCursorSeq(db, docId)
  if (!isCurrent()) return
  if (cursorSeqBeforeCommit !== currentSnapshotSeq) {
    throw new Error('latest-snapshot-apply:wait:remote-cursor-advanced')
  }
  const committed = await commitFullSnapshotApplyIndexedDbTransaction({
    database: createFullSnapshotApplyIndexedDbDatabasePort(db),
    transaction: plan.indexedDbWriteTransaction,
    remoteCursorCas: { expectedRemoteCursorSeq: currentSnapshotSeq },
  })
  if (!committed) throw new Error('latest-snapshot-apply:wait:remote-cursor-advanced')
  if (!isCurrent()) return
  if (docId.kind === 'meta') {
    await replaceMetaDoc(plugin, plan.updateBytes, isCurrent)
    return
  }
  const wasActiveTextDoc = plugin.activeTextDoc?.docId.ydocId === docId.ydocId
  const loaded = await replaceTextDoc(plugin, docId, plan.updateBytes, WORKER_ORIGIN)
  if (!isCurrent()) return
  if (wasActiveTextDoc) {
    activateLoadedTextDoc(plugin, loaded)
  }
  await plugin.resolvePendingRemoteTextFile(loaded)
  if (!isCurrent()) return
  if (sameDocId(docId, await activeDocId(plugin))) {
    await flushYTextToDisk(plugin, 'full-snapshot')
  }
}

/**
 * Automatically recovers from a NeedFullSnapshot response by fetching and applying a
 * replacement snapshot, which resumes the matching paused outbox item as a side effect
 * of {@link applyLatestSnapshot}. Bounded retries with backoff; exhausting them leaves
 * the outbox item in its existing paused/manual-recovery state (fail closed).
 */
export async function recoverFromNeedFullSnapshot(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  reason: NeedFullSnapshotReason,
): Promise<void> {
  const initialContext = plugin.captureVaultOperationContext()
  if (initialContext === undefined) return
  let context: TextDocumentOwner = initialContext
  const isCurrent = () => plugin.vaultOperationStillCurrent(context)
  const epochKey = documentEpochMetadataKey(docId)
  if (
    plugin.needFullSnapshotRecoveryInProgress.has(epochKey) ||
    plugin.documentRecoveryRequired.has(epochKey) ||
    plugin.documentReplacementInProgress.has(epochKey)
  ) {
    return
  }
  const owner = {}
  plugin.needFullSnapshotRecoveryInProgress.add(epochKey)
  plugin.needFullSnapshotRecoveryOwners.set(epochKey, owner)
  plugin.documentReplacementInProgress.add(epochKey)
  try {
    const result = await runNeedFullSnapshotRecovery(
      {
        fetchSnapshot: async () => {
          if (!isCurrent()) return null
          return await fetchLatestSnapshotPayload(
            plugin,
            docId,
            `need-full-snapshot:${reason}`,
            isCurrent,
          )
        },
        applySnapshot: async (payload) => {
          if (!isCurrent()) return false
          try {
            await applyLatestSnapshot(
              plugin,
              docId,
              payload,
              `need-full-snapshot:${reason}`,
              isCurrent,
            )
            if (
              docId.kind === 'meta' &&
              plugin.pendingSetupResponse === null &&
              currentSetupMetadata(plugin)?.vaultId === context.vaultId
            ) {
              context = { ...context, generation: plugin.metadataVaultGeneration }
            }
            return isCurrent()
          } catch (error: unknown) {
            console.warn('[kuroflare] need-full-snapshot auto-recovery apply attempt failed', {
              docId,
              reason,
              error: safeLogError(error),
            })
            return false
          }
        },
        wait: async (delayMs) => {
          await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
        },
      },
      NEED_FULL_SNAPSHOT_RECOVERY_BACKOFF_MS,
    )
    if (!result.ok) {
      console.warn(
        '[kuroflare] need-full-snapshot auto-recovery exhausted retries; outbox item remains paused for manual recovery',
        { docId, reason, attempts: result.attempts },
      )
    }
  } finally {
    if (plugin.needFullSnapshotRecoveryOwners.get(epochKey) === owner) {
      plugin.needFullSnapshotRecoveryOwners.delete(epochKey)
      plugin.needFullSnapshotRecoveryInProgress.delete(epochKey)
    }
    plugin.documentReplacementInProgress.delete(epochKey)
  }
  if (isCurrent()) {
    const recoveredDoc =
      docId.kind === 'meta' ? plugin.metaDoc : plugin.loadedTextDocs.get(docId.ydocId)?.doc
    if (recoveredDoc !== undefined) {
      await requestDocFromWorker(
        plugin,
        docId,
        Y.encodeStateVector(recoveredDoc),
        'need-full-snapshot:post-recovery-catch-up',
        isCurrent,
      )
    }
  }
}
