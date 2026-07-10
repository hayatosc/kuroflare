import { v } from 'valibot'
import { Y } from 'yjs'

import type KuroflareSpikePlugin from './plugin'

export async function runAuthRefreshRequest(
  plugin: KuroflareSpikePlugin,
  request: OutboxAuthRefreshRequestDecision,
): Promise<void> {
  if (request.action !== 'request-refresh' || plugin.authRefreshRunning) {
    return
  }
  plugin.authRefreshRunning = true
  try {
    const setup = plugin.requireSetupMetadata()
    const db = await plugin.openLocalStoreDatabase(setup.vaultId)
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (!metadataSnapshot.ok) {
      console.warn('[kuroflare] auth refresh skipped without trusted metadata', {
        reason: metadataSnapshot.reason,
      })
      return
    }

    const metadataStore = createAuthRefreshMetadataPort(db, metadataSnapshot.snapshot.setup)
    const start = await persistAuthRefreshStart({
      metadata: metadataSnapshot.snapshot.auth,
      request,
      metadataStore,
    })
    if (!start.ok) {
      console.warn('[kuroflare] auth refresh start rejected', { phase: start.phase })
      return
    }

    const attempt = await runAuthRefreshAttempt({
      endpoint: setup.endpoint,
      vaultId: setup.vaultId,
      metadata: start.refreshStart.metadata,
      requiredScopes: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
      now: Date.now(),
      secretStorage: createObsidianAuthRefreshSecretStoragePort(plugin.app.secretStorage),
      http: createAuthRefreshHttpPort(setup),
      verifier: {
        async verify(accessToken) {
          return parseAccessTokenClaimsFromJwt(accessToken)
        },
      },
      metadataStore,
    })
    if (attempt.ok) {
      plugin.syncStoppedByAuth = null
      plugin.pendingOutboxResumeEvents.push(attempt.emitResumeEvent)
      const refreshedSetup = { ...setup, tokenVersion: attempt.response.tokenVersion }
      plugin.trustedSetupMetadata = refreshedSetup
      await plugin.updateSettings({
        setupMetadata: refreshedSetup,
      })
      plugin.syncStatusEl?.setText(`Kuroflare sync: auth refreshed ${setup.vaultId}`)
      plugin.scheduleOutboxWorkerTick(0, 'auth-refresh')
      return
    }
    console.warn('[kuroflare] auth refresh attempt failed', { phase: attempt.phase })
    if (
      'metadataPatch' in attempt &&
      attempt.metadataPatch?.action === 'apply' &&
      attempt.metadataPatch.metadata.authState !== 'active'
    ) {
      plugin.stopLocalSyncAfterAuthBlocked(attempt.metadataPatch.metadata.authState)
      return
    }
    const nextAllowedRefreshAt = nextAllowedRefreshAtFromFailedAuthRefresh(attempt)
    if (nextAllowedRefreshAt !== undefined) {
      plugin.scheduleAuthRefreshRetry(Math.max(0, nextAllowedRefreshAt - Date.now()))
    }
  } finally {
    plugin.authRefreshRunning = false
  }
}

export function scheduleAuthRefreshRetry(plugin: KuroflareSpikePlugin, delayMs: number): void {
  if (plugin.authRefreshRetryTimeout !== null) {
    return
  }
  plugin.authRefreshRetryTimeout = window.setTimeout(() => {
    plugin.authRefreshRetryTimeout = null
    void plugin.runOutboxWorkerTick('auth-refresh-backoff')
  }, delayMs)
}

export async function revokeCurrentDeviceAfterConfirmation(
  plugin: KuroflareSpikePlugin,
  confirmation: string,
): Promise<void> {
  if (confirmation.trim() !== DEVICE_REVOKE_CONFIRMATION) {
    new Notice(`Kuroflare auth: type ${DEVICE_REVOKE_CONFIRMATION} to revoke this device`)
    return
  }
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare auth: setup metadata is missing')
    return
  }
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
    database: createLocalStoreIndexedDbMetadataDatabasePort(db),
  })
  if (!metadataSnapshot.ok) {
    new Notice('Kuroflare auth: local auth metadata is missing')
    console.warn('[kuroflare] device revoke skipped without trusted metadata', {
      reason: metadataSnapshot.reason,
    })
    return
  }
  const accessTokenSecretKey = metadataSnapshot.snapshot.auth.accessTokenSecretKey
  const accessToken =
    accessTokenSecretKey === undefined
      ? undefined
      : await plugin.readAccessToken(accessTokenSecretKey)
  if (accessToken === undefined) {
    new Notice('Kuroflare auth: access token is missing')
    return
  }

  const response = await fetch(deviceRevokeUrl(setup), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: 'obsidian-plugin-self-revoke' }),
  })
  if (!response.ok) {
    new Notice(`Kuroflare auth: revoke failed (${response.status})`)
    console.warn('[kuroflare] device revoke failed', { status: response.status })
    return
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(RevokeDeviceResponseSchema, body)) {
    new Notice('Kuroflare auth: invalid revoke response')
    console.warn('[kuroflare] device revoke response rejected by guard')
    return
  }

  await plugin.persistLocalDeviceRevoke(
    db,
    metadataSnapshot.snapshot.auth,
    body,
    metadataSnapshot.snapshot.setup,
  )
}

