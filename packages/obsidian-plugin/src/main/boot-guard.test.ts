import { assert, test } from 'vitest'

import { createStartupSideEffectGate } from './boot-guard'

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

test('recovery blocks every side effect until its transaction completes', () => {
  const gate = createStartupSideEffectGate()
  gate.setAllowed(true)
  gate.beginRecovery()
  assert.equal(gate.recoveryInProgress, true)
  assert.equal(gate.canRun(), false)
  assert.equal(gate.canSendNetwork(), false)
  gate.endRecovery()
  assert.equal(gate.recoveryInProgress, false)
  assert.equal(gate.canRun(), true)
})

test('recovery failure remains blocked and exposes a retry reason', () => {
  const gate = createStartupSideEffectGate()
  gate.setAllowed(true)
  gate.beginRecovery()
  gate.clearRecoveryBlock()
  assert.equal(gate.canRun(), false)
  gate.failRecovery('remote snapshot unavailable')
  assert.equal(gate.recoveryInProgress, false)
  assert.equal(gate.recoveryBlockReason, 'remote snapshot unavailable')
  assert.equal(gate.canRun(), false)
  gate.setAllowed(true)
  gate.setPermission('allowed')
  assert.equal(gate.canRun(), false)
  gate.beginRecovery()
  gate.clearRecoveryBlock()
  gate.endRecovery()
  assert.equal(gate.recoveryBlockReason, null)
  assert.equal(gate.canRun(), true)
})

test('recovery failures retain actionable evidence for each guarded failure class', () => {
  const reasons = [
    'document-provider-probe-failed:database-directory-read-failed',
    'document-epoch-evidence-malformed:document-epoch:file:note',
    'document-recovery-outbox-cas-mismatch:outbox-1',
    'document-recovery-token-missing',
    'document-recovery-local-store-unavailable',
  ]
  for (const reason of reasons) {
    const gate = createStartupSideEffectGate()
    gate.beginRecovery()
    gate.failRecovery(reason)
    assert.equal(gate.canRun(), false)
    assert.equal(gate.canSendNetwork(), false)
    assert.equal(gate.recoveryBlockReason, reason)
  }
})
