import {
  canonicalizeVaultPath,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import type { KuroflareRepairLogEntry } from '../../main-types'
import {
  planPathConflictAutoResolve,
  planRemoteMaterializeBlockedAutoResolve,
  retryRemoteMaterializeBlockedRepairEntryWithPorts,
  type RemoteMaterializeBlockedRepairPorts,
} from './repair-actions'

const deviceId = makeDeviceId('repair-action-device-1')

test('remote materialize blocked fake harness retries text materialize and clears repair log', async () => {
  const fileId = makeFileId('remote-materialize-text-file')
  const meta = textMeta(fileId, 'Remote/Text.md')
  const harness = new FakeRemoteMaterializeBlockedHarness([[fileId, meta]])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileId, 'path-collision'),
    harness.ports,
  )

  assert.equal(action, 'queued-text')
  assert.deepEqual(harness.requestedText, [meta])
  assert.deepEqual(harness.binaryReasons, [])
  assert.deepEqual(harness.removedRepairEntryIds, [
    'remote-materialize-blocked:remote-materialize-text-file:path-collision',
  ])
  assert.deepEqual(harness.notices, [
    'Kuroflare repair: remote materialize retry queued (Remote/Text.md)',
  ])
})

test('remote materialize blocked retry preserves its repair log when text request is skipped', async () => {
  const fileId = makeFileId('remote-materialize-skipped-text-file')
  const meta = textMeta(fileId, 'Remote/Skipped.md')
  const harness = new FakeRemoteMaterializeBlockedHarness([[fileId, meta]])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileId, 'path-collision'),
    {
      ...harness.ports,
      requestMissingRemoteTextFile: async (entry) => {
        harness.requestedText.push(entry)
        return false
      },
    },
  )

  assert.equal(action, 'skipped-text')
  assert.deepEqual(harness.requestedText, [meta])
  assert.deepEqual(harness.removedRepairEntryIds, [])
  assert.deepEqual(harness.notices, [
    'Kuroflare repair: remote materialize retry skipped (stale or blocked)',
  ])
})

test('remote materialize blocked fake harness retries binary materialize and clears repair log', async () => {
  const fileId = makeFileId('remote-materialize-binary-file')
  const meta = binaryMeta(fileId, 'Remote/Image.png')
  const harness = new FakeRemoteMaterializeBlockedHarness([[fileId, meta]])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileId, 'parent-collision'),
    harness.ports,
  )

  assert.equal(action, 'queued-binary')
  assert.deepEqual(harness.requestedText, [])
  assert.deepEqual(harness.binaryReasons, ['repair:remote-materialize-retry'])
  assert.deepEqual(harness.removedRepairEntryIds, [
    'remote-materialize-blocked:remote-materialize-binary-file:parent-collision',
  ])
  assert.deepEqual(harness.notices, [
    'Kuroflare repair: remote materialize retry queued (Remote/Image.png)',
  ])
})

test('remote materialize blocked retry preserves its repair log when binary enqueue is skipped', async () => {
  const fileId = makeFileId('remote-materialize-skipped-binary-file')
  const meta = binaryMeta(fileId, 'Remote/Skipped.png')
  const harness = new FakeRemoteMaterializeBlockedHarness([[fileId, meta]])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileId, 'parent-collision'),
    {
      ...harness.ports,
      enqueueMissingRemoteBinaryDownloads: async (reason) => {
        harness.binaryReasons.push(reason)
        return new Set()
      },
    },
  )

  assert.equal(action, 'skipped-binary')
  assert.deepEqual(harness.binaryReasons, ['repair:remote-materialize-retry'])
  assert.deepEqual(harness.removedRepairEntryIds, [])
  assert.deepEqual(harness.notices, [
    'Kuroflare repair: remote binary materialize retry skipped or blocked',
  ])
})

test('remote materialize blocked retry keeps A repair when only binary B succeeds', async () => {
  const fileIdA = makeFileId('remote-materialize-binary-file-a')
  const fileIdB = makeFileId('remote-materialize-binary-file-b')
  const metaA = binaryMeta(fileIdA, 'Remote/A.png')
  const metaB = binaryMeta(fileIdB, 'Remote/B.png')
  const harness = new FakeRemoteMaterializeBlockedHarness([
    [fileIdA, metaA],
    [fileIdB, metaB],
  ])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileIdA, 'parent-collision'),
    {
      ...harness.ports,
      enqueueMissingRemoteBinaryDownloads: async (reason) => {
        harness.binaryReasons.push(reason)
        return new Set([fileIdB])
      },
    },
  )

  assert.equal(action, 'skipped-binary')
  assert.deepEqual(harness.removedRepairEntryIds, [])
})

test('remote materialize blocked fake harness clears stale entries without enqueueing work', async () => {
  const fileId = makeFileId('remote-materialize-stale-file')
  const harness = new FakeRemoteMaterializeBlockedHarness([])
  const action = await retryRemoteMaterializeBlockedRepairEntryWithPorts(
    repairEntry(fileId, 'invalid-path'),
    harness.ports,
  )

  assert.equal(action, 'cleared-stale')
  assert.deepEqual(harness.requestedText, [])
  assert.deepEqual(harness.binaryReasons, [])
  assert.deepEqual(harness.removedRepairEntryIds, [
    'remote-materialize-blocked:remote-materialize-stale-file:invalid-path',
  ])
  assert.deepEqual(harness.notices, ['Kuroflare repair: stale remote materialize entry cleared'])
})

