import type { DocId, OutboxSchedulerAuthGateInput } from '@kuroflare/core'
import type { OutboxAuthRefreshState } from '@kuroflare/core'
import type {
  ClientAuthMetadata,
  DeviceTokenRefreshRequest,
  SetupExchangeResponse,
} from '@kuroflare/core'
import { makeOutboxPlanItemId, hashBytesSha256 } from '@kuroflare/core'
import type { SecretStorage } from 'obsidian'

import type { KuroflareRepairLogEntry } from '../main-types'
import type { AuthRefreshHttpResult } from '../sync/auth/refresh'
import type { AuthRefreshMetadataPort } from '../sync/auth/refresh'
import type { AuthRefreshSecretStoragePort } from '../sync/auth/refresh'
import type { runAuthRefreshAttempt } from '../sync/auth/refresh'
import type { AuthRevokeMetadataPort, AuthRevokeSecretStoragePort } from '../sync/auth/revoke'
import type { LocalSetupPersistSecretStoragePort } from '../sync/engine/persist'
import type { LocalSetupMetadata, LocalSetupMetadataPutOperation } from '../sync/engine/setup'
import { LOCAL_SETUP_METADATA_KEY } from '../sync/engine/setup'
import type { QuarantineAdminAction } from '../sync/obsidian/quarantine-admin'
import {
  commitLocalStoreIndexedDbMetadataTransaction,
  planLocalStoreIndexedDbMetadataWrites,
  createLocalStoreIndexedDbMetadataDatabasePort,
} from '../sync/store/indexeddb'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  QUARANTINE_DISCARD_CONFIRMATION,
  QUARANTINE_FORCE_APPLY_CONFIRMATION,
  MAX_REPAIR_LOG_ENTRIES,
  BLOB_CACHE_PATH_PREFIX,
  AUTH_REFRESH_MARGIN_MS,
  AUTH_REFRESH_ESTIMATED_DURATION_MS,
} from './constants'

export function mergeRepairLogEntries(
  current: readonly KuroflareRepairLogEntry[],
  next: readonly KuroflareRepairLogEntry[],
): readonly KuroflareRepairLogEntry[] {
  const byId = new Map<string, KuroflareRepairLogEntry>()
  for (const entry of current) {
    byId.set(entry.id, entry)
  }
  for (const entry of next) {
    byId.set(entry.id, entry)
  }
  return [...byId.values()]
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_REPAIR_LOG_ENTRIES)
}

export function repairLogDescription(entry: KuroflareRepairLogEntry): string {
  const timestamp = new Date(entry.createdAt).toISOString()
  return entry.path === undefined
    ? `${entry.reason} at ${timestamp}`
    : `${entry.reason}: ${entry.path} at ${timestamp}`
}

export function safeLogError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecretText(error.message),
    }
  }
  return {
    name: typeof error,
    message: redactSecretText(String(error)),
  }
}

export function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'Bearer [redacted]')
    .replace(
      /kuroflare-token\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      'kuroflare-token.[redacted]',
    )
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/([?&](?:setupToken|accessToken|refreshToken|token)=)[^&#\s]+/gi, '$1[redacted]')
}

export function docIdLabel(docId: DocId): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
}

export function quarantineActionConfirmationText(action: QuarantineAdminAction): string {
  return action === 'discard'
    ? QUARANTINE_DISCARD_CONFIRMATION
    : QUARANTINE_FORCE_APPLY_CONFIRMATION
}

export function quarantineActionLabel(action: QuarantineAdminAction): string {
  return action === 'discard' ? 'Discard' : 'Force apply'
}

export function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export async function waitForIndexedDbRequest<Result>(
  request: IDBRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

export async function waitForIndexedDbDeleteDatabase(request: IDBOpenDBRequest): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB deleteDatabase failed'))
    }
    request.onblocked = () => {
      reject(new Error('IndexedDB deleteDatabase blocked by an open connection'))
    }
  })
}

export async function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

export function retryAfterMsFromHeader(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  return Math.max(0, timestamp - Date.now())
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const code = Reflect.get(body, 'code')
  if (typeof code === 'string' && code.length > 0) {
    return code
  }
  const error = Reflect.get(body, 'error')
  return typeof error === 'string' && error.length > 0 ? error : undefined
}

export function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export function binaryBlobCacheKey(
  sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
): string {
  return `${BLOB_CACHE_PATH_PREFIX}${sha256}`
}

export function requireOutboxPlanItemId(value: string): LocalStoreOutboxRecord['id'] {
  const id = makeOutboxPlanItemId(value)
  if (id === null) {
    throw new Error('outbox-plan-item-id-empty')
  }
  return id
}

export function hasPendingRunnableOutboxUpdate(
  records: readonly LocalStoreOutboxRecord[],
  docId: DocId,
): boolean {
  return records.some(
    (record) =>
      (record.status === 'pending' || record.status === 'retrying') &&
      (record.kind === 'y-update' || record.kind === 'meta-ref-update') &&
      record.docId !== undefined &&
      sameDocId(record.docId, docId),
  )
}

export function localSetupMetadataFromSetupResponse(
  response: SetupExchangeResponse,
): LocalSetupMetadata {
  return {
    endpoint: response.endpoint,
    vaultId: response.vaultId,
    deviceId: response.deviceId,
    protocolVersion: response.protocolVersion,
    bootstrapMode: response.bootstrapMode,
    tokenVersion: response.tokenVersion,
  }
}

