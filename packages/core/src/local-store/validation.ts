import * as v from 'valibot'

import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'
import { LocalOutboxRepairDurableMessageSchema } from './repair'

const LocalStoreObjectStoreSchema = v.picklist([
  'metadata',
  'meta-ydoc',
  'file-ydocs',
  'remote-cursors',
  'last-materialized',
  'outbox',
  'running-leases',
  'blob-cache',
])

/** Primitive evidence validated before local-store state-machine decisions run. */
export const LocalStoreSchemaDecisionInputSchema = v.object({
  dbExists: v.boolean(),
  currentVersion: v.optional(PositiveSafeIntegerSchema),
  targetVersion: PositiveSafeIntegerSchema,
  minimumReadableVersion: PositiveSafeIntegerSchema,
  presentStores: v.array(LocalStoreObjectStoreSchema),
  requiredStores: v.array(LocalStoreObjectStoreSchema),
  pendingOutboxCount: NonNegativeSafeIntegerSchema,
})

export const LocalStoreVersionEvidenceSchema = v.object({
  targetVersion: PositiveSafeIntegerSchema,
  minimumReadableVersion: PositiveSafeIntegerSchema,
})

export const LocalStoreCurrentVersionSchema = v.object({
  currentVersion: v.optional(PositiveSafeIntegerSchema),
})

export const LocalStorePendingOutboxCountSchema = v.object({
  pendingOutboxCount: NonNegativeSafeIntegerSchema,
})

export const LocalStoreRepairDecisionInputSchema = v.object({
  pendingOutboxCount: NonNegativeSafeIntegerSchema,
  targetVersion: PositiveSafeIntegerSchema,
  now: NonNegativeSafeIntegerSchema,
})

export const LocalOutboxRepairDurableMessagesSchema = v.array(LocalOutboxRepairDurableMessageSchema)
