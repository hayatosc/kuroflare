import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  applySyncUpdateModelMessage,
  assertSyncUpdateModelInvariants,
  compactSyncUpdateModelThrough,
  createSyncUpdateModelMessage,
  createSyncUpdateModelState,
  expireSyncUpdateDedupForMessage,
  restoredSyncUpdateContent,
  type SyncUpdateModelMessage,
} from './sync-update-model'

interface RandomSource {
  nextInt(exclusiveMax: number): number
}

class XorShift32 implements RandomSource {
  private state: number

  constructor(seed: number) {
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0
  }

  nextInt(exclusiveMax: number): number {
    assert(exclusiveMax > 0)
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state % exclusiveMax
  }
}

test('sync update model does not allocate new seqs for duplicate retries', () => {
  const state = createSyncUpdateModelState(100)
  const message = createSyncUpdateModelMessage(state, 50)

  const first = applySyncUpdateModelMessage(state, message)
  assert.equal(first.action, 'append-op')
  assert.equal(state.latestSeq, 1)

  const retry = applySyncUpdateModelMessage(state, message)
  assert.equal(retry.action, 'ack-duplicate')
  assert.equal(state.latestSeq, 1)
  assertSyncUpdateModelInvariants(state)
})

test('sync update model routes large updates to snapshots without op_log rows', () => {
  const state = createSyncUpdateModelState(100)
  const message = createSyncUpdateModelMessage(state, 101)

  const decision = applySyncUpdateModelMessage(state, message)
  assert.equal(decision.action, 'snapshot-escape')
  assert.equal(state.latestSeq, 1)
  assert.equal(state.latestSnapshotSeq, 1)
  assert.equal(state.opLogSeqs.size, 0)
  assert.equal(state.snapshotSeqs.has(1), true)
  assertSyncUpdateModelInvariants(state)
})

test('sync update model preserves restored content after compacted dedup expiry replay', () => {
  const state = createSyncUpdateModelState(100)
  const message = createSyncUpdateModelMessage(state, 50)

  const first = applySyncUpdateModelMessage(state, message)
  assert.equal(first.action, 'append-op')
  const beforeReplay = restoredSyncUpdateContent(state)

  compactSyncUpdateModelThrough(state, state.latestSeq)
  assert.equal(expireSyncUpdateDedupForMessage(state, message), true)

  const replay = applySyncUpdateModelMessage(state, message)
  assert.equal(replay.action, 'append-op')
  assert.equal(state.latestSeq, 2)
  assert.deepEqual(restoredSyncUpdateContent(state), beforeReplay)
  assertSyncUpdateModelInvariants(state)
})

test('random sync update append sequences preserve clock and duplicate invariants', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const state = createSyncUpdateModelState(128)
    const rng = new XorShift32(seed)
    const messages: SyncUpdateModelMessage[] = []

    try {
      for (let step = 0; step < 100; step += 1) {
        const operation = rng.nextInt(8)
        if (operation <= 2 || messages.length === 0) {
          const updateBytesLength = operation === 2 ? 129 + rng.nextInt(512) : 1 + rng.nextInt(128)
          const message = createSyncUpdateModelMessage(state, updateBytesLength)
          messages.push(message)
          applySyncUpdateModelMessage(state, message)
        } else if (operation <= 4) {
          const message = messages[rng.nextInt(messages.length)]
          assert(message)
          const beforeSeq = state.latestSeq
          const decision = applySyncUpdateModelMessage(state, message)
          if (decision.action === 'ack-duplicate') {
            assert.equal(state.latestSeq, beforeSeq)
          } else {
            assert.equal(decision.action, 'append-op')
            assert.equal(state.latestSeq, beforeSeq + 1)
          }
        } else if (operation === 5) {
          if (state.latestSeq > 0) {
            compactSyncUpdateModelThrough(state, 1 + rng.nextInt(state.latestSeq))
          }
        } else {
          const message = messages[rng.nextInt(messages.length)]
          if (message) {
            const beforeContent = restoredSyncUpdateContent(state)
            expireSyncUpdateDedupForMessage(state, message)
            const decision = applySyncUpdateModelMessage(state, message)
            if (decision.action === 'append-op') {
              assert.deepEqual(restoredSyncUpdateContent(state), beforeContent)
            }
          }
        }

        assertSyncUpdateModelInvariants(state)
      }
    } catch (error) {
      throw new Error(`sync update model failed for seed=${seed}`, { cause: error })
    }
  }
})
