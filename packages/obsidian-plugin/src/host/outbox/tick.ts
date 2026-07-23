import {
  outboxConcurrencyLane,
  type OutboxResumeEvent,
  type OutboxRunningLease,
} from '@kuroflare/core'
import type { Doc } from 'yjs'

import { planOutboundQueueTick } from '../../sync/engine/queue'
import {
  planOutboxWorkerSideEffect,
  planOutboxWorkerTick,
  planOutboxWorkerTickIndexedDbWriteTransactions,
} from '../../sync/engine/worker'
import {
  readLocalStoreIndexedDbMetadataSnapshot,
  createLocalStoreIndexedDbMetadataDatabasePort,
} from '../../sync/store/indexeddb'
import type { LocalStoreOutboxRecord } from '../../sync/store/store'
import { createSyncRuntimeWebSocketOutboxSendPort } from '../../sync/transport/outbound'
import {
  requireSetupMetadata,
  readAccessToken,
  recoverStaleAuthRefreshStart,
  runAuthRefreshRequest,
  stopLocalSyncAfterAuthBlocked,
} from '../auth'
import { OUTBOX_WORKER_LEASE_DURATION_MS, OUTBOX_WORKER_MAX_STARTS } from '../constants'
import {
  safeLogError,
  accessTokenSecretKeyForSetup,
  schedulerAuthGateFromMetadata,
  outboxAuthRefreshStateFromMetadata,
} from '../helpers'
import { runLocalStoreMutation } from '../local-store-coordination'
import { metadataWritesEnabled } from '../meta'
import type KuroflareSpikePlugin from '../plugin'
import {
  openLocalStoreDatabase,
  readOutboxWorkerSnapshot,
  commitOutboxWorkerIndexedDbWriteTransaction,
} from '../store'
import { completeLeasedOutboxFailure, completeNonAckSideEffect } from './completion'
import {
  runBlobPutSideEffect,
  runBlobGetSideEffect,
  runManifestPutSideEffect,
  runMaterializeSideEffect,
} from './effects'

export function schedulerItemsForMetadataAccess(
  records: readonly LocalStoreOutboxRecord[],
  metadataAccess: 'read-only' | 'read-write',
): readonly LocalStoreOutboxRecord[] {
  if (metadataAccess !== 'read-only') return records
  return records.map((record) =>
    record.docId?.kind === 'meta' && (record.status === 'pending' || record.status === 'retrying')
      ? { ...record, status: 'blocked' as const }
      : record,
  )
}

export function shouldSendMetadataOutbox(
  plugin: {
    readonly metadataAccess?: 'read-only' | 'read-write'
    readonly metaDoc: Doc
  },
  record: {
    readonly docId?: { readonly kind: string } | undefined
    readonly metadataSchemaVersion?: 2 | undefined
  },
): boolean {
  return (
    record.docId?.kind === 'meta' &&
    metadataWritesEnabled(plugin) &&
    record.metadataSchemaVersion === 2
  )
}

/** Returns whether an unleased sync-control item can start in the next tick. */
export function hasRunnableOutboxWork(
  records: readonly LocalStoreOutboxRecord[],
  leases: readonly OutboxRunningLease[],
  now: number,
): boolean {
  const recordsById = new Map(records.map((record) => [record.id, record]))
  const activeLeaseIds = new Set(
    leases.filter((lease) => lease.leaseExpiresAt > now).map((lease) => lease.itemId),
  )
  const activeLanes = new Set(
    leases
      .filter((lease) => lease.leaseExpiresAt > now)
      .map((lease) => outboxConcurrencyLane(lease.kind)),
  )
  return records.some((record) => {
    if (
      (record.kind !== 'y-update' && record.kind !== 'meta-ref-update') ||
      (record.status !== 'pending' && record.status !== 'retrying') ||
      activeLeaseIds.has(record.id) ||
      (record.nextAttemptAt !== undefined && record.nextAttemptAt > now)
    ) {
      return false
    }
    if (activeLanes.has(outboxConcurrencyLane(record.kind))) return false
    return record.dependsOn.every(
      (dependencyId) => recordsById.get(dependencyId)?.status === 'done',
    )
  })
}

export function scheduleOutboxWorkerTick(
  plugin: KuroflareSpikePlugin,
  delayMs: number,
  reason: string,
): void {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (plugin.outboxWorkerRetryTimeout !== null) {
    return
  }
  plugin.outboxWorkerRetryTimeout = window.setTimeout(() => {
    plugin.outboxWorkerRetryTimeout = null
    void runOutboxWorkerTick(plugin, reason)
  }, delayMs)
}

