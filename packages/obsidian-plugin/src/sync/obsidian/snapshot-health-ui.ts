import {
  YDocIdSchema,
  type DocId,
  type SnapshotHealthAction,
  type SnapshotHealthEntry,
} from '@kuroflare/core'
import { Setting, type ButtonComponent } from 'obsidian'
import * as v from 'valibot'

import { readAccessToken, requireSetupMetadata } from '../../host/auth'
import { accessTokenSecretKeyForSetup, redactSecretText } from '../../host/helpers'
import type KuroflareSpikePlugin from '../../host/plugin'
import {
  fetchSnapshotHealthEntries,
  quarantineSnapshotHealthEntry,
  rollbackSnapshotHealthEntry,
  snapshotHealthEntryStatus,
  verifySnapshotHealthEntry,
} from './snapshot-health-admin'

/** Exact confirmation text required before each snapshot health mutation. */
export const SNAPSHOT_HEALTH_CONFIRMATIONS = {
  verify: 'VERIFY SNAPSHOT',
  quarantine: 'QUARANTINE SNAPSHOT',
  rollback: 'ROLLBACK SNAPSHOT',
} as const

/**
 * Renders the authenticated snapshot health operator surface in an Obsidian settings container.
 *
 * @param containerEl Settings container receiving the section.
 * @param plugin Plugin instance providing trusted setup metadata and SecretStorage access.
 * @returns Nothing; controls are appended to the supplied settings container.
 */
