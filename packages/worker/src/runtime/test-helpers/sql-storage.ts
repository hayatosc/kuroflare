import type { DurableObjectSqlStorageBinding } from '..'
import { expectString, expectNumber, expectUint8Array, quarantineSqlRow } from './helpers'

export interface RecordedDocRow {
  readonly kind: string
  readonly latestSeq: number
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | undefined
  readonly latestStateVector?: Uint8Array | undefined
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
  readonly updateSha256?: string | undefined
  readonly seenAt: number
}

export interface RecordedSnapshotRetentionEventRow {
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | undefined
  readonly attemptedAt: number
}

export interface RecordedSnapshotHealthEventRow {
  readonly id: number
  readonly docId: string
  readonly snapshotKey: string
  readonly upperSeq: number
  readonly event: string
  readonly actor: string
  readonly authorityStatus: string
  readonly expectedByteLength: number | undefined
  readonly expectedUpdateSha256: string | undefined
  readonly expectedStateVectorSha256: string | undefined
  readonly actualByteLength: number | undefined
  readonly actualUpdateSha256: string | undefined
  readonly actualStateVectorSha256: string | undefined
  readonly physicalStatus: string | undefined
  readonly logicalStatus: string | undefined
  readonly reasons: string
  readonly observedAt: number
}

