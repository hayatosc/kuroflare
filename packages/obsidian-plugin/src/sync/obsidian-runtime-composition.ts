import {
  createSyncRuntimeObsidianShellLifecycle,
  type SyncRuntimeObsidianShellLifecycle,
} from './obsidian-shell-lifecycle.js'
import { type SyncRuntimeObsidianShellUiPort } from './obsidian-shell-ui.js'
import {
  createSyncRuntimeObsidianShellEvidencePort,
  createSyncRuntimeObsidianStartupEvidenceReader,
  type SyncRuntimeObsidianLocalStartupEvidenceReaderPort,
  type SyncRuntimeObsidianStartupSettingsEvidenceReaderPort,
} from './obsidian-startup-evidence.js'
import {
  createSyncRuntimeStartupEffectExecutor,
  type SyncRuntimeLocalStoreEffectPort,
  type SyncRuntimeLocalStoreRebuildEffectPort,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeStartupStepEffectPort,
} from './startup-actuation.js'

/** Input ports for composing the Obsidian sync runtime lifecycle. */
export interface SyncRuntimeObsidianCompositionInput {
  readonly settings: SyncRuntimeObsidianStartupSettingsEvidenceReaderPort
  readonly local: SyncRuntimeObsidianLocalStartupEvidenceReaderPort
  readonly ui: SyncRuntimeObsidianShellUiPort
  readonly setupExchange?: SyncRuntimeSetupExchangePort | undefined
  readonly startupStep?: SyncRuntimeStartupStepEffectPort | undefined
  readonly localStore?: SyncRuntimeLocalStoreEffectPort | undefined
  readonly localStoreRebuild?: SyncRuntimeLocalStoreRebuildEffectPort | undefined
}

/** Runtime lifecycle plus the default fail-fast ports used for still-unwired families. */
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
  const setupExchange = input.setupExchange ?? createUnwiredSetupExchangePort()
  const startupStep = input.startupStep ?? createUnwiredStartupStepPort()
  const localStore = input.localStore ?? createUnwiredLocalStoreEffectPort()
  const localStoreRebuild = input.localStoreRebuild ?? createUnwiredLocalStoreRebuildEffectPort()
  const evidence = createSyncRuntimeObsidianShellEvidencePort(
    createSyncRuntimeObsidianStartupEvidenceReader({
      settings: input.settings,
      local: input.local,
    }),
  )
  const executor = createSyncRuntimeStartupEffectExecutor({
    localStore,
    setupExchange,
    startupStep,
    localStoreRebuild,
  })

  return {
    lifecycle: createSyncRuntimeObsidianShellLifecycle({
      ports: {
        evidence,
        executor,
        setupExchange,
        startupStep,
        ui: input.ui,
      },
    }),
    setupExchange,
    startupStep,
    localStore,
    localStoreRebuild,
  }
}

function createUnwiredSetupExchangePort(): SyncRuntimeSetupExchangePort {
  return {
    async run() {
      throw new Error('setup-exchange-port-unwired')
    },
    snapshot() {
      return { completed: [] }
    },
  }
}

function createUnwiredStartupStepPort(): SyncRuntimeStartupStepEffectPort {
  return {
    async run(effect) {
      throw new Error(`startup-step-port-unwired:${effect.step}`)
    },
  }
}

function createUnwiredLocalStoreEffectPort(): SyncRuntimeLocalStoreEffectPort {
  return {
    async runOpenEffect(effect) {
      throw new Error(`local-store-effect-port-unwired:${effect.kind}`)
    },
  }
}

function createUnwiredLocalStoreRebuildEffectPort(): SyncRuntimeLocalStoreRebuildEffectPort {
  return {
    async rerunStartup(effect) {
      throw new Error(`local-store-rebuild-port-unwired:${effect.dbName}`)
    },
  }
}