export function accessTokenSecretKeyForSetup(setup: LocalSetupMetadata): string {
  return `kuroflare:${setup.vaultId}:${setup.deviceId}:access-token`
}

export function deviceRevokeUrl(setup: LocalSetupMetadata): string {
  const url = new URL(setup.endpoint)
  url.pathname = `/devices/${encodeURIComponent(setup.deviceId)}/revoke`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function schedulerAuthGateFromMetadata(
  metadata: ClientAuthMetadata | undefined,
): OutboxSchedulerAuthGateInput | undefined {
  if (metadata?.authState !== 'active') {
    return undefined
  }
  return {
    tokenExpiresAt: metadata.accessTokenExpiresAt ?? 0,
    refreshMarginMs: AUTH_REFRESH_MARGIN_MS,
    defaultEstimatedDurationMs: AUTH_REFRESH_ESTIMATED_DURATION_MS,
  }
}

export function outboxAuthRefreshStateFromMetadata(
  metadata: ClientAuthMetadata | undefined,
): OutboxAuthRefreshState {
  if (metadata?.authState !== 'active') {
    return { status: 'idle' }
  }
  if (metadata.refreshState === 'refreshing') {
    return { status: 'refreshing' }
  }
  if (metadata.refreshState === 'backing-off' && metadata.nextAllowedRefreshAt !== undefined) {
    return { status: 'backing-off', nextAllowedRefreshAt: metadata.nextAllowedRefreshAt }
  }
  return { status: 'idle' }
}

export function createAuthRefreshMetadataPort(
  db: IDBDatabase,
  setup: LocalSetupMetadata,
): AuthRefreshMetadataPort {
  const database = createLocalStoreIndexedDbMetadataDatabasePort(db)
  return {
    async commit(write) {
      const setupWrite: LocalSetupMetadataPutOperation = {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: { ...setup, tokenVersion: write.value.tokenVersion },
      }
      await commitLocalStoreIndexedDbMetadataTransaction({
        database,
        writes: planLocalStoreIndexedDbMetadataWrites([setupWrite, write]),
      })
    },
  }
}

export function createAuthRevokeMetadataPort(
  db: IDBDatabase,
  setup: LocalSetupMetadata,
): AuthRevokeMetadataPort {
  const database = createLocalStoreIndexedDbMetadataDatabasePort(db)
  return {
    async commit(write) {
      const setupWrite: LocalSetupMetadataPutOperation = {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: { ...setup, tokenVersion: write.value.tokenVersion },
      }
      await commitLocalStoreIndexedDbMetadataTransaction({
        database,
        writes: planLocalStoreIndexedDbMetadataWrites([setupWrite, write]),
      })
    },
  }
}

export function createObsidianAuthRevokeSecretStoragePort(
  secretStorage: SecretStorage,
): AuthRevokeSecretStoragePort {
  return {
    async delete(key) {
      secretStorage.setSecret(await obsidianSecretIdForKey(key), '')
    },
  }
}

export function createObsidianAuthRefreshSecretStoragePort(
  secretStorage: SecretStorage,
): AuthRefreshSecretStoragePort {
  return {
    async get(key) {
      const value = secretStorage.getSecret(await obsidianSecretIdForKey(key))
      return value !== null && value.length > 0 ? value : undefined
    },
    async set(key, value) {
      secretStorage.setSecret(await obsidianSecretIdForKey(key), value)
    },
    async delete(key) {
      secretStorage.setSecret(await obsidianSecretIdForKey(key), '')
    },
  }
}

export function createAuthRefreshHttpPort(setup: LocalSetupMetadata) {
  return {
    async refresh(request: DeviceTokenRefreshRequest): Promise<AuthRefreshHttpResult> {
      const url = new URL(setup.endpoint)
      url.pathname = '/auth/refresh'
      url.search = ''
      url.hash = ''
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (!response.ok) {
        return await authRefreshHttpFailure(response)
      }
      return { ok: true, response: await response.json().catch(() => undefined) }
    },
  }
}

export async function authRefreshHttpFailure(response: Response): Promise<AuthRefreshHttpResult> {
  const retryAfterMs = retryAfterMsFromHeader(response.headers.get('Retry-After'))
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { ok: false, reason: 'server-retryable', retryAfterMs }
  }
  const code = await responseErrorCode(response)
  if (code?.includes('device-revoked') === true) {
    return { ok: false, reason: 'device-revoked' }
  }
  if (response.status === 400) {
    return { ok: false, reason: 'invalid-refresh-response' }
  }
  return { ok: false, reason: 'refresh-token-rejected' }
}

export function nextAllowedRefreshAtFromFailedAuthRefresh(
  plan: Exclude<Awaited<ReturnType<typeof runAuthRefreshAttempt>>, { readonly ok: true }>,
): number | undefined {
  if (!('metadataPatch' in plan) || plan.metadataPatch?.action !== 'apply') {
    return undefined
  }
  return plan.metadataPatch.metadata.nextAllowedRefreshAt
}

export function createObsidianSecretStoragePort(
  secretStorage: SecretStorage,
): LocalSetupPersistSecretStoragePort {
  return {
    async set(key, value) {
      secretStorage.setSecret(await obsidianSecretIdForKey(key), value)
    },
    async delete(key) {
      secretStorage.setSecret(await obsidianSecretIdForKey(key), '')
    },
  }
}

export async function obsidianSecretIdForKey(key: string): Promise<string> {
  return await hashBytesSha256(new TextEncoder().encode(key))
}

export function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta' || right.kind === 'meta') {
    return true
  }
  return left.ydocId === right.ydocId
}
