import { type ClientStartupIntent } from '@kuroflare/core'
import { type SetupBootstrapMode, type SetupExchangeResponse } from '@kuroflare/core'

import { type LocalStoreIndexedDbSchemaEvidencePlan } from './local-store-indexeddb'
import {
  type SyncRuntimeObsidianShellEvidencePort,
  type SyncRuntimeObsidianShellEvidenceReadResult,
} from './obsidian-shell-driver'
import {
  planSyncRuntimeObsidianStartupSettings,
  type SyncRuntimeObsidianStartupSettingsInput,
  type SyncRuntimeObsidianStartupSettingsPlan,
} from './obsidian-startup-settings'
import { type LocalSetupMetadataSnapshotDecision } from './setup-persist'
import {
  planSyncRuntimeLocalStateFromEvidence,
  type SyncRuntimeLocalStateEvidencePlan,
  type SyncRuntimeStartupFromSchemaEvidenceInput,
} from './startup-runtime'

/** Raw startup evidence collected by the Obsidian shell before sync planning. */
export interface SyncRuntimeObsidianStartupEvidenceInput {
  readonly intent: ClientStartupIntent
  readonly metadataSnapshot?: LocalSetupMetadataSnapshotDecision | undefined
  readonly localStoreEvidence?: LocalStoreIndexedDbSchemaEvidencePlan | undefined
  readonly hasMetaYDoc: boolean
  readonly hasLocalVaultFiles: boolean
  readonly supportedSchemaVersion?: number | undefined
  readonly setupResponse?: SetupExchangeResponse | undefined
  readonly expectedBootstrapMode?: SetupBootstrapMode | undefined
}

/** Result of converting raw Obsidian startup evidence into runtime startup input. */
export type SyncRuntimeObsidianStartupEvidencePlan =
  | {
      readonly ok: true
      readonly startupInput: SyncRuntimeStartupFromSchemaEvidenceInput
    }
  | {
      readonly ok: false
      readonly localState: Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>
    }

/** Raw evidence reader used by the Obsidian plugin shell. */
export interface SyncRuntimeObsidianStartupEvidenceReaderPort {
  /**
   * Reads raw startup evidence from Obsidian settings, IndexedDB, SecretStorage metadata, and the vault.
   *
   * @returns Raw evidence before local-state validation.
   */
  readEvidence(): Promise<SyncRuntimeObsidianStartupEvidenceInput>
}

/** Settings reader used before composing raw Obsidian startup evidence. */
export interface SyncRuntimeObsidianStartupSettingsEvidenceReaderPort {
  /**
   * Reads startup settings from Obsidian plugin data or setup UI fields.
   *
   * @returns Raw startup settings.
   */
  readSettings(): Promise<SyncRuntimeObsidianStartupSettingsInput>
}

/** Local storage and vault evidence read before composing raw Obsidian startup evidence. */
export interface SyncRuntimeObsidianLocalStartupEvidenceInput {
  readonly metadataSnapshot?: LocalSetupMetadataSnapshotDecision | undefined
  readonly localStoreEvidence?: LocalStoreIndexedDbSchemaEvidencePlan | undefined
  readonly hasMetaYDoc: boolean
  readonly hasLocalVaultFiles: boolean
  readonly supportedSchemaVersion?: number | undefined
  readonly setupResponse?: SetupExchangeResponse | undefined
}

/** Local evidence reader used before composing raw Obsidian startup evidence. */
export interface SyncRuntimeObsidianLocalStartupEvidenceReaderPort {
  /**
   * Reads metadata, local-store schema, local YDoc, and vault file evidence.
   *
   * @returns Local startup evidence that is independent from setup UI/settings.
   */
  readLocalEvidence(): Promise<SyncRuntimeObsidianLocalStartupEvidenceInput>
}

/** Input for creating a raw startup evidence reader from settings and local evidence ports. */
export interface SyncRuntimeObsidianStartupEvidenceReaderInput {
  readonly settings: SyncRuntimeObsidianStartupSettingsEvidenceReaderPort
  readonly local: SyncRuntimeObsidianLocalStartupEvidenceReaderPort
}

/**
 * Converts raw Obsidian startup evidence into the guarded input expected by the runtime planner.
 *
 * @param input Intent, metadata snapshot, schema evidence, vault file evidence, and optional setup response.
 * @returns Startup input when local evidence is trustworthy, or the evidence failure that must stop startup.
 */
export function planSyncRuntimeObsidianStartupInputFromEvidence(
  input: SyncRuntimeObsidianStartupEvidenceInput,
): SyncRuntimeObsidianStartupEvidencePlan {
  const localState = planSyncRuntimeLocalStateFromEvidence({
    metadataSnapshot: input.metadataSnapshot,
    localStoreEvidence: input.localStoreEvidence,
    hasMetaYDoc: input.hasMetaYDoc,
    hasLocalVaultFiles: input.hasLocalVaultFiles,
    supportedSchemaVersion: input.supportedSchemaVersion,
  })
  if (!localState.ok) {
    return { ok: false, localState }
  }

  return {
    ok: true,
    startupInput: {
      intent: input.intent,
      local: localState.local,
      localStoreEvidence: input.localStoreEvidence,
      setupResponse: input.setupResponse,
      expectedBootstrapMode: input.expectedBootstrapMode,
    },
  }
}

/**
 * Creates the driver evidence port from a raw Obsidian evidence reader.
 *
 * @param reader Port that gathers raw Obsidian startup evidence.
 * @returns Driver-compatible evidence port that validates local state before planning startup.
 */
export function createSyncRuntimeObsidianShellEvidencePort(
  reader: SyncRuntimeObsidianStartupEvidenceReaderPort,
): SyncRuntimeObsidianShellEvidencePort {
  return {
    async readStartupInput(): Promise<SyncRuntimeObsidianShellEvidenceReadResult> {
      const plan = planSyncRuntimeObsidianStartupInputFromEvidence(await reader.readEvidence())
      if (!plan.ok) {
        return { ok: false, localState: plan.localState }
      }
      return { ok: true, startupInput: plan.startupInput }
    },
  }
}

/**
 * Creates a raw startup evidence reader from settings and local evidence ports.
 *
 * @param input Settings reader and local storage/vault evidence reader.
 * @returns Raw evidence reader whose intent comes only from startup settings.
 */
export function createSyncRuntimeObsidianStartupEvidenceReader(
  input: SyncRuntimeObsidianStartupEvidenceReaderInput,
): SyncRuntimeObsidianStartupEvidenceReaderPort {
  return {
    async readEvidence(): Promise<SyncRuntimeObsidianStartupEvidenceInput> {
      const [settings, local] = await Promise.all([
        input.settings.readSettings(),
        input.local.readLocalEvidence(),
      ])
      const settingsPlan = planSyncRuntimeObsidianStartupSettings(settings)
      return composeRawStartupEvidence(settingsPlan, local)
    },
  }
}

function composeRawStartupEvidence(
  settingsPlan: SyncRuntimeObsidianStartupSettingsPlan,
  local: SyncRuntimeObsidianLocalStartupEvidenceInput,
): SyncRuntimeObsidianStartupEvidenceInput {
  return {
    intent: settingsPlan.startup.intent,
    expectedBootstrapMode: settingsPlan.startup.expectedBootstrapMode,
    metadataSnapshot: local.metadataSnapshot,
    localStoreEvidence: local.localStoreEvidence,
    hasMetaYDoc: local.hasMetaYDoc,
    hasLocalVaultFiles: local.hasLocalVaultFiles,
    supportedSchemaVersion: local.supportedSchemaVersion,
    setupResponse: local.setupResponse,
  }
}
