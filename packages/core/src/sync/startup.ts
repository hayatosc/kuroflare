import * as v from 'valibot'

import { type SetupBootstrapMode, type SetupExchangeResponse } from '../sync/setup'
import { type VaultId } from '../utils/ids'
import { NonNegativeSafeIntegerSchema } from '../utils/shared'

/** User-visible startup path requested by the plugin shell. */
export type ClientStartupIntent = 'setup-new-vault' | 'join-existing-vault' | 'reconnect'

/** Step the plugin should run while entering sync from local or setup state. */
export type ClientStartupStep =
  | 'persist-setup-response'
  | 'scan-local-vault'
  | 'create-local-meta-ydoc'
  | 'publish-local-meta-snapshot'
  | 'publish-initial-file-snapshots'
  | 'send-meta-update'
  | 'fetch-remote-meta-snapshot'
  | 'apply-remote-meta-snapshot'
  | 'adopt-local-files-after-remote-meta'
  | 'enqueue-missing-downloads'
  | 'load-indexeddb-ydocs'
  | 'open-websocket'
  | 'send-client-hello'
  | 'sync-meta-state-vector'
  | 'sync-active-file-state-vector'
  | 'resume-background-queues'

/** Auth state recovered from persisted local metadata during startup. */
export type ClientStartupAuthState = 'active' | 'revoked' | 'reauth-required'

/** Local store evidence available before the plugin enters sync. */
export interface ClientStartupLocalState {
  readonly hasIndexedDb: boolean
  readonly hasDeviceCredentials: boolean
  readonly hasMetaYDoc: boolean
  readonly hasLocalVaultFiles: boolean
  readonly pendingOutboxCount: number
  readonly schemaVersion?: number | undefined
  readonly supportedSchemaVersion: number
  readonly vaultId?: VaultId | undefined
  readonly authState?: ClientStartupAuthState | undefined
}

/** Input for planning the client startup path. */
export interface ClientStartupPlanInput {
  readonly intent: ClientStartupIntent
  readonly local: ClientStartupLocalState
  readonly setupResponse?: SetupExchangeResponse | undefined
  readonly expectedBootstrapMode?: SetupBootstrapMode | undefined
}

/** Planned startup path for the Obsidian plugin sync engine. */
export type ClientStartupPlan =
  | {
      readonly action: 'run-setup-exchange'
      readonly reason: 'setup-required' | 'missing-local-credentials'
    }
  | {
      readonly action: 'auth-blocked'
      readonly reason: 'device-revoked' | 'reauth-required'
    }
  | {
      readonly action: 'bootstrap-new-vault'
      readonly vaultId: VaultId
      readonly steps: readonly ClientStartupStep[]
    }
  | {
      readonly action: 'join-existing-vault'
      readonly vaultId: VaultId
      readonly steps: readonly ClientStartupStep[]
    }
  | {
      readonly action: 'reconnect'
      readonly vaultId: VaultId
      readonly steps: readonly ClientStartupStep[]
    }
  | {
      readonly action: 'restore-local-meta-snapshot'
      readonly vaultId: VaultId
      readonly steps: readonly ClientStartupStep[]
    }
  | {
      readonly action: 'degraded'
      readonly reason:
        | 'invalid-local-schema'
        | 'local-schema-too-new'
        | 'missing-indexeddb'
        | 'missing-local-vault-id'
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'intent-bootstrap-mode-mismatch'
        | 'setup-response-mode-mismatch'
        | 'local-vault-mismatch'
        | 'invalid-pending-outbox-count'
    }

const BOOTSTRAP_NEW_VAULT_STEPS = [
  'persist-setup-response',
  'scan-local-vault',
  'open-websocket',
  'send-client-hello',
  'create-local-meta-ydoc',
  'publish-local-meta-snapshot',
  'publish-initial-file-snapshots',
  'send-meta-update',
] as const satisfies readonly ClientStartupStep[]

const JOIN_EXISTING_VAULT_STEPS = [
  'persist-setup-response',
  'fetch-remote-meta-snapshot',
  'apply-remote-meta-snapshot',
  'open-websocket',
  'send-client-hello',
  'adopt-local-files-after-remote-meta',
  'enqueue-missing-downloads',
] as const satisfies readonly ClientStartupStep[]

const RECONNECT_STEPS = [
  'load-indexeddb-ydocs',
  'open-websocket',
  'send-client-hello',
  'sync-meta-state-vector',
  'sync-active-file-state-vector',
  'resume-background-queues',
] as const satisfies readonly ClientStartupStep[]

