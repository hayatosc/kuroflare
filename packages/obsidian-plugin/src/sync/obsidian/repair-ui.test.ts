import { assert, test } from 'vitest'

import { planLocalStoreRepairSettingsPresentation } from './repair-ui'

const rebuildConfirmation = 'REBUILD LOCAL STORE'
const discardConfirmation = 'DISCARD LOCAL STORE OUTBOX'

test('local store repair settings presentation keeps manual repair CTAs quiet without degraded state', () => {
  assert.deepEqual(
    planLocalStoreRepairSettingsPresentation({
      repairEntries: [],
      rebuildConfirmation,
      discardConfirmation,
    }),
    {
      emptyStateText: 'No degraded local store state reported.',
      evidenceDescription:
        'No degraded local store state is currently reported. Create an export only when preparing a manual repair or import.',
      exportDescription: 'Write a manual repair export JSON for pending local outbox entries.',
      exportButtonText: 'Export',
      importDefaultPath: '',
      rebuildDescription:
        'No local outbox export recorded in settings. Rebuild is only needed after a local-store repair entry appears. Type DISCARD LOCAL STORE OUTBOX only when intentionally discarding pending local outbox entries.',
    },
  )
})

test('local store repair settings presentation requires export before degraded rebuild', () => {
  assert.deepEqual(
    planLocalStoreRepairSettingsPresentation({
      repairEntries: [
        {
          entry: 'local-store-schema',
          title: 'Local store repair required',
          description:
            'IndexedDB schema evidence blocked startup: missing-required-store-with-pending-outbox',
        },
      ],
      rebuildConfirmation,
      discardConfirmation,
    }),
    {
      emptyStateText: undefined,
      evidenceDescription:
        'Local store repair is blocked and no pending outbox export has been recorded. Export before rebuilding when pending outbox rows exist.',
      exportDescription:
        'Write the required repair export JSON before rebuilding this degraded local store.',
      exportButtonText: 'Export before rebuild',
      importDefaultPath: '',
      rebuildDescription:
        'No local outbox export recorded in settings. Type REBUILD LOCAL STORE only after export, or DISCARD LOCAL STORE OUTBOX to intentionally discard pending local outbox entries.',
    },
  )
})

test('local store repair settings presentation narrows rebuild CTA after export evidence exists', () => {
  assert.deepEqual(
    planLocalStoreRepairSettingsPresentation({
      repairEntries: [
        {
          entry: 'local-store-schema',
          title: 'Local store repair required',
          description:
            'IndexedDB schema evidence blocked startup: store-version-too-old-with-pending-outbox',
        },
      ],
      repairExport: {
        path: '.obsidian/kuroflare/repair-exports/kuroflare-local-outbox-1700000000000.json',
        exportedAt: 1_700_000_000_000,
        pendingOutboxCount: 2,
      },
      rebuildConfirmation,
      discardConfirmation,
    }),
    {
      emptyStateText: undefined,
      evidenceDescription:
        'Export ready for rebuild confirmation: 2 pending entries from .obsidian/kuroflare/repair-exports/kuroflare-local-outbox-1700000000000.json.',
      exportDescription:
        'Refresh the repair export JSON if the pending local outbox count changed.',
      exportButtonText: 'Refresh export',
      importDefaultPath:
        '.obsidian/kuroflare/repair-exports/kuroflare-local-outbox-1700000000000.json',
      rebuildDescription:
        'Last export: .obsidian/kuroflare/repair-exports/kuroflare-local-outbox-1700000000000.json (2 pending entries at 2023-11-14T22:13:20.000Z) Type REBUILD LOCAL STORE to rebuild from the recorded export, or DISCARD LOCAL STORE OUTBOX to intentionally discard pending local outbox entries.',
    },
  )
})
