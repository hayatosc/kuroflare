import {
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotImportResponseSchema,
  decodeFullSnapshotBytesFromResponse,
  type DocId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import * as v from 'valibot'
import type { Doc as YDoc } from 'yjs'

import type { StartupSideEffectGate } from '../host/boot'
import { META_SYNC_DOC_ID } from '../host/constants'
import { isDocIdLike, isStoredYDocRecord } from '../host/guards'
import { filePersistenceDatabaseName, metaPersistenceDatabaseName } from '../host/guards'
import {
  encodeBase64,
  sameDocId,
  waitForIndexedDbRequest,
  waitForIndexedDbTransaction,
} from '../host/helpers'
import { readOutboxWorkerSnapshot } from '../host/store'
import { createWorkerClient } from '../sync/api-client'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  createRecoveringDocumentEpoch,
  documentEpochMetadataKey,
  isDocumentEpochRecord,
  recoverDocumentEpochLifecycle,
  type DocumentEpochRecord,
  type IndexedDbProviderProbe,
  type RecoveryOutboxUpdate,
} from './epoch'
import type { DocumentRecoveryCommitInput } from './epoch-repair'

/** Narrow capabilities required by startup document epoch recovery. */
export interface DocumentEpochRecoveryHost {
  readonly currentSetup: () => LocalSetupMetadata | undefined
  readonly recoveryGate: Pick<
    StartupSideEffectGate,
    'beginRecovery' | 'clearRecoveryBlock' | 'endRecovery' | 'failRecovery'
  >
  readonly recoveryRequired: Pick<Set<string>, 'add' | 'clear'>
  readonly recoveryHydrating: Pick<Set<string>, 'add' | 'delete'>
  readonly probeProvider: (dbName: string) => Promise<IndexedDbProviderProbe>
  readonly resetProvider: (docId: DocId, providerDbName: string) => Promise<void>
  readonly readAccessToken: (setup: LocalSetupMetadata) => Promise<string | undefined>
  readonly latestSnapshotUrl: (setup: LocalSetupMetadata, docId: DocId) => string
  readonly snapshotImportUrl: (setup: LocalSetupMetadata, docId: DocId) => string
  readonly validateMetaCandidate: (doc: YDoc) => boolean
  readonly hydrateProvider: {
    readonly create: (docId: DocId) => Promise<void>
    readonly apply: (docId: DocId, updateBytes: Uint8Array) => Promise<void>
    readonly whenSynced: (docId: DocId, epochId: string) => Promise<void>
  }
  readonly commit: (input: DocumentRecoveryCommitInput) => Promise<void>
}

