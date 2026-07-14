import { assert, test } from 'vitest'

import {
  planRejectedUpdateRepairOutcomePresentation,
  planRejectedUpdateRepairSettingsPresentation,
} from './rejected-update-repair-presentation'

test('rejected repair settings present a quiet empty state after setup', () => {
  assert.deepEqual(
    planRejectedUpdateRepairSettingsPresentation({ entryCount: 0, setupAvailable: true }),
    {
      description:
        'Oversized live updates stay paused until you explicitly import the exact local Yjs delta. Each action targets one evidence-matched outbox row; conflicts and failures leave it paused.',
      emptyStateText: 'No paused rejected updates loaded.',
      refreshButtonText: 'Refresh',
      disabled: false,
    },
  )
})

test('rejected repair settings explain setup gating', () => {
  assert.deepEqual(
    planRejectedUpdateRepairSettingsPresentation({ entryCount: 2, setupAvailable: false }),
    {
      description: 'Complete device setup before importing paused rejected updates.',
      emptyStateText: 'Rejected update repair is disabled until setup completes.',
      refreshButtonText: 'Refresh',
      disabled: true,
    },
  )
})

test('rejected repair settings keep refresh available when rows are loaded', () => {
  assert.deepEqual(
    planRejectedUpdateRepairSettingsPresentation({ entryCount: 2, setupAvailable: true }),
    {
      description:
        'Oversized live updates stay paused until you explicitly import the exact local Yjs delta. Each action targets one evidence-matched outbox row; conflicts and failures leave it paused.',
      emptyStateText: undefined,
      refreshButtonText: 'Refresh',
      disabled: false,
    },
  )
})

test('rejected repair settings distinguish success from a paused failure', () => {
  assert.deepEqual(
    planRejectedUpdateRepairOutcomePresentation({
      ok: true,
      docLabel: 'file:doc-1',
      snapshotSeq: 8,
    }),
    {
      ok: true,
      statusText: 'Success: repaired file:doc-1.',
      noticeText: 'Kuroflare: imported file:doc-1 (snapshot 8).',
    },
  )
  assert.deepEqual(
    planRejectedUpdateRepairOutcomePresentation({
      ok: false,
      docLabel: 'file:doc-1',
      reason: 'conflict',
    }),
    {
      ok: false,
      statusText: 'Error: repair kept paused (conflict).',
      noticeText: 'Kuroflare: repair kept paused (conflict).',
    },
  )
})
