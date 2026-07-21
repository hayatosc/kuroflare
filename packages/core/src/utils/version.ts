import * as v from 'valibot'

export const CURRENT_PROTOCOL_VERSION = 1
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1

// Generated from the root package version by the release-version sync check.
export const PRODUCT_VERSION = '0.1.0'
export const MINIMUM_PLUGIN_VERSION = PRODUCT_VERSION

const PRODUCT_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const ProductVersionSchema = v.pipe(v.string(), v.regex(PRODUCT_VERSION_PATTERN))

export const ReleaseChannelSchema = v.union([v.literal('stable'), v.literal('beta')])
export type ReleaseChannel = v.InferOutput<typeof ReleaseChannelSchema>

/** Bounded metadata strings keep the unauthenticated version response predictable. */
export const BuildCommitSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[A-Za-z0-9._/-]+$/),
)
export const DeploymentVersionIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256))

const VersionProtocolNumberSchema = v.pipe(
  v.number(),
  v.integer(),
  // The diagnostic wire format must parse old Workers even after support moves on.
  v.minValue(1),
)

export const WorkerVersionResponseSchema = v.object({
  productVersion: ProductVersionSchema,
  // Keep this response forward-readable so older clients can diagnose newer Workers.
  protocolVersion: VersionProtocolNumberSchema,
  minimumProtocolVersion: VersionProtocolNumberSchema,
  minimumPluginVersion: ProductVersionSchema,
  channel: ReleaseChannelSchema,
  buildCommit: BuildCommitSchema,
  deploymentVersionId: DeploymentVersionIdSchema,
})
export type WorkerVersionResponse = v.InferOutput<typeof WorkerVersionResponseSchema>

export const ProtocolVersionSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_SUPPORTED_PROTOCOL_VERSION),
  v.maxValue(CURRENT_PROTOCOL_VERSION),
)
