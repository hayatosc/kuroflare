import type { SchemaMigration } from './migrations'

/** SQLite table or index created by a schema migration. */
export interface SqlObjectDefinition {
  readonly kind: 'table' | 'index'
  readonly name: string
  readonly sql: string
}

/** Names of tables required by the initial Durable Object schema. */
export const INITIAL_SCHEMA_TABLES: readonly string[] = [
  'schema_migrations',
  'setup_tokens',
  'devices',
  'device_refresh_tokens',
  'docs',
  'op_log',
  'message_dedup',
  'checkpoint_runs',
  'connected_devices',
  'quarantined_updates',
]

/** Names of indexes required by the initial Durable Object schema. */
export const INITIAL_SCHEMA_INDEXES: readonly string[] = [
  'idx_setup_tokens_vault_expires',
  'idx_device_refresh_tokens_device_expires',
  'idx_op_log_doc_seq',
  'idx_checkpoint_runs_doc_status',
]

/** Structured SQLite objects created by migration 1. */
export const INITIAL_SCHEMA_OBJECTS: readonly SqlObjectDefinition[] = [
  {
    kind: 'table',
    name: 'schema_migrations',
    sql: `create table if not exists schema_migrations (
  version integer primary key,
  applied_at integer not null
)`,
  },
  {
    kind: 'table',
    name: 'setup_tokens',
    sql: `create table if not exists setup_tokens (
  token_hash text primary key,
  vault_id text not null,
  issued_at integer not null,
  expires_at integer not null,
  consumed_at integer
)`,
  },
  {
    kind: 'index',
    name: 'idx_setup_tokens_vault_expires',
    sql: 'create index if not exists idx_setup_tokens_vault_expires on setup_tokens (vault_id, expires_at)',
  },
  {
    kind: 'table',
    name: 'devices',
    sql: `create table if not exists devices (
  device_id text primary key,
  y_client_id integer not null unique,
  token_version integer not null default 1,
  revoked_at integer,
  created_at integer not null,
  last_seen_at integer
)`,
  },
  {
    kind: 'table',
    name: 'device_refresh_tokens',
    sql: `create table if not exists device_refresh_tokens (
  token_hash text primary key,
  device_id text not null references devices(device_id),
  issued_at integer not null,
  expires_at integer not null,
  revoked_at integer
)`,
  },
  {
    kind: 'index',
    name: 'idx_device_refresh_tokens_device_expires',
    sql: 'create index if not exists idx_device_refresh_tokens_device_expires on device_refresh_tokens (device_id, expires_at)',
  },
  {
    kind: 'table',
    name: 'docs',
    sql: `create table if not exists docs (
  doc_id text primary key,
  kind text not null,
  latest_seq integer not null default 0,
  latest_snapshot_seq integer not null default 0,
  latest_snapshot_key text,
  latest_state_vector blob,
  min_retained_seq integer not null default 0,
  horizon_state_vector blob,
  updated_at integer not null
)`,
  },
  {
    kind: 'table',
    name: 'op_log',
    sql: `create table if not exists op_log (
  doc_id text not null,
  seq integer not null,
  message_id text not null,
  device_id text not null,
  y_client_id integer not null,
  update_bytes blob not null,
  update_sha256 text not null,
  created_at integer not null,
  primary key (doc_id, seq),
  unique (doc_id, message_id)
)`,
  },
  {
    kind: 'index',
    name: 'idx_op_log_doc_seq',
    sql: 'create index if not exists idx_op_log_doc_seq on op_log (doc_id, seq)',
  },
  {
    kind: 'table',
    name: 'message_dedup',
    sql: `create table if not exists message_dedup (
  doc_id text not null,
  message_id text not null,
  durable_seq integer not null,
  seen_at integer not null,
  primary key (doc_id, message_id)
)`,
  },
  {
    kind: 'table',
    name: 'checkpoint_runs',
    sql: `create table if not exists checkpoint_runs (
  run_id text primary key,
  doc_id text not null,
  upper_seq integer not null,
  snapshot_key text,
  state_vector blob,
  status text not null,
  error text,
  created_at integer not null,
  r2_written_at integer,
  pointer_updated_at integer,
  compacted_at integer
)`,
  },
  {
    kind: 'index',
    name: 'idx_checkpoint_runs_doc_status',
    sql: 'create index if not exists idx_checkpoint_runs_doc_status on checkpoint_runs (doc_id, status)',
  },
  {
    kind: 'table',
    name: 'connected_devices',
    sql: `create table if not exists connected_devices (
  device_id text primary key,
  y_client_id integer,
  last_seen_at integer not null,
  user_agent text,
  protocol_version integer not null
)`,
  },
  {
    kind: 'table',
    name: 'quarantined_updates',
    sql: `create table if not exists quarantined_updates (
  id text primary key,
  doc_id text not null,
  message_id text not null,
  device_id text not null,
  reason text not null,
  update_sha256 text not null,
  update_bytes blob not null,
  created_at integer not null
)`,
  },
]

/** Bundled schema migrations applied by the Durable Object during startup. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: INITIAL_SCHEMA_OBJECTS.map((definition) => definition.sql),
  },
]

/**
 * Collects SQL object names of a specific kind from a structured schema definition.
 *
 * @param objects Structured SQL object definitions.
 * @param kind Object kind to collect.
 * @returns Object names in declaration order.
 */
export function collectSqlObjectNames(
  objects: readonly SqlObjectDefinition[],
  kind: SqlObjectDefinition['kind'],
): readonly string[] {
  return objects.filter((object) => object.kind === kind).map((object) => object.name)
}

/**
 * Returns the SQL statements for a schema migration.
 *
 * @param migration Migration definition from the Worker bundle.
 * @returns SQL statements in transaction order.
 */
export function migrationStatements(migration: SchemaMigration): readonly string[] {
  return migration.statements
}
