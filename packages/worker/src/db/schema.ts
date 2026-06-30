import type { Kysely } from 'kysely'

import type { SchemaMigration } from './migrations'
import type { Database } from './types'

/** Bundled schema migrations applied by the Durable Object during startup. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'initial-schema',
    migrate: buildInitialSchema,
  },
]

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
    .addColumn('y_client_id', 'integer', (col) => col.notNull().unique())
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
    .addColumn('y_client_id', 'integer', (col) => col.notNull())
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
    .createTable('connected_devices')
    .ifNotExists()
    .addColumn('device_id', 'text', (col) => col.primaryKey())
    .addColumn('y_client_id', 'integer')
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