const RESTORE_LOCAL_META_STEPS = [
  'fetch-remote-meta-snapshot',
  'apply-remote-meta-snapshot',
  'load-indexeddb-ydocs',
  'open-websocket',
  'send-client-hello',
  'sync-meta-state-vector',
  'resume-background-queues',
] as const satisfies readonly ClientStartupStep[]

const ClientStartupLocalValidationSchema = v.object({
  pendingOutboxCount: NonNegativeSafeIntegerSchema,
  supportedSchemaVersion: NonNegativeSafeIntegerSchema,
  schemaVersion: v.optional(NonNegativeSafeIntegerSchema),
})

/**
 * Plans the first sync path after plugin startup or setup exchange.
 *
 * @param input User intent, local store evidence, and optional validated setup response.
 * @returns A side-effect-free startup plan that keeps bootstrap, join, and reconnect paths separate.
 */
export function planClientStartup(input: ClientStartupPlanInput): ClientStartupPlan {
  const localResult = v.safeParse(ClientStartupLocalValidationSchema, input.local)
  if (!localResult.success) {
    return String(localResult.issues[0]?.path?.[0]?.key) === 'pendingOutboxCount'
      ? { action: 'reject', reason: 'invalid-pending-outbox-count' }
      : { action: 'degraded', reason: 'invalid-local-schema' }
  }
  if (
    input.local.schemaVersion !== undefined &&
    input.local.schemaVersion > input.local.supportedSchemaVersion
  ) {
    return { action: 'degraded', reason: 'local-schema-too-new' }
  }

  if (input.intent === 'setup-new-vault' || input.intent === 'join-existing-vault') {
    if (input.setupResponse === undefined) {
      return { action: 'run-setup-exchange', reason: 'setup-required' }
    }
    return planAfterSetupExchange(input)
  }

  if (input.local.authState === 'revoked') {
    return { action: 'auth-blocked', reason: 'device-revoked' }
  }
  if (input.local.authState === 'reauth-required') {
    return { action: 'auth-blocked', reason: 'reauth-required' }
  }

  if (!input.local.hasDeviceCredentials) {
    return { action: 'run-setup-exchange', reason: 'missing-local-credentials' }
  }
  if (input.local.vaultId === undefined) {
    return { action: 'degraded', reason: 'missing-local-vault-id' }
  }
  if (!input.local.hasIndexedDb) {
    return { action: 'degraded', reason: 'missing-indexeddb' }
  }
  if (!input.local.hasMetaYDoc) {
    return {
      action: 'restore-local-meta-snapshot',
      vaultId: input.local.vaultId,
      steps: RESTORE_LOCAL_META_STEPS,
    }
  }

  return {
    action: 'reconnect',
    vaultId: input.local.vaultId,
    steps: RECONNECT_STEPS,
  }
}

function planAfterSetupExchange(input: ClientStartupPlanInput): ClientStartupPlan {
  const setupResponse = input.setupResponse
  if (setupResponse === undefined) {
    return { action: 'run-setup-exchange', reason: 'setup-required' }
  }
  const expectedMode = expectedModeForIntent(input.intent)
  if (expectedMode === undefined || setupResponse.bootstrapMode !== expectedMode) {
    return { action: 'reject', reason: 'intent-bootstrap-mode-mismatch' }
  }
  if (
    input.expectedBootstrapMode !== undefined &&
    setupResponse.bootstrapMode !== input.expectedBootstrapMode
  ) {
    return { action: 'reject', reason: 'setup-response-mode-mismatch' }
  }
  if (input.local.vaultId !== undefined && input.local.vaultId !== setupResponse.vaultId) {
    return { action: 'reject', reason: 'local-vault-mismatch' }
  }

  if (setupResponse.bootstrapMode === 'new-vault') {
    return {
      action: 'bootstrap-new-vault',
      vaultId: setupResponse.vaultId,
      steps: BOOTSTRAP_NEW_VAULT_STEPS,
    }
  }

  return {
    action: 'join-existing-vault',
    vaultId: setupResponse.vaultId,
    steps: JOIN_EXISTING_VAULT_STEPS,
  }
}

function expectedModeForIntent(intent: ClientStartupIntent): SetupBootstrapMode | undefined {
  switch (intent) {
    case 'setup-new-vault':
      return 'new-vault'
    case 'join-existing-vault':
      return 'join-existing'
    case 'reconnect':
      return undefined
  }
}
