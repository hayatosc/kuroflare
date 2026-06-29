import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  applySyncRuntimeObsidianShellPresentation,
  type SyncRuntimeObsidianShellUiPort,
} from '../obsidian/ui'

test('Obsidian shell UI adapter applies presentation without re-deciding shell state', () => {
  const ui = new RecordingObsidianShellUiPort()
  const repairEntries = [
    {
      entry: 'startup-rejected',
      title: 'Startup rejected',
      description: 'Startup effect failed before sync could resume: boom',
    },
  ] as const

  const result = applySyncRuntimeObsidianShellPresentation({
    ui,
    presentation: {
      statusText: 'Kuroflare: rejected / queues stopped (rejected)',
      noticeTexts: ['Kuroflare startup was rejected. Review the repair entry before retrying.'],
      repairEntries,
      canRetryStartup: true,
      nextSnapshot: { shownNoticeCount: 1 },
    },
  })

  assert.deepEqual(ui.operations, [
    {
      kind: 'set-status-text',
      text: 'Kuroflare: rejected / queues stopped (rejected)',
    },
    {
      kind: 'show-notice',
      text: 'Kuroflare startup was rejected. Review the repair entry before retrying.',
    },
    { kind: 'set-repair-entries', entries: repairEntries },
    { kind: 'set-retry-enabled', enabled: true },
  ])
  assert.deepEqual(result, {
    statusText: 'Kuroflare: rejected / queues stopped (rejected)',
    shownNotices: ['Kuroflare startup was rejected. Review the repair entry before retrying.'],
    repairEntries,
    retryEnabled: true,
  })
})

class RecordingObsidianShellUiPort implements SyncRuntimeObsidianShellUiPort {
  readonly operations: (
    | { readonly kind: 'set-status-text'; readonly text: string }
    | { readonly kind: 'show-notice'; readonly text: string }
    | {
        readonly kind: 'set-repair-entries'
        readonly entries: Parameters<SyncRuntimeObsidianShellUiPort['setRepairEntries']>[0]
      }
    | { readonly kind: 'set-retry-enabled'; readonly enabled: boolean }
  )[] = []

  setStatusText(text: string): void {
    this.operations.push({ kind: 'set-status-text', text })
  }

  showNotice(text: string): void {
    this.operations.push({ kind: 'show-notice', text })
  }

  setRepairEntries(
    entries: Parameters<SyncRuntimeObsidianShellUiPort['setRepairEntries']>[0],
  ): void {
    this.operations.push({ kind: 'set-repair-entries', entries })
  }

  setRetryEnabled(enabled: boolean): void {
    this.operations.push({ kind: 'set-retry-enabled', enabled })
  }
}
