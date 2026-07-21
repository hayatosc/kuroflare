import {
  hashBytesSha256,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
  makeSha256Hex,
  type DocId,
} from '@kuroflare/core'
import { DocIdSchema, NonNegativeSafeIntegerSchema } from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

const RecoveryOutboxUpdateSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  docId: DocIdSchema,
  status: v.picklist(['pending', 'retrying', 'paused', 'in-flight']),
  updateBytes: v.pipe(
    v.instance(Uint8Array),
    v.check((b) => b.byteLength <= 64 * 1024 * 1024),
  ),
  dependsOn: v.optional(v.array(v.string())),
})

const DocumentEpochRecordSchema = v.object({
  docId: DocIdSchema,
  providerDbName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  epochId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  status: v.picklist(['recovering', 'ready']),
  createdAt: NonNegativeSafeIntegerSchema,
  updatedAt: NonNegativeSafeIntegerSchema,
  baseUpdateSha256: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  baseStateVectorBase64: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(4 * 1024 * 1024)),
  ),
  remoteCursorSeq: v.optional(NonNegativeSafeIntegerSchema),
  recoveryReason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})

/** The provider database state observed before y-indexeddb is opened. */
export type IndexedDbProviderProbe =
  | { readonly ok: true; readonly status: 'present' | 'absent'; readonly dbName: string }
  | {
      readonly ok: false
      readonly status: 'unavailable' | 'malformed'
      readonly dbName: string
      readonly reason: string
    }

/** Minimal IndexedDB directory surface used by the non-creating provider probe. */
export interface IndexedDbDirectoryPort {
  readonly databases?: (() => Promise<readonly unknown[]>) | undefined
  /** Optional open hook accepted by browser fakes; the probe must never call it. */
  readonly open?: ((name: string) => unknown) | undefined
}

/** A durable epoch record stored in the existing local-store metadata object store. */
export interface DocumentEpochRecord {
  readonly docId: DocId
  readonly providerDbName: string
  readonly epochId: string
  readonly status: 'recovering' | 'ready'
  readonly createdAt: number
  readonly updatedAt: number
  readonly baseUpdateSha256?: string | undefined
  readonly baseStateVectorBase64?: string | undefined
  readonly remoteCursorSeq?: number | undefined
  readonly recoveryReason?: string | undefined
}

/** Evidence used to classify one document before its IndexedDB provider is opened. */
export interface DocumentEpochClassificationInput {
  readonly provider: IndexedDbProviderProbe
  readonly epoch?: DocumentEpochRecord | undefined
  readonly hasLocalYDoc: boolean
  readonly hasPendingOutbox: boolean
}

/** Safe startup action for one document after provider and local evidence are inspected. */
export type DocumentEpochClassification =
  | { readonly action: 'establish-initial-epoch' }
  | { readonly action: 'create-new-provider' }
  | { readonly action: 'recover'; readonly reason: 'provider-loss' | 'provider-probe-failed' }
  | { readonly action: 'blocked'; readonly reason: 'provider-probe-failed' | 'malformed-epoch' }

/** One retained local update included in a recovery candidate. */
export interface RecoveryOutboxUpdate {
  readonly id: string
  readonly docId: DocId
  readonly status: 'pending' | 'retrying' | 'paused' | 'in-flight'
  readonly updateBytes: Uint8Array
  readonly dependsOn?: readonly string[] | undefined
}

/** Input for constructing a merged, validated Yjs recovery candidate. */
export interface RecoveryCandidateInput {
  readonly docId: DocId
  readonly remoteUpdateBytes?: Uint8Array | undefined
  readonly localBaseUpdateBytes?: Uint8Array | undefined
  readonly pendingUpdates: readonly RecoveryOutboxUpdate[]
  readonly durableOutboxIds?: readonly string[] | undefined
  readonly validateCandidate?: ((doc: Y.Doc) => boolean) | undefined
}

/** A merged candidate and the exact outbox rows whose bytes were applied. */
export interface RecoveryCandidate {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
  readonly stateVectorBytes: Uint8Array
  readonly includedOutboxIds: readonly string[]
}

/** Failure returned when recovery input cannot be trusted or applied. */
export type RecoveryCandidateFailure =
  | 'doc-mismatch'
  | 'malformed-remote-update'
  | 'malformed-local-base'
  | 'malformed-pending-update'
  | 'unresolved-pending-update'
  | 'duplicate-outbox-id'
  | 'invalid-outbox-row'
  | 'outbox-dependency-cycle'
  | 'outbox-dependency-missing'
  | 'remote-not-found-existing-document'
  | 'candidate-validation-failed'