export function consumePendingOutboxResumeEvents(
  plugin: KuroflareSpikePlugin,
): readonly OutboxResumeEvent[] {
  const events = plugin.pendingOutboxResumeEvents
  plugin.pendingOutboxResumeEvents = []
  return events
}

export async function runOutboxWorkerTick(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  const context = plugin.captureVaultOperationContext()
  if (context === undefined) return
  const isCurrent = () =>
    plugin.startupSideEffectGate.canSendNetwork() && plugin.vaultOperationStillCurrent(context)
  if (plugin.syncStoppedByAuth !== null) {
    return
  }
  if (document.hidden) {
    return
  }
  if (plugin.outboxWorkerRunning) {
    return
  }
  if (
    !plugin.workerHelloAccepted ||
    plugin.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
  ) {
    return
  }
  plugin.outboxWorkerRunning = true
  let completeTickResolve!: () => void
  const completion = new Promise<void>((resolve) => {
    completeTickResolve = resolve
  })
  plugin.outboxWorkerCompletionPromise = completion
  try {
    const setup = requireSetupMetadata(plugin)
    const db = await openLocalStoreDatabase(plugin, setup.vaultId, isCurrent)
    if (!isCurrent()) return
    const snapshot = await readOutboxWorkerSnapshot(db)
    if (!isCurrent()) return
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (!isCurrent()) return
    const authMetadata = metadataSnapshot.ok ? metadataSnapshot.snapshot.auth : undefined
    if (authMetadata?.refreshState === 'refreshing') {
      await recoverStaleAuthRefreshStart(plugin, db, authMetadata)
      if (!isCurrent()) return
    }
    const currentMetadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (!isCurrent()) return
    const currentAuthMetadata = currentMetadataSnapshot.ok
      ? currentMetadataSnapshot.snapshot.auth
      : undefined
    if (currentAuthMetadata !== undefined && currentAuthMetadata.authState !== 'active') {
      stopLocalSyncAfterAuthBlocked(plugin, currentAuthMetadata.authState)
      return
    }
    const now = Date.now()
    const resumeEvents = consumePendingOutboxResumeEvents(plugin)
    const tick = planOutboundQueueTick({
      items: schedulerItemsForMetadataAccess(snapshot.outboxRecords, plugin.metadataAccess),
      now,
      profile: 'desktop',
      resumeEvents,
      leases: snapshot.leaseRows,
      maxStarts: OUTBOX_WORKER_MAX_STARTS,
      auth: schedulerAuthGateFromMetadata(currentAuthMetadata),
      authRefreshState: outboxAuthRefreshStateFromMetadata(currentAuthMetadata),
    })
    if (!tick.ok) {
      console.warn('[kuroflare] outbox queue tick skipped', {
        reason,
        failure: tick.reason,
        id: tick.id,
      })
      return
    }
    const workerTick = planOutboxWorkerTick({
      tick,
      currentOutboxRecords: snapshot.outboxRecords,
      currentLeaseRows: snapshot.leaseRows,
      ownerId: plugin.outboxWorkerOwnerId,
      now,
      leaseDurationMs: OUTBOX_WORKER_LEASE_DURATION_MS,
    })
    if (!workerTick.ok) {
      console.warn('[kuroflare] outbox worker tick skipped', {
        reason,
        phase: workerTick.phase,
        failure: workerTick.reason,
      })
      return
    }
    for (const transaction of planOutboxWorkerTickIndexedDbWriteTransactions(workerTick)) {
      if (!isCurrent()) return
      await runLocalStoreMutation(plugin, () =>
        commitOutboxWorkerIndexedDbWriteTransaction(db, transaction),
      )
    }
    if (!isCurrent()) return
    if (tick.authRefresh.action === 'request-refresh') {
      await runAuthRefreshRequest(plugin, tick.authRefresh)
      if (!isCurrent()) return
    }
    const nextSnapshot = await readOutboxWorkerSnapshot(db)
    if (!isCurrent()) return
    const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
    if (!isCurrent()) return
    const sender = createSyncRuntimeWebSocketOutboxSendPort({
      session: plugin.workerWebSocketSession,
    })
    for (const effect of workerTick.starts) {
      if (!isCurrent()) return
      const record = nextSnapshot.outboxRecords.find(
        (candidate) => candidate.id === effect.start.id,
      )
      if (record === undefined) {
        continue
      }
      if (record.kind === 'y-update') {
        if (record.docId?.kind === 'meta') {
          if (!metadataWritesEnabled(plugin)) continue
          if (!shouldSendMetadataOutbox(plugin, record)) {
            await completeLeasedOutboxFailure(plugin, record, {
              kind: 'metadata-migration-required',
            })
            continue
          }
        }
        try {
          const send = await sender.sendSyncUpdate({
            record,
            vaultId: setup.vaultId,
            deviceId: setup.deviceId,
          })
          if (!isCurrent()) return
          if (!send.ok) {
            console.warn('[kuroflare] outbox websocket send rejected', {
              reason: send.reason,
              itemId: effect.start.id,
            })
            await completeLeasedOutboxFailure(plugin, record, { kind: 'invalid-payload' })
          }
        } catch (error: unknown) {
          console.warn('[kuroflare] outbox websocket send failed', {
            itemId: effect.start.id,
            error: safeLogError(error),
          })
          await completeLeasedOutboxFailure(plugin, record, { kind: 'network' })
        }
        continue
      }
      const sideEffect = planOutboxWorkerSideEffect({
        effect,
        record,
        endpoint: setup.endpoint,
        accessToken,
      })
      if (!sideEffect.ok) {
        console.warn('[kuroflare] outbox side effect skipped', {
          reason: sideEffect.reason,
          itemId: effect.start.id,
        })
        await completeLeasedOutboxFailure(
          plugin,
          record,
          sideEffect.reason === 'missing-access-token'
            ? { kind: 'auth' }
            : { kind: 'invalid-payload' },
        )
        continue
      }
      if (sideEffect.action === 'blob-put') {
        const result = await runBlobPutSideEffect(plugin, sideEffect)
        if (!isCurrent()) return
        await completeNonAckSideEffect(plugin, record, result)
        continue
      }
      if (sideEffect.action === 'blob-get') {
        const result = await runBlobGetSideEffect(plugin, sideEffect, isCurrent)
        if (!isCurrent()) return
        await completeNonAckSideEffect(plugin, record, result)
        continue
      }
      if (sideEffect.action === 'manifest-put') {
        const result = await runManifestPutSideEffect(sideEffect)
        if (!isCurrent()) return
        await completeNonAckSideEffect(plugin, record, result)
        continue
      }
      if (sideEffect.action === 'materialize') {
        const result = await runMaterializeSideEffect(plugin, sideEffect, isCurrent)
        if (!isCurrent()) return
        await completeNonAckSideEffect(plugin, record, result)
        continue
      }
      if (sideEffect.action !== 'meta-ref-update') {
        continue
      }
      if (record.docId?.kind === 'meta') {
        if (!metadataWritesEnabled(plugin)) continue
        if (!shouldSendMetadataOutbox(plugin, record)) {
          await completeLeasedOutboxFailure(plugin, record, {
            kind: 'metadata-migration-required',
          })
          continue
        }
      }
      try {
        const send = await sender.sendSyncUpdate({
          record,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
        })
        if (!isCurrent()) return
        if (!send.ok) {
          console.warn('[kuroflare] outbox websocket send rejected', {
            reason: send.reason,
            itemId: effect.start.id,
          })
          await completeLeasedOutboxFailure(plugin, record, { kind: 'invalid-payload' })
        }
      } catch (error: unknown) {
        console.warn('[kuroflare] outbox websocket send failed', {
          itemId: effect.start.id,
          error: safeLogError(error),
        })
        await completeLeasedOutboxFailure(plugin, record, { kind: 'network' })
      }
    }
    const completionSnapshot = await readOutboxWorkerSnapshot(db)
    if (!isCurrent()) return
    if (
      hasRunnableOutboxWork(
        schedulerItemsForMetadataAccess(completionSnapshot.outboxRecords, plugin.metadataAccess),
        completionSnapshot.leaseRows,
        Date.now(),
      )
    ) {
      scheduleOutboxWorkerTick(plugin, 250, 'runnable-follow-up')
    } else if (workerTick.starts.length > 0) {
      scheduleOutboxWorkerTick(plugin, OUTBOX_WORKER_LEASE_DURATION_MS + 250, 'lease-expiry-retry')
    }
  } catch (error: unknown) {
    console.error('[kuroflare] outbox worker tick failed', { reason, error: safeLogError(error) })
  } finally {
    plugin.outboxWorkerRunning = false
    completeTickResolve()
    if (plugin.outboxWorkerCompletionPromise === completion) {
      plugin.outboxWorkerCompletionPromise = null
    }
  }
}
