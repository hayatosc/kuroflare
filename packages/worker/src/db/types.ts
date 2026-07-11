import type { Generated } from 'kysely'

export interface Database {
  schema_migrations: SchemaMigrationTable
  setup_tokens: SetupTokenTable
  devices: DeviceTable
  device_refresh_tokens: DeviceRefreshTokenTable
  docs: DocTable
  op_log: OpLogTable
  message_dedup: MessageDedupTable
  checkpoint_runs: CheckpointRunTable
  snapshot_retention_events: SnapshotRetentionEventTable
  connected_devices: ConnectedDeviceTable
  quarantined_updates: QuarantinedUpdateTable
}

export interface SchemaMigrationTable {
  version: Generated<number>
  applied_at: number
}

export interface SetupTokenTable {
  token_hash: string
  vault_id: string
  issued_at: number
  expires_at: number
  consumed_at: number | null
}

export interface DeviceTable {
  device_id: string
  y_client_id: number
  token_version: Generated<number>
  revoked_at: number | null
  created_at: number
  last_seen_at: number | null
}

export interface DeviceRefreshTokenTable {
  token_hash: string
  device_id: string
  issued_at: number
  expires_at: number
  revoked_at: number | null
}

export interface DocTable {
  doc_id: string
  kind: string
  latest_seq: Generated<number>
  latest_snapshot_seq: Generated<number>
  latest_snapshot_key: string | null
  latest_state_vector: ArrayBuffer | null
  min_retained_seq: Generated<number>
  horizon_state_vector: ArrayBuffer | null
  updated_at: number
}

export interface OpLogTable {
  doc_id: string
  seq: number
  message_id: string
  device_id: string
  y_client_id: number
  update_bytes: ArrayBuffer
  update_sha256: string
  created_at: number
}

export interface MessageDedupTable {
  doc_id: string
  message_id: string
  durable_seq: number
  update_sha256: string | null
  seen_at: number
}

export interface CheckpointRunTable {
  run_id: string
  doc_id: string
  upper_seq: number
  snapshot_key: string | null
  state_vector: ArrayBuffer | null
  status: string
  error: string | null
  created_at: number
  r2_written_at: number | null
  pointer_updated_at: number | null
  compacted_at: number | null
}

export interface SnapshotRetentionEventTable {
  id: Generated<number>
  doc_id: string
  snapshot_key: string
  action: string
  error: string | null
  attempted_at: number
}

export interface ConnectedDeviceTable {
  device_id: string
  y_client_id: number | null
  last_seen_at: number
  user_agent: string | null
  protocol_version: number
}

export interface QuarantinedUpdateTable {
  id: string
  doc_id: string
  message_id: string
  device_id: string
  reason: string
  update_sha256: string
  update_bytes: ArrayBuffer
  created_at: number
}
