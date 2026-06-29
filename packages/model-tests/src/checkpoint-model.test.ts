import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  appendInvalidUpdate,
  appendLargeUpdateViaDirectSnapshot,
  appendValidUpdate,
  appendValidUpdateWithMessage,
  assertModelInvariants,
  coldStart,
  coldStartWithStalePointerRead,
  compactCheckpoint,
  corruptCurrentPointerSnapshot,
  createModelState,
  replayCompactedDuplicateWithoutDedup,
  startCheckpoint,
  updateCheckpointPointer,
  writeCheckpointSnapshot,
  type MessageId,
  type RunId,
  type UpdateId,
} from './checkpoint-model'

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

test('checkpoint model preserves acknowledged updates through deterministic crash points', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  const second = appendValidUpdate(state)
  const runId = startCheckpoint(state)
  assert(runId)

  writeCheckpointSnapshot(state, runId)
  assertModelInvariants(state)

  updateCheckpointPointer(state, runId)
  assertModelInvariants(state)

  compactCheckpoint(state, runId)
  assertModelInvariants(state)

  const restored = coldStart(state)
  assert(restored.updates.has(first.updateId))
  assert(restored.updates.has(second.updateId))
})

test('duplicate message ids do not append duplicate logical updates', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  appendValidUpdateWithMessage(state, 'duplicate-should-not-apply', first.messageId)

  assert.equal(state.ackedValid.size, 1)
  assertModelInvariants(state)
})

test('duplicate replay after compaction does not change restored content', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  const runId = startCheckpoint(state)
  assert(runId)
  writeCheckpointSnapshot(state, runId)
  updateCheckpointPointer(state, runId)
  compactCheckpoint(state, runId)

  const before = coldStart(state)
  const nextSeqBeforeReplay = state.nextSeq
  const replay = replayCompactedDuplicateWithoutDedup(state, first.updateId, first.messageId)
  const after = coldStart(state)

  assert.equal(replay.replayed, true)
  assert.equal(state.nextSeq, nextSeqBeforeReplay + 1)
  assert.deepEqual(after.updates, before.updates)
  assertModelInvariants(state)
})

test('duplicate replay before compaction is still handled by live dedup', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  const replay = replayCompactedDuplicateWithoutDedup(state, first.updateId, first.messageId)

  assert.equal(replay.replayed, false)
  assertModelInvariants(state)
})

test('invalid updates are quarantined and never restored', () => {
  const state = createModelState()
  const invalid = appendInvalidUpdate(state)
  appendValidUpdate(state)
  const runId = startCheckpoint(state)
  assert(runId)
  writeCheckpointSnapshot(state, runId)
  updateCheckpointPointer(state, runId)
  compactCheckpoint(state, runId)

  assert(!coldStart(state).updates.has(invalid.updateId))
  assertModelInvariants(state)
})

test('stale pointer reads fall back to the latest healthy listed snapshot', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  const firstRun = startCheckpoint(state)
  assert(firstRun)
  writeCheckpointSnapshot(state, firstRun)
  updateCheckpointPointer(state, firstRun)
  compactCheckpoint(state, firstRun)

  const second = appendValidUpdate(state)
  const secondRun = startCheckpoint(state)
  assert(secondRun)
  writeCheckpointSnapshot(state, secondRun)
  updateCheckpointPointer(state, secondRun)
  compactCheckpoint(state, secondRun)

  const restored = coldStartWithStalePointerRead(state)
  assert(restored.updates.has(first.updateId))
  assert(restored.updates.has(second.updateId))
  assertModelInvariants(state)
})

test('corrupt latest snapshots fall back to retained healthy generations', () => {
  const state = createModelState()
  const first = appendValidUpdate(state)
  const firstRun = startCheckpoint(state)
  assert(firstRun)
  writeCheckpointSnapshot(state, firstRun)
  updateCheckpointPointer(state, firstRun)
  compactCheckpoint(state, firstRun)

  const second = appendValidUpdate(state)
  const secondRun = startCheckpoint(state)
  assert(secondRun)
  writeCheckpointSnapshot(state, secondRun)
  updateCheckpointPointer(state, secondRun)
  corruptCurrentPointerSnapshot(state)

  const restored = coldStart(state)
  assert(restored.updates.has(first.updateId))
  assert(restored.updates.has(second.updateId))
  assertModelInvariants(state)
})

test('random operation sequences preserve checkpoint/cold-start invariants', () => {
  for (let seed = 1; seed <= 1000; seed += 1) {
    const state = createModelState()
    const rng = new XorShift32(seed)
    const knownRuns: RunId[] = []
    const knownMessages: Array<{ readonly updateId: UpdateId; readonly messageId: MessageId }> = []

    try {
      for (let step = 0; step < 80; step += 1) {
        switch (rng.nextInt(13)) {
          case 0:
          case 1:
          case 2: {
            const result = appendValidUpdate(state)
            knownMessages.push(result)
            break
          }
          case 3: {
            appendInvalidUpdate(state)
            break
          }
          case 4: {
            const runId = startCheckpoint(state)
            if (runId) {
              knownRuns.push(runId)
            }
            break
          }
          case 5: {
            const runId = choose(knownRuns, rng)
            if (runId) {
              writeCheckpointSnapshot(state, runId)
            }
            break
          }
          case 6: {
            const runId = choose(knownRuns, rng)
            if (runId) {
              updateCheckpointPointer(state, runId)
            }
            break
          }
          case 7: {
            const runId = choose(knownRuns, rng)
            if (runId) {
              compactCheckpoint(state, runId)
            }
            break
          }
          case 8: {
            const message = choose(knownMessages, rng)
            if (message) {
              appendValidUpdateWithMessage(state, 'duplicate-random', message.messageId)
            }
            break
          }
          case 9: {
            appendLargeUpdateViaDirectSnapshot(state)
            break
          }
          case 10: {
            coldStartWithStalePointerRead(state)
            break
          }
          case 11: {
            corruptCurrentPointerSnapshot(state)
            break
          }
          case 12: {
            const message = choose(knownMessages, rng)
            if (message) {
              replayCompactedDuplicateWithoutDedup(state, message.updateId, message.messageId)
            }
            break
          }
          default: {
            throw new Error('unreachable operation')
          }
        }

        coldStart(state)
        assertModelInvariants(state)
      }
    } catch (error) {
      throw new Error(`checkpoint model failed for seed=${seed}`, {
        cause: error,
      })
    }
  }
})

function choose<T>(items: readonly T[], rng: RandomSource): T | null {
  if (items.length === 0) {
    return null
  }

  return items[rng.nextInt(items.length)] ?? null
}
