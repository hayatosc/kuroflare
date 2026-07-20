import {
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import {
  INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE,
  runSyncRuntimeObsidianShellDriverTransportTick,
  type SyncRuntimeObsidianShellDriverState,
  type SyncRuntimeObsidianShellDriverTickResult,
  type SyncRuntimeObsidianShellEvidencePort,
  type SyncRuntimeSideEffectPermission,
} from '../obsidian/shell'
import {
  applySyncRuntimeObsidianShellPresentation,
  type SyncRuntimeObsidianShellUiApplyResult,
  type SyncRuntimeObsidianShellUiPort,
} from '../obsidian/ui'

/** Runtime ports needed by the Obsidian plugin lifecycle to run startup ticks. */
export interface SyncRuntimeObsidianShellLifecyclePorts {
  readonly evidence: SyncRuntimeObsidianShellEvidencePort
  readonly executor: SyncRuntimeShellEffectExecutor
  readonly setupExchange: SyncRuntimeSetupExchangePort
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly resume: SyncRuntimeObsidianResumePort
  readonly ui: SyncRuntimeObsidianShellUiPort
}

/** Runtime hooks for foreground resume work that lives outside pure startup planning. */
export interface SyncRuntimeObsidianResumePort {
  /** Returns whether background resume is allowed now. */
  canResume(): boolean
  /** Runs synchronization after startup completes. */
  runForegroundResume(reason: string): Promise<void>
  /** Schedules the queue runner to process pending updates. */
  scheduleOutboxTick(reason: string): void
}

/** Input callbacks used to create the default Obsidian foreground resume port. */
export interface SyncRuntimeObsidianResumePortInput {
  readonly isDocumentHidden: () => boolean
  readonly isSyncBlocked: () => boolean
  readonly runForegroundResume: (reason: string) => Promise<void>
  readonly scheduleOutboxTick: (reason: string) => void
}

/** Static options for the Obsidian shell lifecycle adapter. */
export interface SyncRuntimeObsidianShellLifecycleOptions {
  readonly maxLocalEffects?: number | undefined
  readonly maxStartupSteps?: number | undefined
  /** Called once the tick's effects have run, with the resulting startup side-effect permission. */
  readonly onSideEffectPermission?:
    | ((permission: SyncRuntimeSideEffectPermission) => void)
    | undefined
}

/** Input for creating the stateful Obsidian shell lifecycle adapter. */
export interface SyncRuntimeObsidianShellLifecycleInput {
  readonly ports: SyncRuntimeObsidianShellLifecyclePorts
  readonly options?: SyncRuntimeObsidianShellLifecycleOptions | undefined
  readonly initialState?: SyncRuntimeObsidianShellDriverState | undefined
}

/** Snapshot of the state currently owned by the Obsidian shell lifecycle adapter. */
export interface SyncRuntimeObsidianShellLifecycleSnapshot {
  readonly driverState: SyncRuntimeObsidianShellDriverState
  readonly lastUiApply: SyncRuntimeObsidianShellUiApplyResult | undefined
  readonly tickInFlight: boolean
}

/** Result of one serialized Obsidian shell lifecycle startup tick. */
export interface SyncRuntimeObsidianShellLifecycleTickResult {
  readonly driver: SyncRuntimeObsidianShellDriverTickResult
  readonly ui: SyncRuntimeObsidianShellUiApplyResult
}

/** Result of one serialized Obsidian foreground resume tick. */
export type SyncRuntimeObsidianShellLifecycleResumeResult =
  | {
      readonly action: 'skipped'
    }
  | {
      readonly action: 'ran'
      readonly startup: SyncRuntimeObsidianShellLifecycleTickResult
    }

/** Stateful adapter that Obsidian plugin lifecycle hooks can call without reimplementing driver wiring. */
export interface SyncRuntimeObsidianShellLifecycle {
  /**
   * Runs one serialized startup tick and applies its presentation to the UI port.
   *
   * @returns Driver and UI results for logging, tests, or follow-up scheduling.
   */
  runStartupTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult>

  /** Requests a fresh evidence read and startup plan on the next lifecycle tick. */
  requestReplan(): void

  /**
   * Runs the production resume sequence: startup tick, foreground sync, then outbox tick scheduling.
   *
   * @param reason Caller-provided lifecycle reason used for logging and worker scheduling.
   * @returns Whether the resume sequence ran or was skipped by the resume gate.
   */
  runResumeTick(reason: string): Promise<SyncRuntimeObsidianShellLifecycleResumeResult>

  /**
   * Reads the current lifecycle state without triggering I/O.
   *
   * @returns Driver state, last applied UI values, and whether a tick is currently running.
   */
  snapshot(): SyncRuntimeObsidianShellLifecycleSnapshot
}

/**
 * Creates an adapter to manage startup tasks and UI updates.
 */
export function createSyncRuntimeObsidianShellLifecycle(
  input: SyncRuntimeObsidianShellLifecycleInput,
): SyncRuntimeObsidianShellLifecycle {
  let driverState = input.initialState ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  let lastUiApply: SyncRuntimeObsidianShellUiApplyResult | undefined
  let tickInFlight: Promise<SyncRuntimeObsidianShellLifecycleTickResult> | undefined
  let replanRequested = false

  function resetForReplan(): void {
    driverState = input.initialState ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
    lastUiApply = undefined
  }

  async function runTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult> {
    const driver = await runSyncRuntimeObsidianShellDriverTransportTick({
      state: driverState,
      evidence: input.ports.evidence,
      executor: input.ports.executor,
      setupExchange: input.ports.setupExchange,
      startupStep: input.ports.startupStep,
      maxLocalEffects: input.options?.maxLocalEffects,
      maxStartupSteps: input.options?.maxStartupSteps,
      onSideEffectPermission: input.options?.onSideEffectPermission,
    })
    driverState = driver.state
    const ui = applySyncRuntimeObsidianShellPresentation({
      presentation: driver.presentation,
      ui: input.ports.ui,
    })
    lastUiApply = ui
    return { driver, ui }
  }

  function runStartupTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult> {
    if (tickInFlight === undefined && replanRequested) {
      replanRequested = false
      resetForReplan()
    }
    tickInFlight ??= runTick().finally(() => {
      tickInFlight = undefined
      if (replanRequested) {
        replanRequested = false
        resetForReplan()
        void runStartupTick()
      }
    })
    return tickInFlight
  }

  function requestReplan(): void {
    replanRequested = true
    if (tickInFlight === undefined) {
      void runStartupTick()
    }
  }

  return {
    runStartupTick,
    requestReplan,
    async runResumeTick(reason): Promise<SyncRuntimeObsidianShellLifecycleResumeResult> {
      if (!input.ports.resume.canResume()) {
        return { action: 'skipped' }
      }
      const startup = await runStartupTick()
      if (startupSyncIsBlocked(startup)) {
        return { action: 'skipped' }
      }
      await input.ports.resume.runForegroundResume(reason)
      input.ports.resume.scheduleOutboxTick(`lifecycle:${reason}`)
      return { action: 'ran', startup }
    },
    snapshot(): SyncRuntimeObsidianShellLifecycleSnapshot {
      return {
        driverState,
        lastUiApply,
        tickInFlight: tickInFlight !== undefined,
      }
    },
  }
}

function startupSyncIsBlocked(startup: SyncRuntimeObsidianShellLifecycleTickResult): boolean {
  const shell = startup.driver.state.shell
  return (
    shell.lastFailedEffect !== undefined ||
    shell.status === 'auth-blocked' ||
    shell.status === 'degraded' ||
    shell.status === 'local-store-blocked' ||
    shell.status === 'rejected'
  )
}

/**
 * Creates a port to handle app resume gates based on visibility and sync state.
 */
export function createSyncRuntimeObsidianResumePort(
  input: SyncRuntimeObsidianResumePortInput,
): SyncRuntimeObsidianResumePort {
  return {
    canResume() {
      return !input.isDocumentHidden() && !input.isSyncBlocked()
    },
    async runForegroundResume(reason) {
      await input.runForegroundResume(reason)
    },
    scheduleOutboxTick(reason) {
      input.scheduleOutboxTick(reason)
    },
  }
}