/** Runs document-loss recovery at the startup boundary before normal provider side effects resume. */
export async function recoverDocumentEpochsAtStartup(
  host: DocumentEpochRecoveryHost,
  db: IDBDatabase,
  metaRecord: unknown,
  fileRecords: readonly unknown[],
): Promise<void> {
  const setup = host.currentSetup()
  if (setup === undefined) return
  host.recoveryGate.beginRecovery()
  let recoverySucceeded = false
  try {
    const outboxSnapshot = await readOutboxWorkerSnapshot(db)
    const rawOutboxTransaction = db.transaction(['outbox'], 'readonly')
    const rawOutboxRows = await waitForIndexedDbRequest(
      rawOutboxTransaction.objectStore('outbox').getAll(),
    )
    await waitForIndexedDbTransaction(rawOutboxTransaction)
    const documents: Array<{ readonly docId: DocId; readonly updateBytes?: Uint8Array }> = []
    if (isStoredYDocRecord(metaRecord) && metaRecord.docId.kind === 'meta') {
      documents.push({ docId: META_SYNC_DOC_ID, updateBytes: metaRecord.updateBytes })
    }
    for (const record of fileRecords) {
      if (isStoredYDocRecord(record) && record.docId.kind === 'file') {
        documents.push({ docId: record.docId, updateBytes: record.updateBytes })
      }
    }
    const epochTransaction = db.transaction(['metadata'], 'readonly')
    const epochValues = await waitForIndexedDbRequest(
      epochTransaction.objectStore('metadata').getAll(),
    )
    await waitForIndexedDbTransaction(epochTransaction)
    for (const value of epochValues) {
      if (!isDocumentEpochRecord(value)) continue
      if (documents.some((document) => sameDocId(document.docId, value.docId))) continue
      documents.push({ docId: value.docId })
    }
    for (const row of outboxSnapshot.outboxRecords) {
      if (row.kind !== 'y-update' || row.docId === undefined || !isDocIdLike(row.docId)) continue
      const rowDocId = row.docId
      if (documents.some((document) => sameDocId(document.docId, rowDocId))) continue
      documents.push({ docId: rowDocId })
    }
    const RawOutboxRowSchema = v.object({
      docId: v.unknown(),
      kind: v.literal('y-update'),
      status: v.picklist(['pending', 'retrying', 'paused']),
    })
    for (const row of rawOutboxRows) {
      if (!v.is(RawOutboxRowSchema, row)) continue
      if (!isDocIdLike(row.docId)) continue
      if (documents.some((document) => sameDocId(document.docId, row.docId))) continue
      documents.push({ docId: row.docId })
    }
    const affected: Array<{
      readonly docId: DocId
      readonly providerDbName: string
      readonly baseUpdateBytes: Uint8Array | undefined
      readonly epoch: DocumentEpochRecord
    }> = []
    for (const document of documents) {
      const providerDbName =
        document.docId.kind === 'meta'
          ? metaPersistenceDatabaseName(setup.vaultId)
          : filePersistenceDatabaseName(setup.vaultId, document.docId.ydocId)
      const provider = await host.probeProvider(providerDbName)
      if (!provider.ok) {
        host.recoveryRequired.add(documentEpochMetadataKey(document.docId))
        throw new Error(`document-provider-probe-failed:${provider.reason}`)
      }
      const epochValue = await readDocumentEpochRecord(db, document.docId)
      const hasPendingOutbox = outboxSnapshot.outboxRecords.some(
        (row) =>
          row.docId !== undefined &&
          sameDocId(row.docId, document.docId) &&
          (row.status === 'pending' || row.status === 'retrying' || row.status === 'paused'),
      )
      const rawHasPendingOutbox = rawOutboxRows.some((row) => {
        if (!v.is(RawOutboxRowSchema, row)) return false
        return isDocIdLike(row.docId) && sameDocId(row.docId, document.docId)
      })
      if (
        (provider.status === 'absent' || epochValue?.status === 'recovering') &&
        (epochValue !== undefined || hasPendingOutbox || rawHasPendingOutbox)
      ) {
        host.recoveryRequired.add(documentEpochMetadataKey(document.docId))
        assertNoMalformedRecoveryOutboxRows(rawOutboxRows, document.docId)
        if (provider.status === 'present' && epochValue?.status === 'recovering') {
          await host.resetProvider(document.docId, providerDbName)
        }
        const recovering = createRecoveringDocumentEpoch({
          docId: document.docId,
          providerDbName,
          now: Date.now(),
          previous: epochValue,
          reason: 'provider-loss',
        })
        await writeDocumentEpochRecord(db, recovering)
        affected.push({
          docId: document.docId,
          providerDbName,
          baseUpdateBytes: document.updateBytes,
          epoch: recovering,
        })
      }
    }
    if (affected.length === 0) {
      host.recoveryRequired.clear()
      host.recoveryGate.clearRecoveryBlock()
      recoverySucceeded = true
      return
    }
    for (const document of affected) {
      await recoverOneDocumentEpoch(host, {
        db,
        setup,
        document,
        outboxRecords: outboxSnapshot.outboxRecords,
        leaseRows: outboxSnapshot.leaseRows,
      })
    }
    host.recoveryRequired.clear()
    host.recoveryGate.clearRecoveryBlock()
    recoverySucceeded = true
  } catch (error: unknown) {
    host.recoveryGate.failRecovery(
      error instanceof Error ? error.message.slice(0, 256) : 'document-recovery-failed',
    )
    throw error
  } finally {
    if (recoverySucceeded) host.recoveryGate.endRecovery()
  }
}

