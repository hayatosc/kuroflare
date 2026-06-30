import { type ClientStartupLocalState } from '@kuroflare/core'
import { type VaultId } from '@kuroflare/core'

import {
  planSyncEngineStartup,
  type SyncEngineStartupEffect,
  type SyncEngineStartupInput,
  type SyncEngineStartupPlan,
} from '../engine/engine'
import { type LocalSetupMetadataSnapshotDecision } from '../engine/setup'
import { type LocalStoreIndexedDbSchemaEvidencePlan } from '../store/indexeddb'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  planLocalStoreIndexedDbOpen,
  type LocalStoreIndexedDbOpenEffect,
  type LocalStoreIndexedDbOpenPlan,
  type LocalStoreIndexedDbOpenPlanInput,
} from '../store/schema'

/** Local-store schema evidence gathered before the plugin enters sync runtime work. */
export type SyncRuntimeLocalStoreEvidence = Omit<LocalStoreIndexedDbOpenPlanInput, 'vaultId'>

/** Input for planning the plugin runtime startup side-effect sequence. */
export interface SyncRuntimeStartupInput extends SyncEngineStartupInput {
  readonly localStore?: SyncRuntimeLocalStoreEvidence | undefined
}

/** Input for planning startup from the result of the IndexedDB schema evidence probe. */
export interface SyncRuntimeStartupFromSchemaEvidenceInput extends SyncEngineStartupInput {
  readonly localStoreEvidence?: LocalStoreIndexedDbSchemaEvidencePlan | undefined
}

/** Local evidence gathered by the plugin shell before calling the core startup planner. */
export interface SyncRuntimeLocalStateEvidenceInput {
  readonly metadataSnapshot?: LocalSetupMetadataSnapshotDecision | undefined
  readonly localStoreEvidence?: LocalStoreIndexedDbSchemaEvidencePlan | undefined
  readonly hasMetaYDoc: boolean
  readonly hasLocalVaultFiles: boolean
  readonly supportedSchemaVersion?: number | undefined
}

/** Decision for turning plugin storage evidence into core startup local state. */
export type SyncRuntimeLocalStateEvidencePlan =
  | {
      readonly ok: true
      readonly local: ClientStartupLocalState
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-supported-schema-version'
        | 'local-store-schema-evidence-failure'
        | 'invalid-local-metadata'
      readonly localStoreReason?: Extract<
        LocalStoreIndexedDbSchemaEvidencePlan,
        { readonly ok: false }
      >['reason']
      readonly metadataReason?: Extract<
        LocalSetupMetadataSnapshotDecision,
        { readonly ok: false }
      >['reason']
    }

/** One executable startup effect after local-store schema gating is composed with sync startup. */
export type SyncRuntimeStartupEffect =
  | {
      readonly kind: 'run-local-store-open-effect'
      readonly effect: LocalStoreIndexedDbOpenEffect
    }
  | {
      readonly kind: 'run-sync-startup-effect'
      readonly effect: SyncEngineStartupEffect
    }
  | {
      readonly kind: 'rerun-startup-after-local-store-rebuild'
      readonly vaultId: VaultId
      readonly dbName: string
    }
  | {
      readonly kind: 'report-local-store-schema-evidence-failure'
      readonly reason: Extract<
        LocalStoreIndexedDbSchemaEvidencePlan,
        { readonly ok: false }
      >['reason']
    }

/** Runtime startup plan after composing sync intent and local IndexedDB schema evidence. */
export type SyncRuntimeStartupPlan =
  | {
      readonly action: 'run-sync-without-local-store-gate'
      readonly sync: SyncEngineStartupPlan
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }
  | {
      readonly action: 'continue'
      readonly sync: SyncEngineStartupPlan
      readonly localStore: Extract<
        LocalStoreIndexedDbOpenPlan,
        { readonly startupGate: 'continue' }
      >
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }
  | {
      readonly action: 'rebuild-local-store'
      readonly sync: SyncEngineStartupPlan
      readonly localStore: Extract<LocalStoreIndexedDbOpenPlan, { readonly startupGate: 'rebuild' }>
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }
  | {
      readonly action: 'hold-local-store-degraded'
      readonly sync: SyncEngineStartupPlan
      readonly localStore: Extract<
        LocalStoreIndexedDbOpenPlan,
        { readonly startupGate: 'degraded' }
      >
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }
  | {
      readonly action: 'reject-local-store-open'
      readonly sync: SyncEngineStartupPlan
      readonly localStore: Extract<LocalStoreIndexedDbOpenPlan, { readonly startupGate: 'reject' }>
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }
  | {
      readonly action: 'reject-local-store-schema-evidence'
      readonly sync: SyncEngineStartupPlan
      readonly localStoreEvidence: Extract<
        LocalStoreIndexedDbSchemaEvidencePlan,
        { readonly ok: false }
      >
      readonly effects: readonly SyncRuntimeStartupEffect[]
    }

/**
 * Composes sync startup planning with the local-store IndexedDB schema gate.
 *
 * @param input Sync intent/local evidence plus optional browser IndexedDB schema evidence.
 * @returns Ordered startup effects that never start sync side effects before the local-store gate allows them.
 */
