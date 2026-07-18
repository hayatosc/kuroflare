import {
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotImportResponseSchema,
  hashBytesSha256,
  type DocId,
  type OutboxPlanItemId,
  type Sha256Hex,
} from '@kuroflare/core'
import * as v from 'valibot'

import { isLocalStoreOutboxRecord } from '../../main/guards'
import { waitForIndexedDbRequest, waitForIndexedDbTransaction } from '../../main/helpers'
import {
  planOutboundQueueSyncUpdateRejectedRepair,
  type OutboundQueueSyncUpdateRejectedRepairPlan,
} from '../engine/queue'
import type { LocalSetupMetadata } from '../engine/setup'
import {
  commitLocalStoreIndexedDbDatabaseTransaction,
  createLocalStoreIndexedDbDatabasePort,
} from '../store/indexeddb'
import { type LocalStoreOutboxRecord } from '../store/store'
import { planLocalStoreSyncUpdateRejectedRepairTransaction } from '../store/store'

/** HTTP boundary used by the explicit rejected-update repair action. */
export interface RejectedUpdateRepairHttpPort {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
}

/** A paused outbox row eligible for explicit rejected-update repair. */
export type PausedRejectedUpdate = LocalStoreOutboxRecord

/** Result of listing paused rejected updates. */
export interface RejectedUpdateRepairListResult {
  readonly entries: readonly PausedRejectedUpdate[]
}

/** Exact local evidence passed to the authenticated snapshot import adapter. */
export interface RejectedUpdateRepairRemoteRow {
  readonly kind: 'y-update' | 'meta-ref-update'
  readonly docId: DocId
  readonly updateSha256: Sha256Hex
  readonly rejectionUpdateSha256: Sha256Hex
  readonly rejectionReason: 'large-update-requires-snapshot-import'
  readonly rejectionRetryable: false
  readonly updateBytesBase64: string
  readonly metadataSchemaVersion?: 2 | undefined
}

/** Result of the remote import before local outbox completion. */
export type RejectedUpdateRepairRemoteResult =
  | { readonly ok: true; readonly snapshotSeq: number }
  | {
      readonly ok: false
      readonly reason:
        | 'hash-mismatch'
        | 'auth-failed'
        | 'network-failed'
        | 'latest-snapshot-failed'
        | 'invalid-latest-response'
        | 'conflict'
        | 'import-failed'
        | 'invalid-import-response'
      readonly status?: number | undefined
    }

/** Result of one explicit rejected-update repair attempt. */
export type RejectedUpdateRepairResult =
  | {
      readonly ok: true
      readonly itemId: OutboxPlanItemId
      readonly snapshotSeq: number
    }
  | {
      readonly ok: false
      readonly itemId: OutboxPlanItemId
      readonly reason:
        | 'missing-row'
        | 'invalid-evidence'
        | 'hash-mismatch'
        | 'auth-failed'
        | 'network-failed'
        | 'latest-snapshot-failed'
        | 'invalid-latest-response'
        | 'conflict'
        | 'import-failed'
        | 'invalid-import-response'
        | 'local-commit-failed'
      readonly status?: number | undefined
    }

/** Lists only paused rows produced by a guarded sync-update rejection. */
export function listPausedRejectedUpdates(
  records: readonly LocalStoreOutboxRecord[],
): RejectedUpdateRepairListResult {
  return {
    entries: records.filter((record) => planRepairCompletion(record).ok),
  }
}

/**
 * Imports one exact rejected Yjs delta and then completes only its matching outbox row.
 * The remote import is deliberately performed before the local guarded transaction.
 */
