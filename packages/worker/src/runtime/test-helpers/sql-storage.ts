import type { DurableObjectSqlStorageBinding } from '..'
import { expectString, expectNumber, expectUint8Array, quarantineSqlRow } from './helpers'

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
