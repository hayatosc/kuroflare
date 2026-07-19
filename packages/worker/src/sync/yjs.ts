import {
  decodeMetaValue,
  FileIdSchema,
  groupedEntryFromMetaFile,
  type MetaValueDisposition,
} from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

export function stateVectorCoversHorizon(
  clientStateVector: Uint8Array,
  horizonStateVector: Uint8Array | undefined,
): boolean {
  if (horizonStateVector === undefined || horizonStateVector.byteLength === 0) {
    return true
  }

  try {
    const client = Y.decodeStateVector(clientStateVector)
    const horizon = Y.decodeStateVector(horizonStateVector)
    for (const [clientId, horizonClock] of horizon) {
      if ((client.get(clientId) ?? 0) < horizonClock) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function canApplyYjsUpdate(updateBytes: Uint8Array): boolean {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, updateBytes)
    return true
  } catch {
    return false
  } finally {
    candidate.destroy()
  }
}

/** Validates that an update is causally applicable to the supplied document. */
export function canApplyYjsUpdateToDoc(doc: Y.Doc, updateBytes: Uint8Array): boolean {
  try {
    const { from, to } = Y.parseUpdateMeta(updateBytes)
    const currentStateVector = Y.decodeStateVector(Y.encodeStateVector(doc))
    for (const [clientId, predecessorClock] of from) {
      if ((currentStateVector.get(clientId) ?? 0) < predecessorClock) return false
    }

    const candidate = new Y.Doc()
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc))
      Y.applyUpdate(candidate, updateBytes)
      const candidateStateVector = Y.decodeStateVector(Y.encodeStateVector(candidate))
      for (const [clientId, requiredClock] of to) {
        if ((candidateStateVector.get(clientId) ?? 0) < requiredClock) return false
      }
      const { ds } = Y.decodeUpdate(updateBytes)
      for (const [clientId, ranges] of ds.clients) {
        const coveredClock = candidateStateVector.get(clientId) ?? 0
        for (const range of ranges) {
          if (coveredClock < range.clock + range.len) return false
        }
      }
      return true
    } finally {
      candidate.destroy()
    }
  } catch {
    return false
  }
}

/** Returns true when Yjs retained pending structs or delete ranges beyond its state vector. */
export function hasUnresolvedYjsState(doc: Y.Doc): boolean {
  try {
    const stateVector = Y.encodeStateVector(doc)
    const state = Y.decodeStateVector(stateVector)
    const remainder = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, stateVector))
    if (remainder.structs.length > 0) return true
    for (const [clientId, ranges] of remainder.ds.clients) {
      const coveredClock = state.get(clientId) ?? 0
      for (const range of ranges) {
        if (coveredClock < range.clock + range.len) return true
      }
    }
    return false
  } catch {
    return true
  }
}

export type MetaDocumentDisposition =
  | 'supported-v2'
  | 'legacy-v1'
  | 'mixed'
  | 'unsupported'
  | 'invalid'

/** Classifies every root entry without treating legacy values as corrupt data. */
export function metaYDocSchemaDisposition(doc: Y.Doc): MetaDocumentDisposition {
  if (hasUnresolvedYjsState(doc)) return 'invalid'
  const meta = doc.getMap<unknown>('meta')
  if (meta.size === 0) return 'supported-v2'
  const dispositions = new Set<MetaValueDisposition>()
  for (const [fileId, value] of meta.entries()) {
    if (!v.is(FileIdSchema, fileId)) return 'invalid'
    dispositions.add(decodeMetaValue(value, fileId).disposition)
  }
  if (dispositions.has('invalid')) return 'invalid'
  if (dispositions.has('unsupported')) return 'unsupported'
  if (dispositions.size !== 1) return 'mixed'
  return dispositions.values().next().value === 'supported-v2' ? 'supported-v2' : 'legacy-v1'
}

