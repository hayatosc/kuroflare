export const WEBSOCKET_UPGRADE = 'websocket'
export const LARGE_UPDATE_THRESHOLD_BYTES = 512 * 1024
export const SETUP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const SETUP_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const REFRESH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000
export const CHECKPOINT_ALARM_DELAY_MS = 30_000
export const CHECKPOINT_ALARM_DOC_LIMIT = 16
export const CHECKPOINT_OP_THRESHOLD = 128
export const SNAPSHOT_RETENTION_MIN_GENERATIONS = 3
// Unreachable under the default client chunker: every blob object is one CDC
// chunk, capped at `DEFAULT_CHUNKING_OPTIONS.maxSize` (1MiB), so uploads always
// take the single-put path. Raising that cap above this threshold is what
// activates multipart, so the two constants must be changed together.
export const BLOB_MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024
export const BLOB_SINGLE_PUT_MAX_BYTES = BLOB_MULTIPART_THRESHOLD_BYTES - 1
export const BLOB_MANIFEST_MAX_BYTES = 1024 * 1024
export const BLOB_UPLOAD_URL_TTL_MS = 10 * 60 * 1_000
export const QUARANTINE_CONFIRMATION_TTL_MS = 5 * 60 * 1_000
export const VAULT_ID_STORAGE_KEY = 'vault:id'
// deliberate: the DO runtime doesn't expose byte-level heap accounting, so
// resident file-doc count is used as a coarse memory-pressure proxy instead of
// actual bytes. Revisit with real byte accounting if this proves too coarse.
export const MAX_HYDRATED_FILE_DOCS = 256
export const EVICTION_IDLE_THRESHOLD_MS = 5 * 60 * 1_000
export const ADMIN_SETUP_TOKEN_PATH = '/admin/setup-tokens'
export const ADMIN_SNAPSHOT_SEED_PATH = '/admin/snapshots/seed'
