import type { DeviceId } from '@kuroflare/core'

/** Existing device registry row from the Durable Object database. */
export interface DeviceRegistryEntry {
  readonly deviceId: DeviceId
  readonly tokenVersion: number
  readonly revokedAt: number | undefined
}

/** Refresh-token row evidence loaded by hash lookup before minting a new access token. */
export interface DeviceRefreshTokenEvidence {
  readonly tokenHashMatches: boolean
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number | undefined
}

/** Persistable patch for revoking a used refresh token hash. */
export interface DeviceRefreshTokenRevokePatch {
  readonly tokenHash: string
  readonly revokedAt: number
}

/** Persistable patch for inserting a rotated refresh token hash. */
export interface DeviceRefreshTokenInsertPatch {
  readonly tokenHash: string
  readonly deviceId: DeviceId
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Registry state needed while exchanging a setup token for a device token. */
export interface SetupExchangeRegistryState {
  readonly existingDevice: DeviceRegistryEntry | undefined
}

/** Input for setup exchange registry decision. */
export interface SetupExchangeDecisionInput {
  readonly requestedDeviceId: DeviceId | undefined
  readonly registry: SetupExchangeRegistryState
}

/** Setup exchange decision before the caller writes DB rows or mints JWTs. */
export type SetupExchangeDecision =
  | { readonly action: 'reuse-device'; readonly device: DeviceRegistryEntry }
  | { readonly action: 'register-device' }
  | { readonly action: 'reject'; readonly reason: 'device-revoked' }

/** Input for issuing setup exchange credentials after the registry decision was accepted. */
export interface SetupExchangeCredentialPlanInput {
  readonly setupDecision: SetupExchangeDecision
  readonly deviceId: DeviceId
  readonly refreshTokenHash: string
  readonly now: number
  readonly refreshTokenExpiresAt: number
}

/** Setup exchange credentials and refresh-token insert patch for the caller to persist. */
export type SetupExchangeCredentialPlan =
  | {
      readonly action: 'issue-credentials'
      readonly deviceId: DeviceId
      readonly tokenVersion: number
      readonly insertRefreshToken: DeviceRefreshTokenInsertPatch
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'setup-not-accepted'
        | 'device-id-mismatch'
        | 'invalid-time'
        | 'invalid-refresh-token-expiry'
        | 'empty-refresh-token-hash'
    }

/** Input for checking a client hello against the device registry. */
export interface ClientHelloRegistryDecisionInput {
  readonly device: DeviceRegistryEntry | undefined
  readonly tokenVersion: number
}

/** Registry decision for a client hello before normal sync may begin. */
export type ClientHelloRegistryDecision =
  | { readonly action: 'accept' }
  | {
      readonly action: 'reject'
      readonly reason: 'unknown-device' | 'device-revoked' | 'stale-token'
    }

/** Input for deciding whether a refresh token may mint a new device access token. */
export interface DeviceTokenRefreshDecisionInput {
  readonly device: DeviceRegistryEntry | undefined
  readonly refreshToken: DeviceRefreshTokenEvidence | undefined
  readonly previousTokenVersion: number
  readonly now: number
}

/** Device token refresh decision before the caller mints JWTs or rotates refresh tokens. */
export type DeviceTokenRefreshDecision =
  | {
      readonly action: 'mint-token'
      readonly tokenVersion: number
      readonly rotateRefreshToken: true
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'unknown-device'
        | 'device-revoked'
        | 'missing-refresh-token'
        | 'refresh-token-mismatch'
        | 'refresh-token-revoked'
        | 'refresh-token-not-yet-valid'
        | 'refresh-token-expired'
        | 'stale-token'
        | 'token-version-ahead'
        | 'invalid-time'
        | 'invalid-previous-token-version'
        | 'invalid-refresh-token-window'
    }

/** Input for planning refresh-token rotation after a refresh request was accepted. */
export interface DeviceRefreshTokenRotationInput {
  readonly refreshDecision: DeviceTokenRefreshDecision
  readonly deviceId: DeviceId
  readonly currentTokenHash: string
  readonly nextTokenHash: string
  readonly now: number
  readonly nextExpiresAt: number
}

/** Refresh-token rotation plan to apply in the same transaction as the refresh response. */
export type DeviceRefreshTokenRotationPlan =
  | {
      readonly action: 'rotate'
      readonly revoke: DeviceRefreshTokenRevokePatch
      readonly insert: DeviceRefreshTokenInsertPatch
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'refresh-not-accepted'
        | 'invalid-time'
        | 'invalid-next-expiry'
        | 'empty-current-token-hash'
        | 'empty-next-token-hash'
        | 'token-hash-not-rotated'
    }

/** Input for revoking a registered device. */
export interface RevokeDeviceDecisionInput {
  readonly device: DeviceRegistryEntry | undefined
  readonly revokedAt: number
}

/** Device revoke decision before the caller updates the registry row. */
export type RevokeDeviceDecision =
  | { readonly action: 'reject'; readonly reason: 'unknown-device' | 'invalid-revoked-at' }
  | {
      readonly action: 'revoke-device'
      readonly tokenVersion: number
      readonly revokedAt: number
    }
  | {
      readonly action: 'already-revoked'
      readonly tokenVersion: number
      readonly revokedAt: number
    }
