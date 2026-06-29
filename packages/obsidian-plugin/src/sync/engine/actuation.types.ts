import {
  type ClientStartupStep,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type SetupExchangeResponse,
  decideClientAuthRefresh,
} from '@kuroflare/core'
import {
  type LocalStoreIndexedDbExecutableOpenEffect,
  type LocalStoreIndexedDbFactoryPort,
  type LocalStoreIndexedDbOpenEffectPlan,
  type LocalStoreIndexedDbSchemaDatabasePort,
} from '../store/indexeddb'
import { type LocalStoreIndexedDbOpenEffect } from '../store/schema'
import {
  type LocalSetupPersistMetadataPort,
  type LocalSetupPersistRuntimeInput,
  type LocalSetupPersistRuntimePlan,
  type LocalSetupPersistSecretStoragePort,
} from '../engine/persist'
import { type SyncRuntimeStartupEffect, type SyncRuntimeStartupPlan } from '../engine/startup'
import { type SyncEngineStartupEffect } from '../engine/engine'

/** Stable status the plugin shell can expose in the status bar or settings UI. */
export type SyncRuntimeShellStatus =
  | 'setup-required'
  | 'auth-blocked'
  | 'degraded'
  | 'rejected'
  | 'local-store-blocked'
  | 'starting'
  | 'rebuild-local-store'

/** Repair entry the plugin shell should surface to the user. */
export type SyncRuntimeRepairEntry =
  | 'device-revoked'
  | 'reauth-required'
  | 'local-store-schema'
  | 'startup-rejected'

/** Concrete command consumed by the Obsidian plugin shell. */
export type SyncRuntimeShellCommand =
  | {
      readonly kind: 'set-status'
      readonly status: SyncRuntimeShellStatus
      readonly reason?: string | undefined
    }
  | {
      readonly kind: 'stop-background-queues'
      readonly reason:
        | 'startup-not-ready'
        | 'auth-blocked'
        | 'degraded'
        | 'rejected'
        | 'local-store-blocked'
        | 'local-store-rebuild'
    }
  | {
      readonly kind: 'show-repair-entry'
      readonly entry: SyncRuntimeRepairEntry
      readonly reason: string
    }
  | {
      readonly kind: 'clear-repair-entries'
      readonly reason: 'startup-progress'
    }
  | {
      readonly kind: 'show-notice'
      readonly notice:
        | 'setup-required'
        | 'device-revoked'
        | 'reauth-required'
        | 'startup-degraded'
        | 'startup-rejected'
        | 'local-store-blocked'
    }
  | {
      readonly kind: 'run-runtime-effect'
      readonly effect: SyncRuntimeStartupEffect
    }
  | {
      readonly kind: 'ack-runtime-effect'
      readonly effect: SyncRuntimeStartupEffect
    }
  | {
      readonly kind: 'fail-runtime-effect'
      readonly effect: SyncRuntimeStartupEffect
      readonly reason: string
    }
  | {
      readonly kind: 'retry-last-failed-effect'
      readonly reason: 'user-requested-retry' | 'startup-replan'
    }

/** Minimal startup UI/runtime state owned by the Obsidian plugin shell. */
export interface SyncRuntimeShellState {
  readonly status: SyncRuntimeShellStatus | undefined
  readonly statusReason: string | undefined
  readonly backgroundQueues: 'running' | 'stopped'
  readonly backgroundQueueStopReason:
    | Extract<SyncRuntimeShellCommand, { readonly kind: 'stop-background-queues' }>['reason']
    | undefined
  readonly repairEntries: readonly SyncRuntimeRepairEntryState[]
  readonly notices: readonly Extract<
    SyncRuntimeShellCommand,
    { readonly kind: 'show-notice' }
  >['notice'][]
  readonly runnableEffects: readonly SyncRuntimeStartupEffect[]
  readonly completedEffects: readonly SyncRuntimeStartupEffect[]
  readonly lastFailedEffect: SyncRuntimeEffectFailure | undefined
}

