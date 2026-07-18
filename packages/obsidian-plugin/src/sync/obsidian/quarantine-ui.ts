import type {
  QuarantineAuditEntry,
  QuarantinedUpdateActionDryRunResponse,
  QuarantinedUpdateEntry,
} from '@kuroflare/core'
import { Setting, type ButtonComponent } from 'obsidian'

import type KuroflareSpikePlugin from '../../main'
import { readAccessToken, requireSetupMetadata } from '../../main/auth'
import {
  accessTokenSecretKeyForSetup,
  docIdLabel,
  quarantineActionConfirmationText,
  quarantineActionLabel,
  redactSecretText,
} from '../../main/helpers'
import {
  executeQuarantineAdminAction,
  fetchQuarantineAdminAudit,
  fetchQuarantineAdminEntries,
  prepareQuarantineAdminAction,
  type QuarantineAdminAction,
} from './quarantine-admin'

const QUARANTINE_PAGE_SIZE = 20

/**
 * Renders the authenticated quarantine admin surface (list, discard/force-apply,
 * and the resolved-quarantine audit trail) in an Obsidian settings container.
 *
 * @param containerEl Settings container receiving the section.
 * @param plugin Plugin instance providing trusted setup metadata and SecretStorage access.
 * @returns Nothing; controls are appended to the supplied settings container.
 */
