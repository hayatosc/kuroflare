import * as Y from 'yjs'

import type { SqlOnlyStorage } from './fakes'
import { hashTestBytes } from './helpers'

export async function seedVerifiedSnapshotEvidence(
  storage: SqlOnlyStorage,
  snapshotKey: string,
  docId: 'meta' | `file:${string}`,
  bytes: Uint8Array,
  authorityStatus: 'candidate' | 'authoritative' = 'authoritative',
): Promise<void> {
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, bytes)
  const stateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  const seqText = snapshotKey.slice(snapshotKey.lastIndexOf('/') + 1, -'.yupdate'.length)
  const upperSeq = Number(seqText)
  const expectedUpdateSha256 = await hashTestBytes(bytes)
  const expectedStateVectorSha256 = await hashTestBytes(stateVector)
  const base = {
    id: storage.sql.snapshotHealthEvents.length + 1,
    docId,
    snapshotKey,
    upperSeq,
    actor: 'system:verifier',
    authorityStatus,
    expectedByteLength: bytes.byteLength,
    expectedUpdateSha256,
    expectedStateVectorSha256,
    actualByteLength: bytes.byteLength,
    actualUpdateSha256: expectedUpdateSha256,
    actualStateVectorSha256: expectedStateVectorSha256,
    physicalStatus: 'verified',
    logicalStatus: 'healthy',
    reasons: '[]',
    observedAt: 1,
  } as const
  storage.sql.snapshotHealthEvents.push({ ...base, event: 'verification' })
}
