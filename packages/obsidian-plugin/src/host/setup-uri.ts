import {
  parseObsidianSetupUriParams,
  type ParsedObsidianSetupUriParams,
  type SetupBootstrapMode,
} from '@kuroflare/core'
import { Modal, Notice, type ObsidianProtocolData } from 'obsidian'

import {
  isSyncRuntimeObsidianShellBlocked,
  type SyncRuntimeObsidianShellLifecycle,
  type SyncRuntimeObsidianShellLifecycleSnapshot,
} from '../sync/obsidian/lifecycle'
import type { KuroflareSettings } from '../types'
import { handleLifecycleResume } from './editor'
import type KuroflareSpikePlugin from './plugin'

/** Obsidian protocol action registered for `obsidian://kuroflare-setup?...` links. */
export const KUROFLARE_SETUP_PROTOCOL_ACTION = 'kuroflare-setup'

const setupUriApplicationInFlight = new WeakMap<KuroflareSpikePlugin, Promise<void>>()
const SETUP_URI_APPLICATION_FAILED = 'setup-uri-application-failed'

/** Resolves the bootstrap mode used by a setup URI before any settings are written. */
export function resolveSetupUriBootstrapMode(
  parsed: Pick<ParsedObsidianSetupUriParams, 'bootstrapMode'>,
  currentBootstrapMode: string | undefined,
): SetupBootstrapMode {
  if (parsed.bootstrapMode !== undefined) return parsed.bootstrapMode
  return currentBootstrapMode === 'join-existing' || currentBootstrapMode === 'new-vault'
    ? currentBootstrapMode
    : 'new-vault'
}

class SetupUriConfirmModal extends Modal {
  constructor(
    plugin: KuroflareSpikePlugin,
    private readonly parsed: ParsedObsidianSetupUriParams,
    private readonly bootstrapMode: SetupBootstrapMode,
    private readonly onConfirm: () => void,
  ) {
    super(plugin.app)
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h2', { text: 'Connect this vault to Kuroflare?' })
    contentEl.createEl('p', { text: `Endpoint: ${this.parsed.endpoint}` })
    contentEl.createEl('p', { text: `Vault ID: ${this.parsed.vaultId}` })
    contentEl.createEl('p', {
      text: `Bootstrap mode: ${this.bootstrapMode}`,
    })
    const buttons = contentEl.createDiv()
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
      this.close()
    })
    const confirmButton = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' })
    confirmButton.addEventListener('click', () => {
      this.close()
      this.onConfirm()
    })
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

async function applyConfirmedSetupUri(
  plugin: KuroflareSpikePlugin,
  parsed: ParsedObsidianSetupUriParams,
  bootstrapMode: SetupBootstrapMode,
  onApplied?: () => void,
): Promise<void> {
  const runtime = plugin.syncRuntime
  if (runtime === null || runtime === undefined) {
    throw new Error(SETUP_URI_APPLICATION_FAILED)
  }
  const patch: Partial<KuroflareSettings> = {
    endpoint: parsed.endpoint,
    setupVaultId: parsed.vaultId,
    setupToken: parsed.setupToken,
    setupBootstrapMode: bootstrapMode,
  }
  await plugin.updateSettings(patch)
  runtime.lifecycle.requestReplan()
  const resumeResult = await handleLifecycleResume(plugin, 'setup-uri')
  const lifecycleSnapshot = await waitForSetupLifecycleCompletion(runtime.lifecycle)
  const startupBlocked =
    (resumeResult?.action === 'ran' &&
      isSyncRuntimeObsidianShellBlocked(resumeResult.startup.driver.state.shell)) ||
    isSyncRuntimeObsidianShellBlocked(lifecycleSnapshot.driverState.shell)
  if (startupBlocked) {
    if (lifecycleSnapshot.driverState.startupPlan?.sync.clientPlan.action === 'reject') {
      plugin.pendingSetupResponse = null
    }
    throw new Error(SETUP_URI_APPLICATION_FAILED)
  }
  new Notice('Kuroflare setup: URI applied')
  onApplied?.()
}

async function waitForSetupLifecycleCompletion(
  lifecycle: SyncRuntimeObsidianShellLifecycle,
): Promise<SyncRuntimeObsidianShellLifecycleSnapshot> {
  while (lifecycle?.snapshot().tickInFlight === true) {
    await lifecycle.runStartupTick()
  }
  return lifecycle.snapshot()
}

/**
 * Shows confirmation before applying setup fields and resuming synchronization.
 *
 * @param plugin Host plugin instance.
 * @param parsed Validated setup URI fields; the setup token is never rendered or logged.
 * @param onApplied Optional callback invoked after settings are written.
 */
export function confirmAndApplySetupUri(
  plugin: KuroflareSpikePlugin,
  parsed: ParsedObsidianSetupUriParams,
  onApplied?: () => void,
): void {
  if (rejectSetupUriApplicationIfBlocked(plugin)) return
  const bootstrapMode = resolveSetupUriBootstrapMode(
    parsed,
    plugin.kuroflareSettings?.setupBootstrapMode,
  )
  new SetupUriConfirmModal(plugin, parsed, bootstrapMode, () => {
    if (rejectSetupUriApplicationIfBlocked(plugin)) return
    const operation = applyConfirmedSetupUri(plugin, parsed, bootstrapMode, onApplied)
    setupUriApplicationInFlight.set(plugin, operation)
    void operation.then(
      () => {
        if (setupUriApplicationInFlight.get(plugin) === operation) {
          setupUriApplicationInFlight.delete(plugin)
        }
      },
      () => {
        new Notice('Kuroflare setup: URI application failed')
        if (setupUriApplicationInFlight.get(plugin) === operation) {
          setupUriApplicationInFlight.delete(plugin)
        }
      },
    )
  }).open()
}

function rejectSetupUriApplicationIfBlocked(plugin: KuroflareSpikePlugin): boolean {
  if (plugin.trustedSetupMetadata !== null) {
    new Notice(
      'Kuroflare setup: this device already has registration metadata; URI was not applied',
    )
    return true
  }
  if (plugin.syncRuntime === null || plugin.syncRuntime === undefined) {
    new Notice('Kuroflare setup: sync runtime is unavailable; URI was not applied')
    return true
  }
  const pendingSetupResponse = plugin.pendingSetupResponse
  const setupExchangeBusy =
    (pendingSetupResponse !== null && pendingSetupResponse !== undefined) ||
    (plugin.settingsWritePromise !== null && plugin.settingsWritePromise !== undefined) ||
    plugin.syncRuntime?.lifecycle.snapshot().tickInFlight === true
  if (setupUriApplicationInFlight.has(plugin) || setupExchangeBusy) {
    new Notice('Kuroflare setup: setup is already in progress; URI was not applied')
    return true
  }
  return false
}

/** Handles `obsidian://kuroflare-setup?...` links from Obsidian's protocol router. */
export function handleKuroflareSetupUriProtocol(
  plugin: KuroflareSpikePlugin,
  params: ObsidianProtocolData,
): void {
  const parsed = parseObsidianSetupUriParams(params)
  if (parsed === undefined) {
    new Notice('Kuroflare setup: invalid setup URI')
    return
  }
  confirmAndApplySetupUri(plugin, parsed)
}
