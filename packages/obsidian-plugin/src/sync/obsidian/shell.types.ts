import type {
  SyncRuntimeDeferredStartupEffect,
  SyncRuntimeSetupExchangePort,
  SyncRuntimeShellEffectExecutor,
  SyncRuntimeShellState,
  SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import type { SyncRuntimeSetupExchangeShellReplan } from '../engine/replan'
import type {
  SyncRuntimeLocalStateEvidencePlan,
  SyncRuntimeStartupFromSchemaEvidenceInput,
  SyncRuntimeStartupPlan,
} from '../engine/startup'
import type {
  SyncRuntimeObsidianPresentationPlan,
  SyncRuntimeObsidianPresentationSnapshot,
} from '../obsidian/presentation'

/** Result of reading startup evidence for the Obsidian shell driver. */
export type SyncRuntimeObsidianShellEvidenceReadResult =
  | {
      readonly ok: true
      readonly startupInput: SyncRuntimeStartupFromSchemaEvidenceInput
    }
  | {
      readonly ok: false
      readonly localState: Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>
    }

/** Evidence reader used by the Obsidian shell driver before startup planning. */
export interface SyncRuntimeObsidianShellEvidencePort {
  /**
   * Reads current startup evidence from Obsidian settings, SecretStorage, IndexedDB, and the vault.
   *
   * @returns Guarded startup input for the runtime planner, or a local evidence failure to surface.
   */
  readStartupInput(): Promise<SyncRuntimeObsidianShellEvidenceReadResult>
}

/** Durable state owned by the Obsidian shell driver between startup ticks. */
export interface SyncRuntimeObsidianShellDriverState {
  readonly shell: SyncRuntimeShellState
  readonly presentation: SyncRuntimeObsidianPresentationSnapshot
  readonly startupPlan?: SyncRuntimeStartupPlan | undefined
  readonly startupInput?: SyncRuntimeStartupFromSchemaEvidenceInput | undefined
}

/** Input for running one no-network Obsidian startup driver tick. */
export interface SyncRuntimeObsidianShellDriverTickInput {
  readonly state?: SyncRuntimeObsidianShellDriverState | undefined
  readonly evidence: SyncRuntimeObsidianShellEvidencePort
  readonly executor: SyncRuntimeShellEffectExecutor
  readonly maxLocalEffects?: number | undefined
}

/** Input for running one Obsidian startup driver tick that may execute setup exchange. */
export interface SyncRuntimeObsidianShellDriverSetupExchangeTickInput extends SyncRuntimeObsidianShellDriverTickInput {
  readonly setupExchange: SyncRuntimeSetupExchangePort
}

/** Input for running one Obsidian startup driver tick that may execute startup steps. */
export interface SyncRuntimeObsidianShellDriverStartupStepTickInput extends SyncRuntimeObsidianShellDriverTickInput {
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly maxStartupSteps?: number | undefined
}

/** Input for running one Obsidian startup driver tick with setup and startup transports wired. */
export interface SyncRuntimeObsidianShellDriverTransportTickInput extends SyncRuntimeObsidianShellDriverSetupExchangeTickInput {
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly maxStartupSteps?: number | undefined
}

/** Result of one no-network Obsidian startup driver tick. */
export interface SyncRuntimeObsidianShellDriverTickResult {
  readonly state: SyncRuntimeObsidianShellDriverState
  readonly startupPlan: SyncRuntimeStartupPlan | undefined
  readonly presentation: SyncRuntimeObsidianPresentationPlan
  readonly deferredEffect: SyncRuntimeDeferredStartupEffect | undefined
  readonly executedLocalEffectCount: number
  readonly executedStartupStepCount: number
  readonly setupExchangeReplan?: SyncRuntimeSetupExchangeShellReplan | undefined
  readonly evidenceFailure:
    | Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>
    | undefined
}
