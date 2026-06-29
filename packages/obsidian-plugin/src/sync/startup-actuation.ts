import { decideClientAuthRefresh, type ClientStartupStep } from '@kuroflare/core'
import {
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type SetupExchangeResponse,
} from '@kuroflare/protocol'

import {
  applyLocalStoreIndexedDbOpenEffect,
  type LocalStoreIndexedDbExecutableOpenEffect,
  type LocalStoreIndexedDbFactoryPort,
  type LocalStoreIndexedDbOpenEffectPlan,
  type LocalStoreIndexedDbSchemaDatabasePort,
} from './local-store-indexeddb.js'
import { type LocalStoreIndexedDbOpenEffect } from './local-store-schema.js'
import {
  persistLocalSetupResponse,
  type LocalSetupPersistMetadataPort,
  type LocalSetupPersistRuntimeInput,
  type LocalSetupPersistRuntimePlan,
  type LocalSetupPersistSecretStoragePort,
} from './setup-persist-runtime.js'
import { type SyncRuntimeStartupEffect, type SyncRuntimeStartupPlan } from './startup-runtime.js'
import { type SyncEngineStartupEffect } from './sync-engine.js'

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

/** Initial shell state before startup actuation commands are applied. */
export const INITIAL_SYNC_RUNTIME_SHELL_STATE: SyncRuntimeShellState = {
  status: undefined,
  statusReason: undefined,
  backgroundQueues: 'stopped',
  backgroundQueueStopReason: 'startup-not-ready',
  repairEntries: [],
  notices: [],
  runnableEffects: [],
  completedEffects: [],
  lastFailedEffect: undefined,
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
  /**
   * Scans the local vault before bootstrapping a new remote meta tree.
   *
   * @param effect Accepted startup step for local vault scanning.
   * @returns Resolves when local file evidence has been collected.
   */
  scanLocalVault(effect: SyncRuntimeStartupStepEffect<'scan-local-vault'>): Promise<void>
  /**
   * Creates the local meta YDoc for a newly bootstrapped vault.
   *
   * @param effect Accepted startup step for meta YDoc creation.
   * @returns Resolves when the local meta YDoc exists durably.
   */
  createLocalMetaYDoc(effect: SyncRuntimeStartupStepEffect<'create-local-meta-ydoc'>): Promise<void>
  /**
   * Adopts only local files absent from the fetched remote meta snapshot.
   *
   * @param effect Accepted startup step for post-snapshot local adoption.
   * @returns Resolves when adoptable local files have stable metadata.
   */
  adoptLocalFilesAfterRemoteMeta(
    effect: SyncRuntimeStartupStepEffect<'adopt-local-files-after-remote-meta'>,
  ): Promise<void>
}

/** Runtime port for remote snapshot and state-vector startup steps. */
export interface SyncRuntimeSnapshotStepPort {
  /**
   * Fetches the remote meta snapshot before joining or repairing local metadata.
   *
   * @param effect Accepted startup step for remote meta snapshot fetch.
   * @returns Resolves when the snapshot response is available to later steps.
   */
  fetchRemoteMetaSnapshot(
    effect: SyncRuntimeStartupStepEffect<'fetch-remote-meta-snapshot'>,
  ): Promise<void>
  /**
   * Applies the remote meta snapshot to local IndexedDB/Yjs state.
   *
   * @param effect Accepted startup step for remote snapshot apply.
   * @returns Resolves when local metadata reflects the remote snapshot.
   */
  applyRemoteMetaSnapshot(
    effect: SyncRuntimeStartupStepEffect<'apply-remote-meta-snapshot'>,
  ): Promise<void>
  /**
   * Exchanges the meta YDoc state vector after WebSocket admission.
   *
   * @param effect Accepted startup step for meta state-vector sync.
   * @returns Resolves when meta delta exchange is complete.
   */
  syncMetaStateVector(effect: SyncRuntimeStartupStepEffect<'sync-meta-state-vector'>): Promise<void>
  /**
   * Exchanges the active file YDoc state vector after meta sync.
   *
   * @param effect Accepted startup step for active file state-vector sync.
   * @returns Resolves when active file delta exchange is complete.
   */
  syncActiveFileStateVector(
    effect: SyncRuntimeStartupStepEffect<'sync-active-file-state-vector'>,
  ): Promise<void>
}

