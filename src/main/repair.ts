import type KuroflareSpikePlugin from './plugin'

export async function refreshQuarantineAdminEntries(plugin: KuroflareSpikePlugin): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare quarantine: setup metadata is missing')
    return
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    new Notice('Kuroflare quarantine: access token is missing')
    return
  }

  const result = await fetchQuarantineAdminEntries({
    setup,
    accessToken,
    http: { fetch },
  })
  if (!result.ok) {
    if (result.reason === 'http-failed') {
      new Notice(`Kuroflare quarantine: list failed (${result.status})`)
      console.warn('[kuroflare] quarantine list fetch failed', { status: result.status })
      return
    }
    new Notice('Kuroflare quarantine: invalid list response')
    console.warn('[kuroflare] quarantine list response rejected by guard')
    return
  }

  plugin.quarantineAdminEntries = result.entries
  if (
    plugin.quarantineAdminDetail !== null &&
    !result.entries.some((entry) => entry.id === plugin.quarantineAdminDetail?.entry.id)
  ) {
    plugin.quarantineAdminDetail = null
  }
  new Notice(`Kuroflare quarantine entries: ${result.entries.length}`)
}

export async function inspectQuarantineAdminEntry(
  plugin: KuroflareSpikePlugin,
  id: string,
): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare quarantine: setup metadata is missing')
    return
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    new Notice('Kuroflare quarantine: access token is missing')
    return
  }

  const result = await fetchQuarantineAdminDetail({
    setup,
    accessToken,
    id,
    http: { fetch },
  })
  if (!result.ok) {
    if (result.reason === 'http-failed') {
      new Notice(`Kuroflare quarantine: inspect failed (${result.status})`)
      console.warn('[kuroflare] quarantine detail fetch failed', { id, status: result.status })
      return
    }
    new Notice('Kuroflare quarantine: invalid detail response')
    console.warn('[kuroflare] quarantine detail response rejected by guard', { id })
    return
  }

  plugin.quarantineAdminDetail = result.detail
  new Notice(`Kuroflare quarantine inspected: ${id}`)
}

export async function prepareQuarantineAdminAction(
  plugin: KuroflareSpikePlugin,
  id: string,
  action: QuarantineAdminAction,
): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare quarantine: setup metadata is missing')
    return
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    new Notice('Kuroflare quarantine: access token is missing')
    return
  }

  const result = await prepareQuarantineAdminActionHttp({
    setup,
    accessToken,
    id,
    action,
    http: { fetch },
  })
  if (!result.ok) {
    if (result.reason === 'http-failed') {
      new Notice(`Kuroflare quarantine: ${action} dry-run failed (${result.status})`)
      console.warn('[kuroflare] quarantine action dry-run failed', {
        id,
        action,
        status: result.status,
      })
      return
    }
    new Notice('Kuroflare quarantine: invalid dry-run response')
    console.warn('[kuroflare] quarantine action dry-run response rejected by guard', {
      id,
      action,
    })
    return
  }

  plugin.quarantineAdminPendingAction = {
    action: result.dryRun.action,
    id: result.dryRun.id,
    confirmationToken: result.dryRun.confirmationToken,
    effects: result.dryRun.effects,
    preparedAt: Date.now(),
  }
  new Notice(`Kuroflare quarantine ${action} prepared: ${id}`)
}

export function getQuarantineAdminSnapshot(plugin: KuroflareSpikePlugin): {
  readonly entries: readonly QuarantinedUpdateEntry[]
  readonly detail: QuarantinedUpdateDetailResponse | null
  readonly pendingAction: QuarantineAdminPendingAction | null
} {
  return {
    entries: plugin.quarantineAdminEntries,
    detail: plugin.quarantineAdminDetail,
    pendingAction: plugin.quarantineAdminPendingAction,
  }
}

export async function executeQuarantineAdminAction(
  plugin: KuroflareSpikePlugin,
  id: string,
  action: QuarantineAdminAction,
  confirmation: string,
): Promise<void> {
  const requiredConfirmation = quarantineActionConfirmationText(action)
  if (confirmation.trim() !== requiredConfirmation) {
    new Notice(`Kuroflare quarantine: type ${requiredConfirmation} to execute`)
    return
  }
  const pending = plugin.quarantineAdminPendingAction
  if (pending === null || pending.id !== id || pending.action !== action) {
    new Notice('Kuroflare quarantine: run dry-run first')
    return
  }
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare quarantine: setup metadata is missing')
    return
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    new Notice('Kuroflare quarantine: access token is missing')
    return
  }

  const result = await executeQuarantineAdminActionHttp({
    setup,
    accessToken,
    id,
    action,
    confirmationToken: pending.confirmationToken,
    http: { fetch },
  })
  if (!result.ok) {
    if (result.reason === 'http-failed') {
      new Notice(`Kuroflare quarantine: ${action} execute failed (${result.status})`)
      console.warn('[kuroflare] quarantine action execute failed', {
        id,
        action,
        status: result.status,
      })
      return
    }
    new Notice('Kuroflare quarantine: invalid action response')
    console.warn('[kuroflare] quarantine action response rejected by guard', { id, action })
    return
  }

  plugin.quarantineAdminEntries = plugin.quarantineAdminEntries.filter((entry) => entry.id !== id)
  if (plugin.quarantineAdminDetail?.entry.id === id) {
    plugin.quarantineAdminDetail = null
  }
  plugin.quarantineAdminPendingAction = null
  new Notice(`Kuroflare quarantine ${action} applied: ${id}`)
}
