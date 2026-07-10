import { createHash } from 'node:crypto'

import * as Y from 'yjs'

import { yTextName, canonicalizeVaultPath } from './types.ts'
import type { FileDocId, JsonRecord } from './types.ts'

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}

function activeDocIdForPath(path: string): FileDocId {
  const hash = createHash('sha256').update(path).digest('hex')
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

function makeYTextUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText(yTextName).insert(0, text)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function makeMetaSnapshotUpdate(entries: readonly JsonRecord[]): Uint8Array {
  const doc = new Y.Doc()
  const map = doc.getMap('meta')
  for (const entry of entries) {
    const fileId = entry.fileId
    if (typeof fileId !== 'string') {
      throw new Error(`meta snapshot entry missing fileId: ${JSON.stringify(entry)}`)
    }
    map.set(fileId, entry)
  }
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function metaPaths(doc: Y.Doc): [string, unknown][] {
  return [...doc.getMap('meta').entries()]
    .map(
      ([fileId, value]) =>
        [
          String(fileId),
          typeof value === 'object' && value !== null ? Reflect.get(value, 'path') : undefined,
        ] as [string, unknown],
    )
    .sort(([left], [right]) => left.localeCompare(right))
}

function renameMetaEntry(
  doc: Y.Doc,
  fileId: string,
  toPath: string,
  deviceId: string,
  now: number,
): void {
  const map = doc.getMap('meta')
  const entry = map.get(fileId)
  if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'type') !== 'text') {
    throw new Error(`remote meta entry missing for ${fileId}`)
  }
  map.set(fileId, {
    ...entry,
    path: toPath,
    canonicalPath: canonicalizeVaultPath(toPath),
    updatedAt: now,
    updatedBy: deviceId,
    mtime: now,
  })
}

export {
  encodeBase64,
  decodeBase64,
  sha256Hex,
  activeDocIdForPath,
  makeYTextUpdate,
  makeMetaSnapshotUpdate,
  metaPaths,
  renameMetaEntry,
}