/** Runtime port for loading IndexedDB-backed YDocs. */
export interface SyncRuntimeLocalStoreStepPort {
  /**
   * Loads local IndexedDB YDocs before websocket and outbox work starts.
   *
   * @param effect Accepted startup step for local YDoc loading.
   * @returns Resolves when local IndexedDB YDocs are ready.
   */
  loadIndexedDbYDocs(effect: SyncRuntimeStartupStepEffect<'load-indexeddb-ydocs'>): Promise<void>
}

/** Runtime port for WebSocket startup steps. */
export interface SyncRuntimeWebSocketStepPort {
  /**
   * Opens the WebSocket transport for the accepted vault.
   *
   * @param effect Accepted startup step for WebSocket open.
   * @returns Resolves when the socket is open enough for client hello.
   */
  openWebSocket(effect: SyncRuntimeStartupStepEffect<'open-websocket'>): Promise<void>
  /**
   * Sends client hello after the WebSocket transport is open.
   *
   * @param effect Accepted startup step for client hello.
   * @returns Resolves when server admission has accepted the hello.
   */
  sendClientHello(effect: SyncRuntimeStartupStepEffect<'send-client-hello'>): Promise<void>
}

/** Runtime port for startup outbox and background queue steps. */
export interface SyncRuntimeOutboxStepPort {
  /**
   * Enqueues initial file uploads for a newly bootstrapped vault.
   *
   * @param effect Accepted startup step for initial upload enqueue.
   * @returns Resolves when upload outbox rows are durable.
   */
  enqueueInitialFileUploads(
    effect: SyncRuntimeStartupStepEffect<'enqueue-initial-file-uploads'>,
  ): Promise<void>
  /**
   * Sends the meta update that publishes initial or adopted metadata.
   *
   * @param effect Accepted startup step for meta update publishing.
   * @returns Resolves when the meta update has been durably enqueued or sent.
   */
  sendMetaUpdate(effect: SyncRuntimeStartupStepEffect<'send-meta-update'>): Promise<void>
  /**
   * Enqueues missing downloads after a join or snapshot repair.
   *
   * @param effect Accepted startup step for missing download enqueue.
   * @returns Resolves when required download outbox rows are durable.
   */
  enqueueMissingDownloads(
    effect: SyncRuntimeStartupStepEffect<'enqueue-missing-downloads'>,
  ): Promise<void>
  /**
   * Resumes background queues after startup sync barriers have completed.
   *
   * @param effect Accepted startup step for background queue resume.
   * @returns Resolves when background queue workers have been scheduled.
   */
  resumeBackgroundQueues(
    effect: SyncRuntimeStartupStepEffect<'resume-background-queues'>,
  ): Promise<void>
}

/**
 * Converts startup runtime effects into commands for the Obsidian plugin shell.
 *
 * @param input Runtime startup plan produced after storage and sync planning.
 * @returns Ordered shell commands that make terminal startup states visible and keep queues stopped.
 */
export function planSyncRuntimeStartupActuation(
  input: SyncRuntimeStartupActuationInput,
): SyncRuntimeStartupActuationPlan {
  return {
    commands: input.plan.effects.flatMap((effect) => shellCommandsForRuntimeEffect(effect)),
  }
}

/**
 * Applies startup shell commands to the plugin-owned startup state.
 *
 * @param state Previous shell state.
 * @param commands Commands produced by startup actuation planning.
 * @returns The next shell state the Obsidian UI can render.
 */
export function applySyncRuntimeShellCommands(
  state: SyncRuntimeShellState,
  commands: readonly SyncRuntimeShellCommand[],
): SyncRuntimeShellState {
  let next = state
  for (const command of commands) {
    next = applySyncRuntimeShellCommand(next, command)
  }
  return next
}

