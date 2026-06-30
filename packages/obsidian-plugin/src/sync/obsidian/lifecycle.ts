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
  readonly ui: SyncRuntimeObsidianShellUiPort
}

/** Static options for the Obsidian shell lifecycle adapter. */
export interface SyncRuntimeObsidianShellLifecycleOptions {
  readonly maxLocalEffects?: number | undefined
  readonly maxStartupSteps?: number | undefined
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

/** Stateful adapter that Obsidian plugin lifecycle hooks can call without reimplementing driver wiring. */
export interface SyncRuntimeObsidianShellLifecycle {
  /**
   * Runs one serialized startup tick and applies its presentation to the UI port.
   *
   * @returns Driver and UI results for logging, tests, or follow-up scheduling.
   */
  runStartupTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult>

  /**
   * Reads the current lifecycle state without triggering I/O.
   *
   * @returns Driver state, last applied UI values, and whether a tick is currently running.
   */
  snapshot(): SyncRuntimeObsidianShellLifecycleSnapshot
}

/**
 * Creates a stateful lifecycle adapter around the Obsidian shell driver and UI presenter.
 *
 * @param input Runtime ports, optional execution limits, and optional restored driver state.
 * @returns A lifecycle object that serializes startup ticks and keeps driver state durable in memory.
 */
export function createSyncRuntimeObsidianShellLifecycle(
  input: SyncRuntimeObsidianShellLifecycleInput,
): SyncRuntimeObsidianShellLifecycle {
  let driverState = input.initialState ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  let lastUiApply: SyncRuntimeObsidianShellUiApplyResult | undefined
  let tickInFlight: Promise<SyncRuntimeObsidianShellLifecycleTickResult> | undefined

  async function runTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult> {
    const driver = await runSyncRuntimeObsidianShellDriverTransportTick({
      state: driverState,
      evidence: input.ports.evidence,
      executor: input.ports.executor,
      setupExchange: input.ports.setupExchange,
      startupStep: input.ports.startupStep,
      maxLocalEffects: input.options?.maxLocalEffects,
      maxStartupSteps: input.options?.maxStartupSteps,
    })
    driverState = driver.state
    const ui = applySyncRuntimeObsidianShellPresentation({
      presentation: driver.presentation,
      ui: input.ports.ui,
    })
    lastUiApply = ui
    return { driver, ui }
  }

  return {
    runStartupTick(): Promise<SyncRuntimeObsidianShellLifecycleTickResult> {
      tickInFlight ??= runTick().finally(() => {
        tickInFlight = undefined
      })
      return tickInFlight
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
