import type { DeviceId } from '@kuroflare/core'
import * as v from 'valibot'
import type {
  YClientId,
  DeviceRegistryEntry,
  SetupExchangeDecisionInput,
  SetupExchangeDecision,
  YClientIdRange,
  SetupExchangeCredentialPlanInput,
  SetupExchangeCredentialPlan,
  ClientHelloRegistryDecisionInput,
  ClientHelloRegistryDecision,
  DeviceTokenRefreshDecisionInput,
  DeviceTokenRefreshDecision,
  DeviceRefreshTokenRotationInput,
  DeviceRefreshTokenRotationPlan,
  RevokeDeviceDecisionInput,
  RevokeDeviceDecision,
} from './types'

/**
 * Decides how setup exchange should bind a device to a Yjs clientID.
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
