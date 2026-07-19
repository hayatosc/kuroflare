import { hashBytesSha256, type DocId } from '@kuroflare/core'
import * as Y from 'yjs'

import type { R2BucketBinding } from '../runtime/types'
import { metaYDocSchemaDisposition } from '../runtime/yjs-validation'

/** Stable server identities used for automatically generated health events. */
export const SNAPSHOT_HEALTH_SYSTEM_ACTORS = {
  checkpoint: 'system:checkpoint',
  import: 'system:import',
  verifier: 'system:verifier',
} as const

/** Expected immutable snapshot evidence captured before an R2 write. */
export interface SnapshotVerificationExpectedEvidence {
  readonly byteLength: number
  readonly updateSha256: string
  readonly stateVectorSha256: string
}

/** Physical verification outcome for one snapshot object. */
export interface SnapshotPhysicalVerification {
  readonly status: 'verified' | 'unverified' | 'mismatch'
  readonly reasons: readonly SnapshotVerificationReason[]
  readonly actualByteLength: number
  readonly actualUpdateSha256: string
  readonly actualStateVectorSha256: string | undefined
  readonly stateVector: Uint8Array | undefined
}

/** Stable causes emitted by the shared snapshot verifier. */
export type SnapshotVerificationReason =
  | 'missing-evidence'
  | 'missing-object'
  | 'byte-length-mismatch'
  | 'update-hash-mismatch'
  | 'yjs-decode-failed'
  | 'state-vector-hash-mismatch'
  | 'state-vector-decode-failed'
  | 'meta-schema-invalid'

/** Reads and verifies an immutable R2 snapshot using one physical contract. */
export async function verifySnapshotObject(
  bucket: R2BucketBinding,
  key: string,
  docId: DocId,
  expected: SnapshotVerificationExpectedEvidence | undefined,
): Promise<SnapshotPhysicalVerification & { readonly exists: boolean }> {
  const object = await bucket.get(key)
  if (object === null) {
    return {
      exists: false,
      status: 'mismatch',
      reasons: ['missing-object'],
      actualByteLength: 0,
      actualUpdateSha256: '',
      actualStateVectorSha256: undefined,
      stateVector: undefined,
    }
  }

  return {
    exists: true,
    ...(await verifySnapshotBytes(new Uint8Array(await object.arrayBuffer()), docId, expected)),
  }
}

/** Verifies byte length, update hash, Yjs decoding, state vector, and meta schema. */
export async function verifySnapshotBytes(
  bytes: Uint8Array,
  docId: DocId,
  expected: SnapshotVerificationExpectedEvidence | undefined,
): Promise<SnapshotPhysicalVerification> {
  const actualByteLength = bytes.byteLength
  const actualUpdateSha256 = await hashBytesSha256(bytes)
  const reasons: SnapshotVerificationReason[] = []
  if (expected === undefined) reasons.push('missing-evidence')
  if (expected !== undefined && expected.byteLength !== actualByteLength) {
    reasons.push('byte-length-mismatch')
  }
  if (expected !== undefined && expected.updateSha256 !== actualUpdateSha256) {
    reasons.push('update-hash-mismatch')
  }

  const doc = new Y.Doc()
  let stateVector: Uint8Array | undefined
  let actualStateVectorSha256: string | undefined
  try {
    Y.applyUpdate(doc, bytes)
    stateVector = Y.encodeStateVector(doc)
    actualStateVectorSha256 = await hashBytesSha256(stateVector)
  } catch {
    reasons.push('yjs-decode-failed')
  }

  if (stateVector === undefined) {
    reasons.push('state-vector-decode-failed')
  } else if (expected !== undefined && expected.stateVectorSha256 !== actualStateVectorSha256) {
    reasons.push('state-vector-hash-mismatch')
  }

  if (
    docId.kind === 'meta' &&
    !['supported-v2', 'legacy-v1'].includes(metaYDocSchemaDisposition(doc))
  ) {
    reasons.push('meta-schema-invalid')
  }
  doc.destroy()

  const uniqueReasons = [...new Set(reasons)]
  const status = uniqueReasons.includes('missing-evidence')
    ? 'unverified'
    : uniqueReasons.length === 0
      ? 'verified'
      : 'mismatch'
  return {
    status,
    reasons: uniqueReasons,
    actualByteLength,
    actualUpdateSha256,
    actualStateVectorSha256,
    stateVector,
  }
}
