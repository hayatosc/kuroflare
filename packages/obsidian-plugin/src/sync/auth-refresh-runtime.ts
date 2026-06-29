import {
  applyClientAuthMetadataRefreshAttemptPatch,
  decideClientAuthRefresh,
  decideClientAuthRefreshAttempt,
  decideClientAuthRefreshStart,
  decideClientAuthRefreshStaleStartRecovery,
  type ClientAuthMetadata,
  type ClientAuthMetadataPatchDecision,
  type ClientAuthRefreshAttemptDecision,
  type ClientAuthRefreshDecision,
  type ClientAuthRefreshPermanentFailure,
  type ClientAuthRefreshStartDecision,
  type ClientAuthRefreshStaleStartRecoveryDecision,
  type ClientAuthRefreshRetryableFailure,
  type OutboxAuthRefreshRequestDecision,
} from '@kuroflare/core'
import {
  DeviceTokenRefreshResponseSchema,
  type DeviceTokenClaims,
  type DeviceTokenRefreshRequest,
  type DeviceTokenRefreshResponse,
  type DeviceTokenScope,
  type VaultId,
} from '@kuroflare/core'
import * as v from 'valibot'

import {
  commitLocalStoreIndexedDbMetadataTransaction,
  planLocalStoreIndexedDbMetadataWrites,
  type LocalStoreIndexedDbMetadataDatabasePort,
} from './local-store-indexeddb'
import {
  LOCAL_AUTH_METADATA_KEY,
  type LocalSetupMetadataPutOperation,
  type LocalSetupSecretWriteEffect,
} from './setup-persist'

import type {
  AuthRefreshSecretStoragePort,
  AuthRefreshHttpPort,
  AuthRefreshAccessTokenVerifierPort,
  AuthRefreshMetadataPort,
  AuthRefreshHttpResult,
  AuthRefreshRuntimeInput,
  AuthRefreshStartRuntimeInput,
  AuthRefreshStaleStartRecoveryRuntimeInput,
  AuthRefreshSecretRollbackEffect,
  AuthRefreshCleanupFailure,
  SuccessfulAuthRefreshRuntimePlan,
  SuccessfulAuthRefreshStartRuntimePlan,
  FailedAuthRefreshStartRuntimePlan,
  SuccessfulAuthRefreshStaleStartRecoveryRuntimePlan,
  SkippedAuthRefreshStaleStartRecoveryRuntimePlan,
  FailedAuthRefreshRuntimePlan,
  FailedAuthRefreshMetadataCommitRuntimePlan,
  AuthRefreshRuntimePlan,
  AuthRefreshStartRuntimePlan,
  AuthRefreshStaleStartRecoveryRuntimePlan,
} from './auth-refresh-types'

export type {
  AuthRefreshSecretStoragePort,
  AuthRefreshHttpPort,
  AuthRefreshAccessTokenVerifierPort,
  AuthRefreshMetadataPort,
  AuthRefreshHttpResult,
  AuthRefreshRuntimeInput,
  AuthRefreshStartRuntimeInput,
  AuthRefreshStaleStartRecoveryRuntimeInput,
  AuthRefreshSecretRollbackEffect,
  AuthRefreshCleanupFailure,
  SuccessfulAuthRefreshRuntimePlan,
  SuccessfulAuthRefreshStartRuntimePlan,
  FailedAuthRefreshStartRuntimePlan,
  SuccessfulAuthRefreshStaleStartRecoveryRuntimePlan,
  SkippedAuthRefreshStaleStartRecoveryRuntimePlan,
  FailedAuthRefreshRuntimePlan,
  FailedAuthRefreshMetadataCommitRuntimePlan,
  AuthRefreshRuntimePlan,
  AuthRefreshStartRuntimePlan,
  AuthRefreshStaleStartRecoveryRuntimePlan,
}

/**
 * Adapts the concrete IndexedDB metadata transaction runner to the auth refresh runtime port.
 */
export function createAuthRefreshIndexedDbMetadataPort(
  database: LocalStoreIndexedDbMetadataDatabasePort,
): AuthRefreshMetadataPort {
  return {
    async commit(write) {
      const writes = planLocalStoreIndexedDbMetadataWrites([write])
      await commitLocalStoreIndexedDbMetadataTransaction({ database, writes })
    },
  }
}

/**
 * Persists the `refreshing` marker before running the auth refresh HTTP attempt.
 */
