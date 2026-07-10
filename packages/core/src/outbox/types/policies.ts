import { type OutboxRetryPolicy } from './base'

export const Y_UPDATE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [250, 1_000, 5_000, 30_000],
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
}

export const BLOB_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [1_000, 5_000, 30_000, 300_000],
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
}

export const MATERIALIZE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [0, 0, 0],
  maxRetryCount: 3,
  maxDelayMs: 0,
  jitterRatio: 0,
}
