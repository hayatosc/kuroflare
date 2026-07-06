import { type ClientStartupIntent } from '@kuroflare/core'
import { type SetupBootstrapMode } from '@kuroflare/core'

import {
  buildSetupExchangeRequest,
  type SetupExchangeStartupEffect,
  type SetupExchangeRequestBuildPlan,
  type SetupExchangeRuntimeEvidence,
} from '../setup-exchange-http'

/** Raw startup settings loaded from Obsidian plugin data or setup UI fields. */
export interface SyncRuntimeObsidianStartupSettingsInput {
  readonly endpoint?: string | undefined
  readonly setupVaultId?: string | undefined
  readonly setupToken?: string | undefined
  readonly requestedDeviceName?: string | undefined
  readonly existingDeviceId?: string | undefined
  readonly setupBootstrapMode?: string | undefined
}

/** Startup intent evidence derived from Obsidian settings. */
export interface SyncRuntimeObsidianStartupIntentSettingsPlan {
  readonly intent: ClientStartupIntent
  readonly expectedBootstrapMode?: SetupBootstrapMode | undefined
}

/** Result of deriving setup exchange evidence from Obsidian settings. */
export type SyncRuntimeObsidianSetupExchangeSettingsPlan =
  | {
      readonly ok: true
      readonly evidence: SetupExchangeRuntimeEvidence
    }
  | {
      readonly ok: false
      readonly reason:
        | 'setup-settings-not-present'
        | 'invalid-setup-bootstrap-mode'
        | 'missing-setup-endpoint'
        | 'invalid-setup-request'
      readonly requestReason?: Extract<
        SetupExchangeRequestBuildPlan,
        { readonly ok: false }
      >['reason']
    }

/** Complete startup settings plan consumed by evidence and setup-exchange ports. */
export interface SyncRuntimeObsidianStartupSettingsPlan {
  readonly startup: SyncRuntimeObsidianStartupIntentSettingsPlan
  readonly setupExchange: SyncRuntimeObsidianSetupExchangeSettingsPlan
}

/** Reader used by setup exchange runtime ports to access latest Obsidian settings. */
export interface SyncRuntimeObsidianStartupSettingsReaderPort {
  /**
   * Reads current startup settings from Obsidian data or setup UI fields.
   *
   * @param effect Setup exchange startup effect that triggered the read.
   * @returns Raw startup settings.
   */
  readSettings(effect: SetupExchangeStartupEffect): SyncRuntimeObsidianStartupSettingsInput
}

/** Setup exchange evidence reader derived from Obsidian startup settings. */
export interface SyncRuntimeObsidianSetupExchangeEvidenceReader {
  /**
   * Reads guarded setup exchange evidence for the current startup effect.
   *
   * @param effect Setup exchange startup effect.
   * @returns Endpoint and setup request evidence.
   * @throws When setup settings are absent or invalid, without including setup-token material.
   */
  readEvidence(effect: SetupExchangeStartupEffect): SetupExchangeRuntimeEvidence
}

/**
 * Derives startup intent and setup exchange evidence from Obsidian plugin settings.
 *
 * @param input Raw settings loaded from Obsidian data or setup UI fields.
 * @returns Startup intent plus setup exchange evidence or a non-secret failure reason.
 */
export function planSyncRuntimeObsidianStartupSettings(
  input: SyncRuntimeObsidianStartupSettingsInput,
): SyncRuntimeObsidianStartupSettingsPlan {
  const setupMode = setupBootstrapMode(input.setupBootstrapMode)
  if (setupMode === 'invalid') {
    return {
      startup: { intent: 'reconnect' },
      setupExchange: { ok: false, reason: 'invalid-setup-bootstrap-mode' },
    }
  }
  if (setupMode === undefined && !hasSetupExchangeEvidence(input)) {
    return {
      startup: { intent: 'reconnect' },
      setupExchange: { ok: false, reason: 'setup-settings-not-present' },
    }
  }

  const expectedBootstrapMode = setupMode ?? 'join-existing'
  const endpoint = input.endpoint?.trim() ?? ''
  if (endpoint.length === 0) {
    return {
      startup: startupIntentForBootstrapMode(expectedBootstrapMode),
      setupExchange: { ok: false, reason: 'missing-setup-endpoint' },
    }
  }

  const request = {
    vaultId: input.setupVaultId ?? '',
    setupToken: input.setupToken ?? '',
    requestedDeviceName: input.requestedDeviceName ?? '',
    existingDeviceId: input.existingDeviceId,
  }
  const requestPlan = buildSetupExchangeRequest(request)
  if (!requestPlan.ok) {
    return {
      startup: startupIntentForBootstrapMode(expectedBootstrapMode),
      setupExchange: {
        ok: false,
        reason: 'invalid-setup-request',
        requestReason: requestPlan.reason,
      },
    }
  }

  return {
    startup: startupIntentForBootstrapMode(expectedBootstrapMode),
    setupExchange: {
      ok: true,
      evidence: {
        endpoint,
        request,
      },
    },
  }
}

