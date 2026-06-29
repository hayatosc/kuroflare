import {
  type SyncRuntimeObsidianPresentationPlan,
  type SyncRuntimeObsidianRepairPresentation,
} from '../obsidian/presentation'

/** Obsidian UI operations needed to render one sync shell presentation plan. */
export interface SyncRuntimeObsidianShellUiPort {
  /**
   * Updates the plugin status bar text.
   *
   * @param text Already formatted status text from the presentation planner.
   */
  setStatusText(text: string): void

  /**
   * Shows one Obsidian notice.
   *
   * @param text User-visible notice text that has not been shown before.
   */
  showNotice(text: string): void

  /**
   * Replaces the visible repair panel entries.
   *
   * @param entries Repair entries derived from shell state.
   */
  setRepairEntries(entries: readonly SyncRuntimeObsidianRepairPresentation[]): void

  /**
   * Enables or disables the startup retry command affordance.
   *
   * @param enabled Whether the last startup failure can be retried by the user.
   */
  setRetryEnabled(enabled: boolean): void
}

/** Input for applying one Obsidian shell presentation plan to UI ports. */
export interface SyncRuntimeObsidianShellUiApplyInput {
  readonly presentation: SyncRuntimeObsidianPresentationPlan
  readonly ui: SyncRuntimeObsidianShellUiPort
}

/** Ordered UI operations applied for one presentation plan. */
export interface SyncRuntimeObsidianShellUiApplyResult {
  readonly statusText: string
  readonly shownNotices: readonly string[]
  readonly repairEntries: readonly SyncRuntimeObsidianRepairPresentation[]
  readonly retryEnabled: boolean
}

/**
 * Applies a shell presentation plan to Obsidian UI ports without re-deciding sync state.
 *
 * @param input Presentation plan and concrete UI port implementation.
 * @returns The UI values that were applied, for tests and caller logging.
 */
export function applySyncRuntimeObsidianShellPresentation(
  input: SyncRuntimeObsidianShellUiApplyInput,
): SyncRuntimeObsidianShellUiApplyResult {
  input.ui.setStatusText(input.presentation.statusText)
  for (const noticeText of input.presentation.noticeTexts) {
    input.ui.showNotice(noticeText)
  }
  input.ui.setRepairEntries(input.presentation.repairEntries)
  input.ui.setRetryEnabled(input.presentation.canRetryStartup)

  return {
    statusText: input.presentation.statusText,
    shownNotices: [...input.presentation.noticeTexts],
    repairEntries: [...input.presentation.repairEntries],
    retryEnabled: input.presentation.canRetryStartup,
  }
}
