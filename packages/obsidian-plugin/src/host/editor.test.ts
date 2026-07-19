import { assert, test } from 'vitest'

import { waitForActiveMarkdownBindingReadiness } from './editor'

test('active markdown binding waits for a blocked startup tick before allowing local-only work', async () => {
  let startupRuns = 0
  let permission: 'blocked' | 'local-only' = 'blocked'
  const plugin = {
    startupSideEffectGate: {
      canRun: () => permission !== 'blocked',
    },
    syncRuntime: {
      lifecycle: {
        snapshot: () => ({
          driverState: undefined,
          lastUiApply: undefined,
          tickInFlight: startupRuns === 0,
        }),
        runStartupTick: async () => {
          startupRuns += 1
          permission = 'local-only'
          return undefined
        },
      },
    },
  }

  const ready = await waitForActiveMarkdownBindingReadiness(plugin)

  assert.isTrue(ready)
  assert.equal(startupRuns, 1)
})

test('active markdown binding does not run without a startup runtime', async () => {
  const plugin = {
    startupSideEffectGate: { canRun: () => false },
    syncRuntime: null,
  }

  assert.isFalse(await waitForActiveMarkdownBindingReadiness(plugin))
})