/**
 * Executes runnable startup effects in queue order and feeds ACK/FAIL commands back into shell state.
 *
 * @param input Current shell state, effect executor, and optional execution limit for incremental pumping.
 * @returns Updated shell state plus the ACK/FAIL commands produced by execution.
 * @throws When maxEffects is not a non-negative safe integer.
 */
export async function executeRunnableSyncRuntimeShellEffects(
  input: SyncRuntimeShellEffectExecutionInput,
): Promise<SyncRuntimeShellEffectExecutionResult> {
  const maxEffects = input.maxEffects ?? Number.POSITIVE_INFINITY
  if (
    maxEffects !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxEffects) || maxEffects < 0)
  ) {
    throw new Error('maxEffects must be a non-negative safe integer')
  }

  let state = input.state
  const commands: SyncRuntimeShellCommand[] = []
  const executedEffects: SyncRuntimeStartupEffect[] = []
  while (executedEffects.length < maxEffects) {
    const effect = state.runnableEffects[0]
    if (effect === undefined) {
      break
    }

    executedEffects.push(effect)
    try {
      await input.executor.run(effect)
    } catch (error: unknown) {
      const command: SyncRuntimeShellCommand = {
        kind: 'fail-runtime-effect',
        effect,
        reason: runtimeEffectFailureReason(error),
      }
      commands.push(command)
      state = applySyncRuntimeShellCommands(state, [command])
      break
    }

    const command: SyncRuntimeShellCommand = { kind: 'ack-runtime-effect', effect }
    commands.push(command)
    state = applySyncRuntimeShellCommands(state, [command])
  }

  return { state, commands, executedEffects }
}

/**
 * Plans how far a no-network Obsidian shell may pump startup effects.
 *
 * @param input Current shell state and optional upper bound for this pump.
 * @returns Count of leading local-only effects to execute, plus the first deferred network-bound effect.
 * @throws When maxEffects is not a non-negative safe integer.
 */
export function planSyncRuntimeNoNetworkEffectPump(
  input: SyncRuntimeNoNetworkEffectPumpInput,
): SyncRuntimeNoNetworkEffectPumpPlan {
  const maxEffects = input.maxEffects ?? Number.POSITIVE_INFINITY
  if (
    maxEffects !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxEffects) || maxEffects < 0)
  ) {
    throw new Error('maxEffects must be a non-negative safe integer')
  }

  let executableEffectCount = 0
  while (executableEffectCount < maxEffects) {
    const effect = input.state.runnableEffects[executableEffectCount]
    if (effect === undefined) {
      return { executableEffectCount, deferredEffect: undefined }
    }
    const deferredEffect = deferredNoNetworkEffect(effect)
    if (deferredEffect !== undefined) {
      return { executableEffectCount, deferredEffect }
    }
    executableEffectCount += 1
  }

  const nextEffect = input.state.runnableEffects[executableEffectCount]
  return {
    executableEffectCount,
    deferredEffect: nextEffect === undefined ? undefined : deferredNoNetworkEffect(nextEffect),
  }
}

/**
 * Creates the default startup effect executor used by the Obsidian shell.
 *
 * @param ports Runtime ports for each side-effect family needed during startup.
 * @returns An executor that dispatches every runnable startup effect to exactly one port.
 */
export function createSyncRuntimeStartupEffectExecutor(
  ports: SyncRuntimeStartupEffectExecutorPorts,
): SyncRuntimeShellEffectExecutor {
  return {
    async run(effect) {
      switch (effect.kind) {
        case 'run-local-store-open-effect':
          await ports.localStore.runOpenEffect(effect.effect)
          return
        case 'run-sync-startup-effect':
          await runSyncStartupEffect(ports, effect.effect)
          return
        case 'rerun-startup-after-local-store-rebuild':
          await ports.localStoreRebuild.rerunStartup(effect)
          return
        case 'report-local-store-schema-evidence-failure':
          throw new Error(`Non-runnable startup effect: ${effect.kind}`)
      }
    },
  }
}

