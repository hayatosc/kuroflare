import { v } from 'valibot'
import { Y } from 'yjs'

import type KuroflareSpikePlugin from './plugin'

export async function fetchAndApplyFullSnapshot(
  plugin: KuroflareSpikePlugin,
  message: NeedFullSnapshot,
): Promise<void> {
  console.warn('[kuroflare] worker requested full snapshot', {
    reason: message.reason,
    docId: message.docId,
  })
  const snapshot = await plugin.fetchLatestSnapshotPayload(message.docId, message.reason)
  if (snapshot === null) {
    return
  }
  await plugin.applyLatestSnapshot(message.docId, snapshot, message.reason)
}

export async function publishLocalMetaSnapshot(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<SnapshotImportResponse> {
  const body = await plugin.importLocalSnapshot(
    META_SYNC_DOC_ID,
    Y.encodeStateAsUpdate(plugin.metaDoc),
    reason,
  )
  console.info('[kuroflare] local meta snapshot imported', {
    reason,
    snapshotSeq: body.snapshotSeq,
  })
  return body
}

export async function importLocalSnapshot(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  updateBytes: Uint8Array,
  reason: string,
): Promise<SnapshotImportResponse> {
  const setup = plugin.requireSetupMetadata()
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    throw new Error('snapshot-import-token-missing')
  }

  const response = await fetch(plugin.snapshotImportUrl(setup, docId), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      updateBytesBase64: encodeBase64(updateBytes),
    }),
  })
  if (!response.ok) {
    console.warn('[kuroflare] local snapshot import failed', {
      status: response.status,
      docId,
      reason,
    })
    throw new Error('snapshot-import-http-failed')
  }

  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(SnapshotImportResponseSchema, body)) {
    throw new Error('snapshot-import-response-invalid')
  }
  return body
}

export async function applyLatestSnapshot(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  snapshot: LatestSnapshotPayload,
  reason: string,
): Promise<void> {
  const setup = plugin.requireSetupMetadata()
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const localStore = await plugin.readOutboxWorkerSnapshot(db)
  const plan = planFullSnapshotApplyRuntime({
    requestedDocId: docId,
    response: snapshot.response,
    verifiedBytes: snapshot.verifiedBytes,
    hasPendingLocalUpdates: hasPendingRunnableOutboxUpdate(localStore.outboxRecords, docId),
    activeEditorBound: docId.kind === 'file' && sameDocId(docId, await plugin.activeDocId()),
    currentOutboxRecords: localStore.outboxRecords,
    currentLeaseRows: localStore.leaseRows,
  })
  if (!plan.ok) {
    console.warn('[kuroflare] latest snapshot apply deferred', {
      action: plan.action,
      reason: plan.reason,
      docId,
    })
    return
  }

  await commitFullSnapshotApplyIndexedDbTransaction({
    database: createFullSnapshotApplyIndexedDbDatabasePort(db),
    transaction: plan.indexedDbWriteTransaction,
  })
  if (docId.kind === 'meta') {
    Y.applyUpdate(plugin.metaDoc, plan.updateBytes, WORKER_ORIGIN)
    void plugin.runOutboxWorkerTick(`snapshot:${reason}`)
    return
  }

  const loaded = await plugin.loadTextDoc(docId)
  Y.applyUpdate(loaded.doc, plan.updateBytes, WORKER_ORIGIN)
  await plugin.resolvePendingRemoteTextFile(loaded)
  if (sameDocId(docId, await plugin.activeDocId())) {
    await plugin.flushYTextToDisk('full-snapshot')
  }
  void plugin.runOutboxWorkerTick(`snapshot:${reason}`)
}

export async function fetchLatestSnapshotPayload(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  reason: string,
): Promise<LatestSnapshotPayload | null> {
  const setup = plugin.requireSetupMetadata()
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    console.warn('[kuroflare] latest snapshot fetch skipped without access token', {
      reason,
      docId,
    })
    return null
  }
  const response = await fetch(plugin.latestSnapshotUrl(setup, docId), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (!response.ok) {
    console.warn('[kuroflare] latest snapshot fetch failed', {
      status: response.status,
      reason,
      docId,
    })
    return null
  }

  const body: unknown = await response.json().catch(() => undefined)
  const schema =
    docId.kind === 'meta' ? MetaLatestSnapshotResponseSchema : DocLatestSnapshotResponseSchema
  if (!v.is(schema, body)) {
    console.warn('[kuroflare] latest snapshot response rejected by guard', {
      docId,
    })
    return null
  }

  const snapshotResponse = body
  const decoded = await decodeFullSnapshotBytesFromResponse({ response: snapshotResponse })
  if (!decoded.ok) {
    console.warn('[kuroflare] latest snapshot payload rejected', {
      reason: decoded.reason,
      docId,
    })
    return null
  }
  return { response: snapshotResponse, verifiedBytes: decoded }
}

export function latestSnapshotUrl(
  plugin: KuroflareSpikePlugin,
  setup: LocalSetupMetadata,
  docId: DocId,
): string {
  const url = new URL(setup.endpoint)
  if (docId.kind === 'meta') {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`
  } else {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(
      docId.ydocId,
    )}/latest`
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function snapshotImportUrl(
  plugin: KuroflareSpikePlugin,
  setup: LocalSetupMetadata,
  docId: DocId,
): string {
  const url = new URL(setup.endpoint)
  if (docId.kind === 'meta') {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
  } else {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(
      docId.ydocId,
    )}/snapshot`
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function localOutboxRepairEvidenceUrl(
  plugin: KuroflareSpikePlugin,
  setup: LocalSetupMetadata,
): string {
  const url = new URL(setup.endpoint)
  url.pathname = '/repair/local-outbox/evidence'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export async function fetchLocalOutboxRepairEvidence(
  plugin: KuroflareSpikePlugin,
  setup: LocalSetupMetadata,
  items: readonly LocalOutboxRepairEvidenceQueryItem[],
): Promise<LocalOutboxRepairEvidenceResponse | null> {
  if (items.length === 0) {
    return { durableMessages: [], quarantinedMessages: [] }
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    new Notice('Kuroflare repair: access token is missing')
    return null
  }

  const response = await fetch(plugin.localOutboxRepairEvidenceUrl(setup), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: items.map((item) =>
        item.updateSha256 === undefined
          ? { docId: item.docId, messageId: item.messageId }
          : { docId: item.docId, messageId: item.messageId, updateSha256: item.updateSha256 },
      ),
    }),
  })
  if (!response.ok) {
    console.warn('[kuroflare] repair evidence fetch failed', { status: response.status })
    new Notice('Kuroflare repair: failed to fetch server evidence')
    return null
  }

  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(LocalOutboxRepairEvidenceResponseSchema, body)) {
    console.warn('[kuroflare] repair evidence response rejected by guard')
    new Notice('Kuroflare repair: invalid server evidence response')
    return null
  }
  return body
}
