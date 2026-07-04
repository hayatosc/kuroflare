import { assert, test } from 'vitest'

import {
  canonicalizeTextForHash,
  canonicalizeTextForYText,
  computeMinimalTextReplacement,
  hashBytesSha256,
  hashCanonicalText,
} from '../index'

test('canonicalizeTextForYText removes BOM and normalizes line endings', () => {
  assert.equal(canonicalizeTextForYText('\uFEFFa\r\nb\r'), 'a\nb\n')
  assert.equal(canonicalizeTextForYText('note'), 'note')
})

test('canonicalizeTextForHash removes BOM and normalizes line endings', () => {
  assert.equal(canonicalizeTextForHash('\uFEFFa\r\nb\r'), 'a\nb\n')
})

test('hashCanonicalText uses canonical SHA-256', async () => {
  assert.equal(await hashCanonicalText('a\r\nb'), await hashCanonicalText('\uFEFFa\nb\n'))
  assert.equal(
    await hashCanonicalText(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
})

test('hashBytesSha256 hashes arbitrary bytes', async () => {
  assert.equal(
    await hashBytesSha256(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('canonicalizeTextForHash normalizes a single terminal newline', () => {
  assert.equal(canonicalizeTextForHash('note'), 'note\n')
  assert.equal(canonicalizeTextForHash('note\n'), 'note\n')
  assert.equal(canonicalizeTextForHash(''), '')
})

test('computeMinimalTextReplacement returns null for equal text', () => {
  assert.equal(computeMinimalTextReplacement('same', 'same'), null)
})

test('computeMinimalTextReplacement handles middle replacement', () => {
  assert.deepEqual(computeMinimalTextReplacement('abcXYZdef', 'abc123def'), {
    from: 3,
    deleteLength: 3,
    insert: '123',
  })
})

test('computeMinimalTextReplacement handles insertion and deletion', () => {
  assert.deepEqual(computeMinimalTextReplacement('abef', 'abcdef'), {
    from: 2,
    deleteLength: 0,
    insert: 'cd',
  })
  assert.deepEqual(computeMinimalTextReplacement('abcdef', 'abef'), {
    from: 2,
    deleteLength: 2,
    insert: '',
  })
})

test('computeMinimalTextReplacement handles complete replacement', () => {
  assert.deepEqual(computeMinimalTextReplacement('left', 'righT'), {
    from: 0,
    deleteLength: 4,
    insert: 'righT',
  })
})