/**
 * Creates a setup exchange evidence reader backed by Obsidian startup settings.
 *
 * @param reader Port that reads current raw startup settings.
 * @returns Evidence reader suitable for the HTTP setup exchange port.
 */
export function createSyncRuntimeObsidianSetupExchangeEvidenceReader(
  reader: SyncRuntimeObsidianStartupSettingsReaderPort,
): SyncRuntimeObsidianSetupExchangeEvidenceReader {
  return {
    readEvidence(effect): SetupExchangeRuntimeEvidence {
      const plan = planSyncRuntimeObsidianStartupSettings(reader.readSettings(effect))
      if (!plan.setupExchange.ok) {
        const suffix =
          plan.setupExchange.reason === 'invalid-setup-request' &&
          plan.setupExchange.requestReason !== undefined
            ? `${plan.setupExchange.reason}:${plan.setupExchange.requestReason}`
            : plan.setupExchange.reason
        throw new Error(`setup-exchange-settings:${suffix}`)
      }
      return plan.setupExchange.evidence
    },
  }
}

function startupIntentForBootstrapMode(
  bootstrapMode: SetupBootstrapMode,
): SyncRuntimeObsidianStartupIntentSettingsPlan {
  return bootstrapMode === 'new-vault'
    ? { intent: 'setup-new-vault', expectedBootstrapMode: 'new-vault' }
    : { intent: 'join-existing-vault', expectedBootstrapMode: 'join-existing' }
}

function setupBootstrapMode(value: string | undefined): SetupBootstrapMode | 'invalid' | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined
  }
  const normalized = value.trim()
  if (normalized === 'new-vault' || normalized === 'join-existing') {
    return normalized
  }
  return 'invalid'
}

function hasSetupExchangeEvidence(input: SyncRuntimeObsidianStartupSettingsInput): boolean {
  return (
    hasValue(input.endpoint) ||
    hasValue(input.setupVaultId) ||
    hasValue(input.setupToken) ||
    hasValue(input.requestedDeviceName) ||
    hasValue(input.existingDeviceId)
  )
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

/** Settings keys that historically stored secret token material directly in plugin data. */
const LEGACY_SETTINGS_SECRET_KEYS = ['accessToken', 'refreshToken', 'setupResponse'] as const

/** Result of removing legacy plaintext token fields from loaded Obsidian plugin settings. */
export interface SyncRuntimeObsidianLegacySettingsSecretCleanupPlan {
  readonly settings: Record<string, unknown>
  readonly removedLegacySecretKeys: readonly string[]
}

/**
 * Removes legacy plaintext token fields from settings loaded from Obsidian plugin data.
 *
 * Token material now lives in SecretStorage and IndexedDB metadata; any of these keys
 * surviving in `data.json` from a pre-migration install must be dropped before the
 * settings object is ever written back to disk.
 *
 * @param loaded Raw settings object as read from `Plugin.loadData()`.
 * @returns Sanitized settings plus the legacy keys that were removed, if any.
 */
export function planSyncRuntimeObsidianLegacySettingsSecretCleanup(
  loaded: Record<string, unknown>,
): SyncRuntimeObsidianLegacySettingsSecretCleanupPlan {
  const removedLegacySecretKeys: string[] = []
  const settings = { ...loaded }
  for (const key of LEGACY_SETTINGS_SECRET_KEYS) {
    if (key in settings) {
      delete settings[key]
      removedLegacySecretKeys.push(key)
    }
  }
  return { settings, removedLegacySecretKeys }
}