export function renderSnapshotHealthAdmin(
  containerEl: HTMLElement,
  plugin: KuroflareSpikePlugin,
): void {
  containerEl.createEl('h3', { text: 'Snapshot health' })
  const sectionEl = containerEl.createEl('div', { cls: 'kuroflare-snapshot-health' })
  sectionEl.createEl('p', {
    cls: 'kuroflare-snapshot-health-authority-note',
    text: 'Recovery authority is composite: the latest authoritative, verified, healthy R2 snapshot plus later Durable Object SQLite operation-log rows. Normal runtime eviction is recoverable because SQLite survives. Complete SQLite loss is a disaster/manual-recovery case; acknowledged updates after the last checkpoint may be unavailable, and R2 bytes are not promoted without pointer and health evidence. Checkpoint triggers (128 operations or 30 seconds) are best effort, not a recovery-point bound.',
  })
  const controlsEl = sectionEl.createEl('div', { cls: 'kuroflare-snapshot-health-controls' })
  const statusEl = sectionEl.createEl('p', {
    attr: { role: 'status', 'aria-live': 'polite' },
  })
  const errorEl = sectionEl.createEl('p', {
    attr: { role: 'alert' },
  })
  const entriesEl = sectionEl.createEl('div', { cls: 'kuroflare-snapshot-health-entries' })
  const paginationEl = sectionEl.createEl('div', { cls: 'kuroflare-snapshot-health-pagination' })

  let docIdText = 'meta'
  let loading = false
  let entries: readonly SnapshotHealthEntry[] = []
  let nextCursor: string | undefined
  let pageCursors: string[] = []
  let refreshButton: ButtonComponent | null = null
  let nextButton: ButtonComponent | null = null
  let previousButton: ButtonComponent | null = null
  let docIdInput: HTMLInputElement | null = null
  const actionButtons = new Set<ButtonComponent>()
  const actionInputs = new Set<HTMLInputElement>()
  const actionButtonUpdaters = new Set<() => void>()

  const hasSetupMetadata = setupMetadataAvailable(plugin)
  const http = {
    fetch: async (url: string, init?: RequestInit): Promise<Response> => await fetch(url, init),
  }

  new Setting(controlsEl)
    .setName('Document ID')
    .setDesc('Use meta or file:<ydocId>; only the selected document is queried.')
    .addText((text) => {
      text
        .setPlaceholder('meta or file:ydoc-id')
        .setValue(docIdText)
        .onChange((value) => {
          docIdText = value.trim()
          pageCursors = []
          entries = []
          nextCursor = undefined
          renderEntries()
          renderPagination()
          updateRefreshButton()
          if (parseSnapshotHealthDocId(docIdText) === undefined) {
            setError('Enter a valid document ID: meta or file:<ydocId>.')
          } else {
            setError('')
            setStatus('Ready to inspect snapshot health.')
          }
        })
      docIdInput = text.inputEl
      text.inputEl.setAttribute('aria-label', 'Snapshot health document ID')
    })
    .addButton((button) => {
      refreshButton = button
      button
        .setButtonText('Refresh')
        .setCta()
        .onClick(() => {
          void loadPage(undefined, true)
        })
    })

  if (!hasSetupMetadata) {
    setStatus('Disabled until this device completes setup.')
  } else {
    setStatus('Ready to inspect snapshot health.')
  }
  renderEntries()
  renderPagination()
  updateRefreshButton()

  function renderEntries(): void {
    entriesEl.empty()
    actionButtons.clear()
    actionInputs.clear()
    actionButtonUpdaters.clear()
    if (entries.length === 0) {
      entriesEl.createEl('p', { text: 'No snapshot health entries loaded.' })
      return
    }

    for (const entry of entries) {
      if (entry.allowedActions.length === 0) {
        new Setting(entriesEl)
          .setName(`${entry.snapshotKey} (sequence ${entry.upperSeq})`)
          .setDesc(snapshotHealthEntryDescription(entry))
        continue
      }
      for (const action of entry.allowedActions) {
        const setting = new Setting(entriesEl).setName(
          `${entry.snapshotKey} (sequence ${entry.upperSeq}) — ${snapshotHealthActionLabel(action)}`,
        )
        renderAction(setting, entry, action)
      }
    }
  }

  function renderAction(
    setting: Setting,
    entry: SnapshotHealthEntry,
    action: SnapshotHealthAction,
  ): void {
    const confirmation = SNAPSHOT_HEALTH_CONFIRMATIONS[action]
    let reason = ''
    let confirmationInput = ''
    let actionButton: ButtonComponent | null = null

    setting
      .setDesc(
        `${snapshotHealthEntryDescription(entry)}. ${snapshotHealthActionDescription(action)} Type ${confirmation} to confirm.`,
      )
      .addText((text) => {
        text.setPlaceholder('Reason (required)').onChange((value) => {
          reason = value.trim()
          updateActionButton()
        })
        text.inputEl.maxLength = 1024
        actionInputs.add(text.inputEl)
        text.inputEl.setAttribute('aria-label', `${action} reason`)
      })
      .addText((text) => {
        text.setPlaceholder(confirmation).onChange((value) => {
          confirmationInput = value.trim()
          updateActionButton()
        })
        text.inputEl.maxLength = confirmation.length
        actionInputs.add(text.inputEl)
        text.inputEl.setAttribute('aria-label', `${action} confirmation`)
      })
      .addButton((button) => {
        actionButton = button
        actionButtons.add(button)
        button.setButtonText(snapshotHealthActionLabel(action))
        if (action !== 'verify') button.setWarning()
        button.setDisabled(true).onClick(() => {
          if (actionButton === null || loading) return
          void runAction(action, entry, reason, confirmationInput)
        })
      })

    function updateActionButton(): void {
      actionButton?.setDisabled(
        loading ||
          reason.length === 0 ||
          reason.length > 1024 ||
          confirmationInput !== confirmation,
      )
    }

    actionButtonUpdaters.add(updateActionButton)
  }

  function renderPagination(): void {
    paginationEl.empty()
    previousButton = null
    nextButton = null
    const previous = new Setting(paginationEl).setName('Snapshot pages')
    previous.addButton((button) => {
      previousButton = button
      button
        .setButtonText('Previous')
        .setDisabled(loading || pageCursors.length === 0)
        .onClick(() => {
          if (loading || pageCursors.length === 0) return
          pageCursors = pageCursors.slice(0, -1)
          void loadPage(pageCursors.at(-1), false)
        })
    })
    previous.addButton((button) => {
      nextButton = button
      button
        .setButtonText('Next')
        .setDisabled(loading || nextCursor === undefined)
        .onClick(() => {
          if (loading || nextCursor === undefined) return
          pageCursors = [...pageCursors, nextCursor]
          void loadPage(nextCursor, false)
        })
    })
    updatePaginationButtons()
  }

  function updateRefreshButton(): void {
    refreshButton?.setDisabled(
      loading || !hasSetupMetadata || parseSnapshotHealthDocId(docIdText) === undefined,
    )
  }

  function updatePaginationButtons(): void {
    previousButton?.setDisabled(loading || pageCursors.length === 0)
    nextButton?.setDisabled(loading || nextCursor === undefined)
  }

  function updateActionInputs(): void {
    for (const input of actionInputs) input.disabled = loading
  }

  function updateDocIdInput(): void {
    if (docIdInput !== null) docIdInput.disabled = loading
  }

  function setStatus(value: string): void {
    statusEl.setText(value)
  }

  function setError(value: string): void {
    errorEl.setText(value)
    errorEl.toggle(value.length > 0)
  }

  async function loadPage(cursor: string | undefined, reset: boolean): Promise<void> {
    if (loading) return
    const docId = parseSnapshotHealthDocId(docIdText)
    if (docId === undefined) {
      setError('Enter a valid document ID: meta or file:<ydocId>.')
      return
    }
    if (reset) {
      pageCursors = []
      nextCursor = undefined
    }
    loading = true
    setError('')
    setStatus('Pending: loading snapshot health…')
    updateRefreshButton()
    updatePaginationButtons()
    updateActionInputs()
    updateDocIdInput()
    try {
      const auth = await snapshotHealthAuth(plugin)
      if (!auth.ok) {
        setError(auth.message)
        setStatus('Disabled: snapshot health inspection is unavailable.')
        return
      }
      const result = await fetchSnapshotHealthEntries({
        setup: auth.setup,
        accessToken: auth.accessToken,
        docId,
        limit: 32,
        cursor,
        http,
      })
      if (!result.ok) {
        setError(snapshotHealthRequestError(result.reason, result.status))
        setStatus('Error loading snapshot health.')
        return
      }
      entries = result.response.entries
      nextCursor = result.response.nextCursor
      renderEntries()
      renderPagination()
      setStatus(
        `Success: loaded ${entries.length} snapshot health ${entries.length === 1 ? 'entry' : 'entries'}.`,
      )
    } catch {
      setError('Snapshot health request failed unexpectedly.')
      setStatus('Error loading snapshot health.')
    } finally {
      loading = false
      updateRefreshButton()
      updatePaginationButtons()
      updateActionInputs()
      updateDocIdInput()
      for (const updateActionButton of actionButtonUpdaters) updateActionButton()
    }
  }

  async function runAction(
    action: SnapshotHealthAction,
    entry: SnapshotHealthEntry,
    reason: string,
    confirmation: string,
  ): Promise<void> {
    if (loading || reason.length === 0 || confirmation !== SNAPSHOT_HEALTH_CONFIRMATIONS[action]) {
      return
    }
    const docId = parseSnapshotHealthDocId(docIdText)
    if (docId === undefined) {
      setError('Enter a valid document ID before changing snapshot health.')
      return
    }
    loading = true
    setError('')
    setStatus(`Pending: ${snapshotHealthActionLabel(action).toLowerCase()}…`)
    updateRefreshButton()
    updatePaginationButtons()
    updateActionInputs()
    updateDocIdInput()
    for (const button of actionButtons) button.setDisabled(true)
    try {
      const auth = await snapshotHealthAuth(plugin)
      if (!auth.ok) {
        setError(auth.message)
        setStatus('Disabled: snapshot health mutation is unavailable.')
        return
      }
      const requestBase = {
        docId,
        snapshotKey: entry.snapshotKey,
        upperSeq: entry.upperSeq,
        reason,
      }
      const result =
        action === 'verify'
          ? await verifySnapshotHealthEntry({
              setup: auth.setup,
              accessToken: auth.accessToken,
              request: { ...requestBase, confirmation: 'verify' },
              http,
            })
          : action === 'quarantine'
            ? await quarantineSnapshotHealthEntry({
                setup: auth.setup,
                accessToken: auth.accessToken,
                request: { ...requestBase, confirmation: 'quarantine' },
                http,
              })
            : await rollbackSnapshotHealthEntry({
                setup: auth.setup,
                accessToken: auth.accessToken,
                request: { ...requestBase, confirmation: 'rollback' },
                http,
              })
      if (!result.ok) {
        setError(snapshotHealthRequestError(result.reason, result.status))
        setStatus(`Error: ${snapshotHealthActionLabel(action).toLowerCase()} failed.`)
        return
      }
      setStatus(`Success: ${snapshotHealthActionLabel(action).toLowerCase()} applied; refreshing…`)
      loading = false
      await loadPage(pageCursors.at(-1), false)
    } catch {
      setError('Snapshot health mutation failed unexpectedly.')
      setStatus(`Error: ${snapshotHealthActionLabel(action).toLowerCase()} failed.`)
    } finally {
      loading = false
      updateRefreshButton()
      updatePaginationButtons()
      updateActionInputs()
      updateDocIdInput()
      for (const updateActionButton of actionButtonUpdaters) updateActionButton()
    }
  }
}