async function recoverOneDocumentEpoch(
  host: DocumentEpochRecoveryHost,
  input: {
    readonly db: IDBDatabase
    readonly setup: LocalSetupMetadata
    readonly document: {
      readonly docId: DocId
      readonly providerDbName: string
      readonly baseUpdateBytes: Uint8Array | undefined
      readonly epoch: DocumentEpochRecord
    }
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  },
): Promise<void> {
  const pendingUpdates: RecoveryOutboxUpdate[] = []
  for (const row of input.outboxRecords) {
    if (row.docId === undefined || !sameDocId(row.docId, input.document.docId)) continue
    if (row.kind !== 'y-update') continue
    if (row.status !== 'pending' && row.status !== 'retrying' && row.status !== 'paused') continue
    if (row.updateBytesBase64 === undefined || row.id === undefined) {
      throw new Error(`document-recovery-malformed-outbox:${row.id ?? 'unknown'}`)
    }
    const bytes = decodeBase64Bytes(row.updateBytesBase64)
    if (bytes === null) throw new Error(`document-recovery-malformed-outbox:${row.id}`)
    pendingUpdates.push({
      id: row.id,
      docId: row.docId,
      status: row.status,
      updateBytes: bytes,
      dependsOn: row.dependsOn,
    })
  }
  const accessToken = await host.readAccessToken(input.setup)
  if (accessToken === undefined) throw new Error('document-recovery-token-missing')
  const client = createWorkerClient(input.setup.endpoint, accessToken)
  const key = documentEpochMetadataKey(input.document.docId)
  host.recoveryHydrating.add(key)
  try {
    await recoverDocumentEpochLifecycle({
      docId: input.document.docId,
      ...(input.document.baseUpdateBytes !== undefined
        ? { localBaseUpdateBytes: input.document.baseUpdateBytes }
        : {}),
      pendingUpdates,
      durableOutboxIds: input.outboxRecords
        .filter(
          (row) =>
            row.status === 'done' &&
            row.docId !== undefined &&
            sameDocId(row.docId, input.document.docId),
        )
        .map((row) => row.id),
      validateCandidate:
        input.document.docId.kind === 'meta' ? host.validateMetaCandidate : undefined,
      snapshots: {
        fetchLatest: async () => {
          const response =
            input.document.docId.kind === 'meta'
              ? await client.vaults[':vaultId'].meta.latest.$get({
                  param: { vaultId: input.setup.vaultId },
                })
              : await client.vaults[':vaultId'].files[':ydocId'].latest.$get({
                  param: {
                    vaultId: input.setup.vaultId,
                    ydocId: input.document.docId.ydocId,
                  },
                })
          if (response.status === 404) return { kind: 'not-found' as const }
          if (!response.ok) throw new Error(`document-recovery-latest-${response.status}`)
          const body: unknown = await response.json().catch(() => undefined)
          const schema =
            input.document.docId.kind === 'meta'
              ? MetaLatestSnapshotResponseSchema
              : DocLatestSnapshotResponseSchema
          if (!v.is(schema, body)) throw new Error('document-recovery-latest-invalid')
          const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
          if (!decoded.ok) throw new Error(`document-recovery-latest-${decoded.reason}`)
          return {
            kind: 'found' as const,
            updateBytes: decoded.updateBytes,
            manifestSeq: body.manifestSeq,
          }
        },
        importSnapshot: async ({ updateBytes, latestSeq }) => {
          const json = {
            updateBytesBase64: encodeBase64(updateBytes),
            ...(latestSeq !== undefined ? { latestSeq } : {}),
            ...(input.document.docId.kind === 'meta' ? { metadataSchemaVersion: 2 as const } : {}),
          }
          const response =
            input.document.docId.kind === 'meta'
              ? await client.vaults[':vaultId'].meta.snapshot.$put({
                  param: { vaultId: input.setup.vaultId },
                  json,
                })
              : await client.vaults[':vaultId'].files[':ydocId'].snapshot.$put({
                  param: {
                    vaultId: input.setup.vaultId,
                    ydocId: input.document.docId.ydocId,
                  },
                  json,
                })
          if (response.status === 409) return { ok: false as const, status: 409 as const }
          if (!response.ok) return { ok: false as const, status: response.status }
          const body: unknown = await response.json().catch(() => undefined)
          if (!v.is(SnapshotImportResponseSchema, body)) {
            return { ok: false as const, status: 502, reason: 'invalid-import-response' }
          }
          return { ok: true as const, snapshotSeq: body.snapshotSeq }
        },
      },
      recoveringEpoch: input.document.epoch,
      hydrateProvider: {
        create: async () => await host.hydrateProvider.create(input.document.docId),
        apply: async (candidate) =>
          await host.hydrateProvider.apply(input.document.docId, candidate.updateBytes),
        whenSynced: async () =>
          await host.hydrateProvider.whenSynced(input.document.docId, input.document.epoch.epochId),
      },
      commit: async ({ readyEpoch, candidate, snapshotSeq }) => {
        await host.commit({
          db: input.db,
          docId: input.document.docId,
          updateBytes: candidate.updateBytes,
          snapshotSeq,
          epoch: readyEpoch,
          includedOutboxIds: candidate.includedOutboxIds,
          leaseRows: input.leaseRows,
          outboxRecords: input.outboxRecords,
        })
      },
    })
  } finally {
    host.recoveryHydrating.delete(key)
  }
}

