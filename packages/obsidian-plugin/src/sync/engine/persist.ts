import { type SetupExchangeResponse } from '@kuroflare/core'

import {
  commitLocalStoreIndexedDbMetadataTransaction,
  planLocalStoreIndexedDbMetadataWrites,
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbMetadataWriteOperation,
} from '../store/indexeddb'
import {
  planLocalSetupPersist,
  planLocalSetupPersistSecretCleanup,
  type LocalSetupPersistPlan,
  type LocalSetupPersistSecretCleanupPlan,
  type LocalSetupSecretWriteEffect,
  type SuccessfulLocalSetupPersistPlan,
} from '../engine/setup'

/** SecretStorage surface required by setup persistence. */
export interface LocalSetupPersistSecretStoragePort {
  /** Stores one secret token body under a stable key. */
  set(key: string, value: string): Promise<void>
  /** Deletes one secret key during best-effort cleanup. */
  delete(key: string): Promise<void>
}

/** Metadata persistence surface required by setup persistence. */
export interface LocalSetupPersistMetadataPort {
  /** Commits setup/auth metadata writes in one durable metadata transaction. */
  commit(writes: readonly LocalStoreIndexedDbMetadataWriteOperation[]): Promise<void>
}

/** Input for executing setup persistence through concrete storage ports. */
export interface LocalSetupPersistRuntimeInput {
  readonly response: SetupExchangeResponse
  readonly accessTokenExpiresAt: number
  readonly secretKeyPrefix?: string | undefined
  readonly secretStorage: LocalSetupPersistSecretStoragePort
  readonly metadata: LocalSetupPersistMetadataPort
}

/** One cleanup delete that failed during setup persistence compensation. */
export interface LocalSetupPersistCleanupFailure {
  readonly key: string
  readonly token: 'access' | 'refresh'
  readonly error: unknown
}

/** Successful setup persistence runtime result after secrets and metadata are durable. */
export interface SuccessfulLocalSetupPersistRuntimePlan {
  readonly ok: true
  readonly setupPlan: SuccessfulLocalSetupPersistPlan
  readonly metadataWrites: readonly LocalStoreIndexedDbMetadataWriteOperation[]
  readonly completedSecretWrites: readonly LocalSetupSecretWriteEffect[]
}

/** Setup persistence runtime result when input evidence is rejected before I/O. */
export interface RejectedLocalSetupPersistRuntimePlan {
  readonly ok: false
  readonly phase: 'plan'
  readonly setupPlan: Extract<LocalSetupPersistPlan, { readonly ok: false }>
}

/** Setup persistence runtime result when a SecretStorage write fails. */
export interface FailedLocalSetupSecretWriteRuntimePlan {
  readonly ok: false
  readonly phase: 'secret-write'
  readonly setupPlan: SuccessfulLocalSetupPersistPlan
  readonly failedSecretWrite: LocalSetupSecretWriteEffect
  readonly completedSecretWrites: readonly LocalSetupSecretWriteEffect[]
  readonly cleanup: LocalSetupPersistSecretCleanupPlan
  readonly cleanupFailures: readonly LocalSetupPersistCleanupFailure[]
  readonly error: unknown
}

/** Setup persistence runtime result when the metadata transaction fails after secrets are stored. */
export interface FailedLocalSetupMetadataCommitRuntimePlan {
  readonly ok: false
  readonly phase: 'metadata-commit'
  readonly setupPlan: SuccessfulLocalSetupPersistPlan
  readonly metadataWrites: readonly LocalStoreIndexedDbMetadataWriteOperation[]
  readonly completedSecretWrites: readonly LocalSetupSecretWriteEffect[]
  readonly cleanup: LocalSetupPersistSecretCleanupPlan
  readonly cleanupFailures: readonly LocalSetupPersistCleanupFailure[]
  readonly error: unknown
}

/** Result of executing setup persistence through concrete local storage ports. */
export type LocalSetupPersistRuntimePlan =
  | SuccessfulLocalSetupPersistRuntimePlan
  | RejectedLocalSetupPersistRuntimePlan
  | FailedLocalSetupSecretWriteRuntimePlan
  | FailedLocalSetupMetadataCommitRuntimePlan

/**
 * Adapts the concrete IndexedDB metadata transaction runner to the setup persistence runtime port.
 *
 * @param database Database port that opens the metadata object-store transaction.
 * @returns Metadata runtime port that commits setup/auth metadata in one IndexedDB transaction.
 */
export function createLocalSetupPersistIndexedDbMetadataPort(
  database: LocalStoreIndexedDbMetadataDatabasePort,
): LocalSetupPersistMetadataPort {
  return {
    async commit(writes) {
      await commitLocalStoreIndexedDbMetadataTransaction({ database, writes })
    },
  }
}

/**
 * Executes setup persistence with explicit compensation for non-atomic local stores.
 *
 * @param input Guarded setup response evidence plus concrete SecretStorage and metadata ports.
 * @returns Runtime evidence describing success, planning rejection, or the failed phase and cleanup outcome.
 */
export async function persistLocalSetupResponse(
  input: LocalSetupPersistRuntimeInput,
): Promise<LocalSetupPersistRuntimePlan> {
  const setupPlan = planLocalSetupPersist({
    response: input.response,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    secretKeyPrefix: input.secretKeyPrefix,
  })
  if (!setupPlan.ok) {
    return { ok: false, phase: 'plan', setupPlan }
  }

  const completedSecretWrites: LocalSetupSecretWriteEffect[] = []
  for (const secretWrite of setupPlan.secretWrites) {
    try {
      await input.secretStorage.set(secretWrite.key, secretWrite.value)
      completedSecretWrites.push(secretWrite)
    } catch (error: unknown) {
      const cleanup = planLocalSetupPersistSecretCleanup({
        setupPlan,
        completedSecretWrites,
      })
      return {
        ok: false,
        phase: 'secret-write',
        setupPlan,
        failedSecretWrite: secretWrite,
        completedSecretWrites,
        cleanup,
        cleanupFailures: await runSetupSecretCleanup(input.secretStorage, cleanup),
        error,
      }
    }
  }

  const metadataWrites = planLocalStoreIndexedDbMetadataWrites(setupPlan.metadataPuts)
  try {
    await input.metadata.commit(metadataWrites)
  } catch (error: unknown) {
    const cleanup = planLocalSetupPersistSecretCleanup({
      setupPlan,
      completedSecretWrites,
    })
    return {
      ok: false,
      phase: 'metadata-commit',
      setupPlan,
      metadataWrites,
      completedSecretWrites,
      cleanup,
      cleanupFailures: await runSetupSecretCleanup(input.secretStorage, cleanup),
      error,
    }
  }

  return {
    ok: true,
    setupPlan,
    metadataWrites,
    completedSecretWrites,
  }
}

async function runSetupSecretCleanup(
  secretStorage: LocalSetupPersistSecretStoragePort,
  cleanup: LocalSetupPersistSecretCleanupPlan,
): Promise<readonly LocalSetupPersistCleanupFailure[]> {
  if (!cleanup.ok) {
    return []
  }

  const failures: LocalSetupPersistCleanupFailure[] = []
  for (const secretDelete of cleanup.secretDeletes) {
    try {
      await secretStorage.delete(secretDelete.key)
    } catch (error: unknown) {
      failures.push({ key: secretDelete.key, token: secretDelete.token, error })
    }
  }
  return failures
}