/** Result of building a recovery candidate. */
export type RecoveryCandidateResult =
  | { readonly ok: true; readonly candidate: RecoveryCandidate }
  | { readonly ok: false; readonly reason: RecoveryCandidateFailure; readonly outboxId?: string }

/** Outcome of one authenticated snapshot import attempt. */
export type RecoveryImportResult =
  | { readonly ok: true; readonly snapshotSeq: number }
  | { readonly ok: false; readonly status: 404 | 409 | number; readonly reason?: string }

/** Ports required by bounded remote snapshot recovery. */
export interface RecoverySnapshotPort {
  fetchLatest(): Promise<
    | { readonly kind: 'found'; readonly updateBytes: Uint8Array; readonly manifestSeq: number }
    | { readonly kind: 'not-found' }
  >
  importSnapshot(input: {
    readonly updateBytes: Uint8Array
    readonly latestSeq?: number | undefined
  }): Promise<RecoveryImportResult>
}

/** Input for bounded CAS recovery; retries rebuild from the newest authoritative snapshot. */
export interface RecoverDocumentEpochInput extends RecoveryCandidateInput {
  readonly snapshots: RecoverySnapshotPort
  readonly maxAttempts?: number | undefined
  readonly durableOutboxIds?: readonly string[] | undefined
  /** Optional deterministic fault-injection hook used by crash-boundary tests. */
  readonly onStage?:
    | ((stage: 'latest-fetched' | 'candidate-built' | 'remote-imported', attempt: number) => void)
    | undefined
}

/** Result of bounded remote recovery, retaining the candidate for provider creation. */
export type RecoverDocumentEpochResult =
  | {
      readonly ok: true
      readonly candidate: RecoveryCandidate
      readonly snapshotSeq: number
      readonly attempts: number
    }
  | {
      readonly ok: false
      readonly reason:
        | RecoveryCandidateFailure
        | 'latest-fetch-failed'
        | 'snapshot-import-failed'
        | 'snapshot-import-conflict'
        | 'invalid-max-attempts'
      readonly attempts: number
    }

/**
 * Probes the IndexedDB directory without opening a database.
 *
 * @param indexedDb Browser directory API; its absence is a fail-closed condition.
 * @param dbName Exact provider database name to inspect.
 * @returns Presence evidence, or a malformed/unavailable result.
 */
export async function probeIndexedDbProvider(
  indexedDb: IndexedDbDirectoryPort,
  dbName: string,
): Promise<IndexedDbProviderProbe> {
  if (!isBoundedString(dbName, 256) || indexedDb.databases === undefined) {
    return { ok: false, status: 'unavailable', dbName, reason: 'database-directory-unavailable' }
  }

  let databases: readonly unknown[]
  try {
    databases = await indexedDb.databases()
  } catch {
    return { ok: false, status: 'unavailable', dbName, reason: 'database-directory-read-failed' }
  }
  if (!Array.isArray(databases)) {
    return { ok: false, status: 'malformed', dbName, reason: 'database-directory-not-array' }
  }

  const names = new Set<string>()
  for (const database of databases) {
    if (!isRecord(database)) {
      return { ok: false, status: 'malformed', dbName, reason: 'database-entry-not-object' }
    }
    const name = Reflect.get(database, 'name')
    const version = Reflect.get(database, 'version')
    if (!isBoundedString(name, 256) || (version !== undefined && !isPositiveSafeInteger(version))) {
      return { ok: false, status: 'malformed', dbName, reason: 'database-entry-invalid' }
    }
    if (names.has(name)) {
      return { ok: false, status: 'malformed', dbName, reason: 'duplicate-database-name' }
    }
    names.add(name)
  }
  return { ok: true, status: names.has(dbName) ? 'present' : 'absent', dbName }
}

/** Validates persisted epoch evidence at the local-store trust boundary. */
export function isDocumentEpochRecord(value: unknown): value is DocumentEpochRecord {
  return v.is(DocumentEpochRecordSchema, value)
}

/** Classifies provider evidence without opening or creating the provider database. */
export function classifyDocumentEpoch(
  input: DocumentEpochClassificationInput,
): DocumentEpochClassification {
  if (!isDocumentEpochRecord(input.epoch)) {
    if (input.epoch !== undefined) return { action: 'blocked', reason: 'malformed-epoch' }
  }
  if (!input.provider.ok) {
    return { action: 'blocked', reason: 'provider-probe-failed' }
  }
  if (input.provider.status === 'present') {
    if (input.epoch?.status === 'recovering') {
      return { action: 'recover', reason: 'provider-loss' }
    }
    return input.epoch === undefined
      ? { action: 'establish-initial-epoch' }
      : { action: 'create-new-provider' }
  }
  return input.epoch !== undefined || input.hasLocalYDoc || input.hasPendingOutbox
    ? { action: 'recover', reason: 'provider-loss' }
    : { action: 'create-new-provider' }
}

