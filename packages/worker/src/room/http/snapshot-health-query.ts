import {
  Sha256HexSchema,
  SnapshotHealthListResponseSchema,
  YDocIdSchema,
  type DocId,
  type SnapshotHealthEntry,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import {
  getAllLatestSnapshotHealthEvents,
  getLatestSnapshotHealthEvent,
  getSnapshotRetentionCheckpointRuns,
} from '../../db/checkpointRepo'
import { authorizeHttpRequest } from '../../runtime/auth'
import {
  appendSnapshotVerificationEventPreservingLogical,
  listR2Objects,
} from '../../runtime/documents'
import type { VaultRoom } from '../../runtime/room'
import {
  getDb,
  ensureSchema,
  readSnapshotPointer,
  readSyncRequestDocState,
} from '../../runtime/storage'
import { apiErrorBody, docKey } from '../../runtime/utils'
import {
  verifySnapshotObject,
  type SnapshotVerificationExpectedEvidence,
} from '../../sync/snapshot-health'
import { makeSnapshotListPrefix, type SnapshotCandidate } from '../../sync/snapshots'

export async function handleSnapshotHealthList(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-health-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const docId = parseSnapshotHealthDocId(c.req.query('docId'))
  if (docId === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-doc-id'), 400)
  const limit = parseSnapshotHealthLimit(c.req.query('limit'))
  const cursor = parseSnapshotHealthCursor(c.req.query('cursor'))
  if (limit === undefined || (c.req.query('cursor') !== undefined && cursor === undefined)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-pagination'), 400)
  }

  const latestRows = await collectSnapshotHealthRows(room, db, docId)
  const actionContext = await readSnapshotHealthActionContext(room, db, docId, latestRows)
  const candidates = latestRows
    .filter((row) => cursor === undefined || row.upperSeq < cursor)
    .sort(
      (left, right) =>
        right.upperSeq - left.upperSeq || (left.snapshotKey < right.snapshotKey ? -1 : 1),
    )
  const page = candidates.slice(0, limit)
  const lastPageRow = page.at(-1)
  const response = {
    entries: page.map((row) => snapshotHealthEntryFromRow(row, actionContext)),
    ...(lastPageRow !== undefined && candidates.length > page.length
      ? { nextCursor: String(lastPageRow.upperSeq) }
      : {}),
  }
  if (!v.is(SnapshotHealthListResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

async function collectSnapshotHealthRows(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
): Promise<readonly import('../../db/checkpointRepo').SnapshotHealthEventRow[]> {
  const rows = new Map<string, import('../../db/checkpointRepo').SnapshotHealthEventRow>()
  const legacyCandidates = new Map<string, SnapshotCandidate>()
  const runSequences = new Map<string, number>()
  for (const run of await getSnapshotRetentionCheckpointRuns(db, docKey(docId))) {
    if (run.snapshotKey !== null && Number.isSafeInteger(run.upperSeq) && run.upperSeq > 0) {
      runSequences.set(run.snapshotKey, run.upperSeq)
    }
  }
  for (const row of await getAllLatestSnapshotHealthEvents(db, docKey(docId))) {
    rows.set(row.snapshotKey, row)
    const prefix =
      room.vaultId === undefined ? undefined : makeSnapshotListPrefix(room.vaultId, docId)
    const parsedCandidate =
      prefix === undefined ? undefined : snapshotCandidateFromKeyForHealth(prefix, row.snapshotKey)
    const rawSeq = runSequences.get(row.snapshotKey)
    const candidate =
      parsedCandidate ??
      (row.upperSeq <= 0 && rawSeq !== undefined
        ? {
            key: row.snapshotKey,
            upperSeq: rawSeq,
            healthy: true,
          }
        : undefined)
    if (row.upperSeq <= 0 && candidate !== undefined) legacyCandidates.set(candidate.key, candidate)
  }
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) {
    return [...rows.values()].filter((row) => row.upperSeq > 0)
  }
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const listedKeys = new Set<string>()
  for (const object of await listR2Objects(bucket, prefix)) {
    const candidate = snapshotCandidateFromKeyForHealth(prefix, object.key)
    if (candidate !== undefined) listedKeys.add(candidate.key)
    if (
      candidate === undefined ||
      (rows.has(candidate.key) && !legacyCandidates.has(candidate.key))
    )
      continue
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, undefined)
    const existing = rows.get(candidate.key)
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      snapshotExpectedEvidenceFromEvent(existing),
    )
    const latest = await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key)
    rows.set(candidate.key, latest)
    legacyCandidates.delete(candidate.key)
  }
  for (const candidate of legacyCandidates.values()) {
    const existing = rows.get(candidate.key)
    if (existing === undefined) continue
    const verification = await verifySnapshotObject(
      bucket,
      candidate.key,
      docId,
      snapshotExpectedEvidenceFromEvent(existing),
    )
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      snapshotExpectedEvidenceFromEvent(existing),
      existing.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
    )
    rows.set(candidate.key, await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key))
  }
  for (const existing of Array.from(rows.values())) {
    if (existing.upperSeq <= 0 || listedKeys.has(existing.snapshotKey)) continue
    const candidate = snapshotCandidateFromKeyForHealth(prefix, existing.snapshotKey)
    if (candidate === undefined || candidate.upperSeq !== existing.upperSeq) continue
    const expected = snapshotExpectedEvidenceFromEvent(existing)
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, expected)
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      expected,
      existing.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
    )
    rows.set(candidate.key, await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key))
  }
  return [...rows.values()].filter((row) => row.upperSeq > 0)
}