export async function persistLocalDeviceRevoke_Method(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metadata: ClientAuthMetadata,
  response: unknown,
  setup: LocalSetupMetadata,
): Promise<void> {
  const result = await persistLocalDeviceRevoke({
    response,
    metadata,
    secretStorage: createObsidianAuthRevokeSecretStoragePort(plugin.app.secretStorage),
    metadataStore: createAuthRevokeMetadataPort(db, setup),
  })
  if (!result.ok) {
    new Notice(`Kuroflare auth: local revoke failed (${result.phase})`)
    console.warn('[kuroflare] local device revoke failed', { phase: result.phase })
    return
  }
  const revokedSetup = { ...setup, tokenVersion: result.response.tokenVersion }
  plugin.trustedSetupMetadata = revokedSetup
  await plugin.updateSettings({
    setupMetadata: revokedSetup,
  })
  plugin.stopLocalSyncAfterAuthBlocked('revoked')
  new Notice('Kuroflare auth: this device was revoked and sync is stopped')
}

export function stopLocalSyncAfterAuthBlocked(
  plugin: KuroflareSpikePlugin,
  reason: ClientAuthMetadata['authState'],
): void {
  plugin.workerWebSocketSession.close(1000, reason)
  plugin.syncStoppedByAuth = reason
  plugin.workerHelloAccepted = false
  plugin.workerWebSocketStartupPort = null
  plugin.pendingOutboxResumeEvents = []
  if (plugin.outboxWorkerRetryTimeout !== null) {
    window.clearTimeout(plugin.outboxWorkerRetryTimeout)
    plugin.outboxWorkerRetryTimeout = null
  }
  if (plugin.authRefreshRetryTimeout !== null) {
    window.clearTimeout(plugin.authRefreshRetryTimeout)
    plugin.authRefreshRetryTimeout = null
  }
  plugin.syncStatusEl?.setText(`Kuroflare sync: ${reason}`)
}

export async function readAccessToken(
  plugin: KuroflareSpikePlugin,
  key: string,
): Promise<string | undefined> {
  const value = plugin.app.secretStorage.getSecret(await obsidianSecretIdForKey(key))
  return value !== null && value.length > 0 ? value : undefined
}

export function currentSetupMetadata(plugin: KuroflareSpikePlugin): LocalSetupMetadata | undefined {
  if (plugin.pendingSetupResponse !== null) {
    return localSetupMetadataFromSetupResponse(plugin.pendingSetupResponse)
  }
  return plugin.trustedSetupMetadata ?? plugin.kuroflareSettings.setupMetadata
}

export function requireSetupMetadata(plugin: KuroflareSpikePlugin): LocalSetupMetadata {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    throw new Error('setup-metadata-missing')
  }
  return setup
}

export function currentSetupDeviceId(plugin: KuroflareSpikePlugin): DeviceId | undefined {
  return plugin.currentSetupMetadata()?.deviceId
}

export function currentSetupVaultIdHint(
  plugin: KuroflareSpikePlugin,
): LocalSetupMetadata['vaultId'] | undefined {
  if (plugin.pendingSetupResponse !== null) {
    return plugin.pendingSetupResponse.vaultId
  }
  if (plugin.trustedSetupMetadata !== null) {
    return plugin.trustedSetupMetadata.vaultId
  }
  if (plugin.kuroflareSettings.setupMetadata !== undefined) {
    return plugin.kuroflareSettings.setupMetadata.vaultId
  }
  return v.is(VaultIdSchema, plugin.kuroflareSettings.setupVaultId)
    ? plugin.kuroflareSettings.setupVaultId
    : undefined
}

