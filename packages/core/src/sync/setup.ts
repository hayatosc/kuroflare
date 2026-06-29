import * as v from 'valibot'

import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'
import { DeviceIdSchema, VaultIdSchema } from '../utils/ids'
import { ProtocolVersionSchema } from '../utils/version'

export const SetupBootstrapModeSchema = v.union([
  v.literal('new-vault'),
  v.literal('join-existing'),
])
export type SetupBootstrapMode = v.InferInput<typeof SetupBootstrapModeSchema>

const MAX_SETUP_TOKEN_LENGTH = 4096
const MAX_DEVICE_NAME_LENGTH = 128
const MAX_ACCESS_TOKEN_LENGTH = 16_384
const MAX_REFRESH_TOKEN_LENGTH = 4096

export const WireYClientIdSchema = PositiveSafeIntegerSchema

export const SetupExchangeRequestSchema = v.object({
  vaultId: VaultIdSchema,
  setupToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SETUP_TOKEN_LENGTH)),
  requestedDeviceName: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_DEVICE_NAME_LENGTH)),
  existingDeviceId: v.optional(DeviceIdSchema),
})
export type SetupExchangeRequest = v.InferInput<typeof SetupExchangeRequestSchema>

export const HttpEndpointSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(2048),
  v.check((val) => {
    try {
      const url = new URL(val)
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === '' &&
        url.hash === ''
      )
    } catch {
      return false
    }
  }, 'Invalid HTTP endpoint'),
)

export const SetupTokenIssueResponseSchema = v.pipe(
  v.object({
    endpoint: HttpEndpointSchema,
    vaultId: VaultIdSchema,
    setupToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SETUP_TOKEN_LENGTH)),
    setupUri: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    issuedAt: NonNegativeSafeIntegerSchema,
    expiresAt: NonNegativeSafeIntegerSchema,
  }),
  v.check((val) => val.expiresAt > val.issuedAt, 'expiresAt must be after issuedAt'),
  v.check((val) => {
    try {
      const url = new URL(val.setupUri)
      return (
        url.protocol === 'kuroflare:' &&
        url.hostname === 'setup' &&
        url.searchParams.get('endpoint') === val.endpoint &&
        url.searchParams.get('vaultId') === val.vaultId &&
        url.searchParams.get('setupToken') === val.setupToken
      )
    } catch {
      return false
    }
  }, 'Invalid setup URI'),
)
export type SetupTokenIssueResponse = v.InferInput<typeof SetupTokenIssueResponseSchema>

export const SetupExchangeResponseSchema = v.object({
  endpoint: HttpEndpointSchema,
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  yClientId: WireYClientIdSchema,
  accessToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ACCESS_TOKEN_LENGTH)),
  refreshToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REFRESH_TOKEN_LENGTH)),
  tokenVersion: PositiveSafeIntegerSchema,
  protocolVersion: ProtocolVersionSchema,
  bootstrapMode: SetupBootstrapModeSchema,
})
export type SetupExchangeResponse = v.InferInput<typeof SetupExchangeResponseSchema>
