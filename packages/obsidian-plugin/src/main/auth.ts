import {
  canonicalizeVaultPath,
  decideClientAuthStart,
  isClientAuthMetadata,
  makeSha256Hex,
  hashBytesSha256,
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
import type { AuthRefreshMetadataPort } from '../sync/auth/refresh.types'
import { persistLocalDeviceRevoke as persistLocalDeviceRevokeFn } from '../sync/auth/revoke'
import { LOCAL_AUTH_METADATA_KEY, type LocalSetupMetadata } from '../sync/engine/setup'
import { createLocalStoreIndexedDbMetadataDatabasePort } from '../sync/store/indexeddb'
import { readLocalStoreIndexedDbMetadataSnapshot } from '../sync/store/indexeddb'
import { waitForIndexedDbRequest, waitForIndexedDbTransaction } from '../sync/store/indexeddb/utils'
import {
  DEVICE_REVOKE_CONFIRMATION,
  AUTH_REFRESH_ESTIMATED_DURATION_MS,
  AUTH_REFRESH_MARGIN_MS,
  AUTH_REFRESH_STALE_AFTER_MS,
} from './constants'
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
  accessTokenSecretKeyForSetup,
  safeLogError,
} from './helpers'
import { metaMap, readMetaFile } from './meta'
import { scheduleOutboxWorkerTick, runOutboxWorkerTick } from './outbox/tick'
import type KuroflareSpikePlugin from './plugin'
import { createRemoteSetupAccessTokenVerifier } from './setup-verifier'

/** Minimal setup fields required to resolve the current local vault identity. */
export interface SetupMetadataSource {
  readonly pendingSetupResponse: SetupExchangeResponse | null
  readonly trustedSetupMetadata: LocalSetupMetadata | null
  readonly kuroflareSettings: Pick<KuroflareSettings, 'setupVaultId'>
}

export interface AuthRefreshRetryHost {
  authRefreshRetryTimeout: number | null
  workerWebSocketOpenPromise: Promise<void> | null
}

export interface AuthRefreshLockHost {
  authRefreshRunning: boolean
}

export function acquireAuthRefreshLock(plugin: AuthRefreshLockHost): boolean {
  if (plugin.authRefreshRunning) {
    return false
  }
  plugin.authRefreshRunning = true
  return true
}

export function releaseAuthRefreshLock(plugin: AuthRefreshLockHost): void {
  plugin.authRefreshRunning = false
}

type AuthRefreshStartupRetry = () => Promise<void>

const authRefreshStartupRetries = new WeakMap<AuthRefreshRetryHost, AuthRefreshStartupRetry>()
const authRefreshRetryDeadlines = new WeakMap<AuthRefreshRetryHost, number>()
const authRefreshStartupRetryBackoffs = new WeakMap<AuthRefreshRetryHost, number>()
const authRefreshRetryGenerations = new WeakMap<AuthRefreshRetryHost, number>()
const authRefreshRetryTimerGenerations = new WeakMap<AuthRefreshRetryHost, number>()

const AUTH_REFRESH_STARTUP_RETRY_INITIAL_DELAY_MS = 250
const AUTH_REFRESH_STARTUP_RETRY_MAX_DELAY_MS = 30_000

function authRefreshRetryGeneration(plugin: AuthRefreshRetryHost): number {
  return authRefreshRetryGenerations.get(plugin) ?? 0
}

function advanceAuthRefreshRetryGeneration(plugin: AuthRefreshRetryHost): number {
  const generation = authRefreshRetryGeneration(plugin) + 1
  authRefreshRetryGenerations.set(plugin, generation)
  return generation
}

const clientAuthMetadataKeys = [
  'deviceId',
  'authState',
  'tokenVersion',
  'accessTokenExpiresAt',
  'revokedAt',
  'refreshState',
  'refreshStartedAt',
  'retryCount',
  'nextAllowedRefreshAt',
  'accessTokenSecretKey',
  'refreshTokenSecretKey',
] as const satisfies readonly (keyof ClientAuthMetadata)[]