export async function readLocalSetupMetadataSnapshot(plugin: KuroflareSpikePlugin) {
  const vaultId = plugin.currentSetupVaultIdHint()
  if (vaultId === undefined) {
    return undefined
  }
  try {
    const db = await plugin.openLocalStoreDatabase(vaultId)
    const snapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (snapshot.ok) {
      plugin.trustedSetupMetadata = snapshot.snapshot.setup
      if (
        !sameLocalSetupMetadata(plugin.kuroflareSettings.setupMetadata, snapshot.snapshot.setup)
      ) {
        await plugin.updateSettings({ setupMetadata: snapshot.snapshot.setup })
      }
      return snapshot
    }
    // No prior completed setup is cached in settings, so a device that has
    // never persisted local metadata for this vaultId hint is a normal
    // first-time join/bootstrap, not a corrupted local state to reject.
    if (
      snapshot.reason === 'missing-setup-metadata' &&
      plugin.kuroflareSettings.setupMetadata === undefined
    ) {
      return undefined
    }
    return snapshot
  } catch (error: unknown) {
    console.warn('[kuroflare] failed to read local setup metadata', {
      error: safeLogError(error),
    })
    return undefined
  }
}

export async function persistPendingSetupResponse(plugin: KuroflareSpikePlugin): Promise<void> {
  const response = plugin.pendingSetupResponse
  if (response === null) {
    throw new Error('setup-response-missing')
  }
  const accessTokenExpiresAt = accessTokenExpiresAtFromJwt(response.accessToken)
  if (accessTokenExpiresAt === undefined) {
    throw new Error('setup-access-token-expiry-missing')
  }
  const db = await plugin.openLocalStoreDatabase(response.vaultId)
  const port = createSyncRuntimeSetupPersistStepPort({
    response,
    accessTokenExpiresAt,
    secretKeyPrefix: 'kuroflare',
    secretStorage: createObsidianSecretStoragePort(plugin.app.secretStorage),
    metadata: createLocalSetupPersistIndexedDbMetadataPort(
      createLocalStoreIndexedDbMetadataDatabasePort(db),
    ),
  })
  await port.persistSetupResponse({
    kind: 'run-startup-step',
    vaultId: response.vaultId,
    step: 'persist-setup-response',
    phase: 'setup',
  })
  plugin.pendingSetupResponse = null
  const setupMetadata = localSetupMetadataFromSetupResponse(response)
  plugin.trustedSetupMetadata = setupMetadata
  await plugin.updateSettings({
    endpoint: response.endpoint,
    setupVaultId: response.vaultId,
    setupToken: '',
    setupMetadata,
  })
}

export async function loadIndexedDbYDocs(plugin: KuroflareSpikePlugin): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    return
  }
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const transaction = db.transaction(['meta-ydoc', 'file-ydocs'], 'readonly')
  const metaRequest = transaction.objectStore('meta-ydoc').get('meta')
  const fileRequest = transaction.objectStore('file-ydocs').getAll()
  const [metaRecord, fileRecords] = await Promise.all([
    waitForIndexedDbRequest(metaRequest),
    waitForIndexedDbRequest(fileRequest),
  ])
  await waitForIndexedDbTransaction(transaction)

  if (isStoredYDocRecord(metaRecord) && metaRecord.docId.kind === 'meta') {
    Y.applyUpdate(plugin.metaDoc, metaRecord.updateBytes, WORKER_ORIGIN)
  }
  for (const record of fileRecords) {
    if (!isStoredYDocRecord(record) || record.docId.kind !== 'file') {
      continue
    }
    const loaded = await plugin.loadTextDoc(record.docId)
    Y.applyUpdate(loaded.doc, record.updateBytes, WORKER_ORIGIN)
  }
}

export async function recoverStaleAuthRefreshStart_Method(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metadata: ClientAuthMetadata,
): Promise<void> {
  const recovery = await recoverStaleAuthRefreshStart({
    metadata,
    now: Date.now(),
    staleAfterMs: AUTH_REFRESH_STALE_AFTER_MS,
    metadataStore: createAuthRefreshMetadataPort(db, plugin.requireSetupMetadata()),
  })
  if (!recovery.ok && recovery.phase !== 'recovery') {
    console.warn('[kuroflare] stale auth refresh recovery failed', { phase: recovery.phase })
  }
}

export function findActiveFileId(plugin: KuroflareSpikePlugin, path: string): FileId | undefined {
  const canonical = canonicalizeVaultPath(path)
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (isMetaFile(value, fileId) && !value.deleted && value.canonicalPath === canonical) {
      return value.fileId
    }
  }
  return undefined
}

export function findMetaFileIdForDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
): FileId | undefined {
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (isMetaFile(value, fileId) && value.ydocId === docId.ydocId) {
      return value.fileId
    }
  }
  return undefined
}