export function renderQuarantineAdmin(containerEl: HTMLElement, plugin: KuroflareSpikePlugin): void {
  containerEl.createEl('h3', { text: 'Quarantine admin' })
  const sectionEl = containerEl.createEl('div', { cls: 'kuroflare-quarantine' })
  const statusEl = sectionEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
  const errorEl = sectionEl.createEl('p', { attr: { role: 'alert' } })
  const entriesEl = sectionEl.createEl('div', { cls: 'kuroflare-quarantine-entries' })
  const listMoreEl = sectionEl.createEl('div', { cls: 'kuroflare-quarantine-list-more' })
  sectionEl.createEl('h4', { text: 'Resolved quarantine audit trail' })
  const auditEl = sectionEl.createEl('div', { cls: 'kuroflare-quarantine-audit' })
  const auditMoreEl = sectionEl.createEl('div', { cls: 'kuroflare-quarantine-audit-more' })

  let loading = false
  let entries: readonly QuarantinedUpdateEntry[] = []
  let nextCursor: string | undefined
  let prepared: { readonly id: string; readonly action: QuarantineAdminAction; readonly dryRun: QuarantinedUpdateActionDryRunResponse } | undefined
  let auditLoading = false
  let auditEntries: readonly QuarantineAuditEntry[] = []
  let auditNextCursor: string | undefined

  const hasSetupMetadata = setupMetadataAvailable(plugin)
  const http = { fetch: async (url: string, init?: RequestInit): Promise<Response> => await fetch(url, init) }

  new Setting(sectionEl).setName('Quarantined updates').addButton((button) => {
    button
      .setButtonText('Refresh')
      .setCta()
      .setDisabled(!hasSetupMetadata)
      .onClick(() => void loadEntries(true))
  })

  if (!hasSetupMetadata) setStatus('Disabled until this device completes setup.')
  else setStatus('Ready to inspect quarantined updates.')
  renderEntries()
  renderListMore()
  renderAudit()
  renderAuditMore()

  function renderEntries(): void {
    entriesEl.empty()
    if (entries.length === 0) {
      entriesEl.createEl('p', { text: 'No quarantined updates loaded.' })
      return
    }
    for (const entry of entries) {
      const setting = new Setting(entriesEl)
        .setName(`${entry.id}: ${entry.reason}`)
        .setDesc(
          `${docIdLabel(entry.docId)} · ${entry.messageId} · ${redactSecretText(entry.updateSha256)} · ${safeIsoTimestamp(entry.createdAt)}`,
        )
      if (prepared?.id === entry.id) {
        renderConfirm(setting, entry)
      } else {
        renderPrepareButtons(setting, entry)
      }
    }
  }

  function renderPrepareButtons(setting: Setting, entry: QuarantinedUpdateEntry): void {
    for (const action of ['discard', 'force-apply'] as const) {
      setting.addButton((button) => {
        button
          .setButtonText(`Prepare ${quarantineActionLabel(action).toLowerCase()}`)
          .setDisabled(loading)
          .onClick(() => void prepareAction(entry.id, action))
      })
    }
  }

  function renderConfirm(setting: Setting, entry: QuarantinedUpdateEntry): void {
    const active = prepared
    if (active === undefined || active.id !== entry.id) return
    const confirmationText = quarantineActionConfirmationText(active.action)
    let confirmationInput = ''
    setting
      .setDesc(
        `${setting.descEl.textContent} — ${quarantineActionLabel(active.action)}: ${active.dryRun.effects.map((effect) => `${effect.kind}${effect.detail === undefined ? '' : ` (${effect.detail})`}`).join(', ')}. Type ${confirmationText} to confirm.`,
      )
      .addText((text) => {
        text.setPlaceholder(confirmationText).onChange((value) => {
          confirmationInput = value.trim()
          updateConfirmButton()
        })
        text.inputEl.maxLength = confirmationText.length
        text.inputEl.setAttribute('aria-label', `${active.action} confirmation`)
      })
      .addButton((button) => {
        button.setButtonText('Cancel').onClick(() => {
          prepared = undefined
          renderEntries()
        })
      })

    let confirmButton: ButtonComponent | null = null
    setting.addButton((button) => {
      confirmButton = button
      button
        .setButtonText('Confirm')
        .setWarning()
        .setDisabled(true)
        .onClick(() => void executeAction(entry.id))
    })

    function updateConfirmButton(): void {
      confirmButton?.setDisabled(loading || confirmationInput !== confirmationText)
    }
  }

  function renderListMore(): void {
    listMoreEl.empty()
    new Setting(listMoreEl).addButton((button) => {
      button
        .setButtonText('Load more')
        .setDisabled(loading || nextCursor === undefined)
        .onClick(() => void loadEntries(false))
    })
  }

  function renderAudit(): void {
    auditEl.empty()
    if (auditEntries.length === 0) {
      auditEl.createEl('p', { text: 'No resolved quarantine actions loaded.' })
      return
    }
    for (const entry of auditEntries) {
      new Setting(auditEl)
        .setName(`${entry.quarantineId}: ${entry.action}`)
        .setDesc(
          `${docIdLabel(entry.docId)} · actor ${entry.actor}${entry.appliedSeq === undefined ? '' : ` · seq ${entry.appliedSeq}`} · ${safeIsoTimestamp(entry.resolvedAt)}`,
        )
    }
  }

  function renderAuditMore(): void {
    auditMoreEl.empty()
    new Setting(auditMoreEl).addButton((button) => {
      button
        .setButtonText('Load more')
        .setDisabled(auditLoading || auditNextCursor === undefined)
        .onClick(() => void loadAudit(false))
    })
  }

  async function loadEntries(reset: boolean): Promise<void> {
    if (loading) return
    if (reset) {
      entries = []
      nextCursor = undefined
      prepared = undefined
    }
    loading = true
    setError('')
    setStatus('Pending: loading quarantined updates…')
    renderListMore()
    try {
      const auth = await quarantineAuth(plugin)
      if (!auth.ok) {
        setError(auth.message)
        setStatus('Disabled: quarantine inspection is unavailable.')
        return
      }
      const result = await fetchQuarantineAdminEntries({
        setup: auth.setup,
        accessToken: auth.accessToken,
        limit: QUARANTINE_PAGE_SIZE,
        cursor: nextCursor,
        http,
      })
      if (!result.ok) {
        setError(quarantineRequestError(result.reason, result.status))
        setStatus('Error loading quarantined updates.')
        return
      }
      entries = [...entries, ...result.response.items]
      nextCursor = result.response.nextCursor
      setStatus(`Success: loaded ${entries.length} quarantined ${entries.length === 1 ? 'update' : 'updates'}.`)
    } catch {
      setError('Quarantine list request failed unexpectedly.')
      setStatus('Error loading quarantined updates.')
    } finally {
      loading = false
      renderEntries()
      renderListMore()
    }
  }

  async function loadAudit(reset: boolean): Promise<void> {
    if (auditLoading) return
    if (reset) {
      auditEntries = []
      auditNextCursor = undefined
    }
    auditLoading = true
    try {
      const auth = await quarantineAuth(plugin)
      if (!auth.ok) return
      const result = await fetchQuarantineAdminAudit({
        setup: auth.setup,
        accessToken: auth.accessToken,
        limit: QUARANTINE_PAGE_SIZE,
        cursor: auditNextCursor,
        http,
      })
      if (!result.ok) return
      auditEntries = [...auditEntries, ...result.response.items]
      auditNextCursor = result.response.nextCursor
      renderAudit()
    } finally {
      auditLoading = false
      renderAuditMore()
    }
  }

  async function prepareAction(id: string, action: QuarantineAdminAction): Promise<void> {
    if (loading) return
    loading = true
    setError('')
    setStatus(`Pending: preparing ${quarantineActionLabel(action).toLowerCase()}…`)
    renderEntries()
    try {
      const auth = await quarantineAuth(plugin)
      if (!auth.ok) {
        setError(auth.message)
        return
      }
      const result = await prepareQuarantineAdminAction({
        setup: auth.setup,
        accessToken: auth.accessToken,
        id,
        action,
        http,
      })
      if (!result.ok) {
        setError(quarantinePrepareError(result.reason, result.status))
        setStatus(`Error: could not prepare ${quarantineActionLabel(action).toLowerCase()}.`)
        return
      }
      prepared = { id, action, dryRun: result.dryRun }
      setStatus(`Ready: review the effects below and type the confirmation text to proceed.`)
    } catch {
      setError('Quarantine prepare request failed unexpectedly.')
    } finally {
      loading = false
      renderEntries()
    }
  }

  async function executeAction(id: string): Promise<void> {
    const active = prepared
    if (loading || active === undefined || active.id !== id) return
    loading = true
    setError('')
    setStatus(`Pending: ${quarantineActionLabel(active.action).toLowerCase()}…`)
    renderEntries()
    try {
      const auth = await quarantineAuth(plugin)
      if (!auth.ok) {
        setError(auth.message)
        return
      }
      const result = await executeQuarantineAdminAction({
        setup: auth.setup,
        accessToken: auth.accessToken,
        id,
        action: active.action,
        confirmationToken: active.dryRun.confirmationToken,
        http,
      })
      if (!result.ok) {
        setError(quarantinePrepareError(result.reason, result.status))
        setStatus(`Error: ${quarantineActionLabel(active.action).toLowerCase()} failed.`)
        return
      }
      prepared = undefined
      entries = entries.filter((entry) => entry.id !== id)
      setStatus(`Success: ${quarantineActionLabel(active.action).toLowerCase()} applied.`)
      loading = false
      await loadAudit(true)
    } catch {
      setError('Quarantine action request failed unexpectedly.')
      setStatus(`Error: ${quarantineActionLabel(active.action).toLowerCase()} failed.`)
    } finally {
      loading = false
      renderEntries()
    }
  }

  function setStatus(value: string): void {
    statusEl.setText(value)
  }

  function setError(value: string): void {
    errorEl.setText(value)
    errorEl.toggle(value.length > 0)
  }
}