test('remote materialize blocked auto resolve plans conflict path for text entries', () => {
  const fileId = makeFileId('remote-materialize-auto-file')
  const meta = textMeta(fileId, 'Folder/Remote.md')

  assert.deepEqual(
    planRemoteMaterializeBlockedAutoResolve({
      entry: repairEntry(fileId, 'path-collision'),
      current: meta,
      isPathAvailable: (path) =>
        path.endsWith('Remote (conflict remote-materialize-auto-file-2).md'),
    }),
    {
      action: 'rename-meta-path',
      fromPath: 'Folder/Remote.md',
      toPath: 'Folder/Remote (conflict remote-materialize-auto-file-2).md',
      toCanonicalPath: 'folder/remote (conflict remote-materialize-auto-file-2).md',
    },
  )
})

test('remote materialize blocked auto resolve rejects unsupported and stale cases', () => {
  const fileId = makeFileId('remote-materialize-auto-stale-file')

  assert.deepEqual(
    planRemoteMaterializeBlockedAutoResolve({
      entry: repairEntry(fileId, 'invalid-path'),
      current: textMeta(fileId, 'Remote.md'),
      isPathAvailable: () => true,
    }),
    { action: 'unsupported-reason', reason: 'invalid-path' },
  )
  assert.deepEqual(
    planRemoteMaterializeBlockedAutoResolve({
      entry: repairEntry(fileId, 'path-collision'),
      current: undefined,
      isPathAvailable: () => true,
    }),
    { action: 'stale' },
  )
  assert.deepEqual(
    planRemoteMaterializeBlockedAutoResolve({
      entry: repairEntry(fileId, 'path-collision'),
      current: binaryMeta(fileId, 'Remote.bin'),
      isPathAvailable: () => true,
    }),
    { action: 'unsupported-meta-type', type: 'binary' },
  )
})

test('path conflict auto resolve plans alternate conflict path', () => {
  const fileId = makeFileId('path-conflict-auto-file')
  const meta = textMeta(fileId, 'Shared.md')

  assert.deepEqual(
    planPathConflictAutoResolve({
      entry: { ...repairEntry(fileId, 'rename-materialize-failed'), kind: 'path-conflict' },
      current: meta,
      isPathAvailable: (path) => path === 'Shared (conflict path-conflict-auto-file).md',
    }),
    {
      action: 'rename-meta-path',
      fromPath: 'Shared.md',
      toPath: 'Shared (conflict path-conflict-auto-file).md',
      toCanonicalPath: 'shared (conflict path-conflict-auto-file).md',
    },
  )
})

test('path conflict auto resolve clears stale entries', () => {
  const fileId = makeFileId('path-conflict-stale-file')

  assert.deepEqual(
    planPathConflictAutoResolve({
      entry: { ...repairEntry(fileId, 'rename-materialize-failed'), kind: 'path-conflict' },
      current: undefined,
      isPathAvailable: () => true,
    }),
    { action: 'stale' },
  )
})

class FakeRemoteMaterializeBlockedHarness {
  readonly meta = new Map<string, MetaFile>()
  readonly requestedText: MetaFile[] = []
  readonly binaryReasons: string[] = []
  readonly removedRepairEntryIds: string[] = []
  readonly notices: string[] = []

  readonly ports: RemoteMaterializeBlockedRepairPorts = {
    getMetaEntry: (fileId) => this.meta.get(fileId),
    requestMissingRemoteTextFile: async (entry) => {
      this.requestedText.push(entry)
      return true
    },
    enqueueMissingRemoteBinaryDownloads: async (reason) => {
      this.binaryReasons.push(reason)
      return new Set(
        [...this.meta.values()]
          .filter((entry) => !entry.deleted && entry.type === 'binary')
          .map((entry) => entry.fileId),
      )
    },
    removeRepairLogEntry: async (entryId) => {
      this.removedRepairEntryIds.push(entryId)
    },
    showNotice: (message) => {
      this.notices.push(message)
    },
  }

  constructor(entries: readonly (readonly [string, MetaFile])[]) {
    for (const [fileId, entry] of entries) {
      this.meta.set(fileId, entry)
    }
  }
}

function repairEntry(fileId: string, reason: string): KuroflareRepairLogEntry {
  return {
    id: `remote-materialize-blocked:${fileId}:${reason}`,
    kind: 'remote-materialize-blocked',
    fileId,
    path: 'Remote/Text.md',
    reason,
    createdAt: 1,
  }
}

function textMeta(fileId: ReturnType<typeof makeFileId>, path: string): MetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: canonicalizeVaultPath(path),
    type: 'text',
    ydocId: makeYDocId(`doc-${fileId}`),
    deleted: false,
    createdAt: 1,
    createdBy: deviceId,
    contentUpdatedAt: 2,
    contentUpdatedBy: deviceId,
    updatedAt: 3,
    updatedBy: deviceId,
    mtime: 4,
  }
}

function binaryMeta(fileId: ReturnType<typeof makeFileId>, path: string): MetaFile {
  const chunk = makeSha256Hex('a'.repeat(64))
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: canonicalizeVaultPath(path),
    type: 'binary',
    blobManifestHash: makeSha256Hex('b'.repeat(64)),
    blobChunks: [chunk],
    deleted: false,
    createdAt: 1,
    createdBy: deviceId,
    contentUpdatedAt: 2,
    contentUpdatedBy: deviceId,
    updatedAt: 3,
    updatedBy: deviceId,
    mtime: 4,
  }
}
