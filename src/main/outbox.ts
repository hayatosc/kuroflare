import { v } from 'valibot'

import { planOutboundQueueTick } from '../sync/engine/queue'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import type KuroflareSpikePlugin from './plugin'

export async function runOutboxWorkerTick(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  if (plugin.syncStoppedByAuth !== null) {
    return
  }
  if (document.hidden) {
    return
  }
  if (plugin.outboxWorkerRunning) {
    return
  }
  if (
    !plugin.workerHelloAccepted ||
    plugin.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
  ) {
    return
  }
  plugin.outboxWorkerRunning = true
  try {
    const setup = plugin.requireSetupMetadata()
    const db = await plugin.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await plugin.readOutboxWorkerSnapshot(db)
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    const authMetadata = metadataSnapshot.ok ? metadataSnapshot.snapshot.auth : undefined
    if (authMetadata?.refreshState === 'refreshing') {
      await plugin.recoverStaleAuthRefreshStart(db, authMetadata)
    }
    const currentMetadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    const currentAuthMetadata = currentMetadataSnapshot.ok
      ? currentMetadataSnapshot.snapshot.auth
      : undefined
    if (currentAuthMetadata !== undefined && currentAuthMetadata.authState !== 'active') {
      plugin.stopLocalSyncAfterAuthBlocked(currentAuthMetadata.authState)
      return
    }
    const now = Date.now()
    const resumeEvents = plugin.consumePendingOutboxResumeEvents()
    const tick = planOutboundQueueTick({
      items: snapshot.outboxRecords,
      now,
      profile: 'desktop',
      resumeEvents,
      leases: snapshot.leaseRows,
      maxStarts: OUTBOX_WORKER_MAX_STARTS,
      auth: schedulerAuthGateFromMetadata(currentAuthMetadata),
      authRefreshState: outboxAuthRefreshStateFromMetadata(currentAuthMetadata),
    })
    if (!tick.ok) {
      console.warn('[kuroflare] outbox queue tick skipped', {
        reason,
        failure: tick.reason,
        id: tick.id,
      })
      return
    }
    const workerTick = planOutboxWorkerTick({
      tick,
      currentOutboxRecords: snapshot.outboxRecords,
      currentLeaseRows: snapshot.leaseRows,
      ownerId: plugin.outboxWorkerOwnerId,
      now,
      leaseDurationMs: OUTBOX_WORKER_LEASE_DURATION_MS,
    })
    if (!workerTick.ok) {
      console.warn('[kuroflare] outbox worker tick skipped', {
        reason,
        phase: workerTick.phase,
        failure: workerTick.reason,
      })
      return
    }
    for (const transaction of planOutboxWorkerTickIndexedDbWriteTransactions(workerTick)) {
      await plugin.commitOutboxWorkerIndexedDbWriteTransaction(db, transaction)
    }
    if (tick.authRefresh.action === 'request-refresh') {
      await plugin.runAuthRefreshRequest(tick.authRefresh)
    }
    const nextSnapshot = await plugin.readOutboxWorkerSnapshot(db)
    const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
    const sender = createSyncRuntimeWebSocketOutboxSendPort({
      session: plugin.workerWebSocketSession,
    })
    for (const effect of workerTick.starts) {
      const record = nextSnapshot.outboxRecords.find(
        (candidate) => candidate.id === effect.start.id,
      )
      if (record === undefined) {
        continue
      }
      if (record.kind === 'y-update') {
        const send = await sender.sendSyncUpdate({
          record,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
        })
        if (!send.ok) {
          console.warn('[kuroflare] outbox websocket send rejected', {
            reason: send.reason,
            itemId: effect.start.id,
          })
          await plugin.completeLeasedOutboxFailure(db, record, { kind: 'invalid-payload' })
        }
        continue
      }
      const sideEffect = planOutboxWorkerSideEffect({
        effect,
        record,
        endpoint: setup.endpoint,
        accessToken,
      })
      if (!sideEffect.ok) {
        console.warn('[kuroflare] outbox side effect skipped', {
          reason: sideEffect.reason,
          itemId: effect.start.id,
        })
        await plugin.completeLeasedOutboxFailure(
          db,
          record,
          sideEffect.reason === 'missing-access-token'
            ? { kind: 'auth' }
            : { kind: 'invalid-payload' },
        )
        continue
      }
      if (sideEffect.action === 'blob-put') {
        const result = await plugin.runBlobPutSideEffect(sideEffect)
        await plugin.completeNonAckSideEffect(db, record, result)
        continue
      }
      if (sideEffect.action === 'blob-get') {
        const result = await plugin.runBlobGetSideEffect(sideEffect)
        await plugin.completeNonAckSideEffect(db, record, result)
        continue
      }
      if (sideEffect.action === 'manifest-put') {
        const result = await plugin.runManifestPutSideEffect(sideEffect)
        await plugin.completeNonAckSideEffect(db, record, result)
        continue
      }
      if (sideEffect.action === 'materialize') {
        const result = await plugin.runMaterializeSideEffect(sideEffect)
        await plugin.completeNonAckSideEffect(db, record, result)
        continue
      }
      if (sideEffect.action !== 'meta-ref-update') {
        continue
      }
      const send = await sender.sendSyncUpdate({
        record,
        vaultId: setup.vaultId,
        deviceId: setup.deviceId,
      })
      if (!send.ok) {
        console.warn('[kuroflare] outbox websocket send rejected', {
          reason: send.reason,
          itemId: effect.start.id,
        })
        await plugin.completeLeasedOutboxFailure(db, record, { kind: 'invalid-payload' })
      }
    }
    if (workerTick.starts.length > 0) {
      plugin.scheduleOutboxWorkerTick(OUTBOX_WORKER_LEASE_DURATION_MS + 250, 'lease-expiry-retry')
    }
  } catch (error: unknown) {
    console.error('[kuroflare] outbox worker tick failed', { reason, error: safeLogError(error) })
  } finally {
    plugin.outboxWorkerRunning = false
  }
}

