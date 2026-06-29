import type { DeviceId } from '@kuroflare/protocol'
import * as v from 'valibot'

/** Yjs clientID assigned by the Worker and persisted per device. */
export type YClientId = number

/** Existing device registry row from the Durable Object database. */
export interface DeviceRegistryEntry {
  readonly deviceId: DeviceId
  readonly yClientId: YClientId
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
  readonly usedYClientIds: ReadonlySet<YClientId>
}

/** Input for setup exchange registry decision. */
export interface SetupExchangeDecisionInput {
  readonly requestedDeviceId: DeviceId | undefined
  readonly registry: SetupExchangeRegistryState
  readonly yClientIdRange: YClientIdRange
}

/** Inclusive yClientId allocation range reserved for this vault. */
export interface YClientIdRange {
  readonly min: YClientId
  readonly max: YClientId
}

/** Setup exchange decision before the caller writes DB rows or mints JWTs. */
export type SetupExchangeDecision =
  | { readonly action: 'reuse-device'; readonly device: DeviceRegistryEntry }
  | { readonly action: 'register-device'; readonly yClientId: YClientId }
  | { readonly action: 'reject'; readonly reason: 'device-revoked' | 'no-y-client-id-available' }

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
      readonly yClientId: YClientId
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
  readonly claimedYClientId: YClientId
  readonly tokenVersion: number
}

/** Registry decision for a client hello before normal sync may begin. */
export type ClientHelloRegistryDecision =
  | { readonly action: 'accept' }
  | {
      readonly action: 'reject'
      readonly reason: 'unknown-device' | 'device-revoked' | 'stale-token' | 'y-client-id-mismatch'
    }
  | { readonly action: 'require-full-snapshot'; readonly reason: 'device-reinstalled' }

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

/**
 * Decides how setup exchange should bind a device to a Yjs clientID.
 *
 * @param input Requested device identity, current registry evidence, and allocation range.
 * @returns A registry action for the caller to apply transactionally.
 */
export function decideSetupExchange(input: SetupExchangeDecisionInput): SetupExchangeDecision {
  if (input.requestedDeviceId && input.registry.existingDevice) {
    if (input.registry.existingDevice.revokedAt !== undefined) {
      return { action: 'reject', reason: 'device-revoked' }
    }

    return { action: 'reuse-device', device: input.registry.existingDevice }
  }

  const yClientId = allocateYClientId(input.registry.usedYClientIds, input.yClientIdRange)
  return yClientId === null
    ? { action: 'reject', reason: 'no-y-client-id-available' }
    : { action: 'register-device', yClientId }
}

/**
 * Plans the credentials returned by setup exchange and the initial refresh-token row.
 *
 * @param input Accepted setup decision, concrete device identity, refresh-token hash, and validity window.
 * @returns A credential plan to apply transactionally, or the reason the evidence is unsafe.
 */
export function planSetupExchangeCredentials(
  input: SetupExchangeCredentialPlanInput,
): SetupExchangeCredentialPlan {
  if (input.setupDecision.action === 'reject') {
    return { action: 'reject', reason: 'setup-not-accepted' }
  }
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.refreshTokenExpiresAt) ||
    input.refreshTokenExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'invalid-refresh-token-expiry' }
  }
  if (input.refreshTokenHash.length === 0) {
    return { action: 'reject', reason: 'empty-refresh-token-hash' }
  }

  const credential =
    input.setupDecision.action === 'reuse-device'
      ? {
          deviceId: input.setupDecision.device.deviceId,
          yClientId: input.setupDecision.device.yClientId,
          tokenVersion: input.setupDecision.device.tokenVersion,
        }
      : {
          deviceId: input.deviceId,
          yClientId: input.setupDecision.yClientId,
          tokenVersion: 1,
        }

  if (credential.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-id-mismatch' }
  }

  return {
    action: 'issue-credentials',
    deviceId: credential.deviceId,
    yClientId: credential.yClientId,
    tokenVersion: credential.tokenVersion,
    insertRefreshToken: {
      tokenHash: input.refreshTokenHash,
      deviceId: credential.deviceId,
      issuedAt: input.now,
      expiresAt: input.refreshTokenExpiresAt,
    },
  }
}

/**
 * Checks whether a client hello is allowed to enter normal sync.
 *
 * @param input Registry row, claimed yClientId, and token version from the authenticated request.
 * @returns A sync admission decision. Reinstalled devices must take the full-snapshot path first.
 */
export function decideClientHelloRegistry(
  input: ClientHelloRegistryDecisionInput,
): ClientHelloRegistryDecision {
  if (!input.device) {
    return { action: 'reject', reason: 'unknown-device' }
  }

  if (input.device.revokedAt !== undefined) {
    return { action: 'reject', reason: 'device-revoked' }
  }

  if (input.tokenVersion < input.device.tokenVersion) {
    return { action: 'reject', reason: 'stale-token' }
  }

  if (!isValidYClientId(input.claimedYClientId)) {
    return { action: 'reject', reason: 'y-client-id-mismatch' }
  }

  if (input.claimedYClientId !== input.device.yClientId) {
    return { action: 'require-full-snapshot', reason: 'device-reinstalled' }
  }

  return { action: 'accept' }
}