/** Creates a fresh opaque epoch identifier; failure is deliberate rather than predictable reuse. */
export function createFreshDocumentEpochId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID()
  throw new Error('secure-random-epoch-id-unavailable')
}

/** Builds a new ready epoch after provider evidence has been validated. */
export function createReadyDocumentEpoch(input: {
  readonly docId: DocId
  readonly providerDbName: string
  readonly now: number
  readonly epochId?: string | undefined
}): DocumentEpochRecord {
  if (!isDocId(input.docId) || !isBoundedString(input.providerDbName, 256)) {
    throw new Error('invalid-document-epoch-identity')
  }
  if (!isNonNegativeSafeInteger(input.now)) throw new Error('invalid-document-epoch-time')
  const record: DocumentEpochRecord = {
    docId: input.docId,
    providerDbName: input.providerDbName,
    epochId: input.epochId ?? createFreshDocumentEpochId(),
    status: 'ready',
    createdAt: input.now,
    updatedAt: input.now,
  }
  if (!isDocumentEpochRecord(record)) throw new Error('invalid-document-epoch-record')
  return record
}

/** Returns the stable metadata-store key for one document epoch record. */
export function documentEpochMetadataKey(docId: DocId): string {
  if (!isDocId(docId)) throw new Error('invalid-document-epoch-doc-id')
  return docId.kind === 'meta' ? 'document-epoch:meta' : `document-epoch:file:${docId.ydocId}`
}

/** Creates a recovering record before any authenticated remote mutation begins. */
export function createRecoveringDocumentEpoch(input: {
  readonly docId: DocId
  readonly providerDbName: string
  readonly now: number
  readonly previous?: DocumentEpochRecord | undefined
  readonly reason: string
}): DocumentEpochRecord {
  if (!isBoundedString(input.reason, 256)) throw new Error('invalid-document-epoch-recovery-reason')
  if (!isNonNegativeSafeInteger(input.now)) throw new Error('invalid-document-epoch-time')
  const previous = input.previous
  if (previous !== undefined && !isDocumentEpochRecord(previous)) {
    throw new Error('invalid-previous-document-epoch')
  }
  const record: DocumentEpochRecord = {
    docId: input.docId,
    providerDbName: input.providerDbName,
    epochId: createFreshDocumentEpochId(),
    status: 'recovering',
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
    recoveryReason: input.reason,
  }
  if (!isDocumentEpochRecord(record)) throw new Error('invalid-document-epoch-record')
  return record
}

/** Returns a ready record carrying the new candidate evidence after recovery commits. */
export function completeDocumentEpochRecovery(input: {
  readonly recovering: DocumentEpochRecord
  readonly now: number
  readonly updateBytes: Uint8Array
  readonly remoteCursorSeq: number
}): Promise<DocumentEpochRecord> {
  if (!isDocumentEpochRecord(input.recovering) || input.recovering.status !== 'recovering') {
    return Promise.reject(new Error('invalid-recovering-document-epoch'))
  }
  if (!isNonNegativeSafeInteger(input.now) || !isNonNegativeSafeInteger(input.remoteCursorSeq)) {
    return Promise.reject(new Error('invalid-document-epoch-completion-evidence'))
  }
  return epochBaseEvidence(input.updateBytes).then((evidence) => {
    const record: DocumentEpochRecord = {
      ...input.recovering,
      status: 'ready',
      updatedAt: input.now,
      ...evidence,
      remoteCursorSeq: input.remoteCursorSeq,
      recoveryReason: undefined,
    }
    if (!isDocumentEpochRecord(record)) throw new Error('invalid-document-epoch-record')
    return record
  })
}