const RecoveryOutboxRowSchema = v.object({
  docId: v.unknown(),
  kind: v.literal('y-update'),
  status: v.picklist(['pending', 'retrying', 'paused']),
  id: v.string(),
  updateBytesBase64: v.string(),
  dependsOn: v.array(v.string()),
})

function assertNoMalformedRecoveryOutboxRows(rows: readonly unknown[], docId: DocId): void {
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = Reflect.get(row, 'id')
    if (typeof id === 'string') ids.add(id)
  }
  for (const row of rows) {
    if (!v.is(RecoveryOutboxRowSchema, row)) continue
    if (!isDocIdLike(row.docId) || !sameDocId(row.docId, docId)) continue
    if (row.updateBytesBase64.length === 0 || decodeBase64Bytes(row.updateBytesBase64) === null) {
      throw new Error(`document-recovery-malformed-outbox:${row.id}`)
    }
    if (row.dependsOn.some((dependency) => !ids.has(dependency))) {
      throw new Error(`document-recovery-missing-outbox-dependency:${row.id}`)
    }
  }
}

async function readDocumentEpochRecord(
  db: IDBDatabase,
  docId: DocId,
): Promise<DocumentEpochRecord | undefined> {
  const transaction = db.transaction(['metadata'], 'readonly')
  const value = await waitForIndexedDbRequest(
    transaction.objectStore('metadata').get(documentEpochMetadataKey(docId)),
  )
  await waitForIndexedDbTransaction(transaction)
  if (value === undefined) return undefined
  if (!isDocumentEpochRecord(value)) {
    throw new Error(`document-epoch-malformed:${documentEpochMetadataKey(docId)}`)
  }
  return value
}

async function writeDocumentEpochRecord(
  db: IDBDatabase,
  epoch: DocumentEpochRecord,
): Promise<void> {
  const transaction = db.transaction(['metadata'], 'readwrite')
  await waitForIndexedDbRequest(
    transaction.objectStore('metadata').put(epoch, documentEpochMetadataKey(epoch.docId)),
  )
  await waitForIndexedDbTransaction(transaction)
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}