/**
 * Creates a local-store startup effect port backed by an IndexedDB factory.
 *
 * @param input Browser or fake IndexedDB factory used for schema open/delete effects.
 * @returns A local-store effect port that records applied schema effects for later wiring.
 */
export function createSyncRuntimeIndexedDbLocalStoreEffectPort<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
>(
  input: SyncRuntimeIndexedDbLocalStoreEffectPortInput<Database>,
): SyncRuntimeIndexedDbLocalStoreEffectPort<Database> {
  const appliedEffects: LocalStoreIndexedDbExecutableOpenEffect[] = []
  const openPlans: LocalStoreIndexedDbOpenEffectPlan<Database>[] = []

  return {
    async runOpenEffect(effect) {
      if (!localStoreOpenEffectIsExecutable(effect)) {
        throw new Error(`Non-runnable local-store open effect: ${effect.kind}`)
      }
      const plan = await applyLocalStoreIndexedDbOpenEffect({
        indexedDb: input.indexedDb,
        effect,
      })
      appliedEffects.push(effect)
      openPlans.push(plan)
    },
    snapshot() {
      return {
        appliedEffects: [...appliedEffects],
        openPlans: [...openPlans],
      }
    },
  }
}

/**
 * Creates a setup exchange port that replans startup with the returned setup response.
 *
 * @param input Exchange and scheduling callbacks owned by the Obsidian plugin runtime.
 * @returns A setup exchange port that records only requests accepted by the replan scheduler.
 */
export function createSyncRuntimeSetupExchangePort(
  input: SyncRuntimeSetupExchangePortInput,
): SyncRuntimeSetupExchangePort {
  const completed: SyncRuntimeSetupExchangeReplanRequest[] = []

  return {
    async run(effect) {
      const response = await input.exchange(effect)
      const request = { effect, response }
      await input.scheduleReplan(request)
      completed.push(request)
      return request
    },
    snapshot() {
      return { completed: [...completed] }
    },
  }
}

/**
 * Creates a setup persistence startup step port.
 *
 * @param input Setup response evidence plus concrete SecretStorage and metadata ports.
 * @returns A setup step port that persists setup response data and fails the startup effect on rejection.
 */
export function createSyncRuntimeSetupPersistStepPort(
  input: SyncRuntimeSetupPersistStepPortInput,
): SyncRuntimeSetupPersistStepPort {
  const results: LocalSetupPersistRuntimePlan[] = []

  return {
    async persistSetupResponse() {
      const result = await persistLocalSetupResponse({
        response: input.response,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        secretKeyPrefix: input.secretKeyPrefix,
        secretStorage: input.secretStorage,
        metadata: input.metadata,
      })
      results.push(result)
      if (!result.ok) {
        throw new Error(setupPersistFailureReason(result))
      }
    },
    snapshot() {
      return { results: [...results] }
    },
  }
}

/**
 * Creates a setup persistence port that verifies setup access-token claims before persisting.
 *
 * @param input Setup response, verifier, current time, and concrete storage ports.
 * @returns A setup step port that persists only after identity, scope, token version, and expiry checks pass.
 */
export function createVerifiedSyncRuntimeSetupPersistStepPort(
  input: SyncRuntimeVerifiedSetupPersistStepPortInput,
): SyncRuntimeVerifiedSetupPersistStepPort {
  const results: LocalSetupPersistRuntimePlan[] = []
  const verificationFailures: SyncRuntimeSetupPersistTokenVerificationFailure[] = []

  return {
    async persistSetupResponse() {
      const verification = await verifySetupPersistAccessToken(input)
      if (!verification.ok) {
        verificationFailures.push({ reason: verification.reason })
        throw new Error(`setup-persist-token:${verification.reason}`)
      }
      const result = await persistLocalSetupResponse({
        response: input.response,
        accessTokenExpiresAt: verification.expiresAt,
        secretKeyPrefix: input.secretKeyPrefix,
        secretStorage: input.secretStorage,
        metadata: input.metadata,
      })
      results.push(result)
      if (!result.ok) {
        throw new Error(setupPersistFailureReason(result))
      }
    },
    snapshot() {
      return {
        results: [...results],
        verificationFailures: [...verificationFailures],
      }
    },
  }
}