export class RecordingSqlStorage implements DurableObjectSqlStorageBinding {
  readonly docs = new Map<string, RecordedDocRow>()
  readonly opLog = new Map<string, RecordedOpLogRow>()
  readonly messageDedup = new Map<string, RecordedMessageDedupRow>()
  readonly quarantines = new Map<string, RecordedQuarantineRow>()
  readonly checkpointRuns = new Map<string, RecordedCheckpointRunRow>()
  readonly snapshotRetentionEvents: RecordedSnapshotRetentionEventRow[] = []
  readonly snapshotHealthEvents: RecordedSnapshotHealthEventRow[] = []
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
  readonly messageDedupColumns = new Set<string>()
  readonly queries: string[] = []
  failOnQueryIncludes: string | undefined
  failAfterQueryIncludes: string | undefined

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
    if (normalized.startsWith('pragma table_info(message_dedup)')) {
      return [...this.messageDedupColumns].map((name) => ({ name })) as Iterable<T>
    }
    if (normalized.includes('alter table message_dedup') && normalized.includes('update_sha256')) {
      this.messageDedupColumns.add('update_sha256')
      return []
    }
    if (normalized.startsWith('alter table')) {
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
                latestStateVector: doc.latestStateVector ?? null,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('select seq, update_bytes')) {
      const docId = expectString(bindings[0])
      const afterSeq = expectNumber(bindings[1])
      const throughSeq = normalized.includes('seq <= ?') ? expectNumber(bindings[2]) : undefined
      const rows = [...this.opLog.values()]
        .filter((row) => row.docId === docId)
        .filter((row) => row.seq > afterSeq)
        .filter((row) => throughSeq === undefined || row.seq <= throughSeq)
        .sort((left, right) => left.seq - right.seq)
        .map((row) => ({ seq: row.seq, updateBytes: row.updateBytes }))
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
      const rows =
        row === undefined
          ? []
          : [{ durableSeq: row.durableSeq, updateSha256: row.updateSha256 ?? null }]
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
          stateVector: run.stateVector,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('from checkpoint_runs') && normalized.includes('snapshot_key')) {
      const docId = expectString(bindings[0])
      const rows = [...this.checkpointRuns.values()]
        .filter((run) => run.docId === docId)
        .map((run) => ({
          status: run.status,
          upperSeq: run.upperSeq,
          snapshotKey: run.snapshotKey,
          stateVector: run.stateVector,
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
    if (normalized.includes('insert into snapshot_health_events')) {
      this.snapshotHealthEvents.push({
        id: this.snapshotHealthEvents.length + 1,
        docId: expectString(bindings[0]),
        snapshotKey: expectString(bindings[1]),
        upperSeq: expectNumber(bindings[2]),
        event: expectString(bindings[3]),
        actor: expectString(bindings[4]),
        authorityStatus: expectString(bindings[5]),
        expectedByteLength: bindings[6] === null ? undefined : expectNumber(bindings[6]),
        expectedUpdateSha256: bindings[7] === null ? undefined : expectString(bindings[7]),
        expectedStateVectorSha256: bindings[8] === null ? undefined : expectString(bindings[8]),
        actualByteLength: bindings[9] === null ? undefined : expectNumber(bindings[9]),
        actualUpdateSha256: bindings[10] === null ? undefined : expectString(bindings[10]),
        actualStateVectorSha256: bindings[11] === null ? undefined : expectString(bindings[11]),
        physicalStatus: bindings[12] === null ? undefined : expectString(bindings[12]),
        logicalStatus: bindings[13] === null ? undefined : expectString(bindings[13]),
        reasons: expectString(bindings[14]),
        observedAt: expectNumber(bindings[15]),
      })
      return []
    }
    if (normalized.includes('from snapshot_health_events')) {
      const docId = expectString(bindings[0])
      const hasKey = normalized.includes('snapshot_key = ?')
      const snapshotKey = hasKey ? expectString(bindings[1]) : undefined
      const isLatestPerKeyQuery = normalized.includes('from snapshot_health_events as event')
      const sourceRows = this.snapshotHealthEvents
        .filter((row) => row.docId === docId)
        .filter((row) => snapshotKey === undefined || row.snapshotKey === snapshotKey)
      const latestRows = isLatestPerKeyQuery
        ? [
            ...sourceRows
              .reduce((latest, row) => {
                const previous = latest.get(row.snapshotKey)
                if (previous === undefined || previous.id < row.id) latest.set(row.snapshotKey, row)
                return latest
              }, new Map<string, RecordedSnapshotHealthEventRow>())
              .values(),
          ]
        : sourceRows
      const rows = latestRows
        .sort((left, right) => {
          if (
            normalized.includes('order by upper_seq desc') ||
            normalized.includes('order by event.upper_seq desc')
          )
            return right.upperSeq - left.upperSeq || right.id - left.id
          if (
            normalized.includes('order by id desc') ||
            normalized.includes('order by event.id desc')
          )
            return right.id - left.id
          return left.id - right.id
        })
        .slice(
          0,
          isLatestPerKeyQuery && normalized.includes('limit ?')
            ? expectNumber(bindings[1])
            : isLatestPerKeyQuery
              ? latestRows.length
              : 2048,
        )
        .map((row) => ({
          id: row.id,
          docId: row.docId,
          snapshotKey: row.snapshotKey,
          upperSeq: row.upperSeq,
          event: row.event,
          actor: row.actor,
          authorityStatus: row.authorityStatus,
          expectedByteLength: row.expectedByteLength ?? null,
          expectedUpdateSha256: row.expectedUpdateSha256 ?? null,
          expectedStateVectorSha256: row.expectedStateVectorSha256 ?? null,
          actualByteLength: row.actualByteLength ?? null,
          actualUpdateSha256: row.actualUpdateSha256 ?? null,
          actualStateVectorSha256: row.actualStateVectorSha256 ?? null,
          physicalStatus: row.physicalStatus ?? null,
          logicalStatus: row.logicalStatus ?? null,
          reasons: row.reasons,
          observedAt: row.observedAt,
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
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (normalized.includes('insert into docs') && normalized.includes('latest_snapshot_seq')) {
      const docId = expectString(bindings[0])
      this.docs.set(docId, {
        kind: expectString(bindings[1]),
        latestSeq: expectNumber(bindings[2]),
        latestSnapshotSeq: expectNumber(bindings[3]),
        latestSnapshotKey: expectString(bindings[4]),
        latestStateVector: expectUint8Array(bindings[5]),
        minRetainedSeq: expectNumber(bindings[6]),
        horizonStateVector: undefined,
        updatedAt: expectNumber(bindings[7]),
      })
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (normalized.includes('insert into docs')) {
      const docId = expectString(bindings[0])
      this.docs.set(docId, {
        kind: expectString(bindings[1]),
        latestSeq: expectNumber(bindings[2]),
        latestSnapshotSeq: this.docs.get(docId)?.latestSnapshotSeq ?? 0,
        latestSnapshotKey: this.docs.get(docId)?.latestSnapshotKey,
        latestStateVector: this.docs.get(docId)?.latestStateVector,
        minRetainedSeq: this.docs.get(docId)?.minRetainedSeq ?? 0,
        horizonStateVector: this.docs.get(docId)?.horizonStateVector,
        updatedAt: expectNumber(bindings[3]),
      })
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (normalized.includes('insert into message_dedup')) {
      const docId = expectString(bindings[0])
      const messageId = expectString(bindings[1])
      this.messageDedup.set(`${docId}:${messageId}`, {
        docId,
        messageId,
        durableSeq: expectNumber(bindings[2]),
        updateSha256: bindings[3] === null ? undefined : expectString(bindings[3]),
        seenAt: expectNumber(bindings[4]),
      })
      this.maybeFailAfterQuery(normalized)
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
      const latestSnapshotSeq = expectNumber(bindings[1])
      const latestSnapshotKey = expectString(bindings[2])
      const docId = expectString(bindings[5])
      const maxSnapshotSeq = expectNumber(bindings[6])
      const existing = this.docs.get(docId)
      if (existing === undefined || existing.latestSnapshotSeq > maxSnapshotSeq) {
        return []
      }
      this.docs.set(docId, {
        ...existing,
        latestSeq: Math.max(existing.latestSeq, expectNumber(bindings[0])),
        latestSnapshotSeq,
        latestSnapshotKey,
        latestStateVector: expectUint8Array(bindings[3]),
        updatedAt: expectNumber(bindings[4]),
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

  private maybeFailAfterQuery(normalized: string): void {
    if (
      this.failAfterQueryIncludes !== undefined &&
      normalized.includes(this.failAfterQueryIncludes)
    ) {
      throw new Error(`injected SQL failure after query: ${this.failAfterQueryIncludes}`)
    }
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
  readonly messageDedupColumns: Set<string>
  readonly snapshotHealthEvents: RecordedSnapshotHealthEventRow[]
}