export function matchesClientAuthMetadata(
  current: unknown,
  expected: ClientAuthMetadata,
): current is ClientAuthMetadata {
  return (
    isClientAuthMetadata(current) &&
    clientAuthMetadataKeys.every((key) => current[key] === expected[key])
  )
}

function createConditionalAuthRefreshMetadataPort(
  db: IDBDatabase,
  expected: ClientAuthMetadata,
): AuthRefreshMetadataPort {
  const metadataDatabase = createLocalStoreIndexedDbMetadataDatabasePort(db)
  return {
    async commit(write) {
      const transaction = metadataDatabase.openMetadataTransaction('readwrite')
      const current = await waitForIndexedDbRequest(transaction.store.get(LOCAL_AUTH_METADATA_KEY))
      if (matchesClientAuthMetadata(current, expected)) {
        await waitForIndexedDbRequest(transaction.store.put(write.value, write.key))
      }
      await waitForIndexedDbTransaction(transaction.lifecycle)
    },
  }
}

export function registerAuthRefreshStartupRetry(
  plugin: AuthRefreshRetryHost,
  retry: AuthRefreshStartupRetry,
): void {
  const generation = advanceAuthRefreshRetryGeneration(plugin)
  authRefreshStartupRetries.set(plugin, retry)
  if (plugin.authRefreshRetryTimeout !== null) {
    authRefreshRetryTimerGenerations.set(plugin, generation)
  }
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
  return v.is(VaultIdSchema, plugin.kuroflareSettings.setupVaultId)
    ? plugin.kuroflareSettings.setupVaultId
    : undefined
}

