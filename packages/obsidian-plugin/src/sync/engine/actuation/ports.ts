import {
  decideClientAuthRefresh,
  type ClientStartupStep,
  type DeviceTokenScope,
} from '@kuroflare/core'

import {
  applyLocalStoreIndexedDbOpenEffect,
  type LocalStoreIndexedDbExecutableOpenEffect,
  type LocalStoreIndexedDbOpenEffectPlan,
  type LocalStoreIndexedDbSchemaDatabasePort,
} from '../../store/indexeddb'
import { type LocalStoreIndexedDbOpenEffect } from '../../store/schema'
import {
  type SyncRuntimeIndexedDbLocalStoreEffectPort,
  type SyncRuntimeIndexedDbLocalStoreEffectPortInput,
  type SyncRuntimeLocalStoreRebuildReplanPort,
  type SyncRuntimeLocalStoreRebuildReplanPortInput,
  type SyncRuntimeLocalStoreRebuildReplanRequest,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeSetupExchangePortInput,
  type SyncRuntimeSetupExchangeReplanRequest,
  type SyncRuntimeSetupPersistStepPort,
  type SyncRuntimeSetupPersistStepPortInput,
  type SyncRuntimeSetupPersistTokenVerificationFailure,
  type SyncRuntimeStartupStepEffect,
  type SyncRuntimeStartupStepEffectPort,
  type SyncRuntimeStartupStepExecutorPorts,
  type SyncRuntimeVerifiedSetupPersistStepPort,
  type SyncRuntimeVerifiedSetupPersistStepPortInput,
} from '../actuation.types'
import { type SyncEngineStartupEffect } from '../engine'
import { persistLocalSetupResponse, type LocalSetupPersistRuntimePlan } from '../persist'
import { setupPersistFailureReason } from './verify'

/**
 * Creates a local-store startup effect port backed by an IndexedDB factory.
 */
export function createSyncRuntimeIndexedDbLocalStoreEffectPort<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
>(
  input: SyncRuntimeIndexedDbLocalStoreEffectPortInput<Database>,
): SyncRuntimeIndexedDbLocalStoreEffectPort<Database> {
  const appliedEffects: LocalStoreIndexedDbExecutableOpenEffect[] = []
  const openPlans: LocalStoreIndexedDbOpenEffectPlan<Database>[] = []

  return {
    async runOpenEffect(effect) {
      if (!localStoreOpenEffectIsExecutable(effect)) {
        throw new Error(`Non-runnable local-store open effect: ${effect.kind}`)
      }
      const plan = await applyLocalStoreIndexedDbOpenEffect({
        indexedDb: input.indexedDb,
        effect,
      })
      appliedEffects.push(effect)
      openPlans.push(plan)
    },
    snapshot() {
      return {
        appliedEffects: [...appliedEffects],
        openPlans: [...openPlans],
      }
    },
  }
}

/**
 * Creates a setup exchange port that replans startup with the returned setup response.
 */
export function createSyncRuntimeSetupExchangePort(
  input: SyncRuntimeSetupExchangePortInput,
): SyncRuntimeSetupExchangePort {
  const completed: SyncRuntimeSetupExchangeReplanRequest[] = []

  return {
    async run(effect) {
      const response = await input.exchange(effect)
      const request = { effect, response }
      await input.scheduleReplan(request)
      completed.push(request)
      return request
    },
    snapshot() {
      return { completed: [...completed] }
    },
  }
}

/**
 * Creates a setup persistence startup step port.
 */
export function createSyncRuntimeSetupPersistStepPort(
  input: SyncRuntimeSetupPersistStepPortInput,
): SyncRuntimeSetupPersistStepPort {
  const results: LocalSetupPersistRuntimePlan[] = []

  return {
    async persistSetupResponse() {
      const result = await persistLocalSetupResponse({
        response: input.response,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        secretKeyPrefix: input.secretKeyPrefix,
        secretStorage: input.secretStorage,
        metadata: input.metadata,
      })
      results.push(result)
      if (!result.ok) {
        throw new Error(setupPersistFailureReason(result))
      }
    },
    snapshot() {
      return { results: [...results] }
    },
  }
}

/**
 * Creates a setup persistence port that verifies setup access-token claims before persisting.
 */
export function createVerifiedSyncRuntimeSetupPersistStepPort(
  input: SyncRuntimeVerifiedSetupPersistStepPortInput,
): SyncRuntimeVerifiedSetupPersistStepPort {
  const results: LocalSetupPersistRuntimePlan[] = []
  const verificationFailures: SyncRuntimeSetupPersistTokenVerificationFailure[] = []

  return {
    async persistSetupResponse() {
      const verification = await verifySetupPersistAccessToken(input)
      if (!verification.ok) {
        verificationFailures.push({ reason: verification.reason })
        throw new Error(`setup-persist-token:${verification.reason}`)
      }
      const result = await persistLocalSetupResponse({
        response: input.response,
        accessTokenExpiresAt: verification.expiresAt,
        secretKeyPrefix: input.secretKeyPrefix,
        secretStorage: input.secretStorage,
        metadata: input.metadata,
      })
      results.push(result)
      if (!result.ok) {
        throw new Error(setupPersistFailureReason(result))
      }
    },
    snapshot() {
      return {
        results: [...results],
        verificationFailures: [...verificationFailures],
      }
    },
  }
}

/**
 * Creates a local-store rebuild port that schedules startup evidence collection again.
 */