export function scheduleOutboxWorkerTick(
  plugin: KuroflareSpikePlugin,
  delayMs: number,
  reason: string,
): void {
  if (plugin.outboxWorkerRetryTimeout !== null) {
    return
  }
  plugin.outboxWorkerRetryTimeout = window.setTimeout(() => {
    plugin.outboxWorkerRetryTimeout = null
    void plugin.runOutboxWorkerTick(reason)
  }, delayMs)
}

export async function handleForegroundResume(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  if (plugin.foregroundResumeRunning || plugin.syncStoppedByAuth !== null || document.hidden) {
    return
  }
  if (plugin.currentSetupMetadata() === undefined) {
    return
  }
  plugin.foregroundResumeRunning = true
  try {
    await plugin.bindActiveMarkdownView(`foreground-resume:${reason}`)
    await plugin.openWorkerWebSocket()
    await plugin.requestMetaDocFromWorker(`foreground-resume:${reason}`)
    await plugin.requestActiveFileFromWorker(`foreground-resume:${reason}`)
    await plugin.requestPendingRemoteTextFilesFromWorker(`foreground-resume:${reason}`)
    void plugin.runOutboxWorkerTick(`foreground-resume:${reason}`)
  } catch (error: unknown) {
    console.warn('[kuroflare] foreground resume failed', { reason, error: safeLogError(error) })
  } finally {
    plugin.foregroundResumeRunning = false
  }
}

export function consumePendingOutboxResumeEvents(
  plugin: KuroflareSpikePlugin,
): readonly OutboxResumeEvent[] {
  const events = plugin.pendingOutboxResumeEvents
  plugin.pendingOutboxResumeEvents = []
  return events
}

