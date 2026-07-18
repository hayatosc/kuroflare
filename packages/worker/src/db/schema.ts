import { sql, type Kysely } from 'kysely'

import type { SchemaMigration } from './migrations'
import type { Database } from './types'

/** Bundled schema migrations applied by the Durable Object during startup. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'initial-schema',
    migrate: buildInitialSchema,
  },
  {
    version: 2,
    name: 'message-dedup-update-hash',
    migrate: buildMessageDedupUpdateHash,
  },
  {
    version: 3,
    name: 'snapshot-health-evidence',
    migrate: buildSnapshotHealthEvidence,
  },
  {
    version: 4,
    name: 'device-audit-identity',
    migrate: buildDeviceAuditIdentity,
  },
  {
    version: 5,
    name: 'blob-multipart-uploads',
    migrate: buildBlobMultipartUploads,
  },
  {
    version: 6,
    name: 'quarantine-audit-events',
    migrate: buildQuarantineAuditEvents,
  },
]

interface ExpectedColumn {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly defaultValue: string | null
  readonly pk: number
}

interface ExpectedIndex {
  readonly columns: readonly string[]
  readonly unique: boolean
  readonly name?: string
}

interface ExpectedForeignKey {
  readonly table: string
  readonly from: string
  readonly to: string
  readonly targetTable: string
}

interface ExpectedTableSchema {
  readonly columns: readonly ExpectedColumn[]
  readonly indexes: readonly ExpectedIndex[]
  readonly foreignKeys: readonly ExpectedForeignKey[]
}

const DEVICE_TABLE_SCHEMA: ExpectedTableSchema = {
  columns: [
    { name: 'device_id', type: 'text', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'token_version', type: 'integer', notnull: 1, defaultValue: '1', pk: 0 },
    { name: 'revoked_at', type: 'integer', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'integer', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'last_seen_at', type: 'integer', notnull: 0, defaultValue: null, pk: 0 },
  ],
  indexes: [{ columns: ['device_id'], unique: true }],
  foreignKeys: [
    { table: 'device_refresh_tokens', from: 'device_id', to: 'device_id', targetTable: 'devices' },
  ],
}

const OP_LOG_REBUILT_SCHEMA: ExpectedTableSchema = {
  columns: [
    { name: 'doc_id', type: 'text', notnull: 1, defaultValue: null, pk: 1 },
    { name: 'seq', type: 'integer', notnull: 1, defaultValue: null, pk: 2 },
    { name: 'message_id', type: 'text', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'device_id', type: 'text', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'update_bytes', type: 'blob', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'update_sha256', type: 'text', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'integer', notnull: 1, defaultValue: null, pk: 0 },
  ],
  indexes: [
    { columns: ['doc_id', 'seq'], unique: true },
    { columns: ['doc_id', 'message_id'], unique: true },
  ],
  foreignKeys: [],
}

const OP_LOG_TABLE_SCHEMA: ExpectedTableSchema = {
  ...OP_LOG_REBUILT_SCHEMA,
  indexes: [
    ...OP_LOG_REBUILT_SCHEMA.indexes,
    { name: 'idx_op_log_doc_seq', columns: ['doc_id', 'seq'], unique: false },
  ],
}

const CONNECTED_DEVICES_TABLE_SCHEMA: ExpectedTableSchema = {
  columns: [
    { name: 'device_id', type: 'text', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'last_seen_at', type: 'integer', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'user_agent', type: 'text', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'protocol_version', type: 'integer', notnull: 1, defaultValue: null, pk: 0 },
  ],
  indexes: [{ columns: ['device_id'], unique: true }],
  foreignKeys: [],
}

async function buildDeviceAuditIdentity(db: Kysely<Database>): Promise<void> {
  await rebuildTableWithoutColumn(
    db,
    'devices',
    'y_client_id',
    DEVICE_TABLE_SCHEMA,
    `
    create table devices__dr007 (
      device_id text primary key,
      token_version integer not null default 1,
      revoked_at integer,
      created_at integer not null,
      last_seen_at integer
    )
    `,
    `insert into devices__dr007 (device_id, token_version, revoked_at, created_at, last_seen_at)
      select device_id, token_version, revoked_at, created_at, last_seen_at from devices`,
  )
  await rebuildTableWithoutColumn(
    db,
    'op_log',
    'y_client_id',
    OP_LOG_TABLE_SCHEMA,
    `
    create table op_log__dr007 (
      doc_id text not null,
      seq integer not null,
      message_id text not null,
      device_id text not null,
      update_bytes blob not null,
      update_sha256 text not null,
      created_at integer not null,
      constraint op_log_pk primary key (doc_id, seq),
      constraint op_log_doc_message_unique unique (doc_id, message_id)
    )
    `,
    `insert into op_log__dr007 (doc_id, seq, message_id, device_id, update_bytes, update_sha256, created_at)
      select doc_id, seq, message_id, device_id, update_bytes, update_sha256, created_at
      from op_log order by doc_id, seq`,
    OP_LOG_REBUILT_SCHEMA,
  )
  await db.schema
    .createIndex('idx_op_log_doc_seq')
    .ifNotExists()
    .on('op_log')
    .columns(['doc_id', 'seq'])
    .execute()
  await validateRebuiltTable(db, 'op_log', OP_LOG_TABLE_SCHEMA)
  await rebuildTableWithoutColumn(
    db,
    'connected_devices',
    'y_client_id',
    CONNECTED_DEVICES_TABLE_SCHEMA,
    `
    create table connected_devices__dr007 (
      device_id text primary key,
      last_seen_at integer not null,
      user_agent text,
      protocol_version integer not null
    )
    `,
    `insert into connected_devices__dr007 (device_id, last_seen_at, user_agent, protocol_version)
      select device_id, last_seen_at, user_agent, protocol_version from connected_devices`,
  )
}

async function rebuildTableWithoutColumn(
  db: Kysely<Database>,
  table: 'devices' | 'op_log' | 'connected_devices',
  column: 'y_client_id',
  expectedSchema: ExpectedTableSchema,
  createSql: string,
  copySql: string,
  rebuiltSchema: ExpectedTableSchema = expectedSchema,
): Promise<void> {
  const temporaryTable = `${table}__dr007` as TableName
  const originalColumns = await readTableInfo(db, table)
  const temporaryColumns = await readTableInfo(db, temporaryTable)

  if (originalColumns.length === 0) {
    if (temporaryColumns.length === 0) {
      throw new Error(`schema-migration:${table}-missing`)
    }
    await validateRebuiltTable(db, temporaryTable, rebuiltSchema)
    await sql.raw(`alter table ${temporaryTable} rename to ${table}`).execute(db)
    await validateRebuiltTable(db, table, rebuiltSchema)
    return
  }

  if (!originalColumns.some((row) => row.name === column)) {
    await validateRebuiltTable(db, table, expectedSchema)
    if (temporaryColumns.length !== 0) {
      await validateRebuiltTable(db, temporaryTable, rebuiltSchema)
      await sql.raw(`drop table ${temporaryTable}`).execute(db)
    }
    return
  }

  if (temporaryColumns.length !== 0) {
    await validateRebuiltTable(db, temporaryTable, rebuiltSchema)
    await sql.raw(`drop table ${temporaryTable}`).execute(db)
  }

  const originalRowCount = await readTableRowCount(db, table)
  await sql.raw(createSql).execute(db)
  await validateRebuiltTable(db, temporaryTable, rebuiltSchema)
  await sql.raw(copySql).execute(db)
  const rebuiltRowCount = await readTableRowCount(db, temporaryTable)
  if (rebuiltRowCount !== originalRowCount) {
    throw new Error(`schema-migration:${table}-row-count-mismatch`)
  }
  await sql.raw(`drop table ${table}`).execute(db)
  await sql.raw(`alter table ${temporaryTable} rename to ${table}`).execute(db)
  await validateRebuiltTable(db, table, rebuiltSchema)
}

type TableName =
  | 'devices'
  | 'op_log'
  | 'connected_devices'
  | 'devices__dr007'
  | 'op_log__dr007'
  | 'connected_devices__dr007'

interface TableInfoRow {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

async function readTableInfo(
  db: Kysely<Database>,
  table: TableName,
): Promise<readonly TableInfoRow[]> {
  const result = await sql<TableInfoRow>`pragma table_info(${sql.ref(table)})`.execute(db)
  return result.rows
}

async function readTableRowCount(db: Kysely<Database>, table: TableName): Promise<number> {
  const result = await sql<{
    readonly count: number
  }>`select count(*) as count from ${sql.ref(table)}`.execute(db)
  const count = result.rows[0]?.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`schema-migration:${table}-invalid-row-count`)
  }
  return count
}

async function validateRebuiltTable(
  db: Kysely<Database>,
  table: TableName,
  expectedSchema: ExpectedTableSchema,
): Promise<void> {
  const columns = await readTableInfo(db, table)
  if (columns.length !== expectedSchema.columns.length) {
    throw new Error(`schema-migration:${table}-unexpected-columns`)
  }
  for (const [index, expected] of expectedSchema.columns.entries()) {
    const actual = columns[index]
    if (
      actual === undefined ||
      actual.name !== expected.name ||
      actual.type.toLowerCase() !== expected.type ||
      actual.notnull !== expected.notnull ||
      actual.dflt_value !== expected.defaultValue ||
      actual.pk !== expected.pk
    ) {
      throw new Error(`schema-migration:${table}-unexpected-columns`)
    }
  }
  await validateIndexes(db, table, expectedSchema.indexes)
  await validateForeignKeys(db, table, expectedSchema.foreignKeys)
  await readTableRowCount(db, table)
}

interface IndexListRow {
  readonly name: string
  readonly unique: number
}

interface IndexInfoRow {
  readonly seqno: number
  readonly name: string
}

async function validateIndexes(
  db: Kysely<Database>,
  table: TableName,
  expectedIndexes: readonly ExpectedIndex[],
): Promise<void> {
  const listed = await sql<IndexListRow>`pragma index_list(${sql.ref(table)})`.execute(db)
  const actualIndexes: ExpectedIndex[] = []
  for (const index of listed.rows) {
    const info = await sql<IndexInfoRow>`pragma index_info(${sql.ref(index.name)})`.execute(db)
    actualIndexes.push({
      name: index.name,
      unique: index.unique === 1,
      columns: info.rows.sort((left, right) => left.seqno - right.seqno).map((row) => row.name),
    })
  }
  if (actualIndexes.length !== expectedIndexes.length) {
    throw new Error(`schema-migration:${table}-unexpected-indexes`)
  }
  const matched = new Set<number>()
  for (const expected of expectedIndexes) {
    const match = actualIndexes.findIndex((actual, index) => {
      if (matched.has(index)) return false
      if (expected.name !== undefined && actual.name !== expected.name) return false
      return actual.unique === expected.unique && sameStrings(actual.columns, expected.columns)
    })
    if (match < 0) throw new Error(`schema-migration:${table}-unexpected-indexes`)
    matched.add(match)
  }
}

interface ForeignKeyRow {
  readonly table: string
  readonly from: string
  readonly to: string
}

async function validateForeignKeys(
  db: Kysely<Database>,
  table: TableName,
  expectedForeignKeys: readonly ExpectedForeignKey[],
): Promise<void> {
  const tables = new Set<string>([
    table,
    ...expectedForeignKeys.map((foreignKey) => foreignKey.table),
  ])
  for (const foreignKeyTable of tables) {
    const result =
      await sql<ForeignKeyRow>`pragma foreign_key_list(${sql.ref(foreignKeyTable)})`.execute(db)
    const expected = expectedForeignKeys.filter(
      (foreignKey) => foreignKey.table === foreignKeyTable,
    )
    if (
      result.rows.length !== expected.length ||
      expected.some(
        (foreignKey) =>
          !result.rows.some(
            (row) =>
              row.table === foreignKey.targetTable &&
              row.from === foreignKey.from &&
              row.to === foreignKey.to,
          ),
      )
    ) {
      throw new Error(`schema-migration:${foreignKeyTable}-unexpected-foreign-keys`)
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function buildSnapshotHealthEvidence(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('snapshot_health_events')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('snapshot_key', 'text', (col) => col.notNull())
    .addColumn('upper_seq', 'integer', (col) => col.notNull())
    .addColumn('event', 'text', (col) => col.notNull())
    .addColumn('actor', 'text', (col) => col.notNull())
    .addColumn('authority_status', 'text', (col) => col.notNull())
    .addColumn('expected_byte_length', 'integer')
    .addColumn('expected_update_sha256', 'text')
    .addColumn('expected_state_vector_sha256', 'text')
    .addColumn('actual_byte_length', 'integer')
    .addColumn('actual_update_sha256', 'text')
    .addColumn('actual_state_vector_sha256', 'text')
    .addColumn('physical_status', 'text')
    .addColumn('logical_status', 'text')
    .addColumn('reasons', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('observed_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createIndex('idx_snapshot_health_events_doc_key_id')
    .ifNotExists()
    .on('snapshot_health_events')
    .columns(['doc_id', 'snapshot_key', 'id'])
    .execute()

  await db.schema
    .createIndex('idx_snapshot_health_events_doc_seq_id')
    .ifNotExists()
    .on('snapshot_health_events')
    .columns(['doc_id', 'upper_seq', 'id'])
    .execute()
}

async function buildBlobMultipartUploads(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('blob_multipart_uploads')
    .ifNotExists()
    .addColumn('upload_id', 'text', (col) => col.primaryKey())
    .addColumn('sha256', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createIndex('idx_blob_multipart_uploads_expires_at')
    .ifNotExists()
    .on('blob_multipart_uploads')
    .columns(['expires_at'])
    .execute()

  await db.schema
    .createTable('blob_multipart_parts')
    .ifNotExists()
    .addColumn('upload_id', 'text', (col) => col.notNull())
    .addColumn('part_number', 'integer', (col) => col.notNull())
    .addColumn('etag', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('sha256', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('blob_multipart_parts_pk', ['upload_id', 'part_number'])
    .execute()
}

/** Append-only audit trail for resolved (discarded or force-applied) quarantined updates. */
async function buildQuarantineAuditEvents(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('quarantine_audit_events')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('quarantine_id', 'text', (col) => col.notNull())
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('device_id', 'text', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('actor', 'text', (col) => col.notNull())
    .addColumn('applied_seq', 'integer')
    .addColumn('quarantined_at', 'integer', (col) => col.notNull())
    .addColumn('resolved_at', 'integer', (col) => col.notNull())
    .execute()
}

async function buildMessageDedupUpdateHash(db: Kysely<Database>): Promise<void> {
  const columns = await sql<{ readonly name: string }>`pragma table_info(message_dedup)`.execute(db)
  if (columns.rows.some((column) => column.name === 'update_sha256')) return
  await db.schema.alterTable('message_dedup').addColumn('update_sha256', 'text').execute()
}

async function buildInitialSchema(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('setup_tokens')
    .ifNotExists()
    .addColumn('token_hash', 'text', (col) => col.primaryKey())
    .addColumn('vault_id', 'text', (col) => col.notNull())
    .addColumn('issued_at', 'integer', (col) => col.notNull())
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .addColumn('consumed_at', 'integer')
    .execute()

  await db.schema
    .createIndex('idx_setup_tokens_vault_expires')
    .ifNotExists()
    .on('setup_tokens')
    .columns(['vault_id', 'expires_at'])
    .execute()

  await db.schema
    .createTable('devices')
    .ifNotExists()
    .addColumn('device_id', 'text', (col) => col.primaryKey())
    .addColumn('token_version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('revoked_at', 'integer')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_seen_at', 'integer')
    .execute()

  await db.schema
    .createTable('device_refresh_tokens')
    .ifNotExists()
    .addColumn('token_hash', 'text', (col) => col.primaryKey())
    .addColumn('device_id', 'text', (col) => col.notNull().references('devices.device_id'))
    .addColumn('issued_at', 'integer', (col) => col.notNull())
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .addColumn('revoked_at', 'integer')
    .execute()

  await db.schema
    .createIndex('idx_device_refresh_tokens_device_expires')
    .ifNotExists()
    .on('device_refresh_tokens')
    .columns(['device_id', 'expires_at'])
    .execute()

  await db.schema
    .createTable('docs')
    .ifNotExists()
    .addColumn('doc_id', 'text', (col) => col.primaryKey())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('latest_seq', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('latest_snapshot_seq', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('latest_snapshot_key', 'text')
    .addColumn('latest_state_vector', 'blob')
    .addColumn('min_retained_seq', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('horizon_state_vector', 'blob')
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('op_log')
    .ifNotExists()
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('seq', 'integer', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('device_id', 'text', (col) => col.notNull())
    .addColumn('update_bytes', 'blob', (col) => col.notNull())
    .addColumn('update_sha256', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('op_log_pk', ['doc_id', 'seq'])
    .addUniqueConstraint('op_log_doc_message_unique', ['doc_id', 'message_id'])
    .execute()

  await db.schema
    .createIndex('idx_op_log_doc_seq')
    .ifNotExists()
    .on('op_log')
    .columns(['doc_id', 'seq'])
    .execute()

  await db.schema
    .createTable('message_dedup')
    .ifNotExists()
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('durable_seq', 'integer', (col) => col.notNull())
    .addColumn('seen_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('message_dedup_pk', ['doc_id', 'message_id'])
    .execute()

  await db.schema
    .createTable('checkpoint_runs')
    .ifNotExists()
    .addColumn('run_id', 'text', (col) => col.primaryKey())
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('upper_seq', 'integer', (col) => col.notNull())
    .addColumn('snapshot_key', 'text')
    .addColumn('state_vector', 'blob')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('error', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('r2_written_at', 'integer')
    .addColumn('pointer_updated_at', 'integer')
    .addColumn('compacted_at', 'integer')
    .execute()

  await db.schema
    .createIndex('idx_checkpoint_runs_doc_status')
    .ifNotExists()
    .on('checkpoint_runs')
    .columns(['doc_id', 'status'])
    .execute()

  await db.schema
    .createTable('snapshot_retention_events')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('snapshot_key', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('error', 'text')
    .addColumn('attempted_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createIndex('idx_snapshot_retention_events_doc_attempted')
    .ifNotExists()
    .on('snapshot_retention_events')
    .columns(['doc_id', 'attempted_at'])
    .execute()

  await db.schema
    .createTable('connected_devices')
    .ifNotExists()
    .addColumn('device_id', 'text', (col) => col.primaryKey())
    .addColumn('last_seen_at', 'integer', (col) => col.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('protocol_version', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('quarantined_updates')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('doc_id', 'text', (col) => col.notNull())
    .addColumn('message_id', 'text', (col) => col.notNull())
    .addColumn('device_id', 'text', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('update_sha256', 'text', (col) => col.notNull())
    .addColumn('update_bytes', 'blob', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute()
}
