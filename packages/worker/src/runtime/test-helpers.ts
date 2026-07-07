import {
  CURRENT_PROTOCOL_VERSION,
  DEVICE_TOKEN_ISSUER,
  AckSchema,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type Ack,
  type ClientHello,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type BlobManifest,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import workerEntrypoint, {
  type DurableObjectIdBinding,
  type DurableObjectSqlStorageBinding,
  type DurableObjectStateBinding,
  type DurableObjectStorageBinding,
  type DurableObjectStubBinding,
  type R2BucketBinding,
  type R2ListOptionsBinding,
  type R2ObjectBodyBinding,
  type R2ObjectsBinding,
  type RuntimeWebSocket,
  type WorkerEnv,
} from '../runtime'

export const TEST_DEVICE_TOKEN_SECRET = 'test-device-token-secret'

export class FakeSocket implements RuntimeWebSocket {
  readonly sent: Array<string | ArrayBuffer> = []
  accepted = false
  closed = false
  closeCode: number | undefined
  closeReason: string | undefined
  private attachment: unknown

  accept(): void {
    this.accepted = true
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }
}

export class FakeWebSocketPair {
  readonly 0 = new FakeSocket()
  readonly 1 = new FakeSocket()
}

export class FakeUpgradeResponse {
  readonly status: number
  readonly webSocket: RuntimeWebSocket | undefined

  constructor(_body: BodyInit | null, init?: ResponseInit & { webSocket?: RuntimeWebSocket }) {
    this.status = init?.status ?? 200
    this.webSocket = init?.webSocket
  }
}

export class MemoryStorage implements DurableObjectStorageBinding {
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    return closure()
  }
}

export interface RecordedDocRow {
  readonly kind: string
  readonly latestSeq: number
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | undefined
  readonly minRetainedSeq: number
  readonly horizonStateVector: Uint8Array | undefined
  readonly updatedAt: number
}

export interface RecordedOpLogRow {
  readonly docId: string
  readonly seq: number
  readonly messageId: string
  readonly deviceId: string
  readonly yClientId: number
  readonly updateBytes: Uint8Array
  readonly updateSha256: string
  readonly createdAt: number
}

export interface RecordedQuarantineRow {
  readonly id: string
  readonly docId: string
  readonly messageId: string
  readonly deviceId: string
  readonly reason: string
  readonly updateSha256: string
  readonly updateBytes: Uint8Array
  readonly createdAt: number
}

export interface RecordedCheckpointRunRow {
  readonly runId: string
  readonly docId: string
  readonly upperSeq: number
  readonly snapshotKey: string
  readonly stateVector: Uint8Array
  readonly status: string
  readonly createdAt: number
  readonly r2WrittenAt: number | undefined
  readonly pointerUpdatedAt: number | undefined
  readonly compactedAt: number | undefined
}

export interface RecordedDeviceRow {
  readonly deviceId: string
  readonly yClientId: number
  readonly tokenVersion: number
  readonly revokedAt: number | undefined
}

export interface RecordedSetupTokenRow {
  readonly tokenHash: string
  readonly vaultId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | undefined
}

export interface RecordedRefreshTokenRow {
  readonly tokenHash: string
  readonly deviceId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | undefined
}

export interface RecordedMessageDedupRow {
  readonly docId: string
  readonly messageId: string
  readonly durableSeq: number
  readonly seenAt: number
}

export interface RecordedSnapshotRetentionEventRow {
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | undefined
  readonly attemptedAt: number
}

