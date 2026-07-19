/**
 * Compatibility facade for checkpoint-related persistence helpers.
 *
 * The implementations live next to their table responsibilities so callers
 * can keep the established import path while new code can depend on a
 * narrower repository module.
 */
export {
  getAllLatestSnapshotHealthEvents,
  getLatestSnapshotHealthEvent,
  getLatestSnapshotHealthEvents,
  getSnapshotHealthHistory,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
} from './snapshot-health-repo'
export type { SnapshotHealthEventInput, SnapshotHealthEventRow } from './snapshot-health-repo'

export {
  getCheckpointDocRecoveryState,
  getRecoverableCheckpointRuns,
  getSnapshotRetentionCheckpointRuns,
  getSnapshotRetentionEvents,
  insertCheckpointRun,
  insertSnapshotRetentionEvent,
  updateCheckpointCompacted,
  updateCheckpointFailed,
  updateCheckpointPointerUpdated,
  updateCheckpointR2Written,
} from './checkpoint-runs-repo'
export type {
  CheckpointDocRecoveryRow,
  CheckpointRunRow,
  SnapshotRetentionCheckpointRunRow,
  SnapshotRetentionEventRow,
} from './checkpoint-runs-repo'

export {
  deleteQuarantinedUpdate,
  getQuarantineAuditEvents,
  getQuarantinedUpdateById,
  getQuarantinedUpdateBytes,
  getQuarantinedUpdates,
  insertQuarantineAuditEvent,
  insertQuarantinedUpdate,
} from './quarantine-repo'
export type {
  QuarantineAuditEventRow,
  QuarantinedUpdateBytesRow,
  QuarantinedUpdateRow,
} from './quarantine-repo'
