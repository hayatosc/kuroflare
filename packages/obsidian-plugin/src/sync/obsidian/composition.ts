import {
  createSyncRuntimeStartupEffectExecutor,
  type SyncRuntimeLocalStoreEffectPort,
  type SyncRuntimeLocalStoreRebuildEffectPort,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import {
  createSyncRuntimeObsidianShellEvidencePort,
  createSyncRuntimeObsidianStartupEvidenceReader,
  type SyncRuntimeObsidianLocalStartupEvidenceReaderPort,
  type SyncRuntimeObsidianStartupSettingsEvidenceReaderPort,
} from '../obsidian/evidence'
import {
  createSyncRuntimeObsidianShellLifecycle,
  type SyncRuntimeObsidianResumePort,
  type SyncRuntimeObsidianShellLifecycle,
} from '../obsidian/lifecycle'
import { type SyncRuntimeObsidianShellUiPort } from '../obsidian/ui'

/** Input ports for composing the Obsidian sync runtime lifecycle. */
export interface SyncRuntimeObsidianCompositionInput {
  readonly settings: SyncRuntimeObsidianStartupSettingsEvidenceReaderPort
  readonly local: SyncRuntimeObsidianLocalStartupEvidenceReaderPort
  readonly ui: SyncRuntimeObsidianShellUiPort
  readonly setupExchange: SyncRuntimeSetupExchangePort
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly localStore: SyncRuntimeLocalStoreEffectPort
  readonly localStoreRebuild: SyncRuntimeLocalStoreRebuildEffectPort
  readonly resume: SyncRuntimeObsidianResumePort
}

/** Runtime lifecycle plus the concrete ports used by the production composition root. */
export interface SyncRuntimeObsidianComposition {
  readonly lifecycle: SyncRuntimeObsidianShellLifecycle
  readonly setupExchange: SyncRuntimeSetupExchangePort
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly localStore: SyncRuntimeLocalStoreEffectPort
  readonly localStoreRebuild: SyncRuntimeLocalStoreRebuildEffectPort
}

/**
 * Composes startup evidence, shell UI, and runtime effect ports into the Obsidian sync lifecycle.
 *
 * @param input Concrete evidence/UI ports plus optional side-effect ports already wired by the plugin.
 * @returns Lifecycle and the ports used to construct it.
 */
export function createSyncRuntimeObsidianComposition(
  input: SyncRuntimeObsidianCompositionInput,
): SyncRuntimeObsidianComposition {
  const evidence = createSyncRuntimeObsidianShellEvidencePort(
    createSyncRuntimeObsidianStartupEvidenceReader({
      settings: input.settings,
      local: input.local,
    }),
  )
  const executor = createSyncRuntimeStartupEffectExecutor({
    localStore: input.localStore,
    setupExchange: input.setupExchange,
    startupStep: input.startupStep,
    localStoreRebuild: input.localStoreRebuild,
  })

  return {
    lifecycle: createSyncRuntimeObsidianShellLifecycle({
      ports: {
        evidence,
        executor,
        setupExchange: input.setupExchange,
        startupStep: input.startupStep,
        resume: input.resume,
        ui: input.ui,
      },
    }),
    setupExchange: input.setupExchange,
    startupStep: input.startupStep,
    localStore: input.localStore,
    localStoreRebuild: input.localStoreRebuild,
  }
}
