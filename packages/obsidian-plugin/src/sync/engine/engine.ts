import {
  planClientStartup,
  type ClientStartupIntent,
  type ClientStartupLocalState,
  type ClientStartupPlan,
  type ClientStartupPlanInput,
  type ClientStartupStep,
} from '@kuroflare/core'
import { type SetupBootstrapMode, type SetupExchangeResponse, type VaultId } from '@kuroflare/core'

/** Phase used by the plugin shell to sequence startup side effects. */
export type SyncEngineStartupPhase =
  | 'setup'
  | 'local-scan'
  | 'snapshot'
  | 'local-store'
  | 'websocket'
  | 'outbox'

/** One concrete startup effect the Obsidian plugin must execute. */
export type SyncEngineStartupEffect =
  | {
      readonly kind: 'run-setup-exchange'
      readonly reason: 'setup-required' | 'missing-local-credentials'
    }
  | {
      readonly kind: 'enter-auth-blocked'
      readonly reason: 'device-revoked' | 'reauth-required'
    }
  | {
      readonly kind: 'enter-degraded'
      readonly reason:
        | 'invalid-local-schema'
        | 'local-schema-too-new'
        | 'missing-indexeddb'
        | 'missing-local-vault-id'
    }
  | {
      readonly kind: 'reject-startup'
      readonly reason:
        | 'intent-bootstrap-mode-mismatch'
        | 'setup-response-mode-mismatch'
        | 'local-vault-mismatch'
        | 'invalid-pending-outbox-count'
    }
  | {
      readonly kind: 'run-startup-step'
      readonly vaultId: VaultId
      readonly step: ClientStartupStep
      readonly phase: SyncEngineStartupPhase
    }

/** Input available to the plugin shell when starting or resuming sync. */
export interface SyncEngineStartupInput {
  readonly intent: ClientStartupIntent
  readonly local: ClientStartupLocalState
  readonly setupResponse?: SetupExchangeResponse | undefined
  readonly expectedBootstrapMode?: SetupBootstrapMode | undefined
}

/** Startup plan plus plugin-level executable effects. */
export interface SyncEngineStartupPlan {
  readonly clientPlan: ClientStartupPlan
  readonly effects: readonly SyncEngineStartupEffect[]
}

/**
 * Converts core startup decisions into plugin-level startup effects.
 *
 * @param input Local/setup evidence gathered by the plugin shell.
 * @returns The core startup plan and the ordered effects the plugin should execute.
 */
export function planSyncEngineStartup(input: SyncEngineStartupInput): SyncEngineStartupPlan {
  const clientPlan = planClientStartup({
    intent: input.intent,
    local: input.local,
    setupResponse: input.setupResponse,
    expectedBootstrapMode: input.expectedBootstrapMode,
  } satisfies ClientStartupPlanInput)

  switch (clientPlan.action) {
    case 'run-setup-exchange':
      return {
        clientPlan,
        effects: [{ kind: 'run-setup-exchange', reason: clientPlan.reason }],
      }
    case 'auth-blocked':
      return {
        clientPlan,
        effects: [{ kind: 'enter-auth-blocked', reason: clientPlan.reason }],
      }
    case 'degraded':
      return {
        clientPlan,
        effects: [{ kind: 'enter-degraded', reason: clientPlan.reason }],
      }
    case 'reject':
      return {
        clientPlan,
        effects: [{ kind: 'reject-startup', reason: clientPlan.reason }],
      }
    case 'bootstrap-new-vault':
    case 'join-existing-vault':
    case 'reconnect':
    case 'restore-local-meta-snapshot':
      return {
        clientPlan,
        effects: clientPlan.steps.map((step) => ({
          kind: 'run-startup-step',
          vaultId: clientPlan.vaultId,
          step,
          phase: startupStepPhase(step),
        })),
      }
    default:
      return assertNever(clientPlan)
  }
}

/**
 * Groups startup steps into coarse execution phases for status and scheduling.
 *
 * @param step Core startup step.
 * @returns Plugin execution phase for the step.
 */
export function startupStepPhase(step: ClientStartupStep): SyncEngineStartupPhase {
  switch (step) {
    case 'persist-setup-response':
      return 'setup'
    case 'scan-local-vault':
    case 'create-local-meta-ydoc':
    case 'adopt-local-files-after-remote-meta':
      return 'local-scan'
    case 'send-meta-update':
    case 'enqueue-missing-downloads':
    case 'resume-background-queues':
      return 'outbox'
    case 'fetch-remote-meta-snapshot':
    case 'apply-remote-meta-snapshot':
    case 'publish-local-meta-snapshot':
    case 'publish-initial-file-snapshots':
    case 'sync-meta-state-vector':
    case 'sync-active-file-state-vector':
      return 'snapshot'
    case 'load-indexeddb-ydocs':
      return 'local-store'
    case 'open-websocket':
    case 'send-client-hello':
      return 'websocket'
    default:
      return assertNever(step)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected startup variant: ${String(value)}`)
}