export async function repairPausedRejectedUpdate(input: {
  readonly db: IDBDatabase
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly http: RejectedUpdateRepairHttpPort
}): Promise<RejectedUpdateRepairResult> {
  let row: LocalStoreOutboxRecord | undefined
  try {
    row = await readOutboxRow(input.db, input.itemId)
  } catch {
    return { ok: false, itemId: input.itemId, reason: 'local-commit-failed' }
  }
  if (row === undefined) return { ok: false, itemId: input.itemId, reason: 'missing-row' }

  const plan = planRepairCompletion(row)
  if (!plan.ok) {
    return { ok: false, itemId: input.itemId, reason: 'invalid-evidence' }
  }
  const evidence = plan.expected
  if (input.accessToken.trim().length === 0) {
    return { ok: false, itemId: input.itemId, reason: 'auth-failed' }
  }

  const importResponse = await repairRejectedUpdateRemote({
    setup: input.setup,
    accessToken: input.accessToken,
    row: {
      ...evidence,
      ...(row.docId?.kind === 'meta' ? { metadataSchemaVersion: 2 as const } : {}),
    },
    http: input.http,
  })
  if (!importResponse.ok) {
    return { itemId: input.itemId, ...importResponse }
  }

  const importedPlan = planRepairCompletion(row, importResponse.snapshotSeq)
  if (!importedPlan.ok) {
    return { ok: false, itemId: input.itemId, reason: 'invalid-evidence' }
  }
  try {
    const transaction = await commitLocalStoreIndexedDbDatabaseTransaction({
      database: createLocalStoreIndexedDbDatabasePort(input.db),
      operations: planLocalStoreSyncUpdateRejectedRepairTransaction(importedPlan),
    })
    if (!transaction.ok) {
      return { ok: false, itemId: input.itemId, reason: 'local-commit-failed' }
    }
  } catch {
    return { ok: false, itemId: input.itemId, reason: 'local-commit-failed' }
  }

  return { ok: true, itemId: input.itemId, snapshotSeq: importResponse.snapshotSeq }
}

function planRepairCompletion(
  row: LocalStoreOutboxRecord,
  importedSnapshotSeq = 1,
): OutboundQueueSyncUpdateRejectedRepairPlan {
  if (row.docId?.kind === 'meta' && row.metadataSchemaVersion !== 2) {
    return {
      ok: false,
      reason: 'missing-update-bytes',
      decision: { action: 'reject', reason: 'missing-update-bytes' },
    }
  }
  return planOutboundQueueSyncUpdateRejectedRepair({
    itemId: row.id,
    status: row.status,
    reason: row.reason,
    docId: row.docId,
    messageId: row.messageId,
    updateSha256: row.updateSha256,
    rejectionUpdateSha256: row.rejectionUpdateSha256,
    rejectionReason:
      row.rejectionReason === 'large-update-requires-snapshot-import'
        ? row.rejectionReason
        : undefined,
    rejectionRetryable: row.rejectionRetryable,
    updateBytesBase64: row.updateBytesBase64,
    kind: row.kind,
    importedSnapshotSeq,
  })
}

async function readOutboxRow(
  db: IDBDatabase,
  itemId: LocalStoreOutboxRecord['id'],
): Promise<LocalStoreOutboxRecord | undefined> {
  const transaction = db.transaction(['outbox'], 'readonly')
  const value: unknown = await waitForIndexedDbRequest(
    transaction.objectStore('outbox').get(itemId),
  )
  await waitForIndexedDbTransaction(transaction)
  return isLocalStoreOutboxRecord(value) ? value : undefined
}

/** Executes the ordered GET-latest → PUT-import half of rejected-update repair. */
export async function repairRejectedUpdateRemote(input: {
  readonly setup: LocalSetupMetadata
  readonly accessToken: string
  readonly row: RejectedUpdateRepairRemoteRow
  readonly http: RejectedUpdateRepairHttpPort
}): Promise<RejectedUpdateRepairRemoteResult> {
  if (input.accessToken.trim().length === 0)
    return { ok: false, reason: 'auth-failed', status: 401 }
  const bytes = decodeNonEmptyBase64(input.row.updateBytesBase64)
  if (bytes === null) return { ok: false, reason: 'hash-mismatch' }
  let actualHash: string
  try {
    actualHash = await hashBytesSha256(bytes)
  } catch {
    return { ok: false, reason: 'hash-mismatch' }
  }
  if (actualHash !== input.row.updateSha256 || actualHash !== input.row.rejectionUpdateSha256) {
    return { ok: false, reason: 'hash-mismatch' }
  }

  const latest = await fetchLatestManifestSeq(input, input.row.docId)
  if (!latest.ok) return latest
  return await importRejectedUpdate(input, input.row, latest.latestSeq)
}

