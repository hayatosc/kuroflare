import { type DocId } from '@kuroflare/core'
import { makeDeviceId } from '@kuroflare/core'

import type { KuroflareSettings } from '../types'

export const SPIKE_TEXT_NAME = 'fixed-file'
export const META_DOC_NAME = 'kuroflare-meta'
export const META_SYNC_DOC_ID = { kind: 'meta' } satisfies DocId
export const DISK_ORIGIN = 'kuroflare:disk'
export const REMOTE_ORIGIN = 'kuroflare:remote-simulated'
export const WORKER_ORIGIN = 'kuroflare:worker'
export const FILE_TREE_ORIGIN = 'kuroflare:file-tree'
export const BINARY_UPLOAD_ORIGIN = 'kuroflare:binary-upload'
export const REPAIR_ORIGIN = 'kuroflare:repair'
export const REPAIR_DEVICE = makeDeviceId('repair')
export const MARKDOWN_EXTENSION = 'md'
export const BLOB_CACHE_PATH_PREFIX = 'blob-cache/'
export const OUTBOX_WORKER_LEASE_DURATION_MS = 30_000
export const OUTBOX_WORKER_MAX_STARTS = 4
/** Bounded backoff schedule for automatic NeedFullSnapshot fetch+apply recovery. */
export const NEED_FULL_SNAPSHOT_RECOVERY_BACKOFF_MS = [0, 2_000, 5_000] as const
export const AUTH_REFRESH_MARGIN_MS = 60_000
export const AUTH_REFRESH_ESTIMATED_DURATION_MS = 10_000
export const AUTH_REFRESH_STALE_AFTER_MS = 120_000
export const MAX_REPAIR_LOG_ENTRIES = 50
export const LOCAL_STORE_REBUILD_CONFIRMATION = 'REBUILD LOCAL STORE'
export const LOCAL_STORE_DISCARD_CONFIRMATION = 'DISCARD LOCAL OUTBOX'
export const QUARANTINE_DISCARD_CONFIRMATION = 'DISCARD QUARANTINE'
export const QUARANTINE_FORCE_APPLY_CONFIRMATION = 'FORCE APPLY QUARANTINE'
export const DEVICE_REVOKE_CONFIRMATION = 'REVOKE THIS DEVICE'
export const INVALID_META_DISCARD_CONFIRMATION = 'DISCARD INVALID META'

export const DEFAULT_SETTINGS: KuroflareSettings = {
  endpoint: 'http://127.0.0.1:8787',
  setupVaultId: '',
  setupToken: '',
  requestedDeviceName: 'Obsidian',
  setupBootstrapMode: 'new-vault',
}