/**
 * Creates a local-store rebuild port that schedules startup evidence collection again.
 *
 * @param input Scheduler used to request a fresh startup plan after rebuild.
 * @returns A rebuild port that records accepted replan requests.
 */
export function createSyncRuntimeLocalStoreRebuildReplanPort(
  input: SyncRuntimeLocalStoreRebuildReplanPortInput,
): SyncRuntimeLocalStoreRebuildReplanPort {
  const requests: SyncRuntimeLocalStoreRebuildReplanRequest[] = []

  return {
    async rerunStartup(effect) {
      const request = { vaultId: effect.vaultId, dbName: effect.dbName }
      await input.scheduleReplan(request)
      requests.push(request)
    },
    snapshot() {
      return { requests: [...requests] }
    },
  }
}

/**
 * Creates the default executor for accepted startup steps.
 *
 * @param ports Runtime ports grouped by startup responsibility.
 * @returns A startup step port that dispatches every known step to one concrete method.
 */
export function createSyncRuntimeStartupStepEffectPort(
  ports: SyncRuntimeStartupStepExecutorPorts,
): SyncRuntimeStartupStepEffectPort {
  return {
    async run(effect) {
      switch (effect.step) {
        case 'persist-setup-response':
          await ports.setup.persistSetupResponse(
            startupStepEffect(effect, 'persist-setup-response'),
          )
          return
        case 'scan-local-vault':
          await ports.localScan.scanLocalVault(startupStepEffect(effect, 'scan-local-vault'))
          return
        case 'create-local-meta-ydoc':
          await ports.localScan.createLocalMetaYDoc(
            startupStepEffect(effect, 'create-local-meta-ydoc'),
          )
          return
        case 'adopt-local-files-after-remote-meta':
          await ports.localScan.adoptLocalFilesAfterRemoteMeta(
            startupStepEffect(effect, 'adopt-local-files-after-remote-meta'),
          )
          return
        case 'fetch-remote-meta-snapshot':
          await ports.snapshot.fetchRemoteMetaSnapshot(
            startupStepEffect(effect, 'fetch-remote-meta-snapshot'),
          )
          return
        case 'apply-remote-meta-snapshot':
          await ports.snapshot.applyRemoteMetaSnapshot(
            startupStepEffect(effect, 'apply-remote-meta-snapshot'),
          )
          return
        case 'sync-meta-state-vector':
          await ports.snapshot.syncMetaStateVector(
            startupStepEffect(effect, 'sync-meta-state-vector'),
          )
          return
        case 'sync-active-file-state-vector':
          await ports.snapshot.syncActiveFileStateVector(
            startupStepEffect(effect, 'sync-active-file-state-vector'),
          )
          return
        case 'load-indexeddb-ydocs':
          await ports.localStore.loadIndexedDbYDocs(
            startupStepEffect(effect, 'load-indexeddb-ydocs'),
          )
          return
        case 'open-websocket':
          await ports.websocket.openWebSocket(startupStepEffect(effect, 'open-websocket'))
          return
        case 'send-client-hello':
          await ports.websocket.sendClientHello(startupStepEffect(effect, 'send-client-hello'))
          return
        case 'enqueue-initial-file-uploads':
          await ports.outbox.enqueueInitialFileUploads(
            startupStepEffect(effect, 'enqueue-initial-file-uploads'),
          )
          return
        case 'send-meta-update':
          await ports.outbox.sendMetaUpdate(startupStepEffect(effect, 'send-meta-update'))
          return
        case 'enqueue-missing-downloads':
          await ports.outbox.enqueueMissingDownloads(
            startupStepEffect(effect, 'enqueue-missing-downloads'),
          )
          return
        case 'resume-background-queues':
          await ports.outbox.resumeBackgroundQueues(
            startupStepEffect(effect, 'resume-background-queues'),
          )
          return
      }
    },
  }
}