/** Builds a guarded recovery candidate without opening y-indexeddb. */
export async function buildRecoveryCandidate(
  input: RecoveryCandidateInput,
): Promise<RecoveryCandidateResult> {
  if (!isDocId(input.docId)) return { ok: false, reason: 'doc-mismatch' }
  const seenIds = new Set<string>()
  const doc = new Y.Doc()
  try {
    const apply = (bytes: Uint8Array | undefined): boolean => {
      if (bytes === undefined) return true
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) return false
      try {
        Y.applyUpdate(doc, bytes, 'epoch-recovery')
      } catch {
        return false
      }
      return !hasPendingStructs(doc)
    }
    if (!apply(input.remoteUpdateBytes)) {
      return { ok: false, reason: 'malformed-remote-update' }
    }
    if (!apply(input.localBaseUpdateBytes)) {
      return { ok: false, reason: 'malformed-local-base' }
    }
    const updatesById = new Map<string, RecoveryOutboxUpdate>()
    for (const update of input.pendingUpdates) {
      if (!isRecoveryOutboxUpdate(update) || !sameDocId(update.docId, input.docId)) {
        return { ok: false, reason: 'invalid-outbox-row', outboxId: update?.id }
      }
      if (seenIds.has(update.id))
        return { ok: false, reason: 'duplicate-outbox-id', outboxId: update.id }
      seenIds.add(update.id)
      updatesById.set(update.id, update)
    }
    const durableIds = new Set(input.durableOutboxIds ?? [])
    const orderedUpdates: RecoveryOutboxUpdate[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (update: RecoveryOutboxUpdate): RecoveryCandidateResult | undefined => {
      if (visited.has(update.id)) return undefined
      if (visiting.has(update.id))
        return { ok: false, reason: 'outbox-dependency-cycle', outboxId: update.id }
      visiting.add(update.id)
      for (const dependency of update.dependsOn ?? []) {
        if (typeof dependency !== 'string' || dependency.length === 0) {
          return { ok: false, reason: 'outbox-dependency-missing', outboxId: update.id }
        }
        const dependencyUpdate = updatesById.get(dependency)
        if (dependencyUpdate === undefined) {
          if (!durableIds.has(dependency)) {
            return { ok: false, reason: 'outbox-dependency-missing', outboxId: update.id }
          }
          continue
        }
        const dependencyResult = visit(dependencyUpdate)
        if (dependencyResult !== undefined && !dependencyResult.ok) return dependencyResult
      }
      visiting.delete(update.id)
      visited.add(update.id)
      orderedUpdates.push(update)
      return undefined
    }
    for (const update of input.pendingUpdates) {
      const dependencyResult = visit(update)
      if (dependencyResult !== undefined && !dependencyResult.ok) return dependencyResult
    }
    const includedOutboxIds: string[] = []
    for (const update of orderedUpdates) {
      try {
        Y.applyUpdate(doc, update.updateBytes, 'epoch-recovery')
      } catch {
        return { ok: false, reason: 'malformed-pending-update', outboxId: update.id }
      }
      if (hasPendingStructs(doc)) {
        return { ok: false, reason: 'unresolved-pending-update', outboxId: update.id }
      }
      includedOutboxIds.push(update.id)
    }
    if (input.validateCandidate !== undefined && !input.validateCandidate(doc)) {
      return { ok: false, reason: 'candidate-validation-failed' }
    }
    return {
      ok: true,
      candidate: {
        docId: input.docId,
        updateBytes: Y.encodeStateAsUpdate(doc),
        stateVectorBytes: Y.encodeStateVector(doc),
        includedOutboxIds,
      },
    }
  } finally {
    doc.destroy()
  }
}

/** Fetches/rebuilds/imports a candidate with bounded latest-manifest CAS retries. */
export async function recoverDocumentEpoch(
  input: RecoverDocumentEpochInput,
): Promise<RecoverDocumentEpochResult> {
  const maxAttempts = input.maxAttempts ?? 3
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    return { ok: false, reason: 'invalid-max-attempts', attempts: 0 }
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let latest: Awaited<ReturnType<RecoverySnapshotPort['fetchLatest']>>
    try {
      latest = await input.snapshots.fetchLatest()
    } catch {
      return { ok: false, reason: 'latest-fetch-failed', attempts: attempt }
    }
    input.onStage?.('latest-fetched', attempt)
    const candidateResult = await buildRecoveryCandidate({
      ...input,
      remoteUpdateBytes: latest.kind === 'found' ? latest.updateBytes : undefined,
    })
    if (!candidateResult.ok) return { ok: false, reason: candidateResult.reason, attempts: attempt }
    if (
      latest.kind === 'not-found' &&
      input.localBaseUpdateBytes === undefined &&
      input.pendingUpdates.length === 0
    ) {
      return { ok: false, reason: 'remote-not-found-existing-document', attempts: attempt }
    }
    input.onStage?.('candidate-built', attempt)
    const imported = await input.snapshots.importSnapshot({
      updateBytes: candidateResult.candidate.updateBytes,
      ...(latest.kind === 'found' && latest.manifestSeq > 0
        ? { latestSeq: latest.manifestSeq }
        : {}),
    })
    if (imported.ok) {
      input.onStage?.('remote-imported', attempt)
      return {
        ok: true,
        candidate: candidateResult.candidate,
        snapshotSeq: imported.snapshotSeq,
        attempts: attempt,
      }
    }
    if (imported.status === 409) continue
    return { ok: false, reason: 'snapshot-import-failed', attempts: attempt }
  }
  return { ok: false, reason: 'snapshot-import-conflict', attempts: maxAttempts }
}