export async function getLatestSnapshotHealthEventForEntry(
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  snapshotKey: string,
): Promise<import('../../db/checkpointRepo').SnapshotHealthEventRow> {
  const row = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshotKey)
  if (row === undefined) throw new Error('snapshot-health-event-missing')
  return row
}

type SnapshotHealthEventRow = import('../../db/checkpointRepo').SnapshotHealthEventRow

interface SnapshotHealthActionContext {
  readonly persisted: Awaited<ReturnType<typeof readSyncRequestDocState>>
  readonly pointer: Awaited<ReturnType<typeof readSnapshotPointer>>
  readonly runs: Awaited<ReturnType<typeof getSnapshotRetentionCheckpointRuns>>
  readonly latestRows: readonly SnapshotHealthEventRow[]
}

export async function readSnapshotHealthActionContext(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  latestRows?: readonly SnapshotHealthEventRow[],
): Promise<SnapshotHealthActionContext> {
  return {
    persisted: await readSyncRequestDocState(room, docId),
    pointer: await readSnapshotPointer(room, docId),
    runs: await getSnapshotRetentionCheckpointRuns(db, docKey(docId)),
    latestRows: latestRows ?? (await getAllLatestSnapshotHealthEvents(db, docKey(docId))),
  }
}

export function snapshotHealthEntryFromRow(
  row: SnapshotHealthEventRow,
  context: SnapshotHealthActionContext,
): SnapshotHealthEntry {
  const docId = docIdFromSnapshotHealthKey(row.docId)
  if (docId === undefined) throw new Error('invalid-snapshot-health-doc-id')
  const actions = snapshotHealthAllowedActions(row, context)
  const authorityStatus = row.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate'
  return {
    docId,
    snapshotKey: row.snapshotKey,
    upperSeq: row.upperSeq,
    actor: row.actor,
    authorityStatus,
    allowedActions: actions.allowedActions,
    ...(actions.actionBlockReason === undefined
      ? {}
      : { actionBlockReason: actions.actionBlockReason }),
    ...(row.expectedByteLength === null ? {} : { expectedByteLength: row.expectedByteLength }),
    ...(safeSha256(row.expectedUpdateSha256) === undefined
      ? {}
      : { expectedUpdateSha256: safeSha256(row.expectedUpdateSha256) }),
    ...(safeSha256(row.expectedStateVectorSha256) === undefined
      ? {}
      : { expectedStateVectorSha256: safeSha256(row.expectedStateVectorSha256) }),
    ...(row.actualByteLength === null ? {} : { actualByteLength: row.actualByteLength }),
    ...(safeSha256(row.actualUpdateSha256) === undefined
      ? {}
      : { actualUpdateSha256: safeSha256(row.actualUpdateSha256) }),
    ...(safeSha256(row.actualStateVectorSha256) === undefined
      ? {}
      : { actualStateVectorSha256: safeSha256(row.actualStateVectorSha256) }),
    physicalStatus: isSnapshotPhysicalStatus(row.physicalStatus)
      ? row.physicalStatus
      : 'unverified',
    logicalStatus: row.logicalStatus === 'quarantined' ? 'quarantined' : 'healthy',
    reasons: parseSnapshotHealthReasons(row.reasons),
    observedAt: row.observedAt,
  }
}

