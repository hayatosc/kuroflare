import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  decideLocalStoreSchema,
  type LocalStoreObjectStore,
  type LocalStoreSchemaDecision,
} from '@kuroflare/core'
import { type VaultId } from '@kuroflare/protocol'

/** Current IndexedDB schema version created by this plugin bundle. */
export const LOCAL_STORE_INDEXEDDB_TARGET_VERSION = 3

/** Oldest IndexedDB schema version this plugin can safely read and migrate. */
export const LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION = 2

/** Input evidence for planning the plugin local-store IndexedDB open gate. */
export interface LocalStoreIndexedDbOpenPlanInput {
  readonly vaultId: VaultId
  readonly dbExists: boolean
  readonly currentVersion?: number | undefined
  readonly presentStores: readonly LocalStoreObjectStore[]
  readonly pendingOutboxCount: number
  readonly targetVersion?: number | undefined
  readonly minimumReadableVersion?: number | undefined
  readonly requiredStores?: readonly LocalStoreObjectStore[] | undefined
}

/** Concrete IndexedDB schema effect that the plugin startup runtime may execute. */
export type LocalStoreIndexedDbOpenEffect =
  | {
      readonly kind: 'open-database'
      readonly mode: 'create' | 'open' | 'upgrade'
      readonly dbName: string
      readonly version: number
      readonly createStores: readonly LocalStoreObjectStore[]
    }
  | {
      readonly kind: 'delete-database'
      readonly dbName: string
      readonly reason: 'store-version-too-old' | 'missing-required-store'
    }
  | {
      readonly kind: 'hold-degraded'
      readonly dbName: string
      readonly reason:
        | 'local-store-too-new'
        | 'store-version-too-old-with-pending-outbox'
        | 'missing-required-store-with-pending-outbox'
    }
  | {
      readonly kind: 'reject-open'
      readonly dbName: string
      readonly reason:
        | 'invalid-version'
        | 'invalid-pending-outbox-count'
        | 'duplicate-store-name'
        | 'inconsistent-local-store-evidence'
    }

/** Plan for opening the plugin IndexedDB local store before sync startup continues. */
export type LocalStoreIndexedDbOpenPlan =
  | {
      readonly ok: true
      readonly startupGate: 'continue'
      readonly dbName: string
      readonly decision: Extract<
        LocalStoreSchemaDecision,
        { readonly action: 'create' | 'open' | 'upgrade' }
      >
      readonly effects: readonly LocalStoreIndexedDbOpenEffect[]
    }
  | {
      readonly ok: true
      readonly startupGate: 'rebuild'
      readonly dbName: string
      readonly decision: Extract<LocalStoreSchemaDecision, { readonly action: 'rebuild' }>
      readonly effects: readonly LocalStoreIndexedDbOpenEffect[]
    }
  | {
      readonly ok: false
      readonly startupGate: 'degraded'
      readonly dbName: string
      readonly decision: Extract<LocalStoreSchemaDecision, { readonly action: 'degraded' }>
      readonly effects: readonly LocalStoreIndexedDbOpenEffect[]
    }
  | {
      readonly ok: false
      readonly startupGate: 'reject'
      readonly dbName: string
      readonly decision: Extract<LocalStoreSchemaDecision, { readonly action: 'reject' }>
      readonly effects: readonly LocalStoreIndexedDbOpenEffect[]
    }

/**
 * Builds the IndexedDB database name for one synced vault.
 *
 * @param vaultId Stable vault ID assigned during setup.
 * @returns IndexedDB database name used by the plugin local store.
 */
export function localStoreIndexedDbName(vaultId: VaultId): string {
  return `kuroflare:${vaultId}`
}

/**
 * Converts core local-store schema decisions into plugin IndexedDB startup effects.
 *
 * @param input Browser schema evidence and optional schema version overrides for tests.
 * @returns A startup gate plan that either opens the DB, rebuilds empty local state, holds degraded, or rejects sync.
 */
export function planLocalStoreIndexedDbOpen(
  input: LocalStoreIndexedDbOpenPlanInput,
): LocalStoreIndexedDbOpenPlan {
  const targetVersion = input.targetVersion ?? LOCAL_STORE_INDEXEDDB_TARGET_VERSION
  const minimumReadableVersion =
    input.minimumReadableVersion ?? LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION
  const requiredStores = input.requiredStores ?? DEFAULT_LOCAL_STORE_OBJECT_STORES
  const dbName = localStoreIndexedDbName(input.vaultId)
  const decision = decideLocalStoreSchema({
    dbExists: input.dbExists,
    currentVersion: input.currentVersion,
    targetVersion,
    minimumReadableVersion,
    presentStores: input.presentStores,
    requiredStores,
    pendingOutboxCount: input.pendingOutboxCount,
  })

  switch (decision.action) {
    case 'create':
      return {
        ok: true,
        startupGate: 'continue',
        dbName,
        decision,
        effects: [
          {
            kind: 'open-database',
            mode: 'create',
            dbName,
            version: decision.version,
            createStores: decision.createStores,
          },
        ],
      }
    case 'open':
      return {
        ok: true,
        startupGate: 'continue',
        dbName,
        decision,
        effects: [
          {
            kind: 'open-database',
            mode: 'open',
            dbName,
            version: decision.version,
            createStores: [],
          },
        ],
      }
    case 'upgrade':
      return {
        ok: true,
        startupGate: 'continue',
        dbName,
        decision,
        effects: [
          {
            kind: 'open-database',
            mode: 'upgrade',
            dbName,
            version: decision.toVersion,
            createStores: decision.createStores,
          },
        ],
      }
    case 'rebuild':
      return {
        ok: true,
        startupGate: 'rebuild',
        dbName,
        decision,
        effects: [
          { kind: 'delete-database', dbName, reason: decision.reason },
          {
            kind: 'open-database',
            mode: 'create',
            dbName,
            version: decision.targetVersion,
            createStores: requiredStores,
          },
        ],
      }
    case 'degraded':
      return {
        ok: false,
        startupGate: 'degraded',
        dbName,
        decision,
        effects: [{ kind: 'hold-degraded', dbName, reason: decision.reason }],
      }
    case 'reject':
      return {
        ok: false,
        startupGate: 'reject',
        dbName,
        decision,
        effects: [{ kind: 'reject-open', dbName, reason: decision.reason }],
      }
  }
}
