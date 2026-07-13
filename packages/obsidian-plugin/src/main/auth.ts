import {
  canonicalizeVaultPath,
  makeSha256Hex,
  hashBytesSha256,
  isMetaFile,
  type DeviceId,
  type ClientAuthMetadata,
  type DocId,
  type FileId,
  type SetupExchangeResponse,
  VaultIdSchema,
  RevokeDeviceResponseSchema,
} from '@kuroflare/core'
import type { OutboxAuthRefreshRequestDecision } from '@kuroflare/core'
import { Notice } from 'obsidian'
import * as v from 'valibot'

import type { FileDocId, KuroflareSettings } from '../main-types'
import {
  recoverStaleAuthRefreshStart as recoverStaleAuthRefreshStartFn,
  runAuthRefreshAttempt,
  persistAuthRefreshStart,
} from '../sync/auth/refresh'
import { persistLocalDeviceRevoke as persistLocalDeviceRevokeFn } from '../sync/auth/revoke'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import { createLocalStoreIndexedDbMetadataDatabasePort } from '../sync/store/indexeddb'
import { readLocalStoreIndexedDbMetadataSnapshot } from '../sync/store/indexeddb'
import { DEVICE_REVOKE_CONFIRMATION, AUTH_REFRESH_STALE_AFTER_MS } from './constants'
import {
  localSetupMetadataFromSetupResponse,
  deviceRevokeUrl,
  createAuthRefreshMetadataPort,
  createAuthRevokeMetadataPort,
  createObsidianAuthRevokeSecretStoragePort,
  createObsidianAuthRefreshSecretStoragePort,
  createAuthRefreshHttpPort,
  nextAllowedRefreshAtFromFailedAuthRefresh,
  obsidianSecretIdForKey,
} from './helpers'
import { metaMap } from './meta'
import { scheduleOutboxWorkerTick, runOutboxWorkerTick } from './outbox'
import type KuroflareSpikePlugin from './plugin'
import { createRemoteSetupAccessTokenVerifier } from './setup-verifier'

/** Minimal setup fields required to resolve the current local vault identity. */
export interface SetupMetadataSource {
  readonly pendingSetupResponse: SetupExchangeResponse | null
  readonly trustedSetupMetadata: LocalSetupMetadata | null
  readonly kuroflareSettings: Pick<KuroflareSettings, 'setupMetadata' | 'setupVaultId'>
}
import { openLocalStoreDatabase } from './store'

export function currentSetupDeviceId(plugin: SetupMetadataSource): DeviceId | undefined {
  return currentSetupMetadata(plugin)?.deviceId
}

export function currentSetupVaultIdHint(
  plugin: SetupMetadataSource,
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

export function currentSetupMetadata(plugin: SetupMetadataSource): LocalSetupMetadata | undefined {
  if (plugin.pendingSetupResponse !== null) {
    return localSetupMetadataFromSetupResponse(plugin.pendingSetupResponse)
  }
  return plugin.trustedSetupMetadata ?? plugin.kuroflareSettings.setupMetadata
}

export function requireSetupMetadata(plugin: SetupMetadataSource): LocalSetupMetadata {
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) {
    throw new Error('setup-metadata-missing')
  }
  return setup
}

export async function readAccessToken(
  plugin: KuroflareSpikePlugin,
  key: string,
): Promise<string | undefined> {
  const value = plugin.app.secretStorage.getSecret(await obsidianSecretIdForKey(key))
  return value !== null && value.length > 0 ? value : undefined
}

export async function activeDocId(plugin: KuroflareSpikePlugin): Promise<DocId> {
  const path = plugin.activeFile?.path ?? plugin.targetPath ?? 'active-file.md'
  return await fileDocIdForPath(plugin, path)
}

