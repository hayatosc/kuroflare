import type { SyncRuntimeObsidianRepairPresentation } from './presentation'

/** Recorded local outbox repair export evidence shown in the settings panel. */
export interface LocalStoreRepairExportPresentationEvidence {
  readonly path: string
  readonly exportedAt: number
  readonly pendingOutboxCount: number
}

/** Input for deriving local-store repair settings labels and descriptions. */
export interface LocalStoreRepairSettingsPresentationInput {
  readonly repairEntries: readonly SyncRuntimeObsidianRepairPresentation[]
  readonly repairExport?: LocalStoreRepairExportPresentationEvidence | undefined
  readonly rebuildConfirmation: string
  readonly discardConfirmation: string
}

/** Text-only presentation state for the local-store repair settings section. */
export interface LocalStoreRepairSettingsPresentation {
  readonly emptyStateText: string | undefined
  readonly evidenceDescription: string
  readonly exportDescription: string
  readonly exportButtonText: string
  readonly importDefaultPath: string
  readonly rebuildDescription: string
}

/**
 * Derives state-specific local-store repair calls to action for Obsidian settings.
 *
 * @param input Current runtime repair entries, recorded export evidence, and confirmation phrases.
 * @returns Text labels that keep rebuild/discard guidance tied to observed local-store state.
 */
export function planLocalStoreRepairSettingsPresentation(
  input: LocalStoreRepairSettingsPresentationInput,
): LocalStoreRepairSettingsPresentation {
  const localStoreBlocked = input.repairEntries.some(
    (entry) => entry.entry === 'local-store-schema',
  )
  const exportEvidence = input.repairExport
  const exportSummary =
    exportEvidence === undefined
      ? 'No local outbox export recorded in settings.'
      : `Last export: ${exportEvidence.path} (${exportEvidence.pendingOutboxCount} pending entries at ${new Date(
          exportEvidence.exportedAt,
        ).toISOString()})`

  if (!localStoreBlocked) {
    return {
      emptyStateText:
        input.repairEntries.length === 0 ? 'No degraded local store state reported.' : undefined,
      evidenceDescription:
        exportEvidence === undefined
          ? 'No degraded local store state is currently reported. Create an export only when preparing a manual repair or import.'
          : `Manual repair export recorded: ${exportEvidence.pendingOutboxCount} pending entries from ${exportEvidence.path}.`,
      exportDescription: 'Write a manual repair export JSON for pending local outbox entries.',
      exportButtonText: exportEvidence === undefined ? 'Export' : 'Refresh export',
      importDefaultPath: exportEvidence?.path ?? '',
      rebuildDescription: `${exportSummary} Rebuild is only needed after a local-store repair entry appears. Type ${input.discardConfirmation} only when intentionally discarding pending local outbox entries.`,
    }
  }

  if (exportEvidence === undefined) {
    return {
      emptyStateText: undefined,
      evidenceDescription:
        'Local store repair is blocked and no pending outbox export has been recorded. Export before rebuilding when pending outbox rows exist.',
      exportDescription:
        'Write the required repair export JSON before rebuilding this degraded local store.',
      exportButtonText: 'Export before rebuild',
      importDefaultPath: '',
      rebuildDescription: `${exportSummary} Type ${input.rebuildConfirmation} only after export, or ${input.discardConfirmation} to intentionally discard pending local outbox entries.`,
    }
  }

  return {
    emptyStateText: undefined,
    evidenceDescription: `Export ready for rebuild confirmation: ${exportEvidence.pendingOutboxCount} pending entries from ${exportEvidence.path}.`,
    exportDescription: 'Refresh the repair export JSON if the pending local outbox count changed.',
    exportButtonText: 'Refresh export',
    importDefaultPath: exportEvidence.path,
    rebuildDescription: `${exportSummary} Type ${input.rebuildConfirmation} to rebuild from the recorded export, or ${input.discardConfirmation} to intentionally discard pending local outbox entries.`,
  }
}
