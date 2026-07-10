import type {
  SyncRuntimeLocalStateEvidencePlan,
  SyncRuntimeStartupFromSchemaEvidenceInput,
  SyncRuntimeStartupInput,
} from '../../engine/startup'

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