/** Lifecycle boundaries used to exercise restart safety around provider hydration and local commit. */
export type DocumentRecoveryLifecycleStage =
  | 'latest-fetched'
  | 'candidate-built'
  | 'remote-imported'
  | 'provider-created'
  | 'provider-applied'
  | 'provider-synced'
  | 'before-atomic-commit'
  | 'after-atomic-commit'

export interface RecoverDocumentEpochLifecycleInput extends RecoverDocumentEpochInput {
  readonly recoveringEpoch: DocumentEpochRecord
  readonly hydrateProvider: {
    readonly create: () => Promise<void>
    readonly apply: (candidate: RecoveryCandidate) => Promise<void>
    readonly whenSynced: () => Promise<void>
  }
  readonly commit: (input: {
    readonly readyEpoch: DocumentEpochRecord
    readonly candidate: RecoveryCandidate
    readonly snapshotSeq: number
  }) => Promise<void>
  readonly onLifecycleStage?:
    | ((stage: DocumentRecoveryLifecycleStage, attempt: number) => void)
    | undefined
}

export interface RecoverDocumentEpochLifecycleResult {
  readonly candidate: RecoveryCandidate
  readonly snapshotSeq: number
  readonly attempts: number
  readonly readyEpoch: DocumentEpochRecord
}

/** Runs the guarded recovery lifecycle from remote CAS through provider hydration and atomic commit. */
export async function recoverDocumentEpochLifecycle(
  input: RecoverDocumentEpochLifecycleInput,
): Promise<RecoverDocumentEpochLifecycleResult> {
  const remote = await recoverDocumentEpoch({
    ...input,
    onStage: (stage, attempt) => {
      input.onStage?.(stage, attempt)
      input.onLifecycleStage?.(stage, attempt)
    },
  })
  if (!remote.ok) throw new Error(`document-recovery-${remote.reason}`)
  const emit = (stage: DocumentRecoveryLifecycleStage) => {
    input.onLifecycleStage?.(stage, remote.attempts)
  }
  await input.hydrateProvider.create()
  emit('provider-created')
  await input.hydrateProvider.apply(remote.candidate)
  emit('provider-applied')
  await input.hydrateProvider.whenSynced()
  emit('provider-synced')
  const readyEpoch = await completeDocumentEpochRecovery({
    recovering: input.recoveringEpoch,
    now: Date.now(),
    updateBytes: remote.candidate.updateBytes,
    remoteCursorSeq: remote.snapshotSeq,
  })
  emit('before-atomic-commit')
  await input.commit({
    readyEpoch,
    candidate: remote.candidate,
    snapshotSeq: remote.snapshotSeq,
  })
  emit('after-atomic-commit')
  return { ...remote, readyEpoch }
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return v.is(v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength)), value)
}

function isDocId(value: unknown): value is DocId {
  return v.is(DocIdSchema, value)
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'meta' || (right.kind === 'file' && left.ydocId === right.ydocId)
}

function isRecoveryOutboxUpdate(value: unknown): value is RecoveryOutboxUpdate {
  return v.is(RecoveryOutboxUpdateSchema, value)
}

function hasPendingStructs(doc: Y.Doc): boolean {
  const store = Reflect.get(doc, 'store')
  if (!isRecord(store)) return false
  const pendingStructs = Reflect.get(store, 'pendingStructs')
  return pendingStructs !== null && pendingStructs !== undefined
}

/** Computes evidence hashes for epoch records without trusting caller-supplied hashes. */
export async function epochBaseEvidence(updateBytes: Uint8Array): Promise<{
  readonly baseUpdateSha256: string
  readonly baseStateVectorBase64: string
}> {
  if (!(updateBytes instanceof Uint8Array)) throw new Error('invalid-epoch-base-update')
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, updateBytes, 'epoch-evidence')
    return {
      baseUpdateSha256: makeSha256Hex(await hashBytesSha256(updateBytes)),
      baseStateVectorBase64: encodeBase64(Y.encodeStateVector(doc)),
    }
  } finally {
    doc.destroy()
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Creates a fresh Y.Doc from a verified full snapshot update. */
export function createYDocFromSnapshot(updateBytes: Uint8Array, origin: unknown): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, updateBytes, origin)
  return doc
}
