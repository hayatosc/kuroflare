import * as v from 'valibot'

import { DeviceIdSchema, DocIdSchema, MessageIdSchema, VaultIdSchema } from './ids.js'
import { Sha256HexSchema } from './meta.js'
import { WireYClientIdSchema } from './setup.js'
import { ProtocolVersionSchema } from './version.js'

export const ClientCapabilitySchema = v.union([v.literal('awareness'), v.literal('binary-v1')])
export type ClientCapability = v.InferInput<typeof ClientCapabilitySchema>

export const ClientHelloSchema = v.object({
  type: v.literal('hello'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  yClientId: WireYClientIdSchema,
  capabilities: v.array(ClientCapabilitySchema),
})
export type ClientHello = v.InferInput<typeof ClientHelloSchema>

export const HelloAcceptedSchema = v.object({
  type: v.literal('hello-accepted'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  yClientId: WireYClientIdSchema,
})
export type HelloAccepted = v.InferInput<typeof HelloAcceptedSchema>

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const Base64Schema = v.pipe(v.string(), v.minLength(1), v.regex(BASE64_PATTERN, 'Invalid base64'))
const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

export const SyncRequestSchema = v.object({
  type: v.literal('sync-request'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  stateVector: Base64Schema,
})
export type SyncRequest = v.InferInput<typeof SyncRequestSchema>

export const SyncUpdateSchema = v.object({
  type: v.literal('sync-update'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  messageId: MessageIdSchema,
  docId: DocIdSchema,
  update: Base64Schema,
  updateSha256: v.optional(Sha256HexSchema),
  baseStateVector: v.optional(Base64Schema),
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

export const ControlMessageSchema = v.union([
  ClientHelloSchema,
  HelloAcceptedSchema,
  SyncRequestSchema,
  SyncUpdateSchema,
  AckSchema,
  NeedFullSnapshotSchema,
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
