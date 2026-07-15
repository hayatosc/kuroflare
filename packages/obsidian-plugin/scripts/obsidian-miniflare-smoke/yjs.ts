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
  for (const entry of entries) {
    setMetaEntry(doc, entry)
  }
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function setMetaEntry(doc: Y.Doc, entry: JsonRecord): void {
  const fileId = requiredString(entry, 'fileId')
  const type = requiredString(entry, 'type')
  if (type !== 'text' && type !== 'binary') {
    throw new Error(`meta snapshot entry type is unsupported: ${type}`)
  }
  if (type === 'text' && typeof entry.ydocId !== 'string') {
    throw new Error('text meta snapshot entry is missing ydocId')
  }
  const child = new Y.Map<unknown>()
  child.set('identity', {
    schemaVersion: 2,
    fileId,
    type,
    ...(typeof entry.ydocId === 'string' ? { ydocId: entry.ydocId } : {}),
    createdAt: requiredNumber(entry, 'createdAt'),
    createdBy: requiredString(entry, 'createdBy'),
  })
  child.set('location', {
    path: requiredString(entry, 'path'),
    canonicalPath: requiredString(entry, 'canonicalPath'),
    updatedAt: requiredNumber(entry, 'updatedAt'),
    updatedBy: requiredString(entry, 'updatedBy'),
    mtime: requiredNumber(entry, 'mtime'),
  })
  child.set('content', {
    contentUpdatedAt: requiredNumber(entry, 'contentUpdatedAt'),
    contentUpdatedBy: requiredString(entry, 'contentUpdatedBy'),
    ...(type === 'binary'
      ? {
          blobManifestHash: requiredString(entry, 'blobManifestHash'),
          blobChunks: requiredStringArray(entry, 'blobChunks'),
        }
      : {}),
  })
  child.set(
    'deletion',
    entry.deleted === true
      ? {
          deleted: true,
          deletedAt: requiredNumber(entry, 'deletedAt'),
          deletedBy: requiredString(entry, 'deletedBy'),
        }
      : { deleted: false },
  )
  doc.getMap('meta').set(fileId, child)
}

function metaPaths(doc: Y.Doc): [string, unknown][] {
  return [...doc.getMap<unknown>('meta').entries()]
    .map(([fileId, value]) => {
      const location = value instanceof Y.Map ? value.get('location') : undefined
      return [String(fileId), isJsonRecord(location) ? location.path : undefined] as [
        string,
        unknown,
      ]
    })
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
  if (!(entry instanceof Y.Map)) {
    throw new Error(`remote meta entry missing for ${fileId}`)
  }
  const identity = entry.get('identity')
  const location = entry.get('location')
  if (
    typeof identity !== 'object' ||
    identity === null ||
    !isJsonRecord(identity) ||
    identity.type !== 'text' ||
    typeof location !== 'object' ||
    location === null
  ) {
    throw new Error(`remote meta entry is not a text grouped entry for ${fileId}`)
  }
  if (!isJsonRecord(location)) {
    throw new Error(`remote meta location is not a plain object for ${fileId}`)
  }
  entry.set('location', {
    ...location,
    path: toPath,
    canonicalPath: canonicalizeVaultPath(toPath),
    updatedAt: now,
    updatedBy: deviceId,
  })
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(entry: JsonRecord, key: string): string {
  const value = entry[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`meta snapshot entry field ${key} must be a non-empty string`)
  }
  return value
}

function requiredNumber(entry: JsonRecord, key: string): number {
  const value = entry[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`meta snapshot entry field ${key} must be a non-negative integer`)
  }
  return value
}

function requiredStringArray(entry: JsonRecord, key: string): string[] {
  const value = entry[key]
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`meta snapshot entry field ${key} must be a non-empty string array`)
  }
  return [...value]
}

export {
  encodeBase64,
  decodeBase64,
  sha256Hex,
  activeDocIdForPath,
  makeYTextUpdate,
  makeMetaSnapshotUpdate,
  setMetaEntry,
  metaPaths,
  renameMetaEntry,
}