function parseSnapshotHealthDocId(value: string): DocId | undefined {
  if (value === 'meta') return { kind: 'meta' }
  if (!value.startsWith('file:')) return undefined
  const ydocId = value.slice('file:'.length)
  return v.is(YDocIdSchema, ydocId) ? { kind: 'file', ydocId } : undefined
}

function setupMetadataAvailable(plugin: KuroflareSpikePlugin): boolean {
  try {
    requireSetupMetadata(plugin)
    return true
  } catch {
    return false
  }
}

async function snapshotHealthAuth(plugin: KuroflareSpikePlugin): Promise<
  | {
      readonly ok: true
      readonly setup: ReturnType<typeof requireSetupMetadata>
      readonly accessToken: string
    }
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

function snapshotHealthEntryDescription(entry: SnapshotHealthEntry): string {
  const description = [
    `Status: ${snapshotHealthEntryStatus(entry)}`,
    `Physical: ${entry.physicalStatus}`,
    `Logical: ${entry.logicalStatus}`,
    `Authority: ${entry.authorityStatus}`,
    `Reason: ${entry.reasons.length === 0 ? 'none' : redactSecretText(entry.reasons.join(', '))}`,
    `Audit time: ${safeIsoTimestamp(entry.observedAt)}`,
    `Actor: ${snapshotHealthActor(entry)}`,
  ]
  if (entry.allowedActions.length === 0) {
    description.push(
      `Actions blocked: ${
        entry.actionBlockReason === undefined
          ? 'no permitted action'
          : redactSecretText(entry.actionBlockReason)
      }`,
    )
  }
  return description.join(' · ')
}

function snapshotHealthActor(entry: SnapshotHealthEntry): string {
  return entry.actor
}

function safeIsoTimestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'invalid timestamp' : date.toISOString()
}

function snapshotHealthActionLabel(action: SnapshotHealthAction): string {
  return action === 'verify' ? 'Verify' : action === 'quarantine' ? 'Quarantine' : 'Rollback'
}

function snapshotHealthActionDescription(action: SnapshotHealthAction): string {
  return action === 'verify'
    ? 'This explicitly approves the current bytes and promotes the candidate snapshot to authoritative.'
    : action === 'quarantine'
      ? 'This logically quarantines the snapshot, removes it from safe selection, and preserves authority status.'
      : 'This creates a new authoritative generation from a verified authoritative source snapshot.'
}

function snapshotHealthRequestError(
  reason: 'invalid-request' | 'http-failed' | 'invalid-response',
  status: number | undefined,
): string {
  if (reason === 'http-failed') {
    return status === undefined
      ? 'Snapshot health request failed.'
      : `Snapshot health request failed (HTTP ${status}).`
  }
  return reason === 'invalid-response'
    ? 'Snapshot health response was invalid.'
    : 'Snapshot health request was invalid.'
}