/** One visible repair entry tracked by the plugin shell. */
export interface SyncRuntimeRepairEntryState {
  readonly entry: SyncRuntimeRepairEntry
  readonly reason: string
}

/** Last startup runtime effect failure observed by the plugin shell. */
export interface SyncRuntimeEffectFailure {
  readonly effect: SyncRuntimeStartupEffect
  readonly reason: string
}

/** Input for translating startup plans into shell commands. */
export interface SyncRuntimeStartupActuationInput {
  readonly plan: SyncRuntimeStartupPlan
}

/** Shell command plan derived from a startup runtime plan. */
export interface SyncRuntimeStartupActuationPlan {
  readonly commands: readonly SyncRuntimeShellCommand[]
}

/** Runner used by the Obsidian shell to execute one startup runtime effect. */
export interface SyncRuntimeShellEffectExecutor {
  /**
   * Executes one runtime startup effect.
   *
   * @param effect Startup effect at the head of the runnable queue.
   * @returns Resolves when the effect has completed and can be acknowledged.
   */
  run(effect: SyncRuntimeStartupEffect): Promise<void>
}

/** Input for executing queued startup runtime effects from shell state. */
export interface SyncRuntimeShellEffectExecutionInput {
  readonly state: SyncRuntimeShellState
  readonly executor: SyncRuntimeShellEffectExecutor
  readonly maxEffects?: number | undefined
}

/** Result of executing queued startup runtime effects. */
export interface SyncRuntimeShellEffectExecutionResult {
  readonly state: SyncRuntimeShellState
  readonly commands: readonly SyncRuntimeShellCommand[]
  readonly executedEffects: readonly SyncRuntimeStartupEffect[]
}

/** Input for planning a no-network startup effect pump from the current shell queue. */
export interface SyncRuntimeNoNetworkEffectPumpInput {
  readonly state: SyncRuntimeShellState
  readonly maxEffects?: number | undefined
}

/** Plan for executing only startup effects that are safe before network transports are wired. */
export interface SyncRuntimeNoNetworkEffectPumpPlan {
  readonly executableEffectCount: number
  readonly deferredEffect: SyncRuntimeDeferredStartupEffect | undefined
}

/** First startup effect intentionally left queued by the no-network shell pump. */
export interface SyncRuntimeDeferredStartupEffect {
  readonly effect: SyncRuntimeStartupEffect
  readonly reason: 'setup-exchange-transport-unimplemented' | 'startup-step-port-unimplemented'
}

/** Runtime ports used to execute startup effects owned by the Obsidian shell. */
export interface SyncRuntimeStartupEffectExecutorPorts {
  readonly localStore: SyncRuntimeLocalStoreEffectPort
  readonly setupExchange: SyncRuntimeSetupExchangeEffectPort
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly localStoreRebuild: SyncRuntimeLocalStoreRebuildEffectPort
}

/** Runtime port for IndexedDB local-store schema effects. */
export interface SyncRuntimeLocalStoreEffectPort {
  /**
   * Executes one local-store schema open/delete effect.
   *
   * @param effect Local-store effect planned before sync side effects are allowed to run.
   * @returns Resolves when the local-store effect is durable enough to acknowledge.
   */
  runOpenEffect(effect: LocalStoreIndexedDbOpenEffect): Promise<void>
}

/** Runtime state captured while applying local-store schema effects. */
export interface SyncRuntimeIndexedDbLocalStoreEffectState<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
> {
  readonly appliedEffects: readonly LocalStoreIndexedDbExecutableOpenEffect[]
  readonly openPlans: readonly LocalStoreIndexedDbOpenEffectPlan<Database>[]
}

/** Input for creating an IndexedDB-backed local-store schema effect port. */
export interface SyncRuntimeIndexedDbLocalStoreEffectPortInput<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
 > {
  readonly indexedDb: LocalStoreIndexedDbFactoryPort<Database>
}

