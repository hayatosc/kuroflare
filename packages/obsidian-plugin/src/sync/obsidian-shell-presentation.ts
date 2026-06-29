import {
  type SyncRuntimeRepairEntryState,
  type SyncRuntimeShellState,
  type SyncRuntimeShellStatus,
} from './startup-actuation.js'

/** Snapshot of Obsidian shell UI side effects already presented to the user. */
export interface SyncRuntimeObsidianPresentationSnapshot {
  readonly shownNoticeCount: number
}

/** Input for deriving Obsidian status bar, notice, and repair panel presentation from shell state. */
export interface SyncRuntimeObsidianPresentationInput {
  readonly state: SyncRuntimeShellState
  readonly previous?: SyncRuntimeObsidianPresentationSnapshot | undefined
}

/** Presentation data that the Obsidian plugin shell can render without re-deciding sync state. */
export interface SyncRuntimeObsidianPresentationPlan {
  readonly statusText: string
  readonly noticeTexts: readonly string[]
  readonly repairEntries: readonly SyncRuntimeObsidianRepairPresentation[]
  readonly canRetryStartup: boolean
  readonly nextSnapshot: SyncRuntimeObsidianPresentationSnapshot
}

/** One user-visible repair entry derived from startup shell state. */
export interface SyncRuntimeObsidianRepairPresentation {
  readonly entry: SyncRuntimeRepairEntryState['entry']
  readonly title: string
  readonly description: string
}

/**
 * Converts startup shell state into Obsidian UI presentation data.
 *
 * @param input Current shell state and optional presentation snapshot from the previous render.
 * @returns Status text, notices that have not yet been shown, repair entries, and next render snapshot.
 * @throws When the previous presentation snapshot is internally inconsistent.
 */
export function planSyncRuntimeObsidianPresentation(
  input: SyncRuntimeObsidianPresentationInput,
): SyncRuntimeObsidianPresentationPlan {
  const previousNoticeCount = input.previous?.shownNoticeCount ?? 0
  if (
    !Number.isSafeInteger(previousNoticeCount) ||
    previousNoticeCount < 0 ||
    previousNoticeCount > input.state.notices.length
  ) {
    throw new Error('invalid-obsidian-presentation-snapshot')
  }

  return {
    statusText: formatStatusText(input.state),
    noticeTexts: input.state.notices.slice(previousNoticeCount).map(noticeText),
    repairEntries: input.state.repairEntries.map(repairEntryPresentation),
    canRetryStartup: input.state.lastFailedEffect !== undefined,
    nextSnapshot: { shownNoticeCount: input.state.notices.length },
  }
}

function formatStatusText(state: SyncRuntimeShellState): string {
  const status = state.status === undefined ? 'starting' : statusLabel(state.status)
  if (state.backgroundQueues === 'running') {
    return `Kuroflare: ${status} / queues running`
  }
  const reason = state.backgroundQueueStopReason ?? 'not-ready'
  return `Kuroflare: ${status} / queues stopped (${reason})`
}

function statusLabel(status: SyncRuntimeShellStatus): string {
  switch (status) {
    case 'setup-required':
      return 'setup required'
    case 'auth-blocked':
      return 'auth blocked'
    case 'degraded':
      return 'degraded'
    case 'rejected':
      return 'rejected'
    case 'local-store-blocked':
      return 'local store blocked'
    case 'starting':
      return 'starting'
    case 'rebuild-local-store':
      return 'rebuilding local store'
    default:
      return assertNever(status)
  }
}

function noticeText(notice: SyncRuntimeShellState['notices'][number]): string {
  switch (notice) {
    case 'setup-required':
      return 'Kuroflare setup is required before sync can start.'
    case 'device-revoked':
      return 'This Kuroflare device was revoked. Re-authentication is required.'
    case 'reauth-required':
      return 'Kuroflare needs re-authentication before sync can resume.'
    case 'startup-degraded':
      return 'Kuroflare local storage needs review before sync can resume.'
    case 'startup-rejected':
      return 'Kuroflare startup was rejected. Review the repair entry before retrying.'
    case 'local-store-blocked':
      return 'Kuroflare local storage is blocked and sync was not started.'
    default:
      return assertNever(notice)
  }
}

function repairEntryPresentation(
  entry: SyncRuntimeRepairEntryState,
): SyncRuntimeObsidianRepairPresentation {
  switch (entry.entry) {
    case 'device-revoked':
      return {
        entry: entry.entry,
        title: 'Device revoked',
        description: `Sync is stopped because this device is no longer admitted: ${entry.reason}`,
      }
    case 'reauth-required':
      return {
        entry: entry.entry,
        title: 'Re-authentication required',
        description: `Sync is stopped until credentials are refreshed: ${entry.reason}`,
      }
    case 'local-store-schema':
      return {
        entry: entry.entry,
        title: 'Local store repair required',
        description: `IndexedDB schema evidence blocked startup: ${entry.reason}`,
      }
    case 'startup-rejected':
      return {
        entry: entry.entry,
        title: 'Startup rejected',
        description: `Startup effect failed before sync could resume: ${entry.reason}`,
      }
    default:
      return assertNever(entry.entry)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Obsidian shell presentation variant: ${String(value)}`)
}
