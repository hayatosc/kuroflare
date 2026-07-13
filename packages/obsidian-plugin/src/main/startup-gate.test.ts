import { assert, test } from 'vitest'

import { createStartupSideEffectGate } from './startup-gate'

test('startup side effects stay closed during persistence replay', () => {
  const gate = createStartupSideEffectGate()

  assert.equal(gate.canRun(), false)
  gate.setAllowed(true)
  assert.equal(gate.canRun(), true)
  gate.beginPersistenceReplay()
  assert.equal(gate.canRun(), false)
  gate.endPersistenceReplay()
  assert.equal(gate.canRun(), true)
  gate.setAllowed(false)
  assert.equal(gate.canRun(), false)
})

test('startup side effects allow local-only work without network effects', () => {
  const gate = createStartupSideEffectGate()

  gate.setPermission('local-only')

  assert.equal(gate.canRun(), true)
  assert.equal(gate.canSendNetwork(), false)
})
