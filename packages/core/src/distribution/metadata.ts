import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { ProductVersionSchema, ReleaseChannelSchema } from '../utils/version'

/** The first metadata contract supported by the fixed bootstrap. */
export const DISTRIBUTION_SCHEMA_VERSION = 1
export const DISTRIBUTION_BOOTSTRAP_PROTOCOL_VERSION = 1
export const DISTRIBUTION_TEMPLATE_PROTOCOL_VERSION = 1

const ProtocolNumberSchema = v.pipe(v.number(), v.integer(), v.minValue(1))
const RolloutPercentageSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))
const RolloutSaltSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128))
const StableProductVersionSchema = v.pipe(
  ProductVersionSchema,
  v.regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'Expected a stable x.y.z version'),
)

// v.object intentionally ignores unknown keys: v1 can read future optional fields, but every
// known field is still validated and missing/invalid known values fail closed.
// npm integrity values use the canonical base64 encoding of a 64-byte SHA-512 digest.
const NpmSha512IntegritySchema = v.pipe(
  v.string(),
  v.regex(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/, 'Invalid SHA-512 npm integrity'),
)

const GitCommitShaSchema = v.pipe(
  v.string(),
  v.length(40),
  v.regex(/^[0-9a-f]{40}$/, 'Invalid Git commit SHA'),
)

const UtcTimestampSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'Timestamp must be ISO-8601 UTC'),
  v.check((value) => {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return false
    const canonical = parsed.toISOString()
    return canonical === value || canonical.replace('.000Z', 'Z') === value
  }, 'Timestamp must be a valid ISO-8601 UTC instant'),
)

const BlockedSourceVersionsSchema = v.pipe(
  v.array(StableProductVersionSchema),
  v.check(
    (versions) => new Set(versions).size === versions.length,
    'Duplicate blocked source version',
  ),
)

/** Mutable pointer selecting a release for one update channel. */
export const ChannelPointerSchema = v.object({
  schemaVersion: v.literal(DISTRIBUTION_SCHEMA_VERSION),
  channel: ReleaseChannelSchema,
  productVersion: StableProductVersionSchema,
  rolloutPercentage: RolloutPercentageSchema,
  blockedSourceVersions: BlockedSourceVersionsSchema,
  paused: v.boolean(),
  updatedAt: UtcTimestampSchema,
})

export type ChannelPointer = v.InferInput<typeof ChannelPointerSchema>

/** Immutable release metadata consumed by the fixed build bootstrap. */
export const ReleaseManifestSchema = v.pipe(
  v.object({
    schemaVersion: v.literal(DISTRIBUTION_SCHEMA_VERSION),
    bootstrapProtocolVersion: v.literal(DISTRIBUTION_BOOTSTRAP_PROTOCOL_VERSION),
    requiredTemplateProtocolVersion: ProtocolNumberSchema,
    productVersion: StableProductVersionSchema,
    runtimeVersion: StableProductVersionSchema,
    runtimeIntegrity: NpmSha512IntegritySchema,
    runtimeBundleSha256: Sha256HexSchema,
    wranglerVersion: StableProductVersionSchema,
    wranglerIntegrity: NpmSha512IntegritySchema,
    buildLockSha256: Sha256HexSchema,
    buildCommit: GitCommitShaSchema,
    protocolVersion: ProtocolNumberSchema,
    minimumProtocolVersion: ProtocolNumberSchema,
    minimumPluginVersion: StableProductVersionSchema,
    automaticUpdate: v.literal(true),
    rolloutSalt: RolloutSaltSchema,
    publishedAt: UtcTimestampSchema,
  }),
  v.check(
    ({ minimumProtocolVersion, protocolVersion }) => minimumProtocolVersion <= protocolVersion,
    'Minimum protocol version cannot exceed protocol version',
  ),
  v.check(
    ({ productVersion, runtimeVersion }) => productVersion === runtimeVersion,
    'Runtime version must match product version',
  ),
)

export type ReleaseManifest = v.InferInput<typeof ReleaseManifestSchema>

/** Parse untrusted channel metadata while accepting unknown future optional fields. */
export function parseChannelPointer(input: unknown): ChannelPointer {
  return v.parse(ChannelPointerSchema, input)
}

/** Parse untrusted release metadata while accepting unknown future optional fields. */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  return v.parse(ReleaseManifestSchema, input)
}
