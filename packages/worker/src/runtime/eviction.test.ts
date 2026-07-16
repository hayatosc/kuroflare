import { assert, test } from 'vitest'

import {
  decideDocEviction,
  decideDocLoadAdmission,
  type DocEvictionInput,
  type DocLoadAdmissionInput,
} from './eviction'

function input(overrides: Partial<DocEvictionInput>): DocEvictionInput {
  return {
    isMeta: false,
    checkpointed: true,
    activeSocketCount: 0,
    lastAccessedAt: 0,
    now: 10_000,
    idleThresholdMs: 5_000,
    ...overrides,
  }
}

test('doc eviction never evicts the meta doc', () => {
  assert.deepEqual(decideDocEviction(input({ isMeta: true })), {
    action: 'keep',
    reason: 'meta-doc',
  })
})

test('doc eviction keeps file docs that still have uncheckpointed ops', () => {
  assert.deepEqual(decideDocEviction(input({ checkpointed: false })), {
    action: 'keep',
    reason: 'not-checkpointed',
  })
})

test('doc eviction keeps file docs referenced by a currently connected socket', () => {
  assert.deepEqual(decideDocEviction(input({ activeSocketCount: 1 })), {
    action: 'keep',
    reason: 'active-sockets',
  })
})

test('doc eviction keeps file docs accessed more recently than the idle threshold', () => {
  assert.deepEqual(decideDocEviction(input({ lastAccessedAt: 6_000 })), {
    action: 'keep',
    reason: 'recently-accessed',
  })
})

test('doc eviction rejects malformed clocks instead of evicting', () => {
  assert.deepEqual(decideDocEviction(input({ idleThresholdMs: -1 })), {
    action: 'keep',
    reason: 'invalid-clock',
  })
  assert.deepEqual(decideDocEviction(input({ lastAccessedAt: Number.NaN })), {
    action: 'keep',
    reason: 'invalid-clock',
  })
})

test('doc eviction evicts checkpointed, unreferenced, idle file docs', () => {
  assert.deepEqual(decideDocEviction(input({ lastAccessedAt: 5_000 })), { action: 'evict' })
  assert.deepEqual(decideDocEviction(input({ lastAccessedAt: 0 })), { action: 'evict' })
})

function admissionInput(overrides: Partial<DocLoadAdmissionInput>): DocLoadAdmissionInput {
  return {
    isMeta: false,
    alreadyHydrated: false,
    hydratedFileDocCount: 0,
    maxHydratedFileDocs: 2,
    ...overrides,
  }
}

test('doc load admission always admits the meta doc', () => {
  assert.deepEqual(
    decideDocLoadAdmission(admissionInput({ isMeta: true, hydratedFileDocCount: 2 })),
    { action: 'admit' },
  )
})

test('doc load admission always admits re-entrant access to an already-resident doc', () => {
  assert.deepEqual(
    decideDocLoadAdmission(admissionInput({ alreadyHydrated: true, hydratedFileDocCount: 2 })),
    { action: 'admit' },
  )
})

test('doc load admission admits a new file doc while under capacity', () => {
  assert.deepEqual(decideDocLoadAdmission(admissionInput({ hydratedFileDocCount: 1 })), {
    action: 'admit',
  })
})

test('doc load admission degrades a new file doc load once the room is at capacity', () => {
  assert.deepEqual(decideDocLoadAdmission(admissionInput({ hydratedFileDocCount: 2 })), {
    action: 'degraded',
  })
})
