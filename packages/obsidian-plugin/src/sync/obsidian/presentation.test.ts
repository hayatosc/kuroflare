import { makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  applySyncRuntimeShellCommands,
  INITIAL_SYNC_RUNTIME_SHELL_STATE,
} from '../engine/actuation'
import { type SyncRuntimeStartupEffect } from '../engine/startup'
import { planSyncRuntimeObsidianPresentation } from '../obsidian/presentation'

const resumeBackgroundQueuesEffect = {
  kind: 'run-sync-startup-effect',
  effect: {
    kind: 'run-startup-step',
    vaultId: makeVaultId('presentation-vault-1'),
    step: 'resume-background-queues',
    phase: 'outbox',
  },
} satisfies SyncRuntimeStartupEffect

test('Obsidian shell presentation renders blocked auth without starting queues', () => {
  const state = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    { kind: 'stop-background-queues', reason: 'auth-blocked' },
    { kind: 'set-status', status: 'auth-blocked', reason: 'device-revoked' },
    { kind: 'show-repair-entry', entry: 'device-revoked', reason: 'device-revoked' },
    { kind: 'show-notice', notice: 'device-revoked' },
  ])

  assert.deepEqual(planSyncRuntimeObsidianPresentation({ state }), {
    statusText: 'Kuroflare: auth blocked / queues stopped (auth-blocked)',
    noticeTexts: ['This Kuroflare device was revoked. Re-authentication is required.'],
    repairEntries: [
      {
        entry: 'device-revoked',
        title: 'Device revoked',
        description: 'Sync is stopped because this device is no longer admitted: device-revoked',
      },
    ],
    canRetryStartup: false,
    nextSnapshot: { shownNoticeCount: 1 },
  })
})

test('Obsidian shell presentation only returns notices not previously shown', () => {
  const state = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    { kind: 'show-notice', notice: 'setup-required' },
    { kind: 'show-notice', notice: 'startup-rejected' },
  ])

  const first = planSyncRuntimeObsidianPresentation({ state })
  const second = planSyncRuntimeObsidianPresentation({
    state,
    previous: first.nextSnapshot,
  })

  assert.deepEqual(first.noticeTexts, [
    'Kuroflare setup is required before sync can start.',
    'Kuroflare startup was rejected. Review the repair entry before retrying.',
  ])
  assert.deepEqual(second.noticeTexts, [])
})

test('Obsidian shell presentation exposes running queues only after shell ACK state says so', () => {
  const queued = applySyncRuntimeShellCommands(INITIAL_SYNC_RUNTIME_SHELL_STATE, [
    { kind: 'set-status', status: 'starting', reason: 'outbox' },
    { kind: 'run-runtime-effect', effect: resumeBackgroundQueuesEffect },
  ])

  assert.equal(
    planSyncRuntimeObsidianPresentation({ state: queued }).statusText,
    'Kuroflare: starting / queues stopped (startup-not-ready)',
  )

  const acknowledged = applySyncRuntimeShellCommands(queued, [
    { kind: 'ack-runtime-effect', effect: resumeBackgroundQueuesEffect },
  ])

  assert.equal(
    planSyncRuntimeObsidianPresentation({ state: acknowledged }).statusText,
    'Kuroflare: starting / queues running',
  )
})

test('Obsidian shell presentation rejects impossible notice snapshots', () => {
  assert.throws(
    () =>
      planSyncRuntimeObsidianPresentation({
        state: INITIAL_SYNC_RUNTIME_SHELL_STATE,
        previous: { shownNoticeCount: 1 },
      }),
    /invalid-obsidian-presentation-snapshot/,
  )
})