/** IndexedDB-backed local-store schema effect port plus observable runtime state. */
export interface SyncRuntimeIndexedDbLocalStoreEffectPort<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
> extends SyncRuntimeLocalStoreEffectPort {
  /** Returns the local-store open/delete effects applied so far. */
  snapshot(): SyncRuntimeIndexedDbLocalStoreEffectState<Database>
}

/** Runtime port for setup exchange effects that must obtain credentials before setup can continue. */
export interface SyncRuntimeSetupExchangeEffectPort {
  /**
   * Runs setup exchange for a startup plan that lacks local credentials.
   *
   * @param effect Setup exchange effect with the startup reason.
   * @returns The setup exchange response paired with the effect after replan scheduling is accepted.
   */
  run(
    effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>,
  ): Promise<SyncRuntimeSetupExchangeReplanRequest>
}

/** One request to run setup exchange and replan startup with the returned response. */
export interface SyncRuntimeSetupExchangeReplanRequest {
  readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>
  readonly response: SetupExchangeResponse
}

/** Runtime state captured while running setup exchange effects. */
export interface SyncRuntimeSetupExchangePortState {
  readonly completed: readonly SyncRuntimeSetupExchangeReplanRequest[]
}

/** Input for creating a setup exchange port. */
export interface SyncRuntimeSetupExchangePortInput {
  readonly exchange: (
    effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>,
  ) => Promise<SetupExchangeResponse>
  readonly scheduleReplan: (request: SyncRuntimeSetupExchangeReplanRequest) => Promise<void>
}

/** Setup exchange port plus observable completed exchange requests. */
export interface SyncRuntimeSetupExchangePort extends SyncRuntimeSetupExchangeEffectPort {
  /** Returns setup exchange requests whose replan scheduling was accepted. */
  snapshot(): SyncRuntimeSetupExchangePortState
}

/** Runtime port for concrete startup steps after the core startup planner accepts local evidence. */
export interface SyncRuntimeStartupStepEffectPort {
  /**
   * Executes one accepted startup step.
   *
   * @param effect Startup step with vault ID and coarse execution phase.
   * @returns Resolves when the step can be acknowledged.
   */
  run(
    effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>,
  ): Promise<void>
}

/** Runtime port for rebuilding local IndexedDB state before collecting startup evidence again. */
export interface SyncRuntimeLocalStoreRebuildEffectPort {
  /**
   * Requests a startup replan after a local-store rebuild completed.
   *
   * @param effect Rebuild completion effect containing the vault and database name.
   * @returns Resolves when startup replan scheduling has been accepted.
   */
  rerunStartup(
    effect: Extract<
      SyncRuntimeStartupEffect,
      { readonly kind: 'rerun-startup-after-local-store-rebuild' }
    >,
  ): Promise<void>
}

/** Runtime state captured while scheduling startup after a local-store rebuild. */
export interface SyncRuntimeLocalStoreRebuildReplanState {
  readonly requests: readonly SyncRuntimeLocalStoreRebuildReplanRequest[]
}

/** One request to collect startup evidence again after local-store rebuild. */
export interface SyncRuntimeLocalStoreRebuildReplanRequest {
  readonly vaultId: Extract<
    SyncRuntimeStartupEffect,
    { readonly kind: 'rerun-startup-after-local-store-rebuild' }
  >['vaultId']
  readonly dbName: string
}

/** Input for creating a local-store rebuild replan port. */
export interface SyncRuntimeLocalStoreRebuildReplanPortInput {
  readonly scheduleReplan: (request: SyncRuntimeLocalStoreRebuildReplanRequest) => Promise<void>
}