export async function persistAuthRefreshStart(
  input: AuthRefreshStartRuntimeInput,
): Promise<AuthRefreshStartRuntimePlan> {
  if (input.request.action !== 'request-refresh') {
    return {
      ok: false,
      phase: 'request',
      reason: input.request.action,
      request: input.request,
    }
  }

  const refreshStart = decideClientAuthRefreshStart({
    metadata: input.metadata,
    requestedAt: input.request.requestedAt,
  })
  if (refreshStart.action === 'reject') {
    return { ok: false, phase: 'refresh-start', refreshStart }
  }

  const metadataPut: LocalSetupMetadataPutOperation = {
    kind: 'put-metadata-record',
    key: LOCAL_AUTH_METADATA_KEY,
    value: refreshStart.metadata,
  }
  try {
    await input.metadataStore.commit(metadataPut)
  } catch (error: unknown) {
    return { ok: false, phase: 'metadata-commit', refreshStart, metadataPut, error }
  }

  return { ok: true, refreshStart, metadataPut }
}

/**
 * Recovers a stale `refreshing` marker by persisting retry backoff metadata.
 */
export async function recoverStaleAuthRefreshStart(
  input: AuthRefreshStaleStartRecoveryRuntimeInput,
): Promise<AuthRefreshStaleStartRecoveryRuntimePlan> {
  const recovery = decideClientAuthRefreshStaleStartRecovery({
    metadata: input.metadata,
    now: input.now,
    staleAfterMs: input.staleAfterMs,
  })
  if (recovery.action !== 'recover') {
    return { ok: false, phase: 'recovery', recovery }
  }

  const metadataPut: LocalSetupMetadataPutOperation = {
    kind: 'put-metadata-record',
    key: LOCAL_AUTH_METADATA_KEY,
    value: recovery.metadata,
  }
  try {
    await input.metadataStore.commit(metadataPut)
  } catch (error: unknown) {
    return { ok: false, phase: 'metadata-commit', recovery, metadataPut, error }
  }

  return { ok: true, recovery, metadataPut }
}

/**
 * Executes one client auth refresh attempt and persists the outcome through local storage ports.
 */