export async function fileDocIdForPath(
  plugin: Pick<KuroflareSpikePlugin, 'metaDoc'>,
  path: string,
): Promise<FileDocId> {
  const fileId = findActiveFileId(plugin, path)
  if (fileId !== undefined) {
    const value = metaMap(plugin).get(fileId)
    if (isMetaFile(value, fileId) && value.type === 'text') {
      return { kind: 'file', ydocId: value.ydocId }
    }
  }
  const hash = makeSha256Hex(await sha256Hex(plugin, new TextEncoder().encode(path)))
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

export function nextWorkerMessageId(plugin: KuroflareSpikePlugin): string {
  plugin.workerMessageCounter += 1
  return `msg-${Date.now().toString(36)}-${plugin.workerMessageCounter.toString(36)}`
}

export async function sha256Hex(_plugin: unknown, bytes: Uint8Array): Promise<string> {
  return await hashBytesSha256(bytes)
}

export function findActiveFileId(
  plugin: Pick<KuroflareSpikePlugin, 'metaDoc'>,
  path: string,
): FileId | undefined {
  const canonical = canonicalizeVaultPath(path)
  for (const [fileId, value] of metaMap(plugin).entries()) {
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
  for (const [fileId, value] of metaMap(plugin).entries()) {
    if (isMetaFile(value, fileId) && value.ydocId === docId.ydocId) {
      return value.fileId
    }
  }
  return undefined
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

export async function revokeCurrentDeviceAfterConfirmation(
  plugin: KuroflareSpikePlugin,
  confirmation: string,
): Promise<void> {
  if (confirmation.trim() !== DEVICE_REVOKE_CONFIRMATION) {
    new Notice(`Kuroflare auth: type ${DEVICE_REVOKE_CONFIRMATION} to revoke this device`)
    return
  }
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) {
    new Notice('Kuroflare auth: setup metadata is missing')
    return
  }
  const db = await openLocalStoreDatabase(plugin, setup.vaultId)
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
      : await readAccessToken(plugin, accessTokenSecretKey)
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

  await persistLocalDeviceRevoke(
    plugin,
    db,
    metadataSnapshot.snapshot.auth,
    body,
    metadataSnapshot.snapshot.setup,
  )
}

async function persistLocalDeviceRevoke(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metadata: ClientAuthMetadata,
  response: unknown,
  setup: LocalSetupMetadata,
): Promise<void> {
  const result = await persistLocalDeviceRevokeFn({
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
  await plugin.updateSettings({ setupMetadata: revokedSetup })
  stopLocalSyncAfterAuthBlocked(plugin, 'revoked')
  new Notice('Kuroflare auth: this device was revoked and sync is stopped')
}

export async function recoverStaleAuthRefreshStart(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metadata: ClientAuthMetadata,
): Promise<void> {
  const recovery = await recoverStaleAuthRefreshStartFn({
    metadata,
    now: Date.now(),
    staleAfterMs: AUTH_REFRESH_STALE_AFTER_MS,
    metadataStore: createAuthRefreshMetadataPort(db, requireSetupMetadata(plugin)),
  })
  if (!recovery.ok && recovery.phase !== 'recovery') {
    console.warn('[kuroflare] stale auth refresh recovery failed', { phase: recovery.phase })
  }
}

export async function runAuthRefreshRequest(
  plugin: KuroflareSpikePlugin,
  request: OutboxAuthRefreshRequestDecision,
): Promise<void> {
  if (request.action !== 'request-refresh' || plugin.authRefreshRunning) {
    return
  }
  plugin.authRefreshRunning = true
  try {
    const setup = requireSetupMetadata(plugin)
    const db = await openLocalStoreDatabase(plugin, setup.vaultId)
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
      verifier: createRemoteSetupAccessTokenVerifier({
        endpoint: setup.endpoint,
        fetch: (input, init) => fetch(input, init),
      }),
      metadataStore,
    })
    if (attempt.ok) {
      plugin.syncStoppedByAuth = null
      plugin.pendingOutboxResumeEvents.push(attempt.emitResumeEvent)
      const refreshedSetup = { ...setup, tokenVersion: attempt.response.tokenVersion }
      plugin.trustedSetupMetadata = refreshedSetup
      await plugin.updateSettings({ setupMetadata: refreshedSetup })
      plugin.syncStatusEl?.setText(`Kuroflare sync: auth refreshed ${setup.vaultId}`)
      scheduleOutboxWorkerTick(plugin, 0, 'auth-refresh')
      return
    }
    console.warn('[kuroflare] auth refresh attempt failed', { phase: attempt.phase })
    if (
      'metadataPatch' in attempt &&
      attempt.metadataPatch?.action === 'apply' &&
      attempt.metadataPatch.metadata.authState !== 'active'
    ) {
      stopLocalSyncAfterAuthBlocked(plugin, attempt.metadataPatch.metadata.authState)
      return
    }
    const nextAllowedRefreshAt = nextAllowedRefreshAtFromFailedAuthRefresh(attempt)
    if (nextAllowedRefreshAt !== undefined) {
      scheduleAuthRefreshRetry(plugin, Math.max(0, nextAllowedRefreshAt - Date.now()))
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
    void runOutboxWorkerTick(plugin, 'auth-refresh-backoff')
  }, delayMs)
}