/** Local-store rebuild port plus observable scheduled replan requests. */
export interface SyncRuntimeLocalStoreRebuildReplanPort extends SyncRuntimeLocalStoreRebuildEffectPort {
  /** Returns replan requests accepted so far. */
  snapshot(): SyncRuntimeLocalStoreRebuildReplanState
}

/** Runtime ports used to execute individual accepted startup steps. */
export interface SyncRuntimeStartupStepExecutorPorts {
  readonly setup: SyncRuntimeSetupStepPort
  readonly localScan: SyncRuntimeLocalScanStepPort
  readonly snapshot: SyncRuntimeSnapshotStepPort
  readonly localStore: SyncRuntimeLocalStoreStepPort
  readonly websocket: SyncRuntimeWebSocketStepPort
  readonly outbox: SyncRuntimeOutboxStepPort
}

/** Accepted startup step effect narrowed to one concrete core startup step. */
export type SyncRuntimeStartupStepEffect<Step extends ClientStartupStep> = Extract<
  SyncEngineStartupEffect,
  { readonly kind: 'run-startup-step' }
> & {
  readonly step: Step
}

/** Runtime port for setup persistence startup steps. */
export interface SyncRuntimeSetupStepPort {
  /**
   * Persists a successful setup response before any local scan or sync side effect runs.
   *
   * @param effect Accepted startup step for setup persistence.
   * @returns Resolves when setup metadata and secrets are durable enough to continue.
   */
  persistSetupResponse(
    effect: SyncRuntimeStartupStepEffect<'persist-setup-response'>,
  ): Promise<void>
}

/** Runtime state captured while applying setup persistence startup steps. */
export interface SyncRuntimeSetupPersistStepState {
  readonly results: readonly LocalSetupPersistRuntimePlan[]
}

/** Access-token verifier used before persisting setup response metadata. */
export interface SyncRuntimeSetupPersistAccessTokenVerifierPort {
  /**
   * Verifies setup access-token signature and returns guarded claims.
   *
   * @param accessToken Token returned by setup exchange.
   * @returns Verified claims, or undefined when signature or shape validation failed.
   */
  verify(accessToken: string): Promise<DeviceTokenClaims | undefined>
}

/** Input for creating a setup persistence startup step port. */
export interface SyncRuntimeSetupPersistStepPortInput {
  readonly response: LocalSetupPersistRuntimeInput['response']
  readonly accessTokenExpiresAt: number
  readonly secretKeyPrefix?: string | undefined
  readonly secretStorage: LocalSetupPersistSecretStoragePort
  readonly metadata: LocalSetupPersistMetadataPort
}

/** Input for creating a setup persistence port that verifies the setup access token first. */
export interface SyncRuntimeVerifiedSetupPersistStepPortInput extends Omit<
  SyncRuntimeSetupPersistStepPortInput,
  'accessTokenExpiresAt'
> {
  readonly now: number
  readonly verifier: SyncRuntimeSetupPersistAccessTokenVerifierPort
  readonly requiredScopes?: readonly DeviceTokenScope[] | undefined
}

/** Setup persistence step port plus observable runtime results. */
export interface SyncRuntimeSetupPersistStepPort extends SyncRuntimeSetupStepPort {
  /** Returns setup persistence results observed so far. */
  snapshot(): SyncRuntimeSetupPersistStepState
}

/** Setup access-token verification failure recorded without token material. */
export interface SyncRuntimeSetupPersistTokenVerificationFailure {
  readonly reason:
    | 'invalid-clock'
    | 'invalid-access-token'
    | 'token-version-mismatch'
    | Exclude<ReturnType<typeof decideClientAuthRefresh>, { readonly action: 'accept' }>['reason']
}

/** Runtime state captured while verifying and applying setup persistence. */
export interface SyncRuntimeVerifiedSetupPersistStepState extends SyncRuntimeSetupPersistStepState {
  readonly verificationFailures: readonly SyncRuntimeSetupPersistTokenVerificationFailure[]
}

