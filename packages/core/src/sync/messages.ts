import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { DeviceIdSchema, DocIdSchema, MessageIdSchema, VaultIdSchema } from '../utils/ids'
import { NonEmptyBase64Schema, NonNegativeSafeIntegerSchema } from '../utils/shared'
import { ProtocolVersionSchema } from '../utils/version'

export const ClientCapabilitySchema = v.union([
  v.literal('awareness'),
  v.literal('binary-v1'),
  v.literal('metadata-schema-v2'),
])
export type ClientCapability = v.InferInput<typeof ClientCapabilitySchema>

export const ClientHelloSchema = v.strictObject({
  type: v.literal('hello'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  capabilities: v.array(ClientCapabilitySchema),
})
export type ClientHello = v.InferInput<typeof ClientHelloSchema>

export const HelloAcceptedSchema = v.strictObject({
  type: v.literal('hello-accepted'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  metadataAccess: v.optional(v.union([v.literal('read-only'), v.literal('read-write')])),
})
export type HelloAccepted = v.InferInput<typeof HelloAcceptedSchema>

export const MetadataAccessSchema = v.union([v.literal('read-only'), v.literal('read-write')])
export type MetadataAccess = v.InferInput<typeof MetadataAccessSchema>

export const SyncRequestSchema = v.object({
  type: v.literal('sync-request'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  stateVector: NonEmptyBase64Schema,
})
export type SyncRequest = v.InferInput<typeof SyncRequestSchema>

export const SyncUpdateSchema = v.object({
  type: v.literal('sync-update'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  update: NonEmptyBase64Schema,
  updateSha256: v.optional(Sha256HexSchema),
  baseStateVector: v.optional(NonEmptyBase64Schema),
  durableSeq: v.optional(NonNegativeSafeIntegerSchema),
})
export type SyncUpdate = v.InferInput<typeof SyncUpdateSchema>

export const AckSchema = v.object({
  type: v.literal('ack'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  durableSeq: NonNegativeSafeIntegerSchema,
})
export type Ack = v.InferInput<typeof AckSchema>

export const NeedFullSnapshotReasonSchema = v.union([
  v.literal('state-vector-too-old'),
  v.literal('missing-log'),
  v.literal('protocol-upgrade'),
  v.literal('large-update-snapshot'),
])
export type NeedFullSnapshotReason = v.InferInput<typeof NeedFullSnapshotReasonSchema>

export const NeedFullSnapshotSchema = v.object({
  type: v.literal('need-full-snapshot'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  docId: DocIdSchema,
  reason: NeedFullSnapshotReasonSchema,
})
export type NeedFullSnapshot = v.InferInput<typeof NeedFullSnapshotSchema>

export const SyncUpdateRejectedReasonSchema = v.union([
  v.literal('large-update-requires-snapshot-import'),
  v.literal('metadata-read-only'),
  v.literal('hash-mismatch'),
  v.literal('yjs-apply-failed'),
  v.literal('meta-schema-invalid'),
])
export type SyncUpdateRejectedReason = v.InferInput<typeof SyncUpdateRejectedReasonSchema>

export const SyncUpdateRejectedSchema = v.object({
  type: v.literal('sync-update-rejected'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  updateSha256: Sha256HexSchema,
  reason: SyncUpdateRejectedReasonSchema,
  retryable: v.literal(false),
})
export type SyncUpdateRejected = v.InferInput<typeof SyncUpdateRejectedSchema>

export const ControlMessageSchema = v.union([
  ClientHelloSchema,
  HelloAcceptedSchema,
  SyncRequestSchema,
  SyncUpdateSchema,
  AckSchema,
  NeedFullSnapshotSchema,
  SyncUpdateRejectedSchema,
])
export type ControlMessage = v.InferInput<typeof ControlMessageSchema>

export const BinaryFrameHeaderSchema = v.object({
  type: v.literal('sync-update'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  updateSha256: v.optional(Sha256HexSchema),
  durableSeq: v.optional(NonNegativeSafeIntegerSchema),
})
export type BinaryFrameHeader = v.InferInput<typeof BinaryFrameHeaderSchema>

export function parseControlMessage(value: unknown): ControlMessage | null {
  if (typeof value === 'string') {
    try {
      return parseControlMessage(JSON.parse(value))
    } catch {
      return null
    }
  }

  const result = v.safeParse(ControlMessageSchema, value)
  return result.success ? result.output : null
}