function applySyncRuntimeShellCommand(
  state: SyncRuntimeShellState,
  command: SyncRuntimeShellCommand,
): SyncRuntimeShellState {
  switch (command.kind) {
    case 'set-status':
      return {
        ...state,
        status: command.status,
        statusReason: command.reason,
      }
    case 'stop-background-queues':
      return {
        ...state,
        backgroundQueues: 'stopped',
        backgroundQueueStopReason: command.reason,
      }
    case 'show-repair-entry':
      return {
        ...state,
        repairEntries: [
          ...state.repairEntries.filter((entry) => entry.entry !== command.entry),
          { entry: command.entry, reason: command.reason },
        ],
      }
    case 'clear-repair-entries':
      return {
        ...state,
        repairEntries: [],
        backgroundQueueStopReason:
          state.backgroundQueues === 'stopped'
            ? 'startup-not-ready'
            : state.backgroundQueueStopReason,
      }
    case 'show-notice':
      return {
        ...state,
        notices: [...state.notices, command.notice],
      }
    case 'run-runtime-effect':
      return {
        ...state,
        runnableEffects: [...state.runnableEffects, command.effect],
      }
    case 'ack-runtime-effect':
      if (!runtimeStartupEffectIsHead(state.runnableEffects, command.effect)) {
        return state
      }
      return {
        ...state,
        runnableEffects: state.runnableEffects.slice(1),
        completedEffects: [...state.completedEffects, command.effect],
        backgroundQueues: runtimeEffectStartsBackgroundQueues(command.effect)
          ? 'running'
          : state.backgroundQueues,
        backgroundQueueStopReason: runtimeEffectStartsBackgroundQueues(command.effect)
          ? undefined
          : state.backgroundQueueStopReason,
      }
    case 'fail-runtime-effect':
      if (!runtimeStartupEffectIsHead(state.runnableEffects, command.effect)) {
        return state
      }
      return {
        ...state,
        status: 'rejected',
        statusReason: command.reason,
        backgroundQueues: 'stopped',
        backgroundQueueStopReason: 'rejected',
        repairEntries: [
          ...state.repairEntries.filter((entry) => entry.entry !== 'startup-rejected'),
          { entry: 'startup-rejected', reason: command.reason },
        ],
        notices: [...state.notices, 'startup-rejected'],
        runnableEffects: state.runnableEffects.slice(1),
        lastFailedEffect: { effect: command.effect, reason: command.reason },
      }
    case 'retry-last-failed-effect':
      if (state.lastFailedEffect === undefined) {
        return state
      }
      return {
        ...state,
        status: 'starting',
        statusReason: command.reason,
        repairEntries: state.repairEntries.filter((entry) => entry.entry !== 'startup-rejected'),
        runnableEffects: [state.lastFailedEffect.effect, ...state.runnableEffects],
        lastFailedEffect: undefined,
      }
  }
}

function runtimeStartupEffectIsHead(
  effects: readonly SyncRuntimeStartupEffect[],
  target: SyncRuntimeStartupEffect,
): boolean {
  const head = effects[0]
  return head !== undefined && runtimeStartupEffectsEqual(head, target)
}

function runtimeEffectStartsBackgroundQueues(effect: SyncRuntimeStartupEffect): boolean {
  return (
    effect.kind === 'run-sync-startup-effect' &&
    effect.effect.kind === 'run-startup-step' &&
    effect.effect.step === 'resume-background-queues'
  )
}