export function currentSetupMetadata(plugin: SetupMetadataSource): LocalSetupMetadata | undefined {
  if (plugin.pendingSetupResponse !== null) {
    return localSetupMetadataFromSetupResponse(plugin.pendingSetupResponse)
  }
  return plugin.trustedSetupMetadata ?? undefined
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

/** Result of one auth refresh attempt used by the WebSocket preflight. */
export interface UsableAccessTokenRefreshResult {
  readonly metadata: ClientAuthMetadata
  readonly accessToken: string | undefined
}

type AuthRefreshStaleStartRecoveryPlan = Awaited<ReturnType<typeof recoverStaleAuthRefreshStartFn>>

/**
 * Resolves a persisted refresh marker before WebSocket startup.
 *
 * @param metadata - Trusted local auth metadata observed by the preflight.
 * @param recover - Recovery operation for a possibly abandoned refresh marker.
 * @param readMetadata - Reader for metadata committed by a successful recovery.
 * @param scheduleRetryAt - Scheduler used when the in-flight marker is not stale yet.
 * @returns Metadata that may continue through preflight, or `undefined` while recovery is blocked.
 */
export async function recoverAuthRefreshMetadataForPreflight(
  metadata: ClientAuthMetadata,
  recover: () => Promise<AuthRefreshStaleStartRecoveryPlan>,
  readMetadata: () => Promise<ClientAuthMetadata | undefined>,
  scheduleRetryAt: (retryAt: number) => void,
  cancelRetry: () => void,
  staleAfterMs = AUTH_REFRESH_STALE_AFTER_MS,
): Promise<ClientAuthMetadata | undefined> {
  if (metadata.refreshState !== 'refreshing') {
    return metadata
  }
  const recovery = await recover()
  if (!recovery.ok) {
    if (recovery.phase === 'recovery' && recovery.recovery.action === 'wait') {
      scheduleRetryAt(recovery.recovery.staleAt)
      const current = await readMetadata()
      if (current !== undefined) {
        if (current.refreshState !== 'refreshing') {
          cancelRetry()
          return current
        }
        if (
          current.refreshStartedAt !== undefined &&
          current.refreshStartedAt !== recovery.recovery.refreshStartedAt
        ) {
          scheduleRetryAt(current.refreshStartedAt + staleAfterMs)
        }
      }
    }
    return undefined
  }
  const current = await readMetadata()
  if (current?.refreshState === 'refreshing') {
    if (current.refreshStartedAt !== undefined) {
      scheduleRetryAt(current.refreshStartedAt + staleAfterMs)
    }
    return undefined
  }
  return current
}

/**
 * Decides whether a trusted access token can start a network session, refreshing it when required.
 *
 * @param metadata - Trusted local auth metadata for the current device.
 * @param accessToken - Access token currently held in SecretStorage.
 * @param refresh - Refresh callback that returns the post-refresh metadata and token.
 * @param now - Clock function used for deterministic expiry checks.
 * @returns Whether the token is usable for the session startup.
 */
export async function ensureUsableAccessTokenFromMetadata(
  metadata: ClientAuthMetadata,
  accessToken: string | undefined,
  refresh: (
    reason: 'token-expired' | 'token-expiring-soon',
  ) => Promise<UsableAccessTokenRefreshResult | undefined>,
  now: () => number = Date.now,
): Promise<boolean> {
  if (metadata.authState !== 'active') {
    return false
  }
  const decideStart = (candidate: ClientAuthMetadata) =>
    decideClientAuthStart({
      now: now(),
      tokenExpiresAt: candidate.accessTokenExpiresAt ?? 0,
      refreshMarginMs: AUTH_REFRESH_MARGIN_MS,
      estimatedDurationMs: AUTH_REFRESH_ESTIMATED_DURATION_MS,
    })
  const decision = decideStart(metadata)
  if (decision.action === 'reject') {
    return false
  }
  if (decision.action === 'start' && accessToken !== undefined) {
    return true
  }

  const refreshed = await refresh(
    decision.action === 'refresh-first' ? decision.reason : 'token-expired',
  )
  if (refreshed === undefined || refreshed.metadata.authState !== 'active') {
    return false
  }
  const refreshedDecision = decideStart(refreshed.metadata)
  return refreshedDecision.action === 'start' && refreshed.accessToken !== undefined
}

/**
 * Ensures a trusted active access token is usable before opening a Worker WebSocket.
 *
 * @param plugin - Plugin runtime whose local metadata and SecretStorage are authoritative.
 * @param onRefreshRetry - Optional reconnect operation scheduled after transient refresh backoff.
 * @returns Whether startup may create a socket with the current access token.
 */
export async function ensureUsableAccessToken(
  plugin: KuroflareSpikePlugin,
  onRefreshRetry?: () => Promise<void>,
): Promise<boolean> {
  const context = plugin.captureVaultOperationContext()
  if (context === undefined) return false
  const isCurrent = () => plugin.vaultOperationStillCurrent(context)
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('auth-vault-context-stale')
  }
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) {
    return false
  }

  try {
    const db = await openLocalStoreDatabase(plugin, setup.vaultId, isCurrent)
    assertCurrent()
    const readMetadata = async () => {
      assertCurrent()
      const snapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      assertCurrent()
      return snapshot
    }
    const accessTokenSecretKey = accessTokenSecretKeyForSetup(setup)

    const readTrustedMetadata = async (): Promise<ClientAuthMetadata | undefined> => {
      const snapshot = await readMetadata()
      if (!snapshot.ok) {
        console.warn('[kuroflare] websocket auth preflight skipped', {
          reason: snapshot.reason,
        })
        return undefined
      }
      if (
        snapshot.snapshot.setup.vaultId !== setup.vaultId ||
        snapshot.snapshot.setup.deviceId !== setup.deviceId
      ) {
        console.warn('[kuroflare] websocket auth preflight rejected setup mismatch')
        return undefined
      }
      const metadata = snapshot.snapshot.auth
      if (
        metadata.authState !== 'active' ||
        metadata.accessTokenSecretKey !== accessTokenSecretKey
      ) {
        return undefined
      }
      return metadata
    }

    const scheduleAuthRefreshRetryAt = (retryAt: number): void => {
      scheduleAuthRefreshRetry(plugin, Math.max(0, retryAt - Date.now()), onRefreshRetry)
    }

    const recoverRefreshingMetadata = async (
      metadata: ClientAuthMetadata,
    ): Promise<ClientAuthMetadata | undefined> =>
      await recoverAuthRefreshMetadataForPreflight(
        metadata,
        async () => await recoverStaleAuthRefreshStart(plugin, db, metadata),
        readTrustedMetadata,
        scheduleAuthRefreshRetryAt,
        () => cancelAuthRefreshStartupRetry(plugin),
        AUTH_REFRESH_STALE_AFTER_MS,
      )

    const metadata = await readTrustedMetadata()
    assertCurrent()
    if (metadata === undefined) {
      return false
    }
    const recoveredMetadata = await recoverRefreshingMetadata(metadata)
    assertCurrent()
    if (recoveredMetadata === undefined) {
      return false
    }

    const usable = await ensureUsableAccessTokenFromMetadata(
      recoveredMetadata,
      await readAccessToken(plugin, accessTokenSecretKey),
      async (reason) => {
        const currentMetadata = await readTrustedMetadata()
        if (currentMetadata === undefined) {
          return undefined
        }
        const currentRecoveredMetadata = await recoverRefreshingMetadata(currentMetadata)
        if (currentRecoveredMetadata === undefined) {
          return undefined
        }
        if (
          currentRecoveredMetadata.refreshState === 'backing-off' &&
          currentRecoveredMetadata.nextAllowedRefreshAt !== undefined &&
          currentRecoveredMetadata.nextAllowedRefreshAt > Date.now()
        ) {
          scheduleAuthRefreshRetryAt(currentRecoveredMetadata.nextAllowedRefreshAt)
          return undefined
        }
        await runAuthRefreshRequest(
          plugin,
          {
            action: 'request-refresh',
            reason,
            requestedAt: Date.now(),
            blockedItemIds: [],
          },
          onRefreshRetry,
        )
        const refreshedSnapshot = await readMetadata()
        if (!refreshedSnapshot.ok) {
          return undefined
        }
        const refreshedMetadata = refreshedSnapshot.snapshot.auth
        if (
          refreshedMetadata.authState !== 'active' ||
          refreshedMetadata.accessTokenSecretKey !== accessTokenSecretKey
        ) {
          return undefined
        }
        return {
          metadata: refreshedMetadata,
          accessToken: await readAccessToken(plugin, accessTokenSecretKey),
        }
      },
    )
    return isCurrent() && usable
  } catch (error: unknown) {
    console.warn('[kuroflare] websocket auth preflight failed', { error: safeLogError(error) })
    return false
  }
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
    const value = readMetaFile(metaMap(plugin), fileId)
    if (value !== undefined && value.type === 'text') {
      return { kind: 'file', ydocId: value.ydocId }
    }
  }
  const hash = makeSha256Hex(await sha256Hex(plugin, new TextEncoder().encode(path)))
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

