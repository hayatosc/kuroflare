import { type OutboxResumeEvent } from '@kuroflare/core'

import { planOutboundQueueTick } from '../../sync/engine/queue'
import { createSyncRuntimeWebSocketOutboxSendPort } from '../../sync/engine/websocket'
import {
  planOutboxWorkerSideEffect,
  planOutboxWorkerTick,
  planOutboxWorkerTickIndexedDbWriteTransactions,
} from '../../sync/engine/worker'
import {
  readLocalStoreIndexedDbMetadataSnapshot,
  createLocalStoreIndexedDbMetadataDatabasePort,
} from '../../sync/store/indexeddb'
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
} from './side-effects'

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
  try {
    const setup = requireSetupMetadata(plugin)
    const db = await openLocalStoreDatabase(plugin, setup.vaultId)
    const snapshot = await readOutboxWorkerSnapshot(db)
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    const authMetadata = metadataSnapshot.ok ? metadataSnapshot.snapshot.auth : undefined
    if (authMetadata?.refreshState === 'refreshing') {
      await recoverStaleAuthRefreshStart(plugin, db, authMetadata)
    }
    const currentMetadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
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
      items: snapshot.outboxRecords,
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
      await commitOutboxWorkerIndexedDbWriteTransaction(db, transaction)
    }
    if (tick.authRefresh.action === 'request-refresh') {
      await runAuthRefreshRequest(plugin, tick.authRefresh)
    }
    const nextSnapshot = await readOutboxWorkerSnapshot(db)
    const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
    const sender = createSyncRuntimeWebSocketOutboxSendPort({
      session: plugin.workerWebSocketSession,
    })
    for (const effect of workerTick.starts) {
      const record = nextSnapshot.outboxRecords.find(
        (candidate) => candidate.id === effect.start.id,
      )
      if (record === undefined) {
        continue
      }
      if (record.kind === 'y-update') {
        try {
          const send = await sender.sendSyncUpdate({
            record,
            vaultId: setup.vaultId,
            deviceId: setup.deviceId,
          })
          if (!send.ok) {
            console.warn('[kuroflare] outbox websocket send rejected', {
              reason: send.reason,
              itemId: effect.start.id,
            })
            await completeLeasedOutboxFailure(plugin, db, record, { kind: 'invalid-payload' })
          }
        } catch (error: unknown) {
          console.warn('[kuroflare] outbox websocket send failed', {
            itemId: effect.start.id,
            error: safeLogError(error),
          })
          await completeLeasedOutboxFailure(plugin, db, record, { kind: 'network' })
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
          db,
          record,
          sideEffect.reason === 'missing-access-token'
            ? { kind: 'auth' }
            : { kind: 'invalid-payload' },
        )
        continue
      }
      if (sideEffect.action === 'blob-put') {
        const result = await runBlobPutSideEffect(plugin, sideEffect)
        await completeNonAckSideEffect(plugin, db, record, result)
        continue
      }
      if (sideEffect.action === 'blob-get') {
        const result = await runBlobGetSideEffect(plugin, sideEffect)
        await completeNonAckSideEffect(plugin, db, record, result)
        continue
      }
      if (sideEffect.action === 'manifest-put') {
        const result = await runManifestPutSideEffect(sideEffect)
        await completeNonAckSideEffect(plugin, db, record, result)
        continue
      }
      if (sideEffect.action === 'materialize') {
        const result = await runMaterializeSideEffect(plugin, sideEffect)
        await completeNonAckSideEffect(plugin, db, record, result)
        continue
      }
      if (sideEffect.action !== 'meta-ref-update') {
        continue
      }
      try {
        const send = await sender.sendSyncUpdate({
          record,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
        })
        if (!send.ok) {
          console.warn('[kuroflare] outbox websocket send rejected', {
            reason: send.reason,
            itemId: effect.start.id,
          })
          await completeLeasedOutboxFailure(plugin, db, record, { kind: 'invalid-payload' })
        }
      } catch (error: unknown) {
        console.warn('[kuroflare] outbox websocket send failed', {
          itemId: effect.start.id,
          error: safeLogError(error),
        })
        await completeLeasedOutboxFailure(plugin, db, record, { kind: 'network' })
      }
    }
    if (workerTick.starts.length > 0) {
      scheduleOutboxWorkerTick(plugin, OUTBOX_WORKER_LEASE_DURATION_MS + 250, 'lease-expiry-retry')
    }
  } catch (error: unknown) {
    console.error('[kuroflare] outbox worker tick failed', { reason, error: safeLogError(error) })
  } finally {
    plugin.outboxWorkerRunning = false
  }
}