export function planSyncRuntimeStartup(input: SyncRuntimeStartupInput): SyncRuntimeStartupPlan {
  const sync = planSyncEngineStartup(input)
  const vaultId = startupVaultId(sync)
  if (vaultId === undefined || input.localStore === undefined) {
    return {
      action: 'run-sync-without-local-store-gate',
      sync,
      effects: sync.effects.map(toSyncRuntimeEffect),
    }
  }

  const localStore = planLocalStoreIndexedDbOpen({ ...input.localStore, vaultId })
  const localStoreEffects = localStore.effects.map(toLocalStoreRuntimeEffect)
  if (localStore.startupGate === 'continue') {
    return {
      action: 'continue',
      sync,
      localStore,
      effects: [...localStoreEffects, ...sync.effects.map(toSyncRuntimeEffect)],
    }
  }
  if (localStore.startupGate === 'rebuild') {
    return {
      action: 'rebuild-local-store',
      sync,
      localStore,
      effects: [
        ...localStoreEffects,
        {
          kind: 'rerun-startup-after-local-store-rebuild',
          vaultId,
          dbName: localStore.dbName,
        },
      ],
    }
  }
  if (localStore.startupGate === 'degraded') {
    return {
      action: 'hold-local-store-degraded',
      sync,
      localStore,
      effects: localStoreEffects,
    }
  }
  return {
    action: 'reject-local-store-open',
    sync,
    localStore,
    effects: localStoreEffects,
  }
}

/**
 * Composes sync startup with the result of the local-store schema evidence probe.
 *
 * @param input Sync intent/local state plus optional schema evidence probe result.
 * @returns A runtime startup plan that halts sync when a known-vault local-store probe fails.
 */
export function planSyncRuntimeStartupFromSchemaEvidence(
  input: SyncRuntimeStartupFromSchemaEvidenceInput,
): SyncRuntimeStartupPlan {
  const sync = planSyncEngineStartup(input)
  const vaultId = startupVaultId(sync)
  if (vaultId === undefined) {
    return {
      action: 'run-sync-without-local-store-gate',
      sync,
      effects: sync.effects.map(toSyncRuntimeEffect),
    }
  }

  const evidence = input.localStoreEvidence
  if (evidence === undefined) {
    return {
      action: 'run-sync-without-local-store-gate',
      sync,
      effects: sync.effects.map(toSyncRuntimeEffect),
    }
  }
  if (!evidence.ok) {
    return {
      action: 'reject-local-store-schema-evidence',
      sync,
      localStoreEvidence: evidence,
      effects: [
        {
          kind: 'report-local-store-schema-evidence-failure',
          reason: evidence.reason,
        },
      ],
    }
  }

  return planSyncRuntimeStartup({
    ...input,
    localStore: evidence.evidence,
  })
}

/**
 * Converts plugin-local metadata and IndexedDB schema evidence into core startup local state.
 *
 * @param input Metadata snapshot decision, optional schema evidence, local meta/doc evidence, and schema support.
 * @returns Trusted local startup state, or the evidence failure that must stop startup planning.
 */
export function planSyncRuntimeLocalStateFromEvidence(
  input: SyncRuntimeLocalStateEvidenceInput,
): SyncRuntimeLocalStateEvidencePlan {
  const supportedSchemaVersion =
    input.supportedSchemaVersion ?? LOCAL_STORE_INDEXEDDB_TARGET_VERSION
  if (!Number.isSafeInteger(supportedSchemaVersion) || supportedSchemaVersion < 0) {
    return { ok: false, reason: 'invalid-supported-schema-version' }
  }

  const localStore = input.localStoreEvidence
  if (localStore !== undefined && !localStore.ok) {
    return {
      ok: false,
      reason: 'local-store-schema-evidence-failure',
      localStoreReason: localStore.reason,
    }
  }

  const metadata = input.metadataSnapshot
  if (metadata !== undefined && !metadata.ok) {
    return {
      ok: false,
      reason: 'invalid-local-metadata',
      metadataReason: metadata.reason,
    }
  }

  const schemaEvidence = localStore?.evidence
  const metadataSnapshot = metadata?.snapshot
  return {
    ok: true,
    local: {
      hasIndexedDb: schemaEvidence !== undefined && schemaEvidence.dbExists,
      hasDeviceCredentials:
        metadataSnapshot !== undefined &&
        metadataSnapshot.auth.accessTokenSecretKey !== undefined &&
        metadataSnapshot.auth.refreshTokenSecretKey !== undefined,
      hasMetaYDoc: input.hasMetaYDoc,
      hasLocalVaultFiles: input.hasLocalVaultFiles,
      pendingOutboxCount: schemaEvidence?.pendingOutboxCount ?? 0,
      schemaVersion: schemaEvidence?.currentVersion,
      supportedSchemaVersion,
      vaultId: metadataSnapshot?.setup.vaultId,
      authState: metadataSnapshot?.auth.authState,
    },
  }
}

function startupVaultId(sync: SyncEngineStartupPlan): VaultId | undefined {
  const plan = sync.clientPlan
  switch (plan.action) {
    case 'bootstrap-new-vault':
    case 'join-existing-vault':
    case 'reconnect':
    case 'restore-local-meta-snapshot':
      return plan.vaultId
    case 'run-setup-exchange':
    case 'auth-blocked':
    case 'degraded':
    case 'reject':
      return undefined
  }
}

function toLocalStoreRuntimeEffect(
  effect: LocalStoreIndexedDbOpenEffect,
): SyncRuntimeStartupEffect {
  return { kind: 'run-local-store-open-effect', effect }
}

function toSyncRuntimeEffect(effect: SyncEngineStartupEffect): SyncRuntimeStartupEffect {
  return { kind: 'run-sync-startup-effect', effect }
}