export async function runManifestPutSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerManifestPutSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  try {
    const response = await fetch(sideEffect.putManifestRequest.url, {
      method: sideEffect.putManifestRequest.method,
      headers: sideEffect.putManifestRequest.headers,
      body: JSON.stringify(sideEffect.putManifestRequest.bodyJson),
    })
    if (response.ok) {
      return { kind: 'success' }
    }
    return {
      kind: 'http-response',
      status: response.status,
      retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
      code: await responseErrorCode(response),
    }
  } catch (error: unknown) {
    console.warn('[kuroflare] manifest put failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function runBlobPutSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerBlobPutSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const bytes = await plugin.readBlobCacheBytes(
    sideEffect.readLocalCache.key,
    sideEffect.readLocalCache.expectedSha256,
    sideEffect.readLocalCache.expectedSize,
  )
  if (bytes === undefined) {
    return { kind: 'invalid-payload', code: 'local-cache-read-failed' }
  }

  const head = await plugin.fetchJsonSideEffect(sideEffect.headRequest)
  if (head.kind !== 'success') {
    return head
  }
  if (!v.is(BlobHeadResponseSchema, head.body)) {
    return { kind: 'invalid-payload', code: 'blob-head-response-invalid' }
  }
  const entry = head.body.exists[sideEffect.blob.sha256]
  if (entry?.found === true) {
    if (entry.size !== undefined && entry.size !== sideEffect.blob.size) {
      return { kind: 'invalid-payload', code: 'blob-head-size-mismatch' }
    }
    return { kind: 'success' }
  }

  const uploadUrl = await plugin.fetchJsonSideEffect(sideEffect.uploadUrlRequest)
  if (uploadUrl.kind !== 'success') {
    return uploadUrl
  }
  if (!v.is(BlobUploadUrlResponseSchema, uploadUrl.body)) {
    return { kind: 'invalid-payload', code: 'blob-upload-url-response-invalid' }
  }
  if (uploadUrl.body.kind === 'already-exists') {
    return { kind: 'success' }
  }
  if (uploadUrl.body.kind === 'multipart') {
    return { kind: 'invalid-payload', code: 'blob-upload-multipart-unimplemented' }
  }

  try {
    const response = await fetch(uploadUrl.body.url, {
      method: sideEffect.uploadPut.method,
      headers: {
        ...uploadUrl.body.headers,
        authorization: sideEffect.uploadUrlRequest.headers.authorization ?? '',
      },
      body: arrayBufferFromBytes(bytes),
    })
    if (response.ok) {
      return { kind: 'success' }
    }
    return await plugin.httpFailureResult(response)
  } catch (error: unknown) {
    console.warn('[kuroflare] blob put failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function runBlobGetSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerBlobGetSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  let response: Response
  try {
    response = await fetch(sideEffect.downloadRequest.url, {
      method: sideEffect.downloadRequest.method,
      headers: sideEffect.downloadRequest.headers,
    })
  } catch (error: unknown) {
    console.warn('[kuroflare] blob get failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
  if (!response.ok) {
    return await plugin.httpFailureResult(response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (
    !(await plugin.blobBytesMatch(
      bytes,
      sideEffect.writeLocalCache.expectedSha256,
      sideEffect.writeLocalCache.expectedSize,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'blob-download-mismatch' }
  }
  await plugin.writeBlobCacheBytes(sideEffect.writeLocalCache.key, bytes)
  return { kind: 'success' }
}

export async function runMaterializeSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerMaterializeSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const chunks = new Map<NonNullable<LocalStoreOutboxRecord['blobSha256']>, Uint8Array>()
  for (const chunk of sideEffect.readChunks) {
    const bytes = await plugin.readBlobCacheBytes(chunk.key, chunk.sha256, chunk.expectedSize)
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
    }
    chunks.set(chunk.sha256, bytes)
  }

  let assembled: Uint8Array
  try {
    assembled = await assembleBlobBytes(sideEffect.manifest, chunks)
  } catch {
    return { kind: 'invalid-payload', code: 'materialize-assembly-failed' }
  }
  if (
    !(await plugin.blobBytesMatch(
      assembled,
      sideEffect.assemble.expectedContentSha256,
      sideEffect.assemble.expectedSize,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'materialize-assembled-mismatch' }
  }

  const existing = plugin.app.vault.getAbstractFileByPath(sideEffect.diskCas.path)
  if (existing instanceof TFolder) {
    return { kind: 'local-conflict' }
  }
  if (existing instanceof TFile) {
    const currentDiskBytes = new Uint8Array(
      await plugin.app.vault.adapter.readBinary(sideEffect.diskCas.path),
    )
    const decision = decideMaterializeWrite({
      path: sideEffect.diskCas.path,
      activeFilePath: plugin.activeFile?.path,
      currentDiskHash: makeSha256Hex(await plugin.sha256Hex(currentDiskBytes)),
      lastMaterialized: sideEffect.diskCas.lastMaterialized,
    })
    if (decision.action !== 'write') {
      return { kind: 'local-conflict' }
    }
  } else if (!(await plugin.ensureVaultParentFolders(sideEffect.writeVaultFile.path))) {
    return { kind: 'local-conflict' }
  }

  await plugin.app.vault.adapter.writeBinary(
    sideEffect.writeVaultFile.path,
    arrayBufferFromBytes(assembled),
  )
  plugin.lastMaterialized.set(sideEffect.writeVaultFile.path, {
    diskHash: sideEffect.expectedContentSha256,
    ydocHash: sideEffect.expectedContentSha256,
    path: sideEffect.writeVaultFile.path,
    writtenAt: Date.now(),
  })
  return { kind: 'success' }
}

export async function fetchJsonSideEffect(
  plugin: KuroflareSpikePlugin,
  request: OutboxWorkerManifestPutSideEffectPlan['putManifestRequest'],
): Promise<
  | { readonly kind: 'success'; readonly body: unknown }
  | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
> {
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    }
    if (request.bodyJson !== undefined) {
      init.body = JSON.stringify(request.bodyJson)
    }
    const response = await fetch(request.url, init)
    if (!response.ok) {
      return await httpFailureResult(plugin, response)
    }
    return { kind: 'success', body: await response.json().catch(() => undefined) }
  } catch (error: unknown) {
    console.warn('[kuroflare] JSON side effect failed before HTTP response', {
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function httpFailureResult(
  plugin: KuroflareSpikePlugin,
  response: Response,
): Promise<Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>> {
  return {
    kind: 'http-response',
    status: response.status,
    retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
    code: await responseErrorCode(response),
  }
}

export async function readBlobCacheBytes(
  plugin: KuroflareSpikePlugin,
  key: string,
  expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
  expectedSize: number,
): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(key))
    return (await plugin.blobBytesMatch(bytes, expectedSha256, expectedSize)) ? bytes : undefined
  } catch {
    return undefined
  }
}

export async function writeBlobCacheBytes(
  plugin: KuroflareSpikePlugin,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await plugin.ensureAdapterParentFolders(key)
  await plugin.app.vault.adapter.writeBinary(key, arrayBufferFromBytes(bytes))
}

export async function blobBytesMatch(
  plugin: KuroflareSpikePlugin,
  bytes: Uint8Array,
  expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
  expectedSize: number,
): Promise<boolean> {
  return (
    bytes.byteLength === expectedSize &&
    makeSha256Hex(await plugin.sha256Hex(bytes)) === expectedSha256
  )
}

export async function completeNonAckSideEffect(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
  result: OutboxWorkerSideEffectResultEvidence,
): Promise<void> {
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const currentRecord =
    snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
  const evidence = classifyOutboxWorkerSideEffectCompletionEvidence({
    itemId: currentRecord.id,
    kind: currentRecord.kind,
    status: currentRecord.status,
    retryCount: currentRecord.retryCount ?? 0,
    result,
  })
  const plan = evidence.ok
    ? planOutboxWorkerSuccessCompletion({
        itemId: evidence.itemId,
        kind: evidence.kind,
        status: evidence.status,
        ownerId: plugin.outboxWorkerOwnerId,
        now: Date.now(),
        currentOutboxRecords: snapshot.outboxRecords,
        currentLeaseRows: snapshot.leaseRows,
      })
    : planOutboxWorkerFailureCompletion({
        itemId: evidence.itemId,
        kind: evidence.kind,
        retryCount: evidence.retryCount,
        error: evidence.error,
        ownerId: plugin.outboxWorkerOwnerId,
        now: Date.now(),
        currentOutboxRecords: snapshot.outboxRecords,
        currentLeaseRows: snapshot.leaseRows,
      })
  if (!plan.ok) {
    console.warn('[kuroflare] outbox side effect completion rejected', {
      itemId: currentRecord.id,
      reason: plan.reason,
    })
    return
  }
  await plugin.commitOutboxWorkerIndexedDbWriteTransaction(
    db,
    planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
  )
  if (plan.action === 'retry-after-failure') {
    plugin.scheduleOutboxWorkerTick(1_000, 'side-effect-retry')
  } else if (plan.action === 'success-completion') {
    // A completed side effect (e.g. blob-put) can unblock a dependent item
    // (e.g. manifest-put) that wasn't runnable when this tick's plan was
    // computed. Without this, the pipeline would stall until the 30s
    // `lease-expiry-retry` fallback below fires. `scheduleOutboxWorkerTick`
    // coalesces to a single pending timer, so this is a no-op if a shorter
    // retick is already queued, and a follow-up tick that finds no new
    // work simply exits without rescheduling -- no tight loop.
    plugin.scheduleOutboxWorkerTick(250, 'side-effect-complete')
  }
}

export async function completeLeasedOutboxFailure(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
  error: OutboxRunError,
): Promise<void> {
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const currentRecord =
    snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
  const plan = planOutboxWorkerFailureCompletion({
    itemId: currentRecord.id,
    kind: currentRecord.kind,
    retryCount: currentRecord.retryCount ?? 0,
    error,
    ownerId: plugin.outboxWorkerOwnerId,
    now: Date.now(),
    currentOutboxRecords: snapshot.outboxRecords,
    currentLeaseRows: snapshot.leaseRows,
  })
  if (!plan.ok) {
    console.warn('[kuroflare] outbox failure completion rejected', {
      itemId: currentRecord.id,
      reason: plan.reason,
    })
    return
  }
  await plugin.commitOutboxWorkerIndexedDbWriteTransaction(
    db,
    planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
  )
  if (plan.action === 'retry-after-failure') {
    plugin.scheduleOutboxWorkerTick(1_000, 'side-effect-retry')
  }
}

export async function readOutboxWorkerSnapshot(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
): Promise<{
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}> {
  const transaction = db.transaction(['outbox', 'running-leases'], 'readonly')
  const outboxRequest = transaction.objectStore('outbox').getAll()
  const leasesRequest = transaction.objectStore('running-leases').getAll()
  const [outboxValues, leaseValues] = await Promise.all([
    waitForIndexedDbRequest(outboxRequest),
    waitForIndexedDbRequest(leasesRequest),
  ])
  await waitForIndexedDbTransaction(transaction)
  return {
    outboxRecords: outboxValues.filter(isLocalStoreOutboxRecord),
    leaseRows: leaseValues.filter(isOutboxRunningLease),
  }
}

export async function commitOutboxWorkerIndexedDbWriteTransaction(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  transaction: OutboxWorkerIndexedDbWriteTransaction,
): Promise<void> {
  await commitLocalStoreIndexedDbConcreteWriteTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    writes: transaction.writes,
  })
}

export async function putOutboxRecord(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
): Promise<void> {
  const transaction = db.transaction(['outbox'], 'readwrite')
  const request = transaction.objectStore('outbox').put(record, record.id)
  await waitForIndexedDbRequest(request)
  await waitForIndexedDbTransaction(transaction)
}

export async function putOutboxRecords(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  records: readonly LocalStoreOutboxRecord[],
): Promise<void> {
  const transaction = db.transaction(['outbox'], 'readwrite')
  const store = transaction.objectStore('outbox')
  await Promise.all(records.map((record) => waitForIndexedDbRequest(store.put(record, record.id))))
  await waitForIndexedDbTransaction(transaction)
}

export async function ensureAdapterParentFolders(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<void> {
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    if (!(await plugin.app.vault.adapter.exists(current))) {
      try {
        await plugin.app.vault.adapter.mkdir(current)
      } catch (error: unknown) {
        if (!(await plugin.app.vault.adapter.exists(current))) {
          throw error
        }
      }
    }
  }
}

export async function ensureVaultParentFolders(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<boolean> {
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    const existing = plugin.app.vault.getAbstractFileByPath(current)
    if (existing instanceof TFolder) {
      continue
    }
    if (existing !== null) {
      return false
    }
    if (await plugin.app.vault.adapter.exists(current)) {
      continue
    }
    try {
      await plugin.app.vault.adapter.mkdir(current)
    } catch {
      if (!(await plugin.app.vault.adapter.exists(current))) {
        return false
      }
    }
  }
  return true
}

export function isRepairConflictPathAvailable(plugin: KuroflareSpikePlugin, path: string): boolean {
  if (plugin.app.vault.getAbstractFileByPath(path) !== null || plugin.findActiveFileId(path)) {
    return false
  }
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    const existing = plugin.app.vault.getAbstractFileByPath(current)
    if (existing !== null && !(existing instanceof TFolder)) {
      return false
    }
  }
  return true
}
