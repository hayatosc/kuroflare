import type { DurableObjectSqlStorageBinding } from '../runtime'
import { expectString, expectNumber, expectUint8Array, quarantineSqlRow } from './support'

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

export interface RecordedColumnInfo {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

export interface RecordedIndex {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
}

export interface RecordedForeignKey {
  readonly table: string
  readonly from: string
  readonly to: string
}

export interface RecordedMessageDedupRow {
  readonly docId: string
  readonly messageId: string
  readonly durableSeq: number
  readonly updateSha256?: string | undefined
  readonly seenAt: number
}

export interface RecordedSnapshotRetentionEventRow {
  readonly id: number
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | undefined
  readonly attemptedAt: number
}

export interface RecordedQuarantineAuditEventRow {
  readonly id: number
  readonly quarantineId: string
  readonly docId: string
  readonly messageId: string
  readonly deviceId: string
  readonly reason: string
  readonly action: string
  readonly actor: string
  readonly appliedSeq: number | undefined
  readonly quarantinedAt: number
  readonly resolvedAt: number
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

export interface RecordedBlobMultipartUploadRow {
  readonly uploadId: string
  readonly sha256: string
  readonly size: number
  readonly createdAt: number
  readonly expiresAt: number
}

export interface RecordedBlobMultipartPartRow {
  readonly uploadId: string
  readonly partNumber: number
  readonly etag: string
  readonly size: number
  readonly sha256: string
}

export class RecordingSqlStorage implements DurableObjectSqlStorageBinding {
  readonly docs = new Map<string, RecordedDocRow>()
  readonly opLog = new Map<string, RecordedOpLogRow>()
  readonly messageDedup = new Map<string, RecordedMessageDedupRow>()
  readonly quarantines = new Map<string, RecordedQuarantineRow>()
  readonly checkpointRuns = new Map<string, RecordedCheckpointRunRow>()
  readonly snapshotRetentionEvents: RecordedSnapshotRetentionEventRow[] = []
  readonly quarantineAuditEvents: RecordedQuarantineAuditEventRow[] = []
  readonly snapshotHealthEvents: RecordedSnapshotHealthEventRow[] = []
  readonly setupTokens = new Map<string, RecordedSetupTokenRow>()
  readonly refreshTokens = new Map<string, RecordedRefreshTokenRow>()
  readonly blobMultipartUploads = new Map<string, RecordedBlobMultipartUploadRow>()
  readonly blobMultipartParts = new Map<string, RecordedBlobMultipartPartRow>()
  readonly devices = new Map<string, RecordedDeviceRow>([
    [
      'device-1',
      {
        deviceId: 'device-1',
        tokenVersion: 1,
        revokedAt: undefined,
      },
    ],
  ])
  readonly migrationVersions = new Set<number>()
  readonly messageDedupColumns = new Set<string>()
  readonly tableColumns = new Map<string, readonly string[]>([
    ['devices', ['device_id', 'token_version', 'revoked_at', 'created_at', 'last_seen_at']],
    [
      'op_log',
      ['doc_id', 'seq', 'message_id', 'device_id', 'update_bytes', 'update_sha256', 'created_at'],
    ],
    ['connected_devices', ['device_id', 'last_seen_at', 'user_agent', 'protocol_version']],
  ])
  readonly tableRowCounts = new Map<string, number>([
    ['devices', 0],
    ['op_log', 0],
    ['connected_devices', 0],
  ])
  readonly tableRows = new Map<string, readonly (readonly unknown[])[]>([
    ['devices', []],
    ['op_log', []],
    ['connected_devices', []],
  ])
  readonly tableColumnDetails = new Map<string, readonly RecordedColumnInfo[]>()
  readonly tableIndexes = new Map<string, readonly RecordedIndex[]>([
    ['devices', [{ name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] }]],
    [
      'op_log',
      [
        { name: 'sqlite_autoindex_op_log_1', unique: true, columns: ['doc_id', 'seq'] },
        { name: 'sqlite_autoindex_op_log_2', unique: true, columns: ['doc_id', 'message_id'] },
        { name: 'idx_op_log_doc_seq', unique: false, columns: ['doc_id', 'seq'] },
      ],
    ],
    [
      'connected_devices',
      [{ name: 'sqlite_autoindex_connected_devices_1', unique: true, columns: ['device_id'] }],
    ],
  ])
  readonly tableForeignKeys = new Map<string, readonly RecordedForeignKey[]>([
    ['device_refresh_tokens', [{ table: 'devices', from: 'device_id', to: 'device_id' }]],
  ])
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
    const trimmed = normalized.trim()
    if (trimmed.startsWith('create table')) {
      const match = trimmed.match(/^create table(?: if not exists)? ([a-z0-9_]+)/)
      const table = match?.[1]
      if (table !== undefined) {
        const columns = this.expectedTableColumns(table)
        if (columns !== undefined) this.tableColumns.set(table, columns)
        if (!this.tableRowCounts.has(table)) this.tableRowCounts.set(table, 0)
        if (!this.tableRows.has(table)) this.tableRows.set(table, [])
        if (columns !== undefined) {
          this.tableIndexes.set(table, this.expectedTableIndexes(table))
          this.tableForeignKeys.set(table, [])
        }
      }
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (trimmed.startsWith('create index')) {
      const match = trimmed.match(
        /^create index(?: if not exists)? ([a-z0-9_]+) on ([a-z0-9_]+)\s*\(([^)]+)\)/,
      )
      if (match !== null) {
        const [, name, table, columns] = match
        if (name !== undefined && table !== undefined && columns !== undefined) {
          const existing = this.tableIndexes.get(table) ?? []
          if (!existing.some((index) => index.name === name)) {
            this.tableIndexes.set(table, [
              ...existing,
              { name, unique: false, columns: columns.split(',').map((column) => column.trim()) },
            ])
          }
        }
      }
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (trimmed.startsWith('pragma table_info(message_dedup)')) {
      return [...this.messageDedupColumns].map((name) => ({ name })) as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(devices)')) {
      return this.tableInfoRows('devices') as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(op_log)')) {
      return this.tableInfoRows('op_log') as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(connected_devices)')) {
      return this.tableInfoRows('connected_devices') as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(devices__dr007)')) {
      return this.tableInfoRows('devices__dr007') as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(op_log__dr007)')) {
      return this.tableInfoRows('op_log__dr007') as Iterable<T>
    }
    if (trimmed.startsWith('pragma table_info(connected_devices__dr007)')) {
      return this.tableInfoRows('connected_devices__dr007') as Iterable<T>
    }
    if (trimmed.startsWith('pragma index_list(')) {
      const match = trimmed.match(/^pragma index_list\(([a-z0-9_]+)\)/)
      const table = match?.[1]
      return (
        table === undefined
          ? []
          : (this.tableIndexes.get(table) ?? []).map((index, seq) => ({
              seq,
              name: index.name,
              unique: index.unique ? 1 : 0,
              origin: index.name.startsWith('sqlite_autoindex') ? 'pk' : 'c',
              partial: 0,
            }))
      ) as Iterable<T>
    }
    if (trimmed.startsWith('pragma index_info(')) {
      const match = trimmed.match(/^pragma index_info\(([a-z0-9_]+)\)/)
      const name = match?.[1]
      const index =
        name === undefined
          ? undefined
          : [...this.tableIndexes.values()].flat().find((candidate) => candidate.name === name)
      return (index?.columns ?? []).map((column, seqno) => ({
        seqno,
        cid: seqno,
        name: column,
      })) as Iterable<T>
    }
    if (trimmed.startsWith('pragma foreign_key_list(')) {
      const match = trimmed.match(/^pragma foreign_key_list\(([a-z0-9_]+)\)/)
      const table = match?.[1]
      return (
        table === undefined
          ? []
          : (this.tableForeignKeys.get(table) ?? []).map((foreignKey, id) => ({
              id,
              seq: 0,
              table: foreignKey.table,
              from: foreignKey.from,
              to: foreignKey.to,
              on_update: 'NO ACTION',
              on_delete: 'NO ACTION',
              match: 'NONE',
            }))
      ) as Iterable<T>
    }
    if (trimmed.startsWith('pragma foreign_keys')) return []
    if (normalized.includes('alter table message_dedup') && normalized.includes('update_sha256')) {
      this.messageDedupColumns.add('update_sha256')
      return []
    }
    if (trimmed.startsWith('alter table')) {
      const match = trimmed.match(/^alter table ([a-z0-9_]+) rename to ([a-z0-9_]+)/)
      if (match !== null) {
        const [, source, target] = match
        if (source !== undefined && target !== undefined) {
          const columns = this.tableColumns.get(source)
          if (columns !== undefined) this.tableColumns.set(target, columns)
          const rowCount = this.tableRowCounts.get(source)
          if (rowCount !== undefined) this.tableRowCounts.set(target, rowCount)
          const rows = this.tableRows.get(source)
          if (rows !== undefined) this.tableRows.set(target, rows)
          const indexes = this.tableIndexes.get(source)
          if (indexes !== undefined) {
            this.tableIndexes.set(
              target,
              indexes.map((index) => ({
                ...index,
                name: index.name.startsWith('sqlite_autoindex')
                  ? index.name.replace(source, target)
                  : index.name,
              })),
            )
          }
          const foreignKeys = this.tableForeignKeys.get(source)
          if (foreignKeys !== undefined) this.tableForeignKeys.set(target, foreignKeys)
          const columnDetails = this.tableColumnDetails.get(source)
          if (columnDetails !== undefined) this.tableColumnDetails.set(target, columnDetails)
          this.tableColumns.delete(source)
          this.tableRowCounts.delete(source)
          this.tableRows.delete(source)
          this.tableIndexes.delete(source)
          this.tableForeignKeys.delete(source)
          this.tableColumnDetails.delete(source)
        }
      }
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (trimmed.startsWith('drop table')) {
      const match = trimmed.match(/^drop table(?: if exists)? ([a-z0-9_]+)/)
      const table = match?.[1]
      if (table !== undefined) {
        this.tableColumns.delete(table)
        this.tableRowCounts.delete(table)
        this.tableRows.delete(table)
        this.tableIndexes.delete(table)
        this.tableForeignKeys.delete(table)
        this.tableColumnDetails.delete(table)
      }
      this.maybeFailAfterQuery(normalized)
      return []
    }
    if (trimmed.startsWith('select count(*) as count from')) {
      const match = trimmed.match(/from ([a-z0-9_]+)/)
      const table = match?.[1]
      if (table === undefined) throw new Error(`missing count table: ${query}`)
      return [{ count: this.tableRowCounts.get(table) ?? 0 }] as Iterable<T>
    }
    if (trimmed.startsWith('insert into ') && normalized.includes('__dr007')) {
      const match = trimmed.match(/^insert into ([a-z0-9_]+)__dr007\s*\(/)
      const target = match?.[1]
      if (target !== undefined) {
        this.tableRowCounts.set(`${target}__dr007`, this.tableRowCounts.get(target) ?? 0)
        const rows = this.tableRows.get(target)
        if (rows !== undefined) {
          const sourceColumns = this.tableColumns.get(target) ?? []
          const legacyIndex = sourceColumns.indexOf('y_client_id')
          const sortedRows = [...rows].sort((left, right) => {
            if (target !== 'op_log') return 0
            const docIndex = sourceColumns.indexOf('doc_id')
            const seqIndex = sourceColumns.indexOf('seq')
            return (
              String(left[docIndex]).localeCompare(String(right[docIndex])) ||
              Number(left[seqIndex]) - Number(right[seqIndex])
            )
          })
          this.tableRows.set(
            `${target}__dr007`,
            sortedRows.map((row) =>
              legacyIndex < 0 ? row : row.filter((_value, index) => index !== legacyIndex),
            ),
          )
        }
        this.maybeFailAfterQuery(normalized)
        return []
      }
    }
    if (normalized.includes('from schema_migrations')) {
      return [...this.migrationVersions].map((version) => ({ version })) as Iterable<T>
    }
    if (normalized.includes('insert into schema_migrations')) {
      this.migrationVersions.add(expectNumber(bindings[0]))
      this.maybeFailAfterQuery(normalized)
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
      const deviceId = expectString(bindings[0])
      const device = this.devices.get(deviceId)
      const rows =
        device === undefined
          ? []
          : [
              {
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
        tokenVersion: existing?.tokenVersion ?? expectNumber(bindings[1]),
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
        id: this.snapshotRetentionEvents.length + 1,
        docId: expectString(bindings[0]),
        snapshotKey: expectString(bindings[1]),
        action: expectString(bindings[2]),
        error: bindings[3] === null ? undefined : expectString(bindings[3]),
        attemptedAt: expectNumber(bindings[4]),
      })
      return []
    }
    if (normalized.includes('from snapshot_retention_events')) {
      const hasCursor = normalized.includes('where id <')
      const cursor = hasCursor ? expectNumber(bindings[0]) : undefined
      const limit = expectNumber(bindings[hasCursor ? 1 : 0])
      const rows = [...this.snapshotRetentionEvents]
        .filter((event) => cursor === undefined || event.id < cursor)
        .sort((left, right) => right.id - left.id)
        .slice(0, limit)
        .map((event) => ({
          id: event.id,
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
        updateBytes: expectUint8Array(bindings[4]),
        updateSha256: expectString(bindings[5]),
        createdAt: expectNumber(bindings[6]),
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
    if (normalized.includes('delete from quarantined_updates')) {
      this.quarantines.delete(expectString(bindings[0]))
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
    if (normalized.includes('insert into quarantine_audit_events')) {
      this.quarantineAuditEvents.push({
        id: this.quarantineAuditEvents.length + 1,
        quarantineId: expectString(bindings[0]),
        docId: expectString(bindings[1]),
        messageId: expectString(bindings[2]),
        deviceId: expectString(bindings[3]),
        reason: expectString(bindings[4]),
        action: expectString(bindings[5]),
        actor: expectString(bindings[6]),
        appliedSeq: bindings[7] === null ? undefined : expectNumber(bindings[7]),
        quarantinedAt: expectNumber(bindings[8]),
        resolvedAt: expectNumber(bindings[9]),
      })
      return []
    }
    if (normalized.includes('from quarantine_audit_events')) {
      const hasCursor = normalized.includes('where id <')
      const cursor = hasCursor ? expectNumber(bindings[0]) : undefined
      const limit = expectNumber(bindings[hasCursor ? 1 : 0])
      const rows = [...this.quarantineAuditEvents]
        .filter((event) => cursor === undefined || event.id < cursor)
        .sort((left, right) => right.id - left.id)
        .slice(0, limit)
        .map((event) => ({
          id: event.id,
          quarantineId: event.quarantineId,
          docId: event.docId,
          messageId: event.messageId,
          deviceId: event.deviceId,
          reason: event.reason,
          action: event.action,
          actor: event.actor,
          appliedSeq: event.appliedSeq ?? null,
          quarantinedAt: event.quarantinedAt,
          resolvedAt: event.resolvedAt,
        }))
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
    if (normalized.includes('insert into blob_multipart_uploads')) {
      const uploadId = expectString(bindings[0])
      this.blobMultipartUploads.set(uploadId, {
        uploadId,
        sha256: expectString(bindings[1]),
        size: expectNumber(bindings[2]),
        createdAt: expectNumber(bindings[3]),
        expiresAt: expectNumber(bindings[4]),
      })
      return []
    }
    if (
      normalized.includes('from blob_multipart_uploads') &&
      normalized.includes('expires_at <=')
    ) {
      const now = expectNumber(bindings[0])
      const limit = expectNumber(bindings[1])
      const rows = [...this.blobMultipartUploads.values()]
        .filter((row) => row.expiresAt <= now)
        .slice(0, limit)
        .map((row) => ({ uploadId: row.uploadId, sha256: row.sha256 }))
      return rows as Iterable<T>
    }
    if (normalized.includes('from blob_multipart_uploads')) {
      const uploadId = expectString(bindings[0])
      const row = this.blobMultipartUploads.get(uploadId)
      const rows =
        row === undefined
          ? []
          : [
              {
                sha256: row.sha256,
                size: row.size,
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('delete from blob_multipart_uploads')) {
      this.blobMultipartUploads.delete(expectString(bindings[0]))
      return []
    }
    if (normalized.includes('insert into blob_multipart_parts')) {
      const uploadId = expectString(bindings[0])
      const partNumber = expectNumber(bindings[1])
      this.blobMultipartParts.set(`${uploadId}:${partNumber}`, {
        uploadId,
        partNumber,
        etag: expectString(bindings[2]),
        size: expectNumber(bindings[3]),
        sha256: expectString(bindings[4]),
      })
      return []
    }
    if (normalized.includes('from blob_multipart_parts')) {
      const uploadId = expectString(bindings[0])
      const rows = [...this.blobMultipartParts.values()]
        .filter((row) => row.uploadId === uploadId)
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((row) => ({
          partNumber: row.partNumber,
          etag: row.etag,
          size: row.size,
          sha256: row.sha256,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('delete from blob_multipart_parts')) {
      const uploadId = expectString(bindings[0])
      for (const [key, row] of this.blobMultipartParts) {
        if (row.uploadId === uploadId) this.blobMultipartParts.delete(key)
      }
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

  private expectedTableColumns(table: string): readonly string[] | undefined {
    if (!table.endsWith('__dr007')) return undefined
    const base = table.slice(0, -'__dr007'.length)
    return {
      devices: ['device_id', 'token_version', 'revoked_at', 'created_at', 'last_seen_at'],
      op_log: [
        'doc_id',
        'seq',
        'message_id',
        'device_id',
        'update_bytes',
        'update_sha256',
        'created_at',
      ],
      connected_devices: ['device_id', 'last_seen_at', 'user_agent', 'protocol_version'],
    }[base]
  }

  private tableInfoRows(table: string): readonly Record<string, unknown>[] {
    const details = this.tableColumnDetails.get(table)
    if (details !== undefined) return details as unknown as readonly Record<string, unknown>[]
    return (this.tableColumns.get(table) ?? []).map((name, index) => {
      const base = table.replace('__dr007', '')
      const type = [
        'token_version',
        'revoked_at',
        'created_at',
        'last_seen_at',
        'protocol_version',
        'seq',
      ].includes(name)
        ? 'INTEGER'
        : ['update_bytes'].includes(name)
          ? 'BLOB'
          : 'TEXT'
      const notnull =
        (base === 'devices' && ['token_version', 'created_at'].includes(name)) ||
        (base === 'op_log' && name !== 'y_client_id') ||
        name === 'y_client_id' ||
        (base === 'connected_devices' && ['last_seen_at', 'protocol_version'].includes(name))
          ? 1
          : 0
      const pk =
        base === 'op_log' ? (name === 'doc_id' ? 1 : name === 'seq' ? 2 : 0) : index === 0 ? 1 : 0
      const defaultValue = name === 'token_version' ? '1' : null
      return { cid: index, name, type, notnull, dflt_value: defaultValue, pk }
    })
  }

  private expectedTableIndexes(table: string): readonly RecordedIndex[] {
    const base = table.replace('__dr007', '')
    const indexes = {
      devices: [{ name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] }],
      op_log: [
        { name: 'sqlite_autoindex_op_log_1', unique: true, columns: ['doc_id', 'seq'] },
        { name: 'sqlite_autoindex_op_log_2', unique: true, columns: ['doc_id', 'message_id'] },
      ],
      connected_devices: [
        { name: 'sqlite_autoindex_connected_devices_1', unique: true, columns: ['device_id'] },
      ],
    }[base]
    return (indexes ?? []).map((index) => ({
      ...index,
      name: index.name.replace(base, table),
    }))
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
  readonly blobMultipartUploads: Map<string, RecordedBlobMultipartUploadRow>
  readonly blobMultipartParts: Map<string, RecordedBlobMultipartPartRow>
  readonly devices: Map<string, RecordedDeviceRow>
  readonly migrationVersions: Set<number>
  readonly messageDedupColumns: Set<string>
  readonly tableColumns: Map<string, readonly string[]>
  readonly tableRowCounts: Map<string, number>
  readonly tableRows: Map<string, readonly (readonly unknown[])[]>
  readonly tableColumnDetails: Map<string, readonly RecordedColumnInfo[]>
  readonly tableIndexes: Map<string, readonly RecordedIndex[]>
  readonly tableForeignKeys: Map<string, readonly RecordedForeignKey[]>
  readonly snapshotHealthEvents: RecordedSnapshotHealthEventRow[]
}