/** Verified setup persistence step port plus observable verification and persistence state. */
export interface SyncRuntimeVerifiedSetupPersistStepPort extends SyncRuntimeSetupStepPort {
  /** Returns token verification failures and setup persistence results observed so far. */
  snapshot(): SyncRuntimeVerifiedSetupPersistStepState
}

/** Runtime port for local vault scan and metadata adoption steps. */
export interface SyncRuntimeLocalScanStepPort {
  /** Scans the local vault before bootstrapping a new remote meta tree. */
  scanLocalVault(effect: SyncRuntimeStartupStepEffect<'scan-local-vault'>): Promise<void>
  /** Creates the local meta YDoc for a newly bootstrapped vault. */
  createLocalMetaYDoc(effect: SyncRuntimeStartupStepEffect<'create-local-meta-ydoc'>): Promise<void>
  /** Adopts only local files absent from the fetched remote meta snapshot. */
  adoptLocalFilesAfterRemoteMeta(
    effect: SyncRuntimeStartupStepEffect<'adopt-local-files-after-remote-meta'>,
  ): Promise<void>
}

/** Runtime port for remote snapshot and state-vector startup steps. */
export interface SyncRuntimeSnapshotStepPort {
  /** Fetches the remote meta snapshot before joining or repairing local metadata. */
  fetchRemoteMetaSnapshot(
    effect: SyncRuntimeStartupStepEffect<'fetch-remote-meta-snapshot'>,
  ): Promise<void>
  /** Applies the remote meta snapshot to local IndexedDB/Yjs state. */
  applyRemoteMetaSnapshot(
    effect: SyncRuntimeStartupStepEffect<'apply-remote-meta-snapshot'>,
  ): Promise<void>
  /** Exchanges the meta YDoc state vector after WebSocket admission. */
  syncMetaStateVector(effect: SyncRuntimeStartupStepEffect<'sync-meta-state-vector'>): Promise<void>
  /** Exchanges the active file YDoc state vector after meta sync. */
  syncActiveFileStateVector(
    effect: SyncRuntimeStartupStepEffect<'sync-active-file-state-vector'>,
  ): Promise<void>
}

/** Runtime port for loading IndexedDB-backed YDocs. */
export interface SyncRuntimeLocalStoreStepPort {
  /** Loads local IndexedDB YDocs before websocket and outbox work starts. */
  loadIndexedDbYDocs(effect: SyncRuntimeStartupStepEffect<'load-indexeddb-ydocs'>): Promise<void>
}

/** Runtime port for WebSocket startup steps. */
export interface SyncRuntimeWebSocketStepPort {
  /** Opens the WebSocket transport for the accepted vault. */
  openWebSocket(effect: SyncRuntimeStartupStepEffect<'open-websocket'>): Promise<void>
  /** Sends client hello after the WebSocket transport is open. */
  sendClientHello(effect: SyncRuntimeStartupStepEffect<'send-client-hello'>): Promise<void>
}

/** Runtime port for startup outbox and background queue steps. */
export interface SyncRuntimeOutboxStepPort {
  /** Enqueues initial file uploads for a newly bootstrapped vault. */
  enqueueInitialFileUploads(
    effect: SyncRuntimeStartupStepEffect<'enqueue-initial-file-uploads'>,
  ): Promise<void>
  /** Sends the meta update that publishes initial or adopted metadata. */
  sendMetaUpdate(effect: SyncRuntimeStartupStepEffect<'send-meta-update'>): Promise<void>
  /** Enqueues missing downloads after a join or snapshot repair. */
  enqueueMissingDownloads(
    effect: SyncRuntimeStartupStepEffect<'enqueue-missing-downloads'>,
  ): Promise<void>
  /** Resumes background queues after startup sync barriers have completed. */
  resumeBackgroundQueues(
    effect: SyncRuntimeStartupStepEffect<'resume-background-queues'>,
  ): Promise<void>
}