/** Legacy schema is readable; only a fully grouped document is writable. */
export function metaYDocSchemaValid(doc: Y.Doc): boolean {
  const disposition = metaYDocSchemaDisposition(doc)
  return disposition === 'supported-v2' || disposition === 'legacy-v1'
}

export function metaYDocWritable(doc: Y.Doc): boolean {
  return metaYDocSchemaDisposition(doc) === 'supported-v2'
}

/** Existing grouped identities may not be changed or removed; new file IDs are allowed. */
export function metaIdentityImmutable(current: Y.Doc, candidate: Y.Doc): boolean {
  if (!metaYDocWritable(candidate)) return false
  const currentMeta = current.getMap<unknown>('meta')
  const candidateMeta = candidate.getMap<unknown>('meta')
  for (const [fileId, value] of currentMeta.entries()) {
    const currentEntry = decodeMetaValue(value, fileId)
    if (currentEntry.disposition === 'unsupported' || currentEntry.disposition === 'invalid') {
      return false
    }
    const currentIdentity =
      currentEntry.disposition === 'supported-v2'
        ? currentEntry.grouped?.identity
        : currentEntry.metaFile === undefined || currentEntry.metaFile.deleted
          ? undefined
          : groupedEntryFromMetaFile(currentEntry.metaFile).identity
    if (currentIdentity === undefined) return false
    const candidateEntry = decodeMetaValue(candidateMeta.get(fileId), fileId)
    if (
      candidateEntry.disposition !== 'supported-v2' ||
      candidateEntry.grouped === undefined ||
      JSON.stringify(candidateEntry.grouped.identity) !== JSON.stringify(currentIdentity)
    ) {
      return false
    }
  }
  return true
}

/** Rejects root replacement of grouped entries; nested group edits remain mergeable. */
export function metaRootMutationAllowed(
  current: Y.Doc,
  updateBytes: Uint8Array,
  allowLegacyMigration = false,
): boolean {
  const currentMeta = current.getMap<unknown>('meta')
  const candidate = new Y.Doc()
  let allowed = true
  const candidateMeta = candidate.getMap<unknown>('meta')
  const observer = (event: Y.YMapEvent<unknown>): void => {
    for (const [fileId, change] of event.changes.keys) {
      if (!currentMeta.has(fileId)) {
        if (change.action !== 'add') allowed = false
        continue
      }
      const currentDisposition = decodeMetaValue(currentMeta.get(fileId), fileId).disposition
      if (currentDisposition === 'unsupported' || currentDisposition === 'invalid') {
        allowed = false
        continue
      }
      if (currentDisposition === 'supported-v2' && change.action !== 'add') allowed = false
      if (currentDisposition === 'legacy-v1') {
        if (!allowLegacyMigration || change.action === 'delete') allowed = false
      }
    }
  }
  candidateMeta.observe(observer)
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current))
    Y.applyUpdate(candidate, updateBytes)
  } catch {
    allowed = false
  } finally {
    candidateMeta.unobserve(observer)
    candidate.destroy()
  }
  return allowed
}

/** Migrates an all-v1 document in one transaction using a fresh child map per root entry. */
export function migrateLegacyMetaDoc(doc: Y.Doc): boolean {
  const meta = doc.getMap<unknown>('meta')
  if (meta.size === 0) return true
  const entries: Array<[string, ReturnType<typeof groupedEntryFromMetaFile>]> = []
  for (const [fileId, value] of meta.entries()) {
    if (!v.is(FileIdSchema, fileId)) return false
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.disposition !== 'legacy-v1' || decoded.metaFile === undefined) return false
    entries.push([fileId, groupedEntryFromMetaFile(decoded.metaFile)])
  }
  doc.transact(() => {
    for (const [fileId, grouped] of entries) {
      const child = new Y.Map<unknown>()
      child.set('identity', grouped.identity)
      child.set('location', grouped.location)
      child.set('content', grouped.content)
      child.set('deletion', grouped.deletion)
      meta.set(fileId, child)
    }
  }, 'metadata-schema-v2-migration')
  return true
}

export function isEmptyYjsUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2
}
