/** Input evidence for the rejected-update repair settings section. */
export interface RejectedUpdateRepairSettingsPresentationInput {
  readonly entryCount: number
  readonly setupAvailable: boolean
}

/** Text-only presentation state for the explicit rejected-update repair controls. */
export interface RejectedUpdateRepairSettingsPresentation {
  readonly description: string
  readonly emptyStateText: string | undefined
  readonly refreshButtonText: string
  readonly disabled: boolean
}

/** Outcome copy shown after one explicit repair attempt. */
export type RejectedUpdateRepairOutcomePresentation =
  | { readonly ok: true; readonly statusText: string; readonly noticeText: string }
  | { readonly ok: false; readonly statusText: string; readonly noticeText: string }

/** Builds clear success/failure copy while keeping failure semantics paused and explicit. */
export function planRejectedUpdateRepairOutcomePresentation(
  input:
    | { readonly ok: true; readonly docLabel: string; readonly snapshotSeq: number }
    | { readonly ok: false; readonly docLabel: string; readonly reason: string },
): RejectedUpdateRepairOutcomePresentation {
  if (input.ok) {
    return {
      ok: true,
      statusText: `Success: repaired ${input.docLabel}.`,
      noticeText: `Kuroflare: imported ${input.docLabel} (snapshot ${input.snapshotSeq}).`,
    }
  }
  return {
    ok: false,
    statusText: `Error: repair kept paused (${input.reason}).`,
    noticeText: `Kuroflare: repair kept paused (${input.reason}).`,
  }
}

/** Derives safe, explicit settings copy without deciding or mutating repair state. */
export function planRejectedUpdateRepairSettingsPresentation(
  input: RejectedUpdateRepairSettingsPresentationInput,
): RejectedUpdateRepairSettingsPresentation {
  if (!input.setupAvailable) {
    return {
      description: 'Complete device setup before importing paused rejected updates.',
      emptyStateText: 'Rejected update repair is disabled until setup completes.',
      refreshButtonText: 'Refresh',
      disabled: true,
    }
  }
  return {
    description:
      'Oversized live updates stay paused until you explicitly import the exact local Yjs delta. Each action targets one evidence-matched outbox row; conflicts and failures leave it paused.',
    emptyStateText: input.entryCount === 0 ? 'No paused rejected updates loaded.' : undefined,
    refreshButtonText: 'Refresh',
    disabled: false,
  }
}