export function snapshotHealthAllowedActions(
  row: SnapshotHealthEventRow,
  context: SnapshotHealthActionContext,
): {
  readonly allowedActions: SnapshotHealthEntry['allowedActions']
  readonly actionBlockReason: string | undefined
} {
  const pointerMatches =
    context.pointer?.latestSnapshotSeq === row.upperSeq &&
    context.pointer?.latestSnapshotKey === row.snapshotKey
  const matchingRuns = context.runs.filter(
    (run) => run.snapshotKey === row.snapshotKey && run.upperSeq === row.upperSeq,
  )
  if (
    row.physicalStatus === 'mismatch' &&
    parseSnapshotHealthReasons(row.reasons).includes('missing-object')
  ) {
    return { allowedActions: [], actionBlockReason: 'snapshot-health-deleted' }
  }
  const hasCompletedRun = matchingRuns.some(
    (run) =>
      run.status === 'pointer-updated' || run.status === 'compacted' || run.status === 'completed',
  )
  const verifyAllowed =
    row.physicalStatus === 'unverified' &&
    row.logicalStatus !== 'quarantined' &&
    row.logicalStatus === 'healthy' &&
    (context.persisted === undefined || pointerMatches || hasCompletedRun)
  const rollbackAllowed =
    row.authorityStatus === 'authoritative' &&
    row.physicalStatus === 'verified' &&
    row.logicalStatus === 'healthy' &&
    context.persisted !== undefined &&
    row.upperSeq >= context.persisted.minRetainedSeq &&
    row.upperSeq <= context.persisted.latestSeq &&
    (matchingRuns.length === 0 || hasCompletedRun || pointerMatches)
  const floor = context.persisted?.minRetainedSeq ?? 0
  const hasAlternativeFloor = context.latestRows.some(
    (other) =>
      other.snapshotKey !== row.snapshotKey &&
      other.authorityStatus === 'authoritative' &&
      other.physicalStatus === 'verified' &&
      other.logicalStatus === 'healthy' &&
      other.upperSeq >= floor &&
      (context.persisted === undefined || other.upperSeq <= context.persisted.latestSeq),
  )
  const quarantineBlocked =
    row.logicalStatus === 'quarantined' ||
    (row.authorityStatus === 'authoritative' &&
      row.physicalStatus === 'verified' &&
      row.logicalStatus === 'healthy' &&
      context.persisted !== undefined &&
      row.upperSeq >= context.persisted.minRetainedSeq &&
      !hasAlternativeFloor)
  const actions: SnapshotHealthEntry['allowedActions'] = [
    ...(verifyAllowed ? (['verify'] as const) : []),
    ...(!quarantineBlocked ? (['quarantine'] as const) : []),
    ...(rollbackAllowed ? (['rollback'] as const) : []),
  ]
  if (actions.length > 0) return { allowedActions: actions, actionBlockReason: undefined }
  const actionBlockReason =
    row.logicalStatus === 'quarantined'
      ? 'snapshot-health-already-quarantined'
      : !verifyAllowed
        ? 'snapshot-health-approval-not-authoritative'
        : !rollbackAllowed
          ? 'snapshot-rollback-unhealthy-source'
          : 'snapshot-health-quarantine-would-break-floor'
  return { allowedActions: actions, actionBlockReason }
}

export function snapshotExpectedEvidenceFromEvent(
  row: import('../../db/checkpointRepo').SnapshotHealthEventRow | undefined,
): SnapshotVerificationExpectedEvidence | undefined {
  if (
    row === undefined ||
    row.expectedByteLength === null ||
    row.expectedUpdateSha256 === null ||
    row.expectedStateVectorSha256 === null
  ) {
    return undefined
  }
  return {
    byteLength: row.expectedByteLength,
    updateSha256: row.expectedUpdateSha256,
    stateVectorSha256: row.expectedStateVectorSha256,
  }
}

function parseSnapshotHealthDocId(value: string | undefined): DocId | undefined {
  if (value === 'meta') return { kind: 'meta' }
  if (typeof value !== 'string' || !value.startsWith('file:')) return undefined
  const ydocId = value.slice('file:'.length)
  return v.is(YDocIdSchema, ydocId) ? { kind: 'file', ydocId } : undefined
}

export function snapshotHealthRouteDocMatches(
  routeDocId: string | undefined,
  docId: DocId,
): boolean {
  if (routeDocId === undefined) return true
  return docId.kind === 'meta' ? routeDocId === 'meta' : routeDocId === docId.ydocId
}

function docIdFromSnapshotHealthKey(value: string): DocId | undefined {
  return parseSnapshotHealthDocId(value)
}

function parseSnapshotHealthLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 64
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 256 ? parsed : undefined
}

function parseSnapshotHealthCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function snapshotCandidateFromKeyForHealth(
  prefix: string,
  key: string,
): SnapshotCandidate | undefined {
  if (!key.startsWith(prefix) || !key.endsWith('.yupdate')) return undefined
  const seqText = key.slice(prefix.length, -'.yupdate'.length)
  if (!/^[1-9][0-9]*$/.test(seqText)) return undefined
  const upperSeq = Number(seqText)
  return Number.isSafeInteger(upperSeq) && upperSeq > 0
    ? { key, upperSeq, healthy: true }
    : undefined
}

function parseSnapshotHealthReasons(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is string => typeof reason === 'string')
      : []
  } catch {
    return []
  }
}

function isSnapshotPhysicalStatus(
  value: string | null,
): value is SnapshotHealthEntry['physicalStatus'] {
  return value === 'verified' || value === 'unverified' || value === 'mismatch'
}

function safeSha256(value: string | null): string | undefined {
  return value !== null && v.is(Sha256HexSchema, value) ? value : undefined
}