async function fetchLatestManifestSeq(
  input: {
    readonly setup: LocalSetupMetadata
    readonly accessToken: string
    readonly http: RejectedUpdateRepairHttpPort
  },
  docId: DocId,
): Promise<
  | { readonly ok: true; readonly latestSeq: number | undefined }
  | {
      readonly ok: false
      readonly reason:
        | 'auth-failed'
        | 'network-failed'
        | 'latest-snapshot-failed'
        | 'invalid-latest-response'
      readonly status?: number | undefined
    }
> {
  const url = latestSnapshotUrl(input.setup, docId)
  let response: Response
  try {
    response = await input.http.fetch(url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${input.accessToken}` },
    })
  } catch {
    return { ok: false, reason: 'network-failed' }
  }
  if (response.status === 404) return { ok: true, latestSeq: undefined }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'auth-failed', status: response.status }
  }
  if (!response.ok) return { ok: false, reason: 'latest-snapshot-failed', status: response.status }
  const body: unknown = await response.json().catch(() => undefined)
  const schema =
    docId.kind === 'meta' ? MetaLatestSnapshotResponseSchema : DocLatestSnapshotResponseSchema
  if (!v.is(schema, body)) return { ok: false, reason: 'invalid-latest-response' }
  if (docId.kind === 'file' && (!('docId' in body) || !sameDocId(body.docId, docId))) {
    return { ok: false, reason: 'invalid-latest-response' }
  }
  if (body.manifestSeq <= 0) return { ok: false, reason: 'invalid-latest-response' }
  return { ok: true, latestSeq: body.manifestSeq }
}

async function importRejectedUpdate(
  input: {
    readonly setup: LocalSetupMetadata
    readonly accessToken: string
    readonly http: RejectedUpdateRepairHttpPort
  },
  row: RejectedUpdateRepairRemoteRow,
  latestSeq: number | undefined,
): Promise<
  | { readonly ok: true; readonly snapshotSeq: number }
  | {
      readonly ok: false
      readonly reason:
        | 'auth-failed'
        | 'network-failed'
        | 'conflict'
        | 'import-failed'
        | 'invalid-import-response'
      readonly status?: number | undefined
    }
> {
  const body: {
    readonly updateBytesBase64: string
    readonly latestSeq?: number
    readonly metadataSchemaVersion?: 2
  } =
    latestSeq === undefined
      ? {
          updateBytesBase64: row.updateBytesBase64,
          ...(row.metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 as const } : {}),
        }
      : {
          updateBytesBase64: row.updateBytesBase64,
          latestSeq,
          ...(row.metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 as const } : {}),
        }
  let response: Response
  try {
    response = await input.http.fetch(snapshotImportUrl(input.setup, row.docId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, reason: 'network-failed' }
  }
  if (response.status === 409) return { ok: false, reason: 'conflict', status: response.status }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'auth-failed', status: response.status }
  }
  if (!response.ok) return { ok: false, reason: 'import-failed', status: response.status }
  const responseBody: unknown = await response.json().catch(() => undefined)
  if (!v.is(SnapshotImportResponseSchema, responseBody)) {
    return { ok: false, reason: 'invalid-import-response' }
  }
  if (responseBody.vaultId !== input.setup.vaultId) {
    return { ok: false, reason: 'invalid-import-response' }
  }
  if (!sameDocId(responseBody.docId, row.docId)) {
    return { ok: false, reason: 'invalid-import-response' }
  }
  return { ok: true, snapshotSeq: responseBody.snapshotSeq }
}

function latestSnapshotUrl(setup: LocalSetupMetadata, docId: DocId): string {
  const url = new URL(setup.endpoint)
  url.pathname =
    docId.kind === 'meta'
      ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`
      : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/latest`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function snapshotImportUrl(setup: LocalSetupMetadata, docId: DocId): string {
  const url = new URL(setup.endpoint)
  url.pathname =
    docId.kind === 'meta'
      ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
      : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/snapshot`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function decodeNonEmptyBase64(value: string | undefined): Uint8Array | null {
  if (
    value === undefined ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'meta') return true
  return right.kind === 'file' && left.ydocId === right.ydocId
}
