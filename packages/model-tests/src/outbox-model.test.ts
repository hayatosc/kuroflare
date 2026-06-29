import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  assertOutboxInvariants,
  canRun,
  completeItem,
  createOutboxState,
  enqueueBinaryDownload,
  enqueueBinaryUpload,
  failItem,
  retryItem,
  type OutboxItemId,
} from './outbox-model.js'

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

test('binary upload does not publish meta before chunks and manifest', () => {
  const state = createOutboxState()
  const plan = enqueueBinaryUpload(state, 2)

  completeItem(state, plan.metaRefUpdate)
  assert.equal(state.publishedMetaRefs.has(plan.fileId), false)

  for (const id of plan.chunkPuts) {
    completeItem(state, id)
  }
  completeItem(state, plan.metaRefUpdate)
  assert.equal(state.publishedMetaRefs.has(plan.fileId), false)

  completeItem(state, plan.manifestPut)
  completeItem(state, plan.metaRefUpdate)
  assert.equal(state.publishedMetaRefs.has(plan.fileId), true)
  assertOutboxInvariants(state)
})

test('binary download does not materialize before all chunks are verified', () => {
  const state = createOutboxState()
  const plan = enqueueBinaryDownload(state, 2)

  completeItem(state, plan.materialize)
  assert.equal(state.materializedFiles.has(plan.fileId), false)

  completeItem(state, plan.chunkGets[0] ?? 'missing-chunk-get-0')
  completeItem(state, plan.materialize)
  assert.equal(state.materializedFiles.has(plan.fileId), false)

  completeItem(state, plan.chunkGets[1] ?? 'missing-chunk-get-1')
  completeItem(state, plan.materialize)
  assert.equal(state.materializedFiles.has(plan.fileId), true)
  assertOutboxInvariants(state)
})

test('permanent failures block dependent work', () => {
  const state = createOutboxState()
  const upload = enqueueBinaryUpload(state, 1)
  const chunkPut = upload.chunkPuts[0]
  assert(chunkPut)

  failItem(state, chunkPut)

  assert.equal(canRun(state, upload.manifestPut), false)
  assert.equal(canRun(state, upload.metaRefUpdate), false)
  assertOutboxInvariants(state)
})

test('retrying dependencies do not unblock dependents', () => {
  const state = createOutboxState()
  const upload = enqueueBinaryUpload(state, 1)
  const chunkPut = upload.chunkPuts[0]
  assert(chunkPut)

  retryItem(state, chunkPut)
  completeItem(state, upload.manifestPut)
  completeItem(state, upload.metaRefUpdate)

  assert.equal(state.publishedMetaRefs.has(upload.fileId), false)
  assertOutboxInvariants(state)
})

test('random outbox operation sequences preserve dependency invariants', () => {
  for (let seed = 1; seed <= 5_000; seed += 1) {
    const state = createOutboxState()
    const rng = new XorShift32(seed)
    const knownItems: OutboxItemId[] = []

    try {
      for (let step = 0; step < 80; step += 1) {
        switch (rng.nextInt(7)) {
          case 0: {
            const plan = enqueueBinaryUpload(state, rng.nextInt(4))
            knownItems.push(...plan.chunkPuts, plan.manifestPut, plan.metaRefUpdate)
            break
          }
          case 1: {
            const plan = enqueueBinaryDownload(state, rng.nextInt(4))
            knownItems.push(...plan.chunkGets, plan.materialize)
            break
          }
          case 2: {
            const id = choose(knownItems, rng)
            if (id) {
              completeItem(state, id)
            }
            break
          }
          case 3: {
            const id = choose(knownItems, rng)
            if (id) {
              retryItem(state, id)
            }
            break
          }
          case 4: {
            const id = choose(knownItems, rng)
            if (id) {
              failItem(state, id)
            }
            break
          }
          default: {
            break
          }
        }

        assertOutboxInvariants(state)
      }
    } catch (error) {
      throw new Error(`seed ${seed} failed`, { cause: error })
    }
  }
})

function choose<T>(values: readonly T[], rng: RandomSource): T | null {
  if (values.length === 0) {
    return null
  }
  return values[rng.nextInt(values.length)] ?? null
}