function runtimeStartupEffectsEqual(
  left: SyncRuntimeStartupEffect,
  right: SyncRuntimeStartupEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'run-local-store-open-effect':
      if (right.kind !== 'run-local-store-open-effect') {
        return false
      }
      return localStoreOpenEffectsEqual(left.effect, right.effect)
    case 'run-sync-startup-effect':
      if (right.kind !== 'run-sync-startup-effect') {
        return false
      }
      return syncStartupEffectsEqual(left.effect, right.effect)
    case 'rerun-startup-after-local-store-rebuild':
      if (right.kind !== 'rerun-startup-after-local-store-rebuild') {
        return false
      }
      return left.vaultId === right.vaultId && left.dbName === right.dbName
    case 'report-local-store-schema-evidence-failure':
      if (right.kind !== 'report-local-store-schema-evidence-failure') {
        return false
      }
      return left.reason === right.reason
  }
}

function localStoreOpenEffectsEqual(
  left: LocalStoreIndexedDbOpenEffect,
  right: LocalStoreIndexedDbOpenEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'open-database':
      if (right.kind !== 'open-database') {
        return false
      }
      return (
        left.mode === right.mode &&
        left.dbName === right.dbName &&
        left.version === right.version &&
        stringListsEqual(left.createStores, right.createStores)
      )
    case 'delete-database':
    case 'hold-degraded':
    case 'reject-open':
      if (right.kind !== left.kind) {
        return false
      }
      return left.dbName === right.dbName && left.reason === right.reason
  }
}

function syncStartupEffectsEqual(
  left: SyncEngineStartupEffect,
  right: SyncEngineStartupEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'run-setup-exchange':
    case 'enter-auth-blocked':
    case 'enter-degraded':
    case 'reject-startup':
      if (right.kind !== left.kind) {
        return false
      }
      return left.reason === right.reason
    case 'run-startup-step':
      if (right.kind !== 'run-startup-step') {
        return false
      }
      return (
        left.vaultId === right.vaultId && left.step === right.step && left.phase === right.phase
      )
  }
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function runtimeEffectFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return 'startup-effect-failed'
}

function startupStepEffect<Step extends ClientStartupStep>(
  effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>,
  step: Step,
): SyncRuntimeStartupStepEffect<Step> {
  return { ...effect, step }
}

function localStoreOpenEffectIsExecutable(
  effect: LocalStoreIndexedDbOpenEffect,
): effect is LocalStoreIndexedDbExecutableOpenEffect {
  return effect.kind === 'open-database' || effect.kind === 'delete-database'
}

function setupPersistFailureReason(
  result: Extract<LocalSetupPersistRuntimePlan, { readonly ok: false }>,
): string {
  if (result.phase === 'plan') {
    return `setup-persist-plan:${result.setupPlan.reason}`
  }
  return `setup-persist-${result.phase}`
}

async function verifySetupPersistAccessToken(
  input: SyncRuntimeVerifiedSetupPersistStepPortInput,
): Promise<
  | { readonly ok: true; readonly expiresAt: number }
  | {
      readonly ok: false
      readonly reason: SyncRuntimeSetupPersistTokenVerificationFailure['reason']
    }
> {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { ok: false, reason: 'invalid-clock' }
  }

  const claims = await input.verifier.verify(input.response.accessToken)
  if (claims === undefined) {
    return { ok: false, reason: 'invalid-access-token' }
  }
  if (claims.tokenVersion !== input.response.tokenVersion) {
    return { ok: false, reason: 'token-version-mismatch' }
  }

  const decision = decideClientAuthRefresh({
    claims,
    expectedVaultId: input.response.vaultId,
    expectedDeviceId: input.response.deviceId,
    requiredScopes: input.requiredScopes ?? REQUIRED_SETUP_ACCESS_TOKEN_SCOPES,
    now: input.now,
  })
  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason }
  }
  return { ok: true, expiresAt: decision.patch.expiresAt }
}

const REQUIRED_SETUP_ACCESS_TOKEN_SCOPES = [
  'sync:read',
  'sync:write',
  'blob:read',
  'blob:write',
] as const satisfies readonly DeviceTokenScope[]