/**
 * Decides whether a refresh token may mint a new short-lived device access token.
 *
 * @param input Registry row, refresh-token evidence, previous token version, and current time.
 * @returns A mint decision using the registry tokenVersion, or a stable rejection reason.
 */
export function decideDeviceTokenRefresh(
  input: DeviceTokenRefreshDecisionInput,
): DeviceTokenRefreshDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), input.previousTokenVersion)) {
    return { action: 'reject', reason: 'invalid-previous-token-version' }
  }
  if (!input.device) {
    return { action: 'reject', reason: 'unknown-device' }
  }
  if (input.device.revokedAt !== undefined) {
    return { action: 'reject', reason: 'device-revoked' }
  }
  if (!input.refreshToken) {
    return { action: 'reject', reason: 'missing-refresh-token' }
  }
  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.refreshToken.issuedAt) ||
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.refreshToken.expiresAt) ||
    input.refreshToken.expiresAt <= input.refreshToken.issuedAt ||
    (input.refreshToken.revokedAt !== undefined &&
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.refreshToken.revokedAt))
  ) {
    return { action: 'reject', reason: 'invalid-refresh-token-window' }
  }
  if (!input.refreshToken.tokenHashMatches) {
    return { action: 'reject', reason: 'refresh-token-mismatch' }
  }
  if (input.refreshToken.revokedAt !== undefined) {
    return { action: 'reject', reason: 'refresh-token-revoked' }
  }
  if (input.now < input.refreshToken.issuedAt) {
    return { action: 'reject', reason: 'refresh-token-not-yet-valid' }
  }
  if (input.now >= input.refreshToken.expiresAt) {
    return { action: 'reject', reason: 'refresh-token-expired' }
  }
  if (input.previousTokenVersion < input.device.tokenVersion) {
    return { action: 'reject', reason: 'stale-token' }
  }
  if (input.previousTokenVersion > input.device.tokenVersion) {
    return { action: 'reject', reason: 'token-version-ahead' }
  }

  return {
    action: 'mint-token',
    tokenVersion: input.device.tokenVersion,
    rotateRefreshToken: true,
  }
}

/**
 * Plans refresh-token hash rotation after a refresh request has been accepted.
 *
 * @param input Accepted refresh decision, current hash, next hash, target device, and new expiry.
 * @returns Persistable revoke/insert patches, or the reason rotation evidence is unsafe.
 */
export function planDeviceRefreshTokenRotation(
  input: DeviceRefreshTokenRotationInput,
): DeviceRefreshTokenRotationPlan {
  if (input.refreshDecision.action !== 'mint-token') {
    return { action: 'reject', reason: 'refresh-not-accepted' }
  }
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }
  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.nextExpiresAt) ||
    input.nextExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'invalid-next-expiry' }
  }
  if (input.currentTokenHash.length === 0) {
    return { action: 'reject', reason: 'empty-current-token-hash' }
  }
  if (input.nextTokenHash.length === 0) {
    return { action: 'reject', reason: 'empty-next-token-hash' }
  }
  if (input.currentTokenHash === input.nextTokenHash) {
    return { action: 'reject', reason: 'token-hash-not-rotated' }
  }

  return {
    action: 'rotate',
    revoke: {
      tokenHash: input.currentTokenHash,
      revokedAt: input.now,
    },
    insert: {
      tokenHash: input.nextTokenHash,
      deviceId: input.deviceId,
      issuedAt: input.now,
      expiresAt: input.nextExpiresAt,
    },
  }
}

/**
 * Decides how to revoke a device registry row.
 *
 * @param input Existing registry row and the revoke timestamp.
 * @returns A registry action. Active devices get tokenVersion bumped so existing tokens become stale.
 */
export function decideRevokeDevice(input: RevokeDeviceDecisionInput): RevokeDeviceDecision {
  if (!input.device) {
    return { action: 'reject', reason: 'unknown-device' }
  }

  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.revokedAt)) {
    return { action: 'reject', reason: 'invalid-revoked-at' }
  }

  if (input.device.revokedAt !== undefined) {
    return {
      action: 'already-revoked',
      tokenVersion: input.device.tokenVersion,
      revokedAt: input.device.revokedAt,
    }
  }

  return {
    action: 'revoke-device',
    tokenVersion: input.device.tokenVersion + 1,
    revokedAt: input.revokedAt,
  }
}

/**
 * Returns true when a number can safely be used as a Yjs clientID.
 *
 * @param value Candidate clientID.
 * @returns Whether the value is a positive safe integer.
 */
export function isValidYClientId(value: unknown): value is YClientId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function allocateYClientId(
  usedYClientIds: ReadonlySet<YClientId>,
  range: YClientIdRange,
): YClientId | null {
  if (!isValidYClientId(range.min) || !isValidYClientId(range.max) || range.min > range.max) {
    return null
  }

  for (let candidate = range.min; candidate <= range.max; candidate += 1) {
    if (!usedYClientIds.has(candidate)) {
      return candidate
    }
  }

  return null
}