export function createSyncRuntimeLocalStoreRebuildReplanPort(
  input: SyncRuntimeLocalStoreRebuildReplanPortInput,
): SyncRuntimeLocalStoreRebuildReplanPort {
  const requests: SyncRuntimeLocalStoreRebuildReplanRequest[] = []

  return {
    async rerunStartup(effect) {
      const request = { vaultId: effect.vaultId, dbName: effect.dbName }
      await input.scheduleReplan(request)
      requests.push(request)
    },
    snapshot() {
      return { requests: [...requests] }
    },
  }
}

/**
 * Creates the default executor for accepted startup steps.
 */
export function createSyncRuntimeStartupStepEffectPort(
  ports: SyncRuntimeStartupStepExecutorPorts,
): SyncRuntimeStartupStepEffectPort {
  return {
    async run(effect) {
      switch (effect.step) {
        case 'persist-setup-response':
          await ports.setup.persistSetupResponse(
            startupStepEffect(effect, 'persist-setup-response'),
          )
          return
        case 'scan-local-vault':
          await ports.localScan.scanLocalVault(startupStepEffect(effect, 'scan-local-vault'))
          return
        case 'create-local-meta-ydoc':
          await ports.localScan.createLocalMetaYDoc(
            startupStepEffect(effect, 'create-local-meta-ydoc'),
          )
          return
        case 'adopt-local-files-after-remote-meta':
          await ports.localScan.adoptLocalFilesAfterRemoteMeta(
            startupStepEffect(effect, 'adopt-local-files-after-remote-meta'),
          )
          return
        case 'publish-local-meta-snapshot':
          await ports.snapshot.publishLocalMetaSnapshot(
            startupStepEffect(effect, 'publish-local-meta-snapshot'),
          )
          return
        case 'publish-initial-file-snapshots':
          await ports.snapshot.publishInitialFileSnapshots(
            startupStepEffect(effect, 'publish-initial-file-snapshots'),
          )
          return
        case 'fetch-remote-meta-snapshot':
          await ports.snapshot.fetchRemoteMetaSnapshot(
            startupStepEffect(effect, 'fetch-remote-meta-snapshot'),
          )
          return
        case 'apply-remote-meta-snapshot':
          await ports.snapshot.applyRemoteMetaSnapshot(
            startupStepEffect(effect, 'apply-remote-meta-snapshot'),
          )
          return
        case 'sync-meta-state-vector':
          await ports.snapshot.syncMetaStateVector(
            startupStepEffect(effect, 'sync-meta-state-vector'),
          )
          return
        case 'sync-active-file-state-vector':
          await ports.snapshot.syncActiveFileStateVector(
            startupStepEffect(effect, 'sync-active-file-state-vector'),
          )
          return
        case 'load-indexeddb-ydocs':
          await ports.localStore.loadIndexedDbYDocs(
            startupStepEffect(effect, 'load-indexeddb-ydocs'),
          )
          return
        case 'open-websocket':
          await ports.websocket.openWebSocket(startupStepEffect(effect, 'open-websocket'))
          return
        case 'send-client-hello':
          await ports.websocket.sendClientHello(startupStepEffect(effect, 'send-client-hello'))
          return
        case 'send-meta-update':
          await ports.outbox.sendMetaUpdate(startupStepEffect(effect, 'send-meta-update'))
          return
        case 'enqueue-missing-downloads':
          await ports.outbox.enqueueMissingDownloads(
            startupStepEffect(effect, 'enqueue-missing-downloads'),
          )
          return
        case 'resume-background-queues':
          await ports.outbox.resumeBackgroundQueues(
            startupStepEffect(effect, 'resume-background-queues'),
          )
          return
      }
    },
  }
}

function localStoreOpenEffectIsExecutable(
  effect: LocalStoreIndexedDbOpenEffect,
): effect is LocalStoreIndexedDbExecutableOpenEffect {
  return effect.kind === 'open-database' || effect.kind === 'delete-database'
}

function startupStepEffect<Step extends ClientStartupStep>(
  effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>,
  step: Step,
): SyncRuntimeStartupStepEffect<Step> {
  return { ...effect, step }
}

async function verifySetupPersistAccessToken(
  input: SyncRuntimeVerifiedSetupPersistStepPortInput,
): Promise<
  | { readonly ok: true; readonly expiresAt: number }
  | {
      readonly ok: false
      readonly reason: SyncRuntimeSetupPersistTokenVerificationFailure['reason']
    }
> {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { ok: false, reason: 'invalid-clock' }
  }

  const claims = await input.verifier.verify(input.response.accessToken)
  if (claims === undefined) {
    return { ok: false, reason: 'invalid-access-token' }
  }
  if (claims.tokenVersion !== input.response.tokenVersion) {
    return { ok: false, reason: 'token-version-mismatch' }
  }

  const decision = decideClientAuthRefresh({
    claims,
    expectedVaultId: input.response.vaultId,
    expectedDeviceId: input.response.deviceId,
    requiredScopes: input.requiredScopes ?? REQUIRED_SETUP_ACCESS_TOKEN_SCOPES,
    now: input.now,
  })
  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason }
  }
  return { ok: true, expiresAt: decision.patch.expiresAt }
}

const REQUIRED_SETUP_ACCESS_TOKEN_SCOPES = [
  'sync:read',
  'sync:write',
  'blob:read',
  'blob:write',
] as const satisfies readonly DeviceTokenScope[]