function setupMetadataAvailable(plugin: KuroflareSpikePlugin): boolean {
  try {
    requireSetupMetadata(plugin)
    return true
  } catch {
    return false
  }
}

async function quarantineAuth(plugin: KuroflareSpikePlugin): Promise<
  | { readonly ok: true; readonly setup: ReturnType<typeof requireSetupMetadata>; readonly accessToken: string }
  | { readonly ok: false; readonly message: string }
> {
  try {
    const setup = requireSetupMetadata(plugin)
    const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
    return accessToken === undefined
      ? { ok: false, message: 'Disabled until an access token is available.' }
      : { ok: true, setup, accessToken }
  } catch {
    return { ok: false, message: 'Disabled until this device completes setup.' }
  }
}

function safeIsoTimestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'invalid timestamp' : date.toISOString()
}

function quarantineRequestError(
  reason: 'http-failed' | 'invalid-response',
  status: number | undefined,
): string {
  if (reason === 'http-failed') {
    return status === undefined
      ? 'Quarantine request failed.'
      : `Quarantine request failed (HTTP ${status}).`
  }
  return 'Quarantine response was invalid.'
}

function quarantinePrepareError(
  reason: 'http-failed' | 'invalid-response' | 'mismatched-response',
  status: number | undefined,
): string {
  if (reason === 'http-failed') {
    return status === undefined
      ? 'Quarantine action request failed.'
      : `Quarantine action request failed (HTTP ${status}).`
  }
  return reason === 'mismatched-response'
    ? 'Quarantine action response did not match the request.'
    : 'Quarantine action response was invalid.'
}