async function runSyncStartupEffect(
  ports: SyncRuntimeStartupEffectExecutorPorts,
  effect: SyncEngineStartupEffect,
): Promise<void> {
  switch (effect.kind) {
    case 'run-setup-exchange':
      await ports.setupExchange.run(effect)
      return
    case 'run-startup-step':
      await ports.startupStep.run(effect)
      return
    case 'enter-auth-blocked':
    case 'enter-degraded':
    case 'reject-startup':
      throw new Error(`Non-runnable sync startup effect: ${effect.kind}`)
  }
}

function deferredNoNetworkEffect(
  effect: SyncRuntimeStartupEffect,
): SyncRuntimeDeferredStartupEffect | undefined {
  switch (effect.kind) {
    case 'run-local-store-open-effect':
    case 'rerun-startup-after-local-store-rebuild':
      return undefined
    case 'report-local-store-schema-evidence-failure':
      return undefined
    case 'run-sync-startup-effect':
      if (effect.effect.kind === 'run-setup-exchange') {
        return { effect, reason: 'setup-exchange-transport-unimplemented' }
      }
      if (effect.effect.kind === 'run-startup-step') {
        return { effect, reason: 'startup-step-port-unimplemented' }
      }
      return undefined
  }
}

function shellCommandsForRuntimeEffect(
  effect: SyncRuntimeStartupEffect,
): readonly SyncRuntimeShellCommand[] {
  switch (effect.kind) {
    case 'run-sync-startup-effect':
      return shellCommandsForSyncEffect(effect.effect)
    case 'run-local-store-open-effect':
      return [{ kind: 'run-runtime-effect', effect }]
    case 'rerun-startup-after-local-store-rebuild':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-rebuild' },
        { kind: 'set-status', status: 'rebuild-local-store', reason: effect.dbName },
        { kind: 'run-runtime-effect', effect },
      ]
    case 'report-local-store-schema-evidence-failure':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-blocked' },
        { kind: 'set-status', status: 'local-store-blocked', reason: effect.reason },
        { kind: 'show-repair-entry', entry: 'local-store-schema', reason: effect.reason },
        { kind: 'show-notice', notice: 'local-store-blocked' },
      ]
  }
}

function shellCommandsForSyncEffect(
  effect: SyncEngineStartupEffect,
): readonly SyncRuntimeShellCommand[] {
  switch (effect.kind) {
    case 'enter-auth-blocked':
      return [
        { kind: 'stop-background-queues', reason: 'auth-blocked' },
        { kind: 'set-status', status: 'auth-blocked', reason: effect.reason },
        {
          kind: 'show-repair-entry',
          entry: effect.reason,
          reason: effect.reason,
        },
        { kind: 'show-notice', notice: effect.reason },
      ]
    case 'enter-degraded':
      return [
        { kind: 'stop-background-queues', reason: 'degraded' },
        { kind: 'set-status', status: 'degraded', reason: effect.reason },
        { kind: 'show-notice', notice: 'startup-degraded' },
      ]
    case 'reject-startup':
      return [
        { kind: 'stop-background-queues', reason: 'rejected' },
        { kind: 'set-status', status: 'rejected', reason: effect.reason },
        { kind: 'show-repair-entry', entry: 'startup-rejected', reason: effect.reason },
        { kind: 'show-notice', notice: 'startup-rejected' },
      ]
    case 'run-setup-exchange':
      return [
        { kind: 'set-status', status: 'setup-required', reason: effect.reason },
        { kind: 'show-notice', notice: 'setup-required' },
        { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
      ]
    case 'run-startup-step':
      if (effect.step === 'resume-background-queues') {
        return [
          { kind: 'clear-repair-entries', reason: 'startup-progress' },
          { kind: 'set-status', status: 'starting', reason: effect.phase },
          { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
        ]
      }
      return [
        { kind: 'clear-repair-entries', reason: 'startup-progress' },
        { kind: 'set-status', status: 'starting', reason: effect.phase },
        { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
      ]
  }
}
