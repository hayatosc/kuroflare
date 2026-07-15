import { assert, test } from 'vitest'

import {
  blobHeadHashBatches,
  blobHeadEntryMatchesChunk,
  activeMarkdownBindingMatches,
  clearPendingFsRename,
  consumePendingFsRename,
  deferStartupReplan,
  markPendingFsRename,
  metaPersistenceDatabaseName,
  MAX_BLOB_HEAD_HASHES_PER_REQUEST,
} from './runtime-guards'

test('meta persistence is scoped to the vault identity', () => {
  assert.notEqual(metaPersistenceDatabaseName('vault-a'), metaPersistenceDatabaseName('vault-b'))
  assert.equal(metaPersistenceDatabaseName('vault-a'), 'kuroflare-meta:vault-a')
})

test('blob head batches keep 513 hashes within the worker request bound', () => {
  const hashes = Array.from(
    { length: MAX_BLOB_HEAD_HASHES_PER_REQUEST + 1 },
    (_, index) => `hash-${index}`,
  )

  const batches = blobHeadHashBatches(hashes)

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [MAX_BLOB_HEAD_HASHES_PER_REQUEST, 1],
  )
  assert.deepEqual(batches.flat(), hashes)
})

test('blob head evidence without an exact size is not restorable evidence', () => {
  assert.equal(blobHeadEntryMatchesChunk({ found: true }, 3), false)
  assert.equal(blobHeadEntryMatchesChunk({ found: true, size: 2 }, 3), false)
  assert.equal(blobHeadEntryMatchesChunk({ found: true, size: 3 }, 3), true)
})

test('remote rename guards are consumed and cleared after the operation settles', () => {
  const pending = new Set<string>()
  const target = markPendingFsRename(pending, 'Folder/Note.md')

  assert.equal(target, 'folder/note.md')
  assert.equal(consumePendingFsRename(pending, 'folder/note.md'), true)
  assert.equal(pending.size, 0)

  markPendingFsRename(pending, 'Folder/Note.md')
  clearPendingFsRename(pending, 'FOLDER/NOTE.md')
  assert.equal(pending.size, 0)
})

test('startup replans are deferred until the lifecycle tick yields', async () => {
  const scheduled: (() => void)[] = []
  let started = false
  let resolveTick!: () => void
  const tick = new Promise<void>((resolve) => {
    resolveTick = resolve
  })

  deferStartupReplan(
    async () => {
      started = true
      await tick
    },
    (callback) => {
      scheduled.push(callback)
    },
  )

  assert.equal(started, false)
  assert.equal(scheduled.length, 1)
  scheduled[0]?.()
  await Promise.resolve()
  assert.equal(started, true)
  resolveTick()
})

test('active binding does not accept a same-view file with a different Y.Doc identity', () => {
  assert.equal(
    activeMarkdownBindingMatches({
      activePath: 'note.md',
      expectedPath: 'note.md',
      activeDocId: 'ydoc-old',
      expectedDocId: 'ydoc-new',
      sameView: true,
    }),
    false,
  )
  assert.equal(
    activeMarkdownBindingMatches({
      activePath: 'note.md',
      expectedPath: 'note.md',
      activeDocId: 'ydoc-new',
      expectedDocId: 'ydoc-new',
      sameView: true,
    }),
    true,
  )
})
