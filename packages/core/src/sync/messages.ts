import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import {
  DeviceIdSchema,
  DocIdSchema,
  KuroflareIdSchema,
  MessageIdSchema,
  VaultIdSchema,
} from '../utils/ids'
import { NonEmptyBase64Schema, NonNegativeSafeIntegerSchema } from '../utils/shared'
import { ProtocolVersionSchema } from '../utils/version'

/**
 * Capabilities this build understands and can act on. DR-012: adding an entry here must never
 * change what {@link ClientHelloSchema} accepts on the wire — a peer has to keep admitting a
 * hello that advertises a capability it predates, simply ignoring the value it does not know.
 */
export const KNOWN_CLIENT_CAPABILITIES = ['awareness', 'binary-v1', 'metadata-schema-v2'] as const
export const ClientCapabilitySchema = v.picklist(KNOWN_CLIENT_CAPABILITIES)
export type ClientCapability = (typeof KNOWN_CLIENT_CAPABILITIES)[number]

/** No capability is mandatory today; kept as the required-capability boundary DR-012 calls for. */
export const REQUIRED_CLIENT_CAPABILITIES: readonly ClientCapability[] = []

export const ClientHelloSchema = v.strictObject({
  type: v.literal('hello'),
  protocolVersion: ProtocolVersionSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  // Opaque, format-guarded tokens rather than KNOWN_CLIENT_CAPABILITIES: an unrecognized
  // optional capability must not fail hello admission (DR-012).
  capabilities: v.array(KuroflareIdSchema),
})
export type ClientHello = v.InferInput<typeof ClientHelloSchema>

export type ClientCapabilityNegotiation =
  | { readonly action: 'accept'; readonly accepted: readonly ClientCapability[] }
  | { readonly action: 'reject'; readonly capability: ClientCapability }

/**
 * Negotiates the known intersection of an advertised capability list (DR-012). Unknown or
 * duplicate entries never fail negotiation; a capability missing from `required` does, and the
 * decision names it instead of forcing a generic malformed-hello close.
 */
export function decideClientCapabilityNegotiation(input: {
  readonly advertised: readonly string[]
  readonly required?: readonly ClientCapability[]
}): ClientCapabilityNegotiation {
  const accepted = KNOWN_CLIENT_CAPABILITIES.filter((capability) =>
    input.advertised.includes(capability),
  )
  for (const capability of input.required ?? REQUIRED_CLIENT_CAPABILITIES) {
    if (!accepted.includes(capability)) return { action: 'reject', capability }
  }
  return { action: 'accept', accepted }
}

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

/** Presence is loss-tolerant ephemeral data, so `state` only carries a byte-size cap. */
export const MAX_AWARENESS_STATE_BYTES = 4096

const AwarenessStateSchema = v.pipe(
  v.record(v.string(), v.unknown()),
  v.check(
    (state) => new TextEncoder().encode(JSON.stringify(state)).length <= MAX_AWARENESS_STATE_BYTES,
    'awareness state exceeds size limit',
  ),
)

export const AwarenessUpdateSchema = v.strictObject({
  type: v.literal('awareness-update'),
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  docId: DocIdSchema,
  clientId: NonNegativeSafeIntegerSchema,
  state: v.union([AwarenessStateSchema, v.null()]),
})
export type AwarenessUpdate = v.InferInput<typeof AwarenessUpdateSchema>

export const ControlMessageSchema = v.union([
  ClientHelloSchema,
  HelloAcceptedSchema,
  SyncRequestSchema,
  SyncUpdateSchema,
  AckSchema,
  NeedFullSnapshotSchema,
  SyncUpdateRejectedSchema,
  AwarenessUpdateSchema,
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

const AwarenessUpdateEnvelopeSchema = v.looseObject({ type: v.literal('awareness-update') })

/**
 * True when a raw WS message declares itself as an awareness-update frame but fails
 * full {@link AwarenessUpdateSchema} validation (e.g. an oversized `state`). Presence
 * is loss-tolerant ephemeral data, so callers use this to drop the malformed frame
 * silently instead of closing the whole sync session over it.
 */
export function isMalformedAwarenessUpdate(value: unknown): boolean {
  const parsed = typeof value === 'string' ? tryParseJson(value) : value
  return v.is(AwarenessUpdateEnvelopeSchema, parsed) && !v.is(AwarenessUpdateSchema, parsed)
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