export class RecordingSqlStorage implements DurableObjectSqlStorageBinding {
  readonly docs = new Map<string, RecordedDocRow>()
  readonly opLog = new Map<string, RecordedOpLogRow>()
  readonly messageDedup = new Map<string, RecordedMessageDedupRow>()
  readonly quarantines = new Map<string, RecordedQuarantineRow>()
  readonly checkpointRuns = new Map<string, RecordedCheckpointRunRow>()
  readonly snapshotRetentionEvents: RecordedSnapshotRetentionEventRow[] = []
  readonly setupTokens = new Map<string, RecordedSetupTokenRow>()
  readonly refreshTokens = new Map<string, RecordedRefreshTokenRow>()
  readonly devices = new Map<string, RecordedDeviceRow>([
    [
      'device-1',
      {
        deviceId: 'device-1',
        yClientId: 1,
        tokenVersion: 1,
        revokedAt: undefined,
      },
    ],
  ])
  readonly migrationVersions = new Set<number>()
  readonly queries: string[] = []
  failOnQueryIncludes: string | undefined

  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: readonly unknown[]
  ): Iterable<T> {
    const normalized = query.toLowerCase().replace(/"/g, '')
    this.queries.push(normalized)
    if (normalized === 'begin immediate' || normalized === 'commit' || normalized === 'rollback') {
      return []
    }
    if (this.failOnQueryIncludes !== undefined && normalized.includes(this.failOnQueryIncludes)) {
      throw new Error(`injected SQL failure: ${this.failOnQueryIncludes}`)
    }
    if (normalized.startsWith('create table') || normalized.startsWith('create index')) {
      return []
    }
    if (normalized.includes('from schema_migrations')) {
      return [...this.migrationVersions].map((version) => ({ version })) as Iterable<T>
    }
    if (normalized.includes('insert into schema_migrations')) {
      this.migrationVersions.add(expectNumber(bindings[0]))
      return []
    }
    if (normalized.includes('from setup_tokens')) {
      const tokenHash = expectString(bindings[0])
      const token = this.setupTokens.get(tokenHash)
      const rows =
        token === undefined
          ? []
          : [
              {
                vaultId: token.vaultId,
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
                consumedAt: token.consumedAt ?? null,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('from device_refresh_tokens')) {
      const tokenHash = expectString(bindings[0])
      const token = this.refreshTokens.get(tokenHash)
      const rows =
        token === undefined
          ? []
          : [
              {
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
                revokedAt: token.revokedAt,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('from devices')) {
      if (!normalized.includes('where device_id')) {
        return [...this.devices.values()].map((device) => ({
          yClientId: device.yClientId,
        })) as Iterable<T>
      }
      const deviceId = expectString(bindings[0])
      const device = this.devices.get(deviceId)
      const rows =
        device === undefined
          ? []
          : [
              {
                yClientId: device.yClientId,
                tokenVersion: device.tokenVersion,
                revokedAt: device.revokedAt,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('update setup_tokens')) {
      const consumedAt = expectNumber(bindings[0])
      const tokenHash = expectString(bindings[1])
      const existing = this.setupTokens.get(tokenHash)
      if (existing !== undefined) {
        this.setupTokens.set(tokenHash, { ...existing, consumedAt })
      }
      return []
    }
    if (normalized.includes('insert into setup_tokens')) {
      const tokenHash = expectString(bindings[0])
      this.setupTokens.set(tokenHash, {
        tokenHash,
        vaultId: expectString(bindings[1]),
        issuedAt: expectNumber(bindings[2]),
        expiresAt: expectNumber(bindings[3]),
        consumedAt: undefined,
      })
      return []
    }
    if (normalized.includes('insert into devices')) {
      const deviceId = expectString(bindings[0])
      const existing = this.devices.get(deviceId)
      this.devices.set(deviceId, {
        deviceId,
        yClientId: existing?.yClientId ?? expectNumber(bindings[1]),
        tokenVersion: existing?.tokenVersion ?? expectNumber(bindings[2]),
        revokedAt: existing?.revokedAt,
      })
      return []
    }
    if (normalized.includes('update devices')) {
      const tokenVersion = expectNumber(bindings[0])
      const revokedAt = expectNumber(bindings[1])
      const deviceId = expectString(bindings[3])
      const existing = this.devices.get(deviceId)
      if (existing !== undefined) {
        this.devices.set(deviceId, { ...existing, tokenVersion, revokedAt })
      }
      return []
    }
    if (normalized.includes('insert into device_refresh_tokens')) {
      const tokenHash = expectString(bindings[0])
      this.refreshTokens.set(tokenHash, {
        tokenHash,
        deviceId: expectString(bindings[1]),
        issuedAt: expectNumber(bindings[2]),
        expiresAt: expectNumber(bindings[3]),
        revokedAt: undefined,
      })
      return []
    }
    if (normalized.includes('update device_refresh_tokens')) {
      const revokedAt = expectNumber(bindings[0])
      const tokenHash = expectString(bindings[1])
      const existing = this.refreshTokens.get(tokenHash)
      if (existing !== undefined) {
        this.refreshTokens.set(tokenHash, { ...existing, revokedAt })
      }
      return []
    }
    if (normalized.includes('select') && normalized.includes('min_retained_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows =
        doc === undefined
          ? []
          : [
              {
                latestSeq: doc.latestSeq,
                minRetainedSeq: doc.minRetainedSeq,
                horizonStateVector: doc.horizonStateVector,
              },
            ]
      return rows as Iterable<T>
    }
    if (
      normalized.includes('from docs') &&
      normalized.includes('latest_seq > latest_snapshot_seq')
    ) {
      const limit = expectNumber(bindings[0])
      const rows = [...this.docs.entries()]
        .filter(([, doc]) => doc.latestSeq > doc.latestSnapshotSeq)
        .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
        .slice(0, limit)
        .map(([docId]) => ({ docId }))
      return rows as Iterable<T>
    }
    if (normalized.includes('select latest_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows = doc === undefined ? [] : [{ latestSeq: doc.latestSeq }]
      return rows as Iterable<T>
    }
    if (
      normalized.includes('from docs') &&
      normalized.includes('limit') &&
      !normalized.includes('latest_seq > latest_snapshot_seq')
    ) {
      const first = this.docs.keys().next()
      const rows = first.done === true ? [] : [{ docId: first.value }]
      return rows as Iterable<T>
    }
    if (normalized.includes('select') && normalized.includes('latest_snapshot_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows =
        doc === undefined
          ? []
          : [
              {
                latestSnapshotSeq: doc.latestSnapshotSeq,
                latestSnapshotKey: doc.latestSnapshotKey,
              },
            ]
      return rows as Iterable<T>
    }
    if (
      normalized.includes('select update_bytes') &&
      !normalized.includes('from quarantined_updates')
    ) {
      const docId = expectString(bindings[0])
      const minSeq = expectNumber(bindings[1])
      const rows = [...this.opLog.values()]
        .filter((row) => row.docId === docId)
        .filter((row) => row.seq > minSeq)
        .sort((left, right) => left.seq - right.seq)
        .map((row) => ({ updateBytes: row.updateBytes }))
      return rows as Iterable<T>
    }
    if (normalized.includes('select durable_seq as durableseq')) {
      const docId = expectString(bindings[0])
      const messageId = expectString(bindings[1])
      const row = this.messageDedup.get(`${docId}:${messageId}`)
      const rows = row === undefined ? [] : [{ durableSeq: row.durableSeq }]
      return rows as Iterable<T>
    }
    if (normalized.includes('from checkpoint_runs') && normalized.includes('status in')) {
      const limit = expectNumber(bindings[3])
      const rows = [...this.checkpointRuns.values()]
        .filter(
          (run) =>
            run.status === 'writing' ||
            run.status === 'r2-written' ||
            run.status === 'pointer-updated',
        )
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, limit)
        .map((run) => ({
          runId: run.runId,
          docId: run.docId,
          status: run.status,
          upperSeq: run.upperSeq,
          snapshotKey: run.snapshotKey,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('from checkpoint_runs') && normalized.includes('snapshot_key')) {
      const docId = expectString(bindings[0])
      const rows = [...this.checkpointRuns.values()]
        .filter((run) => run.docId === docId)
        .map((run) => ({
          status: run.status,
          snapshotKey: run.snapshotKey,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('insert into snapshot_retention_events')) {
      this.snapshotRetentionEvents.push({
        docId: expectString(bindings[0]),
        snapshotKey: expectString(bindings[1]),
        action: expectString(bindings[2]),
        error: bindings[3] === null ? undefined : expectString(bindings[3]),
        attemptedAt: expectNumber(bindings[4]),
      })
      return []
    }
    if (normalized.includes('from snapshot_retention_events')) {
      const limit = expectNumber(bindings[0])
      const rows = [...this.snapshotRetentionEvents]
        .sort((left, right) => right.attemptedAt - left.attemptedAt)
        .slice(0, limit)
        .map((event) => ({
          docId: event.docId,
          snapshotKey: event.snapshotKey,
          action: event.action,
          error: event.error ?? null,
          attemptedAt: event.attemptedAt,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('insert into op_log')) {
      const docId = expectString(bindings[0])
      const seq = expectNumber(bindings[1])
      const messageId = expectString(bindings[2])
      this.opLog.set(`${docId}:${messageId}`, {
        docId,
        seq,
        messageId,
        deviceId: expectString(bindings[3]),
        yClientId: expectNumber(bindings[4]),
        updateBytes: expectUint8Array(bindings[5]),
        updateSha256: expectString(bindings[6]),
        createdAt: expectNumber(bindings[7]),
      })
      return []
    }
    if (normalized.includes('insert into docs')) {
      const docId = expectString(bindings[0])
      this.docs.set(docId, {
        kind: expectString(bindings[1]),
        latestSeq: expectNumber(bindings[2]),
        latestSnapshotSeq: this.docs.get(docId)?.latestSnapshotSeq ?? 0,
        latestSnapshotKey: this.docs.get(docId)?.latestSnapshotKey,
        minRetainedSeq: this.docs.get(docId)?.minRetainedSeq ?? 0,
        horizonStateVector: this.docs.get(docId)?.horizonStateVector,
        updatedAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('insert into message_dedup')) {
      const docId = expectString(bindings[0])
      const messageId = expectString(bindings[1])
      this.messageDedup.set(`${docId}:${messageId}`, {
        docId,
        messageId,
        durableSeq: expectNumber(bindings[2]),
        seenAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('insert into quarantined_updates')) {
      const id = expectString(bindings[0])
      this.quarantines.set(id, {
        id,
        docId: expectString(bindings[1]),
        messageId: expectString(bindings[2]),
        deviceId: expectString(bindings[3]),
        reason: expectString(bindings[4]),
        updateSha256: expectString(bindings[5]),
        updateBytes: expectUint8Array(bindings[6]),
        createdAt: expectNumber(bindings[7]),
      })
      return []
    }
    if (normalized.includes('from quarantined_updates') && normalized.includes('where id')) {
      const id = expectString(bindings[0])
      const row = this.quarantines.get(id)
      const rows = row === undefined ? [] : [quarantineSqlRow(row)]
      return rows as Iterable<T>
    }
    if (normalized.includes('from quarantined_updates')) {
      const rows = [...this.quarantines.values()]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(quarantineSqlRow)
      return rows as Iterable<T>
    }
    if (normalized.includes('insert into checkpoint_runs')) {
      const runId = expectString(bindings[0])
      this.checkpointRuns.set(runId, {
        runId,
        docId: expectString(bindings[1]),
        upperSeq: expectNumber(bindings[2]),
        snapshotKey: expectString(bindings[3]),
        stateVector: expectUint8Array(bindings[4]),
        status: expectString(bindings[5]),
        createdAt: expectNumber(bindings[6]),
        r2WrittenAt: undefined,
        pointerUpdatedAt: undefined,
        compactedAt: undefined,
      })
      return []
    }
    if (normalized.includes('update checkpoint_runs') && normalized.includes('r2_written_at')) {
      const status = expectString(bindings[0])
      const r2WrittenAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, r2WrittenAt })
      return []
    }
    if (
      normalized.includes('update checkpoint_runs') &&
      normalized.includes('set status = ? where run_id')
    ) {
      const status = expectString(bindings[0])
      const runId = expectString(bindings[1])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status })
      return []
    }
    if (
      normalized.includes('update checkpoint_runs') &&
      normalized.includes('pointer_updated_at')
    ) {
      const status = expectString(bindings[0])
      const pointerUpdatedAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, pointerUpdatedAt })
      return []
    }
    if (normalized.includes('update docs') && normalized.includes('latest_snapshot_seq')) {
      const latestSnapshotSeq = expectNumber(bindings[0])
      const latestSnapshotKey = expectString(bindings[1])
      const docId = expectString(bindings[4])
      const maxSnapshotSeq = expectNumber(bindings[5])
      const existing = this.docs.get(docId)
      if (existing === undefined || existing.latestSnapshotSeq > maxSnapshotSeq) {
        return []
      }
      this.docs.set(docId, {
        ...existing,
        latestSnapshotSeq,
        latestSnapshotKey,
        updatedAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('delete from op_log')) {
      const docId = expectString(bindings[0])
      const upperSeq = expectNumber(bindings[1])
      for (const [key, row] of this.opLog) {
        if (row.docId === docId && row.seq <= upperSeq) {
          this.opLog.delete(key)
        }
      }
      return []
    }
    if (normalized.includes('update docs') && normalized.includes('min_retained_seq')) {
      const minRetainedSeq = expectNumber(bindings[0])
      const horizonStateVector = expectUint8Array(bindings[1])
      const docId = expectString(bindings[3])
      const maxRetainedSeq = expectNumber(bindings[4])
      const existing = this.docs.get(docId)
      if (existing === undefined || existing.minRetainedSeq > maxRetainedSeq) {
        return []
      }
      this.docs.set(docId, {
        ...existing,
        minRetainedSeq,
        horizonStateVector,
        updatedAt: expectNumber(bindings[2]),
      })
      return []
    }
    if (normalized.includes('update checkpoint_runs') && normalized.includes('compacted_at')) {
      const status = expectString(bindings[0])
      const compactedAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, compactedAt })
      return []
    }
    throw new Error(`unexpected SQL query: ${query}`)
  }
}

export class FakeR2Object implements R2ObjectBodyBinding {
  constructor(private readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.bytes.byteLength)
    new Uint8Array(buffer).set(this.bytes)
    return buffer
  }
}

export class FakeR2Bucket implements R2BucketBinding {
  readonly gets: string[] = []
  readonly heads: string[] = []
  readonly lists: string[] = []
  readonly puts: string[] = []
  readonly deletes: string[] = []
  private readonly values = new Map<string, Uint8Array>()

  set(key: string, bytes: Uint8Array): void {
    this.values.set(key, bytes)
  }

  async get(key: string): Promise<R2ObjectBodyBinding | null> {
    this.gets.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : new FakeR2Object(bytes)
  }

  async head(key: string): Promise<{ readonly size: number } | null> {
    this.heads.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : { size: bytes.byteLength }
  }

  async list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding> {
    this.lists.push(options.prefix)
    return {
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({ key })),
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.puts.push(key)
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key)
    this.values.delete(key)
  }
}

export class SqlOnlyStorage implements DurableObjectStorageBinding {
  readonly sql = new RecordingSqlStorage()
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    const snapshot = this.snapshotSql()
    this.sql.queries.push('transaction begin')
    try {
      const result = await closure()
      this.sql.queries.push('transaction commit')
      return result
    } catch (error) {
      this.restoreSql(snapshot)
      this.sql.queries.push('transaction rollback')
      throw error
    }
  }

  private snapshotSql(): RecordingSqlSnapshot {
    return {
      docs: new Map(this.sql.docs),
      opLog: new Map(this.sql.opLog),
      messageDedup: new Map(this.sql.messageDedup),
      quarantines: new Map(this.sql.quarantines),
      checkpointRuns: new Map(this.sql.checkpointRuns),
      setupTokens: new Map(this.sql.setupTokens),
      refreshTokens: new Map(this.sql.refreshTokens),
      devices: new Map(this.sql.devices),
      migrationVersions: new Set(this.sql.migrationVersions),
    }
  }

  private restoreSql(snapshot: RecordingSqlSnapshot): void {
    replaceMap(this.sql.docs, snapshot.docs)
    replaceMap(this.sql.opLog, snapshot.opLog)
    replaceMap(this.sql.messageDedup, snapshot.messageDedup)
    replaceMap(this.sql.quarantines, snapshot.quarantines)
    replaceMap(this.sql.checkpointRuns, snapshot.checkpointRuns)
    replaceMap(this.sql.setupTokens, snapshot.setupTokens)
    replaceMap(this.sql.refreshTokens, snapshot.refreshTokens)
    replaceMap(this.sql.devices, snapshot.devices)
    replaceSet(this.sql.migrationVersions, snapshot.migrationVersions)
  }
}

export interface RecordingSqlSnapshot {
  readonly docs: Map<string, RecordedDocRow>
  readonly opLog: Map<string, RecordedOpLogRow>
  readonly messageDedup: Map<string, RecordedMessageDedupRow>
  readonly quarantines: Map<string, RecordedQuarantineRow>
  readonly checkpointRuns: Map<string, RecordedCheckpointRunRow>
  readonly setupTokens: Map<string, RecordedSetupTokenRow>
  readonly refreshTokens: Map<string, RecordedRefreshTokenRow>
  readonly devices: Map<string, RecordedDeviceRow>
  readonly migrationVersions: Set<number>
}

export function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, value)
  }
}

export function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
  target.clear()
  for (const value of source) {
    target.add(value)
  }
}

export class FakeState implements DurableObjectStateBinding {
  readonly accepted: RuntimeWebSocket[] = []

  constructor(readonly storage: DurableObjectStorageBinding = new MemoryStorage()) {}

  acceptWebSocket(webSocket: RuntimeWebSocket): void {
    webSocket.accept?.()
    this.accepted.push(webSocket)
  }

  getWebSockets(): readonly RuntimeWebSocket[] {
    return this.accepted
  }
}

test('worker entrypoint routes vault websocket upgrades to a Durable Object', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('routed', { status: 209 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/ws/vault-1', {
    headers: { Upgrade: 'websocket' },
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 209)
  assert.equal(await response.text(), 'routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest, request)
})

test('worker entrypoint routes setup exchange requests by body vaultId', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('setup-routed', { status: 207 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/setup/exchange', {
    method: 'POST',
    body: JSON.stringify({
      vaultId: 'vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'Laptop',
    }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 207)
  assert.equal(await response.text(), 'setup-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/setup/exchange')
})

export function makeEnv(): WorkerEnv {
  return {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(): Promise<Response> {
            return new Response('unused')
          },
        }
      },
    },
  }
}

export function quarantineSqlRow(row: RecordedQuarantineRow): Record<string, unknown> {
  return {
    id: row.id,
    docId: row.docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    updateSha256: row.updateSha256,
    updateBytes: row.updateBytes,
    createdAt: row.createdAt,
  }
}

export function makeEnvWithSnapshotBucket(bucket: R2BucketBinding): WorkerEnv {
  return { ...makeEnv(), SNAPSHOT_BUCKET: bucket }
}

export function makeEnvWithSnapshotBucketAndDeviceTokenSecret(
  bucket: R2BucketBinding,
  secret: string,
): WorkerEnv {
  return { ...makeEnvWithSnapshotBucket(bucket), DEVICE_TOKEN_SECRET: secret }
}

export function makeEnvWithDeviceTokenSecret(secret: string): WorkerEnv {
  return { ...makeEnv(), DEVICE_TOKEN_SECRET: secret }
}

export async function makeAuthenticatedWebSocketRequest(
  secret = TEST_DEVICE_TOKEN_SECRET,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<Request> {
  return new Request('https://worker.example/ws/vault-1', {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${await makeDeviceToken(secret, {
        tokenVersion: 1,
        ...overrides,
      })}`,
    },
  })
}

export function makeHello(): ClientHello {
  return {
    type: 'hello',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    yClientId: 1,
    capabilities: [],
  }
}

export function makeSyncUpdate(messageId: SyncUpdate['messageId']): SyncUpdate {
  return {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    update: makeYjsUpdateBase64(messageId),
  }
}

export function makeSyncRequest(
  messageId: SyncRequest['messageId'],
  stateVector: string,
): SyncRequest {
  return {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    stateVector,
  }
}

export function makeYjsUpdateBase64(messageId: SyncUpdate['messageId']): string {
  const doc = new Y.Doc()
  const fileId = makeFileId(`file-${messageId}`)
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: `${messageId}.md`,
    canonicalPath: `${messageId}.md`,
    deleted: false,
    type: 'text',
    ydocId: makeYDocId(`ydoc-${messageId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeInvalidMetaSchemaYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  const fileId = makeFileId('file-invalid-meta')
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Valid.md',
    canonicalPath: 'wrong.md',
    deleted: false,
    type: 'text',
    ydocId: makeYDocId('ydoc-invalid-meta'),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeLargeFileYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'x'.repeat(600 * 1024))
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeYjsUpdateBytes(messageId: SyncUpdate['messageId']): Uint8Array {
  return new Uint8Array(Buffer.from(makeYjsUpdateBase64(messageId), 'base64'))
}

export function stringMessageAt(
  messages: readonly (string | ArrayBuffer)[],
  index: number,
): string {
  const message = syncMessages(messages)[index]
  if (message === undefined) {
    throw new Error(`missing message at index ${index}`)
  }
  return stringMessage(message)
}

export function findAckForMessage(
  messages: readonly (string | ArrayBuffer)[],
  messageId: string,
): Ack | undefined {
  for (const message of syncMessages(messages)) {
    if (typeof message !== 'string') {
      continue
    }
    const parsed = JSON.parse(message) as unknown
    if (v.is(AckSchema, parsed) && parsed.messageId === messageId) {
      return parsed
    }
  }
  return undefined
}

export function hasTypeProperty(obj: unknown): obj is { type: unknown } {
  return typeof obj === 'object' && obj !== null && 'type' in obj
}

export function syncMessages(
  messages: readonly (string | ArrayBuffer)[],
): readonly (string | ArrayBuffer)[] {
  return messages.filter((message) => {
    if (typeof message !== 'string') {
      return true
    }
    const parsed: unknown = JSON.parse(message)
    if (hasTypeProperty(parsed) && typeof parsed.type === 'string') {
      return parsed.type !== 'hello-accepted'
    }
    return true
  })
}

export function stringMessage(message: string | ArrayBuffer): string {
  if (typeof message !== 'string') {
    throw new Error('expected string message')
  }
  return message
}

export function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export function makeStateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString('base64')
}

export function decodeTestBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

export async function makeDeviceToken(
  secret: string,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<string> {
  const now = Date.now()
  const claims: DeviceTokenClaims = {
    iss: DEVICE_TOKEN_ISSUER,
    aud: makeVaultId('vault-1'),
    sub: makeDeviceId('device-1'),
    scope: ['sync:read', 'sync:write'] satisfies readonly DeviceTokenScope[],
    iat: now - 1_000,
    exp: now + 60_000,
    tokenVersion: 2,
    ...overrides,
  }
  const encodedHeader = encodeTestBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const encodedPayload = encodeTestBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await signTestHs256(`${encodedHeader}.${encodedPayload}`, secret)
  return `${encodedHeader}.${encodedPayload}.${encodeTestBase64Url(signature)}`
}

export async function signTestHs256(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export function encodeTestBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export async function hashTestText(value: string): Promise<string> {
  return hashTestBytes(new TextEncoder().encode(value))
}

export async function hashTestBytes(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength)
  bytes.set(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function testBlobManifest(): BlobManifest {
  return {
    version: 1,
    fileId: makeFileId('file-1'),
    contentSha256: makeSha256Hex('f'.repeat(64)),
    size: 123,
    chunks: [
      { sha256: makeSha256Hex('d'.repeat(64)), offset: 0, size: 64 },
      { sha256: makeSha256Hex('e'.repeat(64)), offset: 64, size: 59 },
    ],
    createdBy: makeDeviceId('device-1'),
    createdAt: 1_000,
  }
}

export function expectString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('expected string SQL binding')
  }
  return value
}

export function expectNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('expected number SQL binding')
  }
  return value
}

export function expectUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  throw new Error('expected Uint8Array SQL binding')
}

export function installFakeWebSocketPair(): unknown {
  const previous = Reflect.get(globalThis, 'WebSocketPair')
  Reflect.set(globalThis, 'WebSocketPair', FakeWebSocketPair)
  return previous
}

export function installFakeUpgradeResponse(): unknown {
  const previous = Reflect.get(globalThis, 'Response')
  Reflect.set(globalThis, 'Response', FakeUpgradeResponse)
  return previous
}

export function restoreWebSocketPair(previous: unknown): void {
  if (previous === undefined) {
    Reflect.deleteProperty(globalThis, 'WebSocketPair')
    return
  }
  Reflect.set(globalThis, 'WebSocketPair', previous)
}

export function restoreResponse(previous: unknown): void {
  Reflect.set(globalThis, 'Response', previous)
}
