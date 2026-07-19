import type { SyncRuntimeShellState } from '../../engine/actuation'
import type {
  SyncRuntimeLocalStateEvidencePlan,
  SyncRuntimeStartupFromSchemaEvidenceInput,
  SyncRuntimeStartupInput,
  SyncRuntimeStartupPlan,
} from '../../engine/startup'
import type { SyncRuntimeSideEffectPermission } from '../shell.types'

/** Decides whether the current startup plan may execute plugin side effects. */
export function startupPlanSideEffectPermission(
  plan: SyncRuntimeStartupPlan | undefined,
  shell: SyncRuntimeShellState,
  evidenceFailure: boolean,
): SyncRuntimeSideEffectPermission {
  // A failed setup exchange is a pure network probe with no local mutation on
  // failure (see setup-exchange-http.ts), so it degrades to local-only editing
  // instead of the full block reserved for local-store-safety failures below.
  const setupExchangeFailed = lastFailedEffectIsSetupExchange(shell)
  if (
    evidenceFailure ||
    plan === undefined ||
    (shell.lastFailedEffect !== undefined && !setupExchangeFailed) ||
    shell.status === 'local-store-blocked' ||
    plan.action === 'rebuild-local-store' ||
    plan.action === 'hold-local-store-degraded' ||
    plan.action === 'reject-local-store-open' ||
    plan.action === 'reject-local-store-schema-evidence'
  ) {
    return 'blocked'
  }
  if (setupExchangeFailed) {
    return 'local-only'
  }

  switch (plan.sync.clientPlan.action) {
    case 'run-setup-exchange':
    case 'bootstrap-new-vault':
    case 'join-existing-vault':
    case 'reconnect':
    case 'restore-local-meta-snapshot':
      return 'allowed'
    case 'auth-blocked':
    case 'degraded':
    case 'reject':
      return 'local-only'
  }
}

function lastFailedEffectIsSetupExchange(shell: SyncRuntimeShellState): boolean {
  const effect = shell.lastFailedEffect?.effect
  return effect?.kind === 'run-sync-startup-effect' && effect.effect.kind === 'run-setup-exchange'
}

export function startupReplanCurrentFromEvidenceInput(
  input: SyncRuntimeStartupFromSchemaEvidenceInput,
): Omit<SyncRuntimeStartupInput, 'setupResponse' | 'expectedBootstrapMode'> {
  const localStore = input.localStoreEvidence?.ok
    ? {
        dbExists: input.localStoreEvidence.evidence.dbExists,
        currentVersion: input.localStoreEvidence.evidence.currentVersion,
        presentStores: input.localStoreEvidence.evidence.presentStores,
        pendingOutboxCount: input.localStoreEvidence.evidence.pendingOutboxCount,
      }
    : undefined

  return {
    intent: input.intent,
    local: input.local,
    localStore,
  }
}

export function remainingLocalEffectLimit(
  maxLocalEffects: number | undefined,
  executedLocalEffectCount: number,
): number | undefined {
  return maxLocalEffects === undefined
    ? undefined
    : Math.max(0, maxLocalEffects - executedLocalEffectCount)
}

export function runtimeDriverFailureReason(
  phase: 'setup-exchange' | 'startup-step',
  _error: unknown,
): string {
  return phase === 'setup-exchange' ? 'setup-exchange-failed' : 'startup-step-failed'
}

export function shellCommandsForEvidenceFailure(
  failure: Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>,
) {
  switch (failure.reason) {
    case 'local-store-schema-evidence-failure':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-blocked' },
        {
          kind: 'set-status',
          status: 'local-store-blocked',
          reason: failure.localStoreReason ?? failure.reason,
        },
        {
          kind: 'show-repair-entry',
          entry: 'local-store-schema',
          reason: failure.localStoreReason ?? failure.reason,
        },
        { kind: 'show-notice', notice: 'local-store-blocked' },
      ] as const
    case 'invalid-local-metadata':
    case 'invalid-supported-schema-version':
      return [
        { kind: 'stop-background-queues', reason: 'rejected' },
        {
          kind: 'set-status',
          status: 'rejected',
          reason: failure.metadataReason ?? failure.reason,
        },
        {
          kind: 'show-repair-entry',
          entry: 'startup-rejected',
          reason: failure.metadataReason ?? failure.reason,
        },
        { kind: 'show-notice', notice: 'startup-rejected' },
      ] as const
  }
}