export async function runAuthRefreshAttempt(
  input: AuthRefreshRuntimeInput,
): Promise<AuthRefreshRuntimePlan> {
  if (
    input.metadata.authState !== 'active' ||
    input.metadata.accessTokenSecretKey === undefined ||
    input.metadata.refreshTokenSecretKey === undefined
  ) {
    return { ok: false, phase: 'metadata', reason: 'missing-active-token-secret-keys' }
  }

  let previousSecrets: AuthRefreshSecretSnapshot
  try {
    previousSecrets = await readAuthRefreshSecretSnapshot(input.secretStorage, input.metadata)
  } catch (error: unknown) {
    return { ok: false, phase: 'secret-read', error }
  }
  if (previousSecrets.refreshToken === undefined) {
    return { ok: false, phase: 'secret-read', reason: 'missing-refresh-token' }
  }

  const request: DeviceTokenRefreshRequest = {
    vaultId: input.vaultId,
    deviceId: input.metadata.deviceId,
    refreshToken: previousSecrets.refreshToken,
    previousTokenVersion: input.metadata.tokenVersion,
  }
  const httpResult = await input.http.refresh(request)
  if (!httpResult.ok) {
    return await persistFailedRefreshAttempt(input, {
      status: 'retryable-or-permanent',
      reason: httpResult.reason,
      retryAfterMs: httpResult.retryAfterMs,
      phase: 'http',
    })
  }

  if (!v.is(DeviceTokenRefreshResponseSchema, httpResult.response)) {
    return await persistFailedRefreshAttempt(input, {
      status: 'permanent',
      reason: 'invalid-refresh-response',
      phase: 'response',
    })
  }
  const response = httpResult.response

  const claims = await input.verifier.verify(response.accessToken)
  if (claims === undefined) {
    return await persistFailedRefreshAttempt(input, {
      status: 'permanent',
      reason: 'invalid-refresh-response',
      phase: 'claims',
    })
  }

  const refreshDecision = decideClientAuthRefresh({
    claims,
    expectedVaultId: input.vaultId,
    expectedDeviceId: input.metadata.deviceId,
    requiredScopes: input.requiredScopes,
    previousTokenVersion: input.metadata.tokenVersion,
    now: input.now,
  })
  if (refreshDecision.action === 'reject') {
    return await persistFailedRefreshAttempt(input, {
      status: 'permanent',
      reason: 'invalid-refresh-response',
      phase: 'refresh-decision',
      reasonDetail: refreshDecision.reason,
    })
  }

  const attemptDecision = decideClientAuthRefreshAttempt({
    now: input.now,
    retryCount: input.metadata.retryCount,
    result: { status: 'accepted', patch: refreshDecision.patch },
  })
  if (attemptDecision.action !== 'complete') {
    return { ok: false, phase: 'attempt-decision', attemptDecision }
  }

  const metadataPatch = applyClientAuthMetadataRefreshAttemptPatch({
    metadata: input.metadata,
    decision: attemptDecision,
  })
  if (metadataPatch.action !== 'apply') {
    return { ok: false, phase: 'metadata-patch', attemptDecision, metadataPatch }
  }

  const secretWrites = planAuthRefreshSecretWrites(input.metadata, response)
  const completedSecretWrites: CompletedAuthRefreshSecretWrite[] = []
  for (const secretWrite of secretWrites) {
    try {
      await input.secretStorage.set(secretWrite.key, secretWrite.value)
      completedSecretWrites.push({
        write: secretWrite,
        previousValue: previousSecretValue(previousSecrets, secretWrite.token),
      })
    } catch (error: unknown) {
      const cleanup = planAuthRefreshSecretRollback(completedSecretWrites)
      return {
        ok: false,
        phase: 'secret-write',
        attemptDecision,
        metadataPatch,
        secretWrites: completedSecretWrites.map((completed) => completed.write),
        cleanup,
        cleanupFailures: await runAuthRefreshSecretRollback(input.secretStorage, cleanup),
        error,
      }
    }
  }

  const metadataPut: LocalSetupMetadataPutOperation = {
    kind: 'put-metadata-record',
    key: LOCAL_AUTH_METADATA_KEY,
    value: metadataPatch.metadata,
  }
  try {
    await input.metadataStore.commit(metadataPut)
  } catch (error: unknown) {
    const cleanup = planAuthRefreshSecretRollback(completedSecretWrites)
    return {
      ok: false,
      phase: 'metadata-commit',
      response,
      refreshDecision,
      attemptDecision,
      metadataPatch,
      metadataPut,
      secretWrites: completedSecretWrites.map((completed) => completed.write),
      cleanup,
      cleanupFailures: await runAuthRefreshSecretRollback(input.secretStorage, cleanup),
      error,
    }
  }

  return {
    ok: true,
    response,
    refreshDecision,
    attemptDecision,
    metadataPatch,
    secretWrites: completedSecretWrites.map((completed) => completed.write),
    metadataPut,
    emitResumeEvent: attemptDecision.patch.emitResumeEvent,
  }
}

interface AuthRefreshSecretSnapshot {
  readonly accessToken: string | undefined
  readonly refreshToken: string | undefined
}

interface CompletedAuthRefreshSecretWrite {
  readonly write: LocalSetupSecretWriteEffect
  readonly previousValue: string | undefined
}

async function readAuthRefreshSecretSnapshot(
  secretStorage: AuthRefreshSecretStoragePort,
  metadata: ClientAuthMetadata,
): Promise<AuthRefreshSecretSnapshot> {
  const accessTokenSecretKey = metadata.accessTokenSecretKey
  const refreshTokenSecretKey = metadata.refreshTokenSecretKey
  if (accessTokenSecretKey === undefined || refreshTokenSecretKey === undefined) {
    return { accessToken: undefined, refreshToken: undefined }
  }
  const accessToken = await secretStorage.get(accessTokenSecretKey)
  const refreshToken = await secretStorage.get(refreshTokenSecretKey)
  return { accessToken, refreshToken }
}

type FailedRefreshAttemptInput =
  | {
      readonly status: 'retryable-or-permanent'
      readonly reason: ClientAuthRefreshRetryableFailure | ClientAuthRefreshPermanentFailure
      readonly retryAfterMs?: number | undefined
      readonly phase: 'http'
      readonly reasonDetail?: string | undefined
    }
  | {
      readonly status: 'permanent'
      readonly reason: ClientAuthRefreshPermanentFailure
      readonly phase: 'response' | 'claims' | 'refresh-decision'
      readonly reasonDetail?: string | undefined
    }