export function nextWorkerMessageId(
  plugin: Pick<KuroflareSpikePlugin, 'workerMessageCounter'>,
): string {
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
  for (const [fileId] of metaMap(plugin).entries()) {
    const value = readMetaFile(metaMap(plugin), fileId)
    if (value !== undefined && !value.deleted && value.canonicalPath === canonical) {
      return value.fileId
    }
  }
  return undefined
}

export function findMetaFileIdForDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
): FileId | undefined {
  for (const [fileId] of metaMap(plugin).entries()) {
    const value = readMetaFile(metaMap(plugin), fileId)
    if (value !== undefined && value.type === 'text' && value.ydocId === docId.ydocId) {
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
  cancelAuthRefreshStartupRetry(plugin)
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
  if (!acquireAuthRefreshLock(plugin)) {
    new Notice('Kuroflare auth: another auth operation is already running')
    return
  }
  try {
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
  } finally {
    releaseAuthRefreshLock(plugin)
  }
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
  stopLocalSyncAfterAuthBlocked(plugin, 'revoked')
  new Notice('Kuroflare auth: this device was revoked and sync is stopped')
}

export async function recoverStaleAuthRefreshStart(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metadata: ClientAuthMetadata,
): Promise<Awaited<ReturnType<typeof recoverStaleAuthRefreshStartFn>>> {
  const recovery = await recoverStaleAuthRefreshStartFn({
    metadata,
    now: Date.now(),
    staleAfterMs: AUTH_REFRESH_STALE_AFTER_MS,
    metadataStore: createConditionalAuthRefreshMetadataPort(db, metadata),
  })
  if (!recovery.ok && recovery.phase !== 'recovery') {
    console.warn('[kuroflare] stale auth refresh recovery failed', { phase: recovery.phase })
  }
  return recovery
}

export async function runAuthRefreshRequest(
  plugin: KuroflareSpikePlugin,
  request: OutboxAuthRefreshRequestDecision,
  onRefreshRetry?: () => Promise<void>,
): Promise<void> {
  if (request.action !== 'request-refresh' || !acquireAuthRefreshLock(plugin)) {
    return
  }
  const context = plugin.captureVaultOperationContext()
  if (context === undefined) {
    releaseAuthRefreshLock(plugin)
    return
  }
  let completeRefresh!: () => void
  const completion = new Promise<void>((resolve) => {
    completeRefresh = resolve
  })
  plugin.authRefreshCompletionPromise = completion
  const isCurrent = () => plugin.vaultOperationStillCurrent(context)
  try {
    const setup = requireSetupMetadata(plugin)
    const db = await openLocalStoreDatabase(plugin, setup.vaultId, isCurrent)
    if (!isCurrent()) return
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (!isCurrent()) return
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
    if (!isCurrent()) return
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
    if (!isCurrent()) return
    if (attempt.ok) {
      plugin.syncStoppedByAuth = null
      plugin.pendingOutboxResumeEvents.push(attempt.emitResumeEvent)
      const refreshedSetup = { ...setup, tokenVersion: attempt.response.tokenVersion }
      plugin.trustedSetupMetadata = refreshedSetup
      plugin.syncStatusEl?.setText(`Kuroflare sync: auth refreshed ${setup.vaultId}`)
      scheduleOutboxWorkerTick(plugin, 0, 'auth-refresh')
      notifyAuthRefreshStartupRetry(plugin)
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
      scheduleAuthRefreshRetry(
        plugin,
        Math.max(0, nextAllowedRefreshAt - Date.now()),
        onRefreshRetry,
      )
    }
  } finally {
    completeRefresh()
    if (plugin.authRefreshCompletionPromise === completion) {
      plugin.authRefreshCompletionPromise = null
    }
    releaseAuthRefreshLock(plugin)
  }
}

export function scheduleAuthRefreshRetry(
  plugin: KuroflareSpikePlugin,
  delayMs: number,
  onRefreshRetry?: () => Promise<void>,
): void {
  if (onRefreshRetry !== undefined) {
    registerAuthRefreshStartupRetry(plugin, onRefreshRetry)
  }
  scheduleAuthRefreshRetryTimer(plugin, delayMs, () => {
    void runOutboxWorkerTick(plugin, 'auth-refresh-backoff')
  })
}

function scheduleAuthRefreshRetryTimer(
  plugin: AuthRefreshRetryHost,
  delayMs: number,
  fallback: () => void,
): void {
  const delay = Math.max(0, delayMs)
  const deadline = Date.now() + delay
  const generation = authRefreshRetryGeneration(plugin)
  const existingDeadline = authRefreshRetryDeadlines.get(plugin)
  if (plugin.authRefreshRetryTimeout !== null) {
    if (existingDeadline !== undefined && existingDeadline <= deadline) {
      authRefreshRetryTimerGenerations.set(plugin, generation)
      return
    }
    window.clearTimeout(plugin.authRefreshRetryTimeout)
    plugin.authRefreshRetryTimeout = null
    authRefreshRetryTimerGenerations.delete(plugin)
  }
  authRefreshRetryDeadlines.set(plugin, deadline)
  authRefreshRetryTimerGenerations.set(plugin, generation)
  plugin.authRefreshRetryTimeout = window.setTimeout(() => {
    const timerGeneration = authRefreshRetryTimerGenerations.get(plugin)
    if (timerGeneration === undefined || authRefreshRetryGeneration(plugin) !== timerGeneration) {
      return
    }
    plugin.authRefreshRetryTimeout = null
    authRefreshRetryDeadlines.delete(plugin)
    authRefreshRetryTimerGenerations.delete(plugin)
    const startupRetry = authRefreshStartupRetries.get(plugin)
    if (startupRetry !== undefined) {
      authRefreshStartupRetries.delete(plugin)
      invokeAuthRefreshStartupRetry(plugin, startupRetry)
      return
    }
    fallback()
  }, delay)
}

export function notifyAuthRefreshStartupRetry(plugin: AuthRefreshRetryHost): void {
  const startupRetry = authRefreshStartupRetries.get(plugin)
  if (startupRetry === undefined) {
    return
  }
  authRefreshStartupRetries.delete(plugin)
  if (plugin.authRefreshRetryTimeout !== null) {
    window.clearTimeout(plugin.authRefreshRetryTimeout)
    plugin.authRefreshRetryTimeout = null
  }
  authRefreshRetryDeadlines.delete(plugin)
  authRefreshRetryTimerGenerations.delete(plugin)
  invokeAuthRefreshStartupRetry(plugin, startupRetry)
}

function invokeAuthRefreshStartupRetry(
  plugin: AuthRefreshRetryHost,
  startupRetry: AuthRefreshStartupRetry,
): void {
  const generation = authRefreshRetryGeneration(plugin)
  const runStartupRetry = async (): Promise<void> => {
    try {
      await startupRetry()
      if (authRefreshRetryGeneration(plugin) !== generation) {
        return
      }
      authRefreshStartupRetryBackoffs.delete(plugin)
    } catch (error: unknown) {
      if (authRefreshRetryGeneration(plugin) !== generation) {
        return
      }
      console.warn('[kuroflare] auth refresh retry failed', { error: safeLogError(error) })
      authRefreshStartupRetries.set(plugin, startupRetry)
      const previousDelay =
        authRefreshStartupRetryBackoffs.get(plugin) ?? AUTH_REFRESH_STARTUP_RETRY_INITIAL_DELAY_MS
      const nextDelay = Math.min(AUTH_REFRESH_STARTUP_RETRY_MAX_DELAY_MS, previousDelay * 2)
      authRefreshStartupRetryBackoffs.set(plugin, nextDelay)
      scheduleAuthRefreshRetryTimer(plugin, previousDelay, () => undefined)
    }
  }
  const inFlightOpen = plugin.workerWebSocketOpenPromise
  if (inFlightOpen !== null) {
    void inFlightOpen.then(runStartupRetry, runStartupRetry)
    return
  }
  void runStartupRetry()
}

export function cancelAuthRefreshStartupRetry(plugin: AuthRefreshRetryHost): void {
  advanceAuthRefreshRetryGeneration(plugin)
  authRefreshStartupRetries.delete(plugin)
  authRefreshStartupRetryBackoffs.delete(plugin)
  if (plugin.authRefreshRetryTimeout !== null) {
    window.clearTimeout(plugin.authRefreshRetryTimeout)
    plugin.authRefreshRetryTimeout = null
  }
  authRefreshRetryDeadlines.delete(plugin)
  authRefreshRetryTimerGenerations.delete(plugin)
}
