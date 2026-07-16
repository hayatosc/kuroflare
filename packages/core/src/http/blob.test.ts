import { assert, test } from 'vitest'

import { blobMultipartPartByteSize, blobMultipartPartCount } from './blob'

const PART_SIZE = 8 * 1024 * 1024

test('blobMultipartPartCount splits by fixed part size and floors at one part', () => {
  assert.equal(blobMultipartPartCount(0, PART_SIZE), 1)
  assert.equal(blobMultipartPartCount(1, PART_SIZE), 1)
  assert.equal(blobMultipartPartCount(PART_SIZE, PART_SIZE), 1)
  assert.equal(blobMultipartPartCount(PART_SIZE + 1, PART_SIZE), 2)
  assert.equal(blobMultipartPartCount(PART_SIZE * 10, PART_SIZE), 10)
})

test('blobMultipartPartByteSize fixes every part except the trailing remainder', () => {
  const size = PART_SIZE * 2 + 100
  const partCount = blobMultipartPartCount(size, PART_SIZE)

  assert.equal(partCount, 3)
  assert.equal(blobMultipartPartByteSize(size, PART_SIZE, 1, partCount), PART_SIZE)
  assert.equal(blobMultipartPartByteSize(size, PART_SIZE, 2, partCount), PART_SIZE)
  assert.equal(blobMultipartPartByteSize(size, PART_SIZE, 3, partCount), 100)

  // All parts sum back to the declared size, which is what the client independently
  // reconstructs from `size` and `parts.length` alone (the wire response carries no
  // byte ranges), so client and server must derive identical boundaries.
  let total = 0
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    total += blobMultipartPartByteSize(size, PART_SIZE, partNumber, partCount)
  }
  assert.equal(total, size)
})