async function persistFailedRefreshAttempt(
  input: AuthRefreshRuntimeInput,
  failure: FailedRefreshAttemptInput,
): Promise<FailedAuthRefreshRuntimePlan> {
  const result =
    failure.status === 'retryable-or-permanent' && isRetryableRefreshFailure(failure.reason)
      ? { status: 'retryable-failure' as const, reason: failure.reason }
      : { status: 'permanent-failure' as const, reason: toPermanentRefreshFailure(failure.reason) }
  const attemptDecision = decideClientAuthRefreshAttempt({
    now: input.now,
    retryCount: input.metadata.retryCount,
    retryAfterMs: failure.status === 'retryable-or-permanent' ? failure.retryAfterMs : undefined,
    result,
  })
  if (attemptDecision.action === 'reject') {
    return { ok: false, phase: 'attempt-decision', attemptDecision, reason: failure.reasonDetail }
  }

  const metadataPatch = applyClientAuthMetadataRefreshAttemptPatch({
    metadata: input.metadata,
    decision: attemptDecision,
  })
  if (metadataPatch.action !== 'apply') {
    return {
      ok: false,
      phase: 'metadata-patch',
      attemptDecision,
      metadataPatch,
      reason: failure.reasonDetail,
    }
  }

  const metadataPut: LocalSetupMetadataPutOperation = {
    kind: 'put-metadata-record',
    key: LOCAL_AUTH_METADATA_KEY,
    value: metadataPatch.metadata,
  }
  try {
    await input.metadataStore.commit(metadataPut)
  } catch (error: unknown) {
    return {
      ok: false,
      phase: 'failure-metadata-commit',
      attemptDecision,
      metadataPatch,
      metadataPut,
      error,
      reason: failure.reasonDetail ?? failure.reason,
    }
  }
  return {
    ok: false,
    phase: failure.phase,
    attemptDecision,
    metadataPatch,
    metadataPut,
    reason: failure.reasonDetail ?? failure.reason,
  }
}

function planAuthRefreshSecretWrites(
  metadata: ClientAuthMetadata,
  response: DeviceTokenRefreshResponse,
): readonly LocalSetupSecretWriteEffect[] {
  const accessTokenSecretKey = metadata.accessTokenSecretKey
  const refreshTokenSecretKey = metadata.refreshTokenSecretKey
  if (accessTokenSecretKey === undefined || refreshTokenSecretKey === undefined) {
    return []
  }
  const writes: LocalSetupSecretWriteEffect[] = [
    {
      kind: 'write-secret',
      key: accessTokenSecretKey,
      value: response.accessToken,
      token: 'access',
    },
  ]
  if (response.refreshToken !== undefined) {
    writes.push({
      kind: 'write-secret',
      key: refreshTokenSecretKey,
      value: response.refreshToken,
      token: 'refresh',
    })
  }
  return writes
}

function planAuthRefreshSecretRollback(
  writes: readonly CompletedAuthRefreshSecretWrite[],
): readonly AuthRefreshSecretRollbackEffect[] {
  return [...writes].reverse().map((completed) => {
    if (completed.previousValue !== undefined) {
      return {
        kind: 'restore-secret',
        key: completed.write.key,
        value: completed.previousValue,
        token: completed.write.token,
      }
    }
    return {
      kind: 'delete-secret',
      key: completed.write.key,
      token: completed.write.token,
    }
  })
}

async function runAuthRefreshSecretRollback(
  secretStorage: AuthRefreshSecretStoragePort,
  cleanup: readonly AuthRefreshSecretRollbackEffect[],
): Promise<readonly AuthRefreshCleanupFailure[]> {
  const failures: AuthRefreshCleanupFailure[] = []
  for (const effect of cleanup) {
    try {
      if (effect.kind === 'restore-secret') {
        await secretStorage.set(effect.key, effect.value)
        continue
      }
      await secretStorage.delete(effect.key)
    } catch (error: unknown) {
      failures.push({ key: effect.key, token: effect.token, operation: effect.kind, error })
    }
  }
  return failures
}

function previousSecretValue(
  snapshot: AuthRefreshSecretSnapshot,
  token: 'access' | 'refresh',
): string | undefined {
  return token === 'access' ? snapshot.accessToken : snapshot.refreshToken
}

function isRetryableRefreshFailure(
  reason: ClientAuthRefreshRetryableFailure | ClientAuthRefreshPermanentFailure,
): reason is ClientAuthRefreshRetryableFailure {
  return (
    reason === 'network' ||
    reason === 'timeout' ||
    reason === 'offline' ||
    reason === 'server-retryable'
  )
}

function toPermanentRefreshFailure(
  reason: ClientAuthRefreshRetryableFailure | ClientAuthRefreshPermanentFailure,
): ClientAuthRefreshPermanentFailure {
  return isRetryableRefreshFailure(reason) ? 'reauth-required' : reason
}
